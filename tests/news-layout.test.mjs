import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { productVideoPython } from '../server/product-video.mjs';

const execute = promisify(execFile);
const renderer = fileURLToPath(new URL('../tools/news_video/render.py', import.meta.url));
const python = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('news_card_layout',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
font=module.ImageFont.truetype(module.font_path(),20)
results=[]
for item in json.loads(sys.argv[2]):
    rows=module.wrapped(item['text'],font,item['width'])
    results.append({'rows':rows,'widths':[font.getlength(row) for row in rows]})
print(json.dumps(results,ensure_ascii=False))`;
async function layout(t, cases) {
  try {
    const { stdout } = await execute(productVideoPython(), ['-c', python, renderer, JSON.stringify(cases)], { windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONUTF8: '1' } });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('本机未安装 Python，未执行字体排版检查。'); return null; }
    throw error;
  }
}

test('资讯价格、小数、百分比及常见单位跨行时保持完整，不改变标题', async t => {
  const tokens = ['7458 元', '3999.50万元', '20.5%', '24.8 英寸', '64GB', '12,345元', '25 万棵', '720×1280px'];
  const cases = tokens.map(token => ({ text: `${'前文'.repeat(6)}${token}继续`, width: 180 }));
  const values = await layout(t, cases); if (!values) return;
  for (const [index, item] of values.entries()) {
    assert.equal(item.rows.join(''), cases[index].text);
    assert.ok(item.rows.some(row => row.includes(tokens[index])), `${tokens[index]} 被拆开：${item.rows.join('|')}`);
    assert.ok(item.widths.every(width => width <= cases[index].width));
  }
});

test('英文型号尽量整体换行，显式换行和空行保留', async t => {
  const values = await layout(t, [{ text: '前文前文前文AirPods继续', width: 140 }, { text: '甲\n7458 元\n\n乙', width: 180 }]); if (!values) return;
  assert.ok(values[0].rows.some(row => row.includes('AirPods')));
  assert.equal(values[0].rows.join(''), '前文前文前文AirPods继续');
  assert.deepEqual(values[1].rows, ['甲', '7458 元', '', '乙']);
});

test('无法整行容纳的超长数字与英文串按实际字宽拆分，既不截断也不溢出', async t => {
  const cases = [{ text: `开头${'1234567890'.repeat(15)}元结尾`, width: 120 }, { text: 'extraordinarilylongmodelidentifier'.repeat(5), width: 120 }];
  const values = await layout(t, cases); if (!values) return;
  for (const [index, item] of values.entries()) {
    assert.equal(item.rows.join(''), cases[index].text);
    assert.ok(item.rows.length > 2);
    assert.ok(item.widths.every(width => width <= cases[index].width));
  }
});

test('真实验收标题的7458不再被拆开，完整标题仍可放入图卡', async t => {
  const title = 'iPhone 17 Pro 京东 7458 元国补直降,AirPods 5 限时 755 元探底继续';
  const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('news_card_layout',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
font,rows,advance=module.fitted(sys.argv[2],module.font_path(),600,534,54,34,14)
print(json.dumps({'rows':rows,'widths':[font.getlength(row) for row in rows],'height':len(rows)*advance},ensure_ascii=False))`;
  const { stdout } = await execute(productVideoPython(), ['-c', code, renderer, title], { windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONUTF8: '1' } });
  const value = JSON.parse(stdout);
  assert.equal(value.rows.join(''), title); assert.ok(value.rows.some(row => row.includes('7458 元')));
  assert.ok(value.rows.some(row => row.includes('755 元'))); assert.ok(value.widths.every(width => width <= 600)); assert.ok(value.height <= 534);
});
