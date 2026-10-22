// Fixed read-only inspection of controls observed in the creator editor.
export function inspectPublishSettingsDOM() {
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => String(el?.innerText || el?.textContent || '').trim();
  const nodes = (root, query) => [...root.querySelectorAll(query)].filter(visible);
  const one = values => values.length === 1 ? values[0] : null;
  const selector = el => {
    if (!el) return null;
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter(s => s.tagName === node.tagName) : [node];
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
      if (node.tagName === 'BODY') break;
    }
    return parts.join(' > ');
  };
  const button = (root, label) => one(nodes(root, 'button').filter(el => text(el) === label && !el.disabled && el.getAttribute('aria-disabled') !== 'true'));
  const checked = el => !!el && (el.classList.contains('semi-radio-checked') || !!el.querySelector('input:checked') || el.getAttribute('aria-checked') === 'true');
  const covers = {};
  for (const [name, label] of [['vertical', '竖封面3:4'], ['horizontal', '横封面4:3']]) {
    const control = one(nodes(document, 'div[class*="coverControl-"]').filter(el => nodes(el, 'div[class*="cover-tip-"]').some(tip => text(tip) === label)));
    if (!control) { covers[name] = null; continue; }
    const surface = one(nodes(control, 'div[class*="cover-"]').filter(el => el.parentElement === control));
    const background = one(nodes(control, 'div[class*="background-"]'));
    const editLabels = [...control.querySelectorAll('div[class*="title-"]')].filter(el => text(el) === '编辑封面');
    const image = background && one(nodes(background, 'img'));
    covers[name] = { entry: selector(surface), saved: !!background && ![...background.classList].some(name => name.startsWith('filter-')) && editLabels.length === 1 && !!image?.complete && image.naturalWidth > 0 };
  }
  const dialogs = nodes(document, '[role="dialog"]');
  const coverEditors = dialogs.filter(el => nodes(el, 'div[class*="steps-"]').length === 1);
  const editor = one(coverEditors);
  const prompts = dialogs.filter(el => text(el).includes('设置横封面获更多流量'));
  const prompt = one(prompts);
  const step = editor && one(nodes(editor, 'div[class*="step-active-"]'));
  const orientation = text(step) === '设置竖封面' ? 'vertical' : text(step) === '设置横封面' ? 'horizontal' : '';
  const canvas = editor && one(nodes(editor, 'canvas').filter(el => el.getAttribute('id') === `${orientation}_coverCanvas`));
  const frames = editor ? nodes(editor, 'div[class*="preview-frame-"]') : [];
  const coverDialog = editor ? {
    orientation, frameReady: !!orientation && !!canvas && canvas.width > 0 && canvas.height > 0 && frames.some(el => /^url\(/.test(getComputedStyle(el).backgroundImage || '')),
    complete: selector(button(editor, '完成')),
    horizontal: selector(button(editor, '设置横封面'))
  } : null;
  const declarationEntry = one(nodes(document, 'div[class*="selectText-"]'));
  const repost = one(nodes(document, 'label').filter(el => text(el) === '内容为转载信息'));
  const external = one(nodes(document, 'label').filter(el => text(el) === '取材站外'));
  const declarationOpen = !!repost;
  const choiceLabels = nodes(document, 'label').filter(el => el.querySelector('input:checked') || checked(el)).map(text);
  return {
    covers, coverDialog, coverPrompt: prompt ? { horizontal: selector(button(prompt, '设置横封面')) } : null,
    unexpectedDialogs: dialogs.length - coverEditors.length - prompts.length,
    ambiguous: coverEditors.length > 1 || prompts.length > 1,
    declaration: {
      entry: selector(declarationEntry), value: text(declarationEntry), open: declarationOpen,
      repost: repost ? { selector: selector(repost), checked: checked(repost) } : null,
      external: external ? { selector: selector(external), checked: checked(external) } : null,
      confirm: declarationOpen ? selector(button(document, '确定')) : null
    },
    noCrosspost: choiceLabels.some(value => value === '不同时发布') && !choiceLabels.some(value => value === '同时发布到')
  };
}

export function validatePublicationSettings(page, approval, prepared) {
  const settings = page.settings;
  if (!settings || settings.ambiguous || settings.unexpectedDialogs || settings.coverDialog || settings.coverPrompt || settings.declaration?.open) throw new Error('发布设置尚未完成或有未识别的弹窗，已停止。');
  if (!settings.covers?.vertical?.saved || !settings.covers?.horizontal?.saved) throw new Error('无法确认横、竖封面均已保存，已停止。');
  if (!settings.noCrosspost) throw new Error('无法确认页面已选择不同时发布，已停止。');
  if (approval.contentDeclaration === 'external-source' && (prepared?.contentDeclaration !== 'external-source' || settings.declaration?.value !== '内容为转载信息')) throw new Error('站外来源声明未完成，已停止。');
}

