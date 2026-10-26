import { join, resolve } from 'node:path';
import { isAbsolute } from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { JsonStore } from '../workbuddy/connector/lib/json-store.mjs';
import { LocalTextGeneration } from './local-text-generation.mjs';
import { TaskRunner } from './task-runner.mjs';
import { ContentAutomation } from './content-automation.mjs';
import { MediaAutomation } from './media-automation.mjs';
import { BilibiliTracking } from './bilibili-tracking.mjs';
import { runtimeBackupHandler } from './runtime-backup.mjs';
import { LegacyJobBridge } from './legacy-job-bridge.mjs';
import { distributionHandler } from './distribution-preparation.mjs';
import { operationsCatalog } from './operations-catalog.mjs';
import { assertDouyinVideoDraft } from '../shared/publish-target.mjs';
import { validateNewsSettings } from './news-source.mjs';

const problem = (message, status = 400) => Object.assign(new Error(message), { status, code: 'requires_action' });
export class OperationsService {
  constructor(runtimeDir, { workspace, automation, dailyProduction, tracking, jobsStore, content, media, bilibili } = {}) {
    Object.assign(this, { runtimeDir, workspace, automation, dailyProduction, tracking });
    this.content = content || new ContentAutomation(runtimeDir, { workspace, publisher: automation.publisher, tracking });
    this.media = media || new MediaAutomation(runtimeDir, { workspace });
    this.bilibili = bilibili || new BilibiliTracking(runtimeDir, { workspace });
    this.text = new LocalTextGeneration(runtimeDir, { workspace, content: this.content, getBinding: () => this.binding() });
    this.settings = new JsonStore(join(runtimeDir, 'operations', 'settings.json'), { wanDepsDir: '' });
    const contentHandlers = Object.fromEntries(Object.entries(this.content.handlers()).map(([kind, handler]) => [`content.${kind}`, {
      ...handler, execute: async (input, context) => {
        const binding = await this.binding();
        return handler.execute({ ...binding, ...input }, context);
      },
    }]));
    const backup = runtimeBackupHandler(runtimeDir);
    const backupDir = join(resolve(runtimeDir, '..'), '.runtime-backups');
    const handlers = { ...contentHandlers, ...this.media.handlers(), ...this.bilibili.handlers(), ...this.text.handlers(),
      'backup.full': { ...backup, validate: input => backup.validate({ ...input, backupDir: input.backupDir || backupDir }) },
      'distribution.prepare': distributionHandler(runtimeDir, workspace),
      'workflow.news': this.workflowHandler('news'), 'workflow.product': this.workflowHandler('product'),
    };
    this.runner = new TaskRunner(runtimeDir, { handlers });
    if (jobsStore) this.legacy = new LegacyJobBridge({ jobsStore, runner: this.runner, getBinding: () => this.binding() });
  }
  async binding() {
    const { value } = await this.dailyProduction.store.read();
    return { ...(value.config.browserId ? { browserId: value.config.browserId } : {}), ...(value.config.accountId ? { accountId: value.config.accountId } : {}) };
  }
  workflowHandler(kind) {
    return { readOnly: true,
      validate(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['feedUrl', 'keywords', 'productId', 'platform', 'enqueue'].includes(k))) throw problem('生产流程参数无效。');
        if (input.platform && !['douyin', 'bilibili'].includes(input.platform)) throw problem('请选择抖音或B站草稿。');
        if (input.enqueue !== undefined && typeof input.enqueue !== 'boolean') throw problem('入队选项无效。');
        if (input.enqueue && input.platform === 'bilibili') throw problem('B站草稿不能加入抖音自动发布队列。');
        if (kind === 'product' && (typeof input.productId !== 'string' || !input.productId)) throw problem('请选择商品。');
        return { ...(kind === 'news' ? validateNewsSettings(input) : { productId: input.productId }), platform: input.platform || 'douyin', enqueue: input.enqueue === true };
      },
      execute: async (input, context) => {
        let research, ideas, items;
        if (kind === 'news') {
          research = await this.content.run('research', { feedUrl: input.feedUrl, keywords: input.keywords, limit: 3 }, context);
          if (research.status !== 'completed') return research;
          items = research.output.articles;
          if (!items?.length) return { status: 'requires_action', output: { summary: '来源中没有可制作的近期资讯。', research: research.output } };
          ideas = await this.content.run('ideas', { researchIds: research.output.ids, limit: 3 }, context);
          if (ideas.status !== 'completed') return ideas;
        }
        await context.reportProgress?.({ message: '正在制作并校验本地成片。' });
        const output = await this.media.handlers()[`media.${kind}`].execute(kind === 'news' ? { items, platform: input.platform } : { productId: input.productId, platform: input.platform }, context);
        if (output.status !== 'completed') return output;
        let queued = null;
        if (input.enqueue) {
          if (context.signal?.aborted) throw Object.assign(new Error('已取消，成片已保留。'), { code: 'cancelled' });
          const draft = (await this.workspace.read()).value.drafts.find(row => row.id === output.output.draftId);
          if (!draft) throw problem('成片已生成，但草稿未找到。');
          assertDouyinVideoDraft(draft);
          const queue = await this.automation.snapshot();
          queued = await this.automation.importDraft({ draftId: draft.id, asset: draft.asset, title: draft.pubTitle || draft.title, caption: draft.caption, tags: draft.hashtags || draft.topics }, queue.revision);
        }
        return { status: 'completed', output: { ...output.output, summary: input.enqueue ? '采集与制作完成，成片已进入待审批队列。' : '采集与制作完成，成片和待检查草稿已归档。', researchIds: research?.output.ids || [], ideaIds: ideas?.output.ids || [], queue: queued, publicationSubmitted: false } };
      },
    };
  }
  async snapshot() {
    const [state, wb, bili, settings] = await Promise.all([this.runner.snapshot(), this.workspace.read(), this.bilibili.snapshot(), this.settings.read()]);
    const kinds = new Map(state.kinds.map(row => [row.kind, row]));
    return { ...state, catalog: operationsCatalog.filter(row => kinds.has(row.kind)).map(row => ({ ...row, recurring: kinds.get(row.kind).readOnly && row.recurring !== false })),
      products: wb.value.products.map(p => ({ id: p.id, title: p.title, imageCount: p.images?.length || 0 })),
      drafts: wb.value.drafts.map(d => ({ id: d.id, title: d.pubTitle || d.title, platform: d.platform || 'douyin', format: d.format || '视频', asset: d.asset || '' })),
      bilibili: bili, settings: settings.value, settingsRevision: settings.revision, legacy: this.legacy ? { error: this.legacy.lastError || '' } : null,
    };
  }
  async configure(input, revision) {
    if (!input || Object.keys(input).some(key => key !== 'wanDepsDir') || typeof input.wanDepsDir !== 'string') throw problem('制作设置只接受本机 Wan 依赖目录。');
    let path = input.wanDepsDir.trim();
    if (path) {
      if (!isAbsolute(path) || /^\\\\/.test(path)) throw problem('依赖目录必须为本机绝对路径。');
      path = await realpath(path);
      if (/^\\\\/.test(path)) throw problem('依赖目录不能使用网络共享。');
      await access(join(path, 'gradio_client', '__init__.py'));
    }
    await this.settings.replace({ wanDepsDir: path }, revision);
    this.media.depsDir = path || process.env.DOUFENG_WAN_DEPS || '';
    return this.snapshot();
  }
  async environment() { const [media, text] = await Promise.all([this.media.readiness(), this.text.readiness()]); return { media, text }; }
  async start() { const config = await this.settings.read(); if (config.value.wanDepsDir) this.media.depsDir = config.value.wanDepsDir; await this.runner.start(); await this.legacy?.start(); }
  async stop() { await this.legacy?.stop(); await this.runner.stop(); }
}
