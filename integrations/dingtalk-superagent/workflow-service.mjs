import { randomUUID } from 'node:crypto';
import { WorkflowStore, hasOutstandingInputs } from './workflow-store.mjs';
import { settingsVersion, fault } from './workflow-settings.mjs';
import { Assessor } from './assessor.mjs';
import { DshExecutor } from './dsh-executor.mjs';
import { DingTalkStream } from './stream-client.mjs';
import { GitHubSource } from './github-source.mjs';
import { GitHubDelivery } from './github-delivery.mjs';

export class WorkflowService {
  constructor(runtimeDir, { assessorFactory = settings => new Assessor({ settings: { model: settings.model.name, endpoint: settings.model.endpoint } }), executorFactory = settings => new DshExecutor({ settings }), streamFactory = options => new DingTalkStream(options), githubFactory = options => new GitHubSource(options), deliveryFactory = options => new GitHubDelivery(options), env = process.env } = {}) {
    this.store = new WorkflowStore(runtimeDir); this.owner = randomUUID(); this.factories = { assessorFactory, executorFactory, streamFactory, githubFactory, deliveryFactory }; this.env = env;
    this.active = new Map(); this.evaluating = new Set(); this.running = false; this.tickFlight = null; this.stream = null; this.sourceVersion = null; this.githubDue = 0;
    this.lifetime = new AbortController();
    this.healthState = { source: { state: 'disabled', message: '钉钉接入未启用。' }, model: { ready: false, message: '评估模型未配置。' }, github: { ready: false, message: 'GitHub 接入未启用。' }, runtime: { ready: true, message: '本地任务服务已就绪。' } };
    this.workerHealth = { ready: false, message: '独立 Worker 未配置。' }; this.healthCheckedAt = 0;
  }
  async snapshot() {
    const state = await this.store.snapshot();
    return { ...state, health: structuredClone(this.healthState), worker: { ...this.workerHealth, active: this.active.size, concurrency: state.settings.concurrency }, capabilities: { merge: false } };
  }
  async start() {
    if (this.running) return;
    this.running = true; this.lifetime = new AbortController();
    await this.store.recover();
    if (!this.running) return;
    await this.configure();
    if (!this.running) return;
    this.timer = setInterval(() => { void this.tick(); }, 2000); this.timer.unref?.(); void this.tick();
  }
  async stop() {
    this.running = false; this.lifetime.abort(); clearInterval(this.timer);
    for (const { controller } of this.active.values()) controller.abort();
    await this.stream?.stop();
    await this.tickFlight;
    await Promise.allSettled([...this.active.values()].map(item => item.done));
    this.sourceVersion = null;
  }
  async configure() {
    const { settings } = await this.store.snapshot(), version = JSON.stringify([settings.source, settings.cards]);
    if (version !== this.sourceVersion) {
      await this.stream?.stop(); this.sourceVersion = version;
      this.stream = this.factories.streamFactory({ config: settings.source, cards: settings.cards, env: this.env, onHealth: value => { this.healthState.source = value; },
        onCardAction: event => this.cardAction(event), onMessage: async message => {
        try {
          // Attachment requires a concrete task reference, never topic similarity.
          const reference = /(?:任务|task|#)\s*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/i.exec(message.text)?.[1];
          await this.ingest({ source: 'dingtalk', eventId: message.eventId, text: message.text, senderId: message.senderId, conversationId: message.conversationId, ticketId: reference, origin: message });
          return { accepted: true };
        } catch (error) { if ([400, 403, 404, 409].includes(error.status)) return { accepted: false }; throw error; }
      } });
      this.healthState.source = await this.stream.start();
    }
    this.healthState.model = { ready: settings.model.enabled, message: settings.model.enabled ? '模型已配置；评估结果以实际调用为准。' : '请先配置本机评估模型。' };
    this.healthState.github = { ready: settings.github.enabled && !!this.env.SUPERAGENT_GITHUB_TOKEN, message: settings.github.enabled ? (this.env.SUPERAGENT_GITHUB_TOKEN ? '已配置，等待实际轮询验证。' : '缺少本机 SUPERAGENT_GITHUB_TOKEN。') : 'GitHub 接入未启用。' };
    this.healthCheckedAt = 0;
    await this.checkWorker(settings);
  }
  async checkWorker(settings) {
    this.healthCheckedAt = Date.now();
    if (!settings.worker.enabled) { this.workerHealth = { ready: false, message: '独立 Worker 未启用。' }; return; }
    try { const result = await this.factories.executorFactory(settings).health(); this.workerHealth = { ...result, ready: result.ready === true || result.ok === true && result.isolated === true }; }
    catch { this.workerHealth = { ready: false, message: 'Worker 无法连接或身份验证未通过，请检查独立部署和本机令牌。' }; }
  }
  async saveSettings(input, revision) {
    const before = await this.store.snapshot();
    await this.store.saveSettings(input, revision);
    const after = await this.store.snapshot();
    if (settingsVersion(before.settings) !== settingsVersion(after.settings)) {
      const activeEntries = [...this.active];
      for (const [, active] of activeEntries) active.controller.abort();
      await Promise.all(activeEntries.map(async ([id, active]) => {
        try { await active.executor.stop({ ticketId: id, assignmentId: active.assignmentId }); }
        catch { await this.store.note(id, 'policy_stop_unconfirmed', '策略已变更；远端停止结果尚未确认，请核对独立 Worker。'); }
      }));
    }
    await this.configure(); return this.snapshot();
  }
  async restoreSettings(version, revision) { const state = await this.store.snapshot(), entry = state.settingsHistory.find(h => h.version === version); if (!entry) throw fault('配置历史不存在。', 404); return this.saveSettings(entry.settings, revision); }
  async pause(paused, revision) { if (typeof paused !== 'boolean') throw fault('暂停状态无效。'); const state = await this.store.snapshot(); return this.saveSettings({ ...state.settings, paused }, revision); }
  async reconcileOutbound(id, resolution, revision) { await this.store.reconcileOutbound(id, resolution, revision); return this.snapshot(); }
  async ingest(input) {
    const result = await this.store.ingest(input);
    if (!result.duplicate && this.active.has(result.ticketId)) this.pumpSteering(result.ticketId);
  }
  async request(input) {
    if (!input || Object.keys(input).some(key => !['text', 'conversationId', 'ticketId', 'idempotencyKey'].includes(key))) throw fault('请求包含未知字段。');
    await this.ingest({ source: 'local', text: input.text, conversationId: input.conversationId || 'local-console', ticketId: input.ticketId, eventId: input.idempotencyKey });
    return this.snapshot();
  }
  async evaluate(id, revision) {
    const state = await this.store.snapshot();
    if (!revision) throw fault('请刷新任务后评估。', 428);
    if (revision !== state.revision) throw fault('任务已变化，请刷新后评估。', 409);
    const ticket = state.tickets.find(t => t.id === id); if (!ticket) throw fault('任务不存在。', 404);
    if (ticket.status !== 'observed' || !state.settings.model.enabled || state.settings.acceptMode === 'off') throw fault('需要观察中的任务和已启用的评估模型。', 409);
    if (this.evaluating.has(id)) throw fault('此任务正在评估。', 409);
    this.evaluating.add(id);
    try {
      const result = await this.factories.assessorFactory(state.settings).assess({ text: ticket.inputs.slice(-20).map(x => x.text).join('\n').slice(-12000), tickets: state.tickets.slice(0, 100), rules: state.settings.rules, prompt: state.settings.prompts.router });
      await this.store.decision(id, result, settingsVersion(state.settings), ticket.inputs.length);
      this.healthState.model = { ready: true, message: '最近一次模型评估成功。' };
    } catch (error) {
      if (error.status !== 409) { await this.store.assessmentFailed(id, settingsVersion(state.settings), ticket.inputs.length); this.healthState.model = { ready: false, message: '最近一次评估失败，可检查服务后手动重试。' }; }
      throw error;
    } finally { this.evaluating.delete(id); }
    return this.snapshot();
  }
  async action(id, action, revision) {
    if (action === 'evaluate') return this.evaluate(id, revision);
    if (['queue', 'retry'].includes(action)) { const state = await this.store.snapshot(); await this.checkWorker(state.settings); if (!this.workerHealth.ready) throw fault(this.workerHealth.message || 'Worker 尚未就绪。', 503); }
    const before = await this.store.snapshot();
    await this.store.action(id, action, revision);
    if (action === 'stop') {
      await this.stopAssignment(id, before.tickets.find(t => t.id === id)?.assignment?.id, before.settings);
    }
    void this.tick(); return this.snapshot();
  }
  async stopAssignment(ticketId, assignmentId, settings) {
    if (!assignmentId) return;
    const active = this.active.get(ticketId);
    if (active?.assignmentId === assignmentId) active.controller.abort();
    try { await (active?.executor || this.factories.executorFactory(settings)).stop({ ticketId, assignmentId }); }
    catch { await this.store.note(ticketId, 'stop_unconfirmed', '授权已撤销；远端 Worker 停止结果尚未确认，需要检查独立服务。'); }
  }
  async cardAction(event) {
    if (this.lifetime.signal.aborted) throw fault('工作台正在停止，请稍后重试。', 503);
    const { settings } = await this.store.snapshot();
    try {
      if (event.action === 'approve') await this.checkWorker(settings);
      if (this.lifetime.signal.aborted) throw fault('工作台正在停止，请稍后重试。', 503);
      const result = await this.store.applyCardAction(event, { workerReady: event.action === 'approve' && this.workerHealth.ready === true });
      if (!result.duplicate && result.action === 'stop') await this.stopAssignment(result.ticketId, result.assignmentId, settings);
      void this.tick();
      return result;
    } catch (error) {
      if (error.code === 'worker_unavailable') return { accepted: false, reason: 'worker_unavailable' };
      if ([400, 403, 404, 409].includes(error.status)) return { accepted: false };
      throw error;
    }
  }
  pumpSteering(ticketId) {
    const entry = this.active.get(ticketId);
    if (!entry || entry.finishing || entry.controller.signal.aborted || entry.pumping) return;
    entry.pumping = this.forwardInputs(ticketId, entry).catch(() => {
      this.healthState.runtime = { ready: false, message: '追加指令回执待核对。原文已保存在任务中。' };
    }).finally(() => { entry.pumping = null; });
  }
  async forwardInputs(ticketId, entry) {
    const { assignmentId, controller, executor } = entry;
    const inputs = await this.store.steeringBatch(ticketId, assignmentId);
    for (const input of inputs) {
      if (entry.finishing || controller.signal.aborted) return;
      let status = 'unavailable';
      if (entry.supportsSteering) {
        const identity = { ticketId, assignmentId, inputId: input.id };
        try {
          const result = await executor.steer({ ...identity, text: input.text, signal: controller.signal });
          status = Object.entries(identity).every(([k, v]) => result?.[k] === v) &&
            ['delivered', 'queued', 'unavailable', 'uncertain'].includes(result.status) ? result.status : 'uncertain';
        } catch { status = 'uncertain'; }
      }
      if (input.steering.status !== status) await this.store.markSteering(ticketId, assignmentId, [{ inputId: input.id, status }]);
      if (entry.supportsSteering && ['unavailable', 'uncertain'].includes(status)) break;
    }
  }
  async run(claim) {
    if (this.lifetime.signal.aborted) {
      await this.store.report(claim.ticket.id, claim.assignmentId, { status: 'blocked', summary: '工作台在派工启动前停止，请重新授权。' }); return;
    }
    const controller = new AbortController(), executor = this.factories.executorFactory(claim.settings);
    const entry = { controller, executor, assignmentId: claim.assignmentId, supportsSteering: this.workerHealth.steering === true && typeof executor.steer === 'function', done: null }; this.active.set(claim.ticket.id, entry);
    entry.done = (async () => {
      try {
        let result = await executor.execute({ ticket: { ...claim.ticket, executionPrompt: claim.settings.prompts.worker }, assignmentId: claim.assignmentId, signal: controller.signal });
        entry.finishing = true;
        await entry.pumping;
        if (result.deliveredInputIds?.length) await this.store.markSteering(claim.ticket.id, claim.assignmentId,
          result.deliveredInputIds.map(inputId => ({ inputId, status: 'delivered' })));
        const current = (await this.store.snapshot()).tickets.find(t => t.id === claim.ticket.id);
        if (!current || current.status !== 'working') return;
        if (controller.signal.aborted) { await this.store.report(claim.ticket.id, claim.assignmentId, { status: 'blocked', summary: '执行授权或运行配置已变更，当前派工已中断；核对后重新授权。' }); return; }
        if (result.status === 'ready' && result.changes?.length) {
          if (hasOutstandingInputs(current)) result = { ...result, status: 'blocked', summary: result.summary.slice(0, 31900) + '\n本轮仍有补充信息待处理，修改保留在 Worker，核对后可重新授权交付。' };
          else if (!claim.ticket.mandate.allowed.push || !claim.settings.github.enabled) result = { ...result, status: 'blocked', summary: result.summary.slice(0, 31900) + '\n代码变更已保留在独立 Worker；GitHub 交付未授权。' };
          else {
            // Record the external write boundary before starting. A network
            // ambiguity never causes automatic repeat of a GitHub mutation.
            await this.store.note(claim.ticket.id, 'delivery_started', '开始创建分支与草稿 PR；异常时需核对 GitHub。');
            const delivery = this.factories.deliveryFactory({ repository: claim.settings.repository, token: this.env.SUPERAGENT_GITHUB_TOKEN, signal: controller.signal, beforeWrite: () => this.store.assertDelivery(claim.ticket.id, claim.assignmentId, claim.ticket.mandate.policyVersion) });
            await this.store.assertDelivery(claim.ticket.id, claim.assignmentId, claim.ticket.mandate.policyVersion);
            const published = await delivery.publishChanges({ ticketId: claim.ticket.id, baseCommit: result.baseCommit, baseBranch: claim.settings.github.baseBranch, expectedHead: current.deliveryHead, changes: result.changes, title: claim.ticket.title, body: `${result.summary}\n\n由豆蜂开发代理创建。请人工审查测试证据后决定合并。` });
            result = { ...result, prUrl: published.html_url || published.prUrl || published.url, ...(published.commitSha ? { deliveryHead: published.commitSha } : {}) };
          }
        }
        await this.store.report(claim.ticket.id, claim.assignmentId, result);
      } catch {
        await this.store.report(claim.ticket.id, claim.assignmentId, { status: 'blocked', summary: controller.signal.aborted ? '执行被中断；请核对独立 Worker 状态后继续。' : 'Worker 或交付阶段未完成。请核对独立工作目录、GitHub 分支和 PR 后重试，避免重复外部操作。' });
      } finally { entry.finishing = true; await entry.pumping; this.active.delete(claim.ticket.id); }
    })();
  }
  tick() {
    if (!this.running) return;
    this.tickFlight ??= this.tickOnce().finally(() => { this.tickFlight = null; });
    return this.tickFlight;
  }
  async tickOnce() {
    try {
      let state = await this.store.snapshot();
      if (Date.now() - this.healthCheckedAt > 30000) await this.checkWorker(state.settings);
      for (const id of this.active.keys()) this.pumpSteering(id);
      if (this.workerHealth.ready) for (let i = 0; this.running && i < state.settings.concurrency; i++) { const claim = await this.store.claim(this.owner); if (!claim) break; await this.run(claim); }
      if (this.running && !state.settings.paused) {
        const message = await this.store.claimOutbound(this.owner);
        if (message) {
          if (!this.running) { await this.store.finishOutbound(message.id, { ok: false, retryable: true }); return; }
          try {
            if (message.source === 'github') {
              const number = Number(message.conversationId.split('#').at(-1));
              await this.factories.deliveryFactory({ repository: state.settings.repository, token: this.env.SUPERAGENT_GITHUB_TOKEN, signal: this.lifetime.signal }).commentIssue(number, message.text);
            } else if (message.kind === 'card') {
              await this.stream.send({ ...message, beforeSend: () => this.store.assertCardDelivery(message.id) });
            } else await this.stream.send(message);
            await this.store.finishOutbound(message.id, { ok: true });
          } catch (error) { await this.store.finishOutbound(message.id, { ok: false, retryable: error.retryable, uncertain: error.uncertain }); }
        }
        if (this.running && state.settings.github.enabled && this.env.SUPERAGENT_GITHUB_TOKEN && Date.now() >= this.githubDue) {
          this.githubDue = Date.now() + 60000;
          try {
            const source = this.factories.githubFactory({ repository: state.settings.repository, token: this.env.SUPERAGENT_GITHUB_TOKEN, onEvent: e => this.store.githubEvent(e) });
            const result = await source.poll({ cursor: state.cursors.github, baseBranch: state.settings.github.baseBranch, pullNumbers: state.tickets.filter(t => t.prUrl).map(t => Number(t.prUrl.split('/').at(-1))).slice(0, 100) });
            await this.store.setCursor('github', result.cursor); this.healthState.github = { ready: true, message: '最近一次 GitHub 轮询成功。' };
          } catch { this.healthState.github = { ready: false, message: 'GitHub 轮询失败，游标保留，下一轮继续。' }; }
        }
        state = await this.store.snapshot();
        if (this.running && state.settings.model.enabled && state.settings.acceptMode !== 'off' && !this.evaluating.size) {
          const pending = [...state.tickets].reverse().find(t => t.status === 'observed' && !(t.lastEvaluation?.inputCount === t.inputs.length && t.lastEvaluation?.policyVersion === settingsVersion(state.settings)));
          if (pending) void this.evaluate(pending.id, state.revision).catch(() => {});
        }
      }
      this.healthState.runtime = { ready: true, message: '调度与持久化正常。' };
    } catch { this.healthState.runtime = { ready: false, message: '调度或状态读取失败，请检查本机记录后重试。' }; }
  }
}
