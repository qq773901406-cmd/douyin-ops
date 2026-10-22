import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { inspectPublishSettingsDOM, preparePublicationSettings, validatePublicationSettings } from '../server/douyin-publish-settings.mjs';

// Minimal DOM fixture for the observed native controls; no browser or network.
function element(tag, { text = '', classes = '', hidden = false, checked = false, disabled = false, attrs = {}, complete = true, naturalWidth = 100, width = 0, height = 0, backgroundImage = '' } = {}, children = []) {
  const classList = classes.split(' ').filter(Boolean);
  classList.contains = value => classList.includes(value);
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), classList, hidden, checked, disabled, complete, naturalWidth, width, height, backgroundImage, children,
    get innerText() { return this.hidden ? '' : (text || children.map(child => child.innerText).join('')); },
    get textContent() { return text || children.map(child => child.textContent).join(''); },
    getClientRects() { return this.hidden || this.parentElement && !this.parentElement.getClientRects().length ? [] : [{}]; },
    getAttribute(name) { return attrs[name] ?? null; },
    querySelectorAll(query) {
      const match = candidate => {
        if (query === 'input:checked') return candidate.tagName === 'INPUT' && candidate.checked;
        if (query === '[role="dialog"]') return candidate.getAttribute('role') === 'dialog';
        const css = query.match(/^div\[class\*="([^"]+)"\]$/);
        if (css) return candidate.tagName === 'DIV' && candidate.classList.join(' ').includes(css[1]);
        return candidate.tagName === query.toUpperCase();
      };
      const descendants = children.flatMap(child => [child, ...child.descendants()]);
      return descendants.filter(match);
    },
    querySelector(query) { return this.querySelectorAll(query)[0] || null; },
    descendants() { return children.flatMap(child => [child, ...child.descendants()]); }
  };
  children.forEach(child => { child.parentElement = node; });
  return node;
}
function cover(label, saved, loaded = true) {
  return element('div', { classes: 'coverControl-fixture' }, [
    element('div', { classes: 'cover-fixture' }, [
      element('div', { classes: `background-fixture${saved ? '' : ' filter-fixture'}` }, [element('img', { complete: loaded, naturalWidth: loaded ? 100 : 0 })]),
      element('div', { classes: 'filter-fixture' }, [element('div', { classes: 'title-fixture', text: saved ? '编辑封面' : '选择封面', hidden: saved })])
    ]),
    element('div', { classes: 'controlContainer-fixture' }, [element('div', { classes: 'cover-tip-fixture', text: label })])
  ]);
}
function radio(label, selected, hidden = false) {
  return element('label', { classes: selected ? 'semi-radio semi-radio-checked' : 'semi-radio', hidden }, [element('input', { attrs: { type: 'radio' } }), element('span', { text: label })]);
}
function inspect(children) {
  const body = element('body', {}, children);
  return runInNewContext(`(${inspectPublishSettingsDOM.toString()})()`, {
    document: body, getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', backgroundImage: node.backgroundImage })
  });
}

test('封面 DOM 区分默认预览和已保存封面，隐藏的编辑提示仍属于可见封面控件', () => {
  const unsaved = inspect([cover('竖封面3:4', false), cover('横封面4:3', false)]);
  assert.equal(unsaved.covers.vertical.saved, false);
  assert.equal(unsaved.covers.horizontal.saved, false);
  assert.equal(unsaved.covers.vertical.entry, 'body:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1)');
  const saved = inspect([cover('竖封面3:4', true), cover('横封面4:3', true)]);
  assert.equal(saved.covers.vertical.saved, true);
  assert.equal(saved.covers.horizontal.saved, true);
  assert.equal(inspect([cover('竖封面3:4', true, false)]).covers.vertical.saved, false);
  assert.equal(inspect([cover('竖封面3:4', true), cover('竖封面3:4', true)]).covers.vertical, null);
});

test('声明 DOM 读取实际选中样式，未选、隐藏或重复选项不会被认作站外来源', () => {
  const base = [element('div', { classes: 'selectText-fixture selected-fixture', text: '内容为转载信息' }), radio('内容为转载信息', true), element('button', { text: '确定' })];
  const selected = inspect([...base, radio('取材站外', true), element('label', { text: '不同时发布' }, [element('input', { checked: true })])]);
  assert.equal(selected.declaration.repost.checked, true);
  assert.equal(selected.declaration.external.checked, true);
  assert.equal(selected.declaration.open, true);
  assert.equal(selected.noCrosspost, true);
  assert.ok(selected.declaration.confirm);
  assert.equal(inspect([...base, radio('取材站外', false)]).declaration.external.checked, false);
  assert.equal(inspect([...base, radio('取材站外', true, true)]).declaration.external, null);
  assert.equal(inspect([...base, radio('取材站外', true), radio('取材站外', true)]).declaration.external, null);
});

test('封面弹窗只返回可用按钮并区分顶部步骤和横封面引导', () => {
  const editor = element('div', { attrs: { role: 'dialog' } }, [
    element('div', { classes: 'steps-fixture' }, [element('div', { classes: 'step-active-fixture', text: '设置竖封面' }), element('div', { text: '设置横封面' })]),
    element('button', { text: '设置横封面' }), element('button', { text: '完成', disabled: true }),
    element('canvas', { attrs: { id: 'vertical_coverCanvas' }, width: 596, height: 341 }),
    element('div', { classes: 'preview-frame-fixture', backgroundImage: 'url(blob:fixture)' })
  ]);
  const prompt = element('div', { attrs: { role: 'dialog' } }, [element('p', { text: '设置横封面获更多流量' }), element('button', { text: '设置横封面' })]);
  const result = inspect([editor, prompt]);
  assert.equal(result.coverDialog.orientation, 'vertical');
  assert.equal(result.coverDialog.frameReady, true);
  assert.ok(result.coverDialog.horizontal);
  assert.equal(result.coverDialog.complete, null);
  assert.ok(result.coverPrompt.horizontal);
  assert.equal(result.unexpectedDialogs, 0);
  assert.equal(inspect([editor, editor]).ambiguous, true);
  editor.querySelector('canvas').width = 0;
  assert.equal(inspect([editor]).coverDialog.frameReady, false);
});

