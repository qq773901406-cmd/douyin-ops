import { parseArgs } from 'node:util';
import { handoff, readJson } from '../lib/jimeng-publish-handoff.mjs';

const help = `即梦成片验收与正式抖音队列交接

node scripts/jimeng-publish-handoff.mjs inspect --manifest <完整路径.json>
node scripts/jimeng-publish-handoff.mjs enqueue --manifest <完整路径.json>

省略子命令时默认为只读 inspect。仅显式 enqueue 会创建草稿、批准同一成片并启用正式发布调度。
--base-url 默认为 http://127.0.0.1:4174，仅接受本机 HTTP 地址。
缺少完整成片、真实哈希、四个源片、验收报告或本条用户授权时阻止交接。
enqueue 不执行网页发布；真实提交仍由 AutomationService / DouyinPublisher 负责。`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { manifest: { type: 'string' }, 'base-url': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log(help);
  else {
    if (!values.manifest || positionals.length > 1) throw new Error('需要 --manifest <完整路径.json>；使用 --help 查看说明。');
    const result = await handoff(await readJson(values.manifest), { command: positionals[0] || 'inspect', ...(values['base-url'] ? { baseURL: values['base-url'] } : {}) });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (problem) {
  console.error(JSON.stringify({ ok: false, status: problem.uncertain ? 'uncertain' : 'blocked', message: problem.message }, null, 2));
  process.exitCode = problem.uncertain ? 3 : 2;
}
