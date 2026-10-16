import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BilibiliWorkflow, readJson } from '../server/bilibili-workflow.mjs';

const help = `B 站发布流程记录（仅本地操作，不会打开浏览器、批准或发布视频）

node scripts/bilibili-workflow.mjs prepare --manifest <清单.json>
node scripts/bilibili-workflow.mjs list
node scripts/bilibili-workflow.mjs show --id <任务ID>
node scripts/bilibili-workflow.mjs begin-submit --id <任务ID> --account-name <当前账号名> --browser-id <当前实例> --authorization <已有用户授权说明> --evidence <提交前截图>
node scripts/bilibili-workflow.mjs finish --id <任务ID> --status <submitted|published|uncertain> --url <视频链接> --evidence <结果截图> --note <可见结果>
node scripts/bilibili-workflow.mjs abandon --id <任务ID> --note <原因>
node scripts/bilibili-workflow.mjs confirm-not-submitted --id <任务ID> --authorization <用户确认未投稿的说明> --evidence <平台核实截图> --note <核实结果>
node scripts/bilibili-workflow.mjs import-receipt --file <已核实回执.json>

可选：--account-uid <可见UID>；--data-dir <记录目录>。
默认记录目录：runtime/bilibili-publish；设置 DOUFENG_DATA_DIR 时使用其下的 bilibili-publish，--data-dir 优先。submitting / uncertain 不自动回退或重试。
先阅读 references/bilibili-publish-flow.md；填写授权说明不代表用户已授权。`;

try {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
    'manifest', 'id', 'account-name', 'account-uid', 'browser-id', 'authorization', 'evidence', 'status', 'url', 'note', 'file', 'data-dir',
  ].map(key => [key, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
  const command = positionals[0];
  if (v.help || !command) { console.log(help); }
  else {
    if (positionals.length !== 1) throw new Error('仅接受一个子命令。路径和文字参数请使用引号。');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const runtimeDir = resolve(process.env.DOUFENG_DATA_DIR || resolve(root, 'runtime'));
    const workflow = new BilibiliWorkflow(v['data-dir'] ? resolve(v['data-dir']) : resolve(runtimeDir, 'bilibili-publish'));
    let result;
    if (command === 'prepare') result = await workflow.prepare(await readJson(v.manifest || ''));
    else if (command === 'list') result = await workflow.list();
    else if (command === 'show') result = await workflow.show(v.id);
    else if (command === 'begin-submit') result = await workflow.beginSubmit(v.id, { accountName: v['account-name'], accountUid: v['account-uid'], browserId: v['browser-id'], authorization: v.authorization, evidence: v.evidence });
    else if (command === 'finish') result = await workflow.finish(v.id, { status: v.status, url: v.url, evidence: v.evidence, note: v.note });
    else if (command === 'abandon') result = await workflow.abandon(v.id, v.note);
    else if (command === 'confirm-not-submitted') result = await workflow.confirmNotSubmitted(v.id, { authorization: v.authorization, evidence: v.evidence, note: v.note });
    else if (command === 'import-receipt') result = await workflow.importReceipt(await readJson(v.file || ''));
    else throw new Error(`未知命令：${command}。使用 --help 查看用法。`);
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: error.message }, null, 2));
  process.exitCode = 1;
}