function fixture({ prompt = false, alreadySaved = false, existingDeclaration = false } = {}) {
  const calls = [];
  const page = {
    url: 'https://creator.douyin.com/creator-micro/content/post/video',
    settings: {
      covers: { vertical: { saved: alreadySaved, entry: '#vertical' }, horizontal: { saved: alreadySaved, entry: '#horizontal' } },
      noCrosspost: true, coverDialog: null, coverPrompt: null, unexpectedDialogs: 0, ambiguous: false,
      declaration: { entry: '#declaration', value: existingDeclaration ? '内容为转载信息' : '请选择自主声明', open: false }
    }
  };
  const publisher = {
    page: async () => structuredClone(page),
    waitPage: async (_session, condition, guard) => { await guard(); assert.ok(condition(page), 'expected next visible state'); return structuredClone(page); },
    command: async args => {
      assert.equal(args[0], 'click');
      const target = args[args.indexOf('--selector') + 1]; calls.push(target);
      const settings = page.settings;
      if (target === '#vertical') settings.coverDialog = { orientation: 'vertical', frameReady: true, horizontal: '#next-horizontal', complete: '#unused-vertical-complete' };
      else if (target === '#next-horizontal') {
        if (prompt) settings.coverPrompt = { horizontal: '#confirm-horizontal' };
        else settings.coverDialog = { orientation: 'horizontal', frameReady: true, complete: '#complete' };
      } else if (target === '#confirm-horizontal') { settings.coverPrompt = null; settings.coverDialog = { orientation: 'horizontal', frameReady: true, complete: '#complete' }; }
      else if (target === '#complete') { settings.coverDialog = null; settings.covers.vertical.saved = settings.covers.horizontal.saved = true; }
      else if (target === '#declaration') Object.assign(settings.declaration, { open: true, repost: { selector: '#repost', checked: existingDeclaration }, external: existingDeclaration ? { selector: '#external', checked: false } : null, confirm: '#confirm' });
      else if (target === '#repost') { settings.declaration.repost.checked = true; settings.declaration.external = { selector: '#external', checked: false }; }
      else if (target === '#external') settings.declaration.external.checked = true;
      else if (target === '#confirm') { assert.equal(settings.declaration.external.checked, true); settings.declaration.open = false; settings.declaration.value = '内容为转载信息'; }
      else assert.fail(`Unexpected click ${target}`);
    }
  };
  return { page, publisher, calls };
}

test('预提交准备保存横竖封面及站外声明，整个流程从不点发布', async () => {
  for (const prompt of [false, true]) {
    const f = fixture({ prompt }); let guards = 0;
    const prepared = await preparePublicationSettings(f.publisher, 'owned', { contentDeclaration: 'external-source' }, async () => { guards++; });
    assert.equal(prepared.covers, 'video-frame');
    assert.equal(prepared.contentDeclaration, 'external-source');
    assert.equal(prepared.verticalCoverSaved, true); assert.equal(prepared.horizontalCoverSaved, true);
    assert.ok(Number.isFinite(Date.parse(prepared.checkedAt)));
    assert.deepEqual(f.calls, ['#vertical', '#next-horizontal', ...(prompt ? ['#confirm-horizontal'] : []), '#complete', '#declaration', '#repost', '#external', '#confirm']);
    assert.ok(guards > f.calls.length);
    assert.doesNotThrow(() => validatePublicationSettings(f.page, { contentDeclaration: 'external-source' }, prepared));
  }
});

test('已保存转载摘要仍重新核对站外选项，任意素材不会自动声明为转载', async () => {
  const f = fixture({ alreadySaved: true, existingDeclaration: true });
  await preparePublicationSettings(f.publisher, 'owned', { contentDeclaration: 'external-source' });
  assert.deepEqual(f.calls, ['#declaration', '#external', '#confirm']);
  const generic = fixture({ alreadySaved: true });
  await preparePublicationSettings(generic.publisher, 'owned', {});
  assert.deepEqual(generic.calls, []);
});

test('页面身份、来源策略、同时发布和未完成状态均在发布前拒绝', async () => {
  const f = fixture({ alreadySaved: true });
  await assert.rejects(preparePublicationSettings(f.publisher, 'owned', { contentDeclaration: 'unknown' }), /不支持/);
  f.page.settings.noCrosspost = false;
  await assert.rejects(preparePublicationSettings(f.publisher, 'owned', {}), /不同时发布/);
  f.page.settings.noCrosspost = true; f.page.url = 'https://creator.douyin.com/creator-micro/home';
  await assert.rejects(preparePublicationSettings(f.publisher, 'owned', {}), /无法唯一识别/);
  assert.deepEqual(f.calls, []);
  const ready = fixture({ alreadySaved: true }).page;
  assert.throws(() => validatePublicationSettings(ready, { contentDeclaration: 'external-source' }, {}), /站外来源声明/);
  ready.settings.covers.horizontal.saved = false;
  assert.throws(() => validatePublicationSettings(ready, {}, {}), /封面/);
  ready.settings.coverDialog = {};
  assert.throws(() => validatePublicationSettings(ready, {}, {}), /弹窗/);
});