export async function preparePublicationSettings(publisher, session, approval, guard = async () => {}) {
  if (approval.contentDeclaration && approval.contentDeclaration !== 'external-source') throw new Error('尚不支持此自主声明策略，已停止。');
  const safe = page => {
    if (!/\/creator-micro\/content\/(?:post\/video|publish)(?:[/?#]|$)/.test(page.url) || !page.settings || page.settings.ambiguous || page.settings.unexpectedDialogs) throw new Error('无法唯一识别当前发布设置，已停止。');
    return page;
  };
  const read = async () => { await guard(); return safe(await publisher.page(session)); };
  const click = async target => {
    if (!target) throw new Error('无法唯一识别发布设置控件，已停止。');
    await guard(); await publisher.command(['click', '--selector', target, '--session', session]);
  };
  const wait = async condition => publisher.waitPage(session, page => { safe(page); return condition(page.settings); }, guard);
  let page = await read();
  if (!page.settings.noCrosspost) throw new Error('无法确认页面已选择不同时发布，已停止。');
  const existingCovers = !!page.settings.covers.vertical?.saved && !!page.settings.covers.horizontal?.saved;
  if (!page.settings.covers.vertical?.saved || !page.settings.covers.horizontal?.saved) {
    if (page.settings.declaration.open) throw new Error('请先关闭自主声明弹窗，已停止。');
    if (!page.settings.coverDialog) {
      await click(page.settings.covers.vertical?.entry);
      page = await wait(settings => !!settings.coverDialog?.frameReady);
    }
    if (page.settings.coverPrompt) {
      await click(page.settings.coverPrompt.horizontal);
      page = await wait(settings => !settings.coverPrompt && settings.coverDialog?.orientation === 'horizontal' && settings.coverDialog.frameReady);
    } else if (page.settings.coverDialog.orientation === 'vertical') {
      if (!page.settings.coverDialog.frameReady) page = await wait(settings => settings.coverDialog?.orientation === 'vertical' && settings.coverDialog.frameReady);
      await click(page.settings.coverDialog.horizontal);
      page = await wait(settings => settings.coverDialog?.orientation === 'horizontal' && settings.coverDialog.frameReady || !!settings.coverPrompt);
      if (page.settings.coverPrompt) {
        await click(page.settings.coverPrompt.horizontal);
        page = await wait(settings => !settings.coverPrompt && settings.coverDialog?.orientation === 'horizontal' && settings.coverDialog.frameReady);
      }
    }
    if (page.settings.coverDialog?.orientation !== 'horizontal') throw new Error('无法确认横封面编辑状态，已停止。');
    if (!page.settings.coverDialog.frameReady) page = await wait(settings => settings.coverDialog?.orientation === 'horizontal' && settings.coverDialog.frameReady);
    await click(page.settings.coverDialog.complete);
    page = await wait(settings => !settings.coverDialog && !settings.coverPrompt && settings.covers.vertical?.saved && settings.covers.horizontal?.saved);
  }
  const prepared = { covers: existingCovers ? 'confirmed-existing' : 'video-frame', contentDeclaration: '' };
  if (approval.contentDeclaration === 'external-source') {
    // Open even when the summary already says repost: only the dialog exposes
    // whether the source is outside Douyin. Do not infer that from the caption.
    if (!page.settings.declaration.open) {
      await click(page.settings.declaration.entry);
      page = await wait(settings => settings.declaration.open);
    }
    if (!page.settings.declaration.repost?.checked) {
      await click(page.settings.declaration.repost?.selector);
      page = await wait(settings => settings.declaration.repost?.checked && !!settings.declaration.external);
    }
    if (!page.settings.declaration.external?.checked) {
      await click(page.settings.declaration.external?.selector);
      page = await wait(settings => settings.declaration.repost?.checked && settings.declaration.external?.checked);
    }
    if (!page.settings.declaration.repost?.checked || !page.settings.declaration.external?.checked) throw new Error('无法确认取材站外已选中，已停止。');
    await click(page.settings.declaration.confirm);
    page = await wait(settings => !settings.declaration.open && settings.declaration.value === '内容为转载信息');
    prepared.contentDeclaration = 'external-source';
  }
  validatePublicationSettings(page, approval, prepared);
  return { ...prepared, verticalCoverSaved: true, horizontalCoverSaved: true, noCrosspost: true, checkedAt: new Date().toISOString() };
}
