# DY 草稿保存与存草稿流程

用于把视频/图文放入抖音草稿状态。适用场景：用户要求"保存草稿""存草稿""暂存""只填发布页不要发"。

## 0. 安全原则

- 用户只要求草稿时，严禁点击「发布」。
- 目标不是"停在编辑页"，而是执行「存草稿」并确认草稿箱里出现对应草稿。
- 保存前后都要用 `openclaw browser snapshot` 或 `openclaw browser evaluate` 校验页面状态。
- 如果用户在页面上手动修改了内容，不要再次覆盖正文；只执行保存或核验。

## 1. 视频草稿流程

1. 打开创作服务平台 creator.douyin.com 发布页，进入「发布视频」。
2. 上传视频文件，等待上传完成（进度条到100%，出现封面选择界面）。
3. 选择/设置封面。
4. 填写标题/文案、描述、话题。
5. 如用户要求，可选择合集；否则不要擅自更改发布设置。
6. 核验：视频已上传、封面已选、标题描述已填、预览内容可见。
7. 点击「存草稿」按钮。
8. 核验：回到创作中心或草稿管理页，显示草稿数量增加，并能看到草稿标题和保存时间。

## 2. 图文草稿流程

1. 打开创作服务平台发布页，进入「图文发布」。
2. 上传图片。
3. 填写标题/文案、描述、话题。
4. 核验：图片数量、标题、描述、预览内容可见。
5. 点击「存草稿」按钮。
6. 核验：回到草稿管理页，显示草稿数量增加。

## 3. 上传路径注意

OpenClaw 不提供 `browser upload` 命令。文件上传通过标准流程实现（详见 `dy-openclaw-browser-guide.md` §3）：

- 上传白名单目录：WSL2/Linux/macOS：`/tmp/openclaw/uploads`；Windows 原生：`%LOCALAPPDATA%\openclaw\uploads`（若被拒绝改用 `D:\openclaw\media\inbound`）

流程：
1. 将待上传文件复制到白名单目录。
2. `openclaw browser snapshot` 获取上传区域 ref。
3. `openclaw browser act ref=<ref_id> kind=click` 点击上传区域触发文件选择器。
4. `POST /hooks/file-chooser` 设置文件路径，完成上传。

## 4. 「存草稿」按钮定位

抖音发布页的按钮可能使用自定义组件。推荐安全执行顺序：

1. 先 `openclaw browser snapshot` 确认页面底部按钮区域。
2. 确认存在「存草稿」和「发布」两个按钮。
3. 优先通过 `openclaw browser evaluate` 定位按钮文本：

```js
() => {
  const buttons = [...document.querySelectorAll('button, [role="button"], [class*="btn"]')];
  const draftBtn = buttons.find(b => b.textContent.includes('草稿') || b.textContent.includes('存'));
  const publishBtn = buttons.find(b => b.textContent.includes('发布') && !b.textContent.includes('草稿'));
  return {
    draftFound: !!draftBtn,
    draftText: draftBtn?.textContent?.trim(),
    draftDisabled: draftBtn?.disabled || draftBtn?.getAttribute('aria-disabled') === 'true',
    publishFound: !!publishBtn,
    publishText: publishBtn?.textContent?.trim(),
  };
}
```

4. 确认 draftFound=true 且 draftDisabled=false 后，点击「存草稿」按钮。
5. 点击后重新 snapshot，确认进入草稿管理页或出现"保存成功"提示。

如果按钮定位失败，不要猜测按钮坐标，提示用户手动点击「存草稿」。

## 5. 发布页状态判断

- "上传完成"只代表视频已上传，不等于草稿箱已保存。
- "发布按钮可见"只代表半程预发完成，不等于草稿。
- "草稿管理页显示对应标题 + 保存时间"才算草稿保存完成。

## 6. 用户手动修改时

如果用户已经在页面手动修改正文、话题、合集：
- 不要再用 `openclaw browser act kind=type` 覆盖正文。
- 先 snapshot 摘要当前内容。
- 只执行存草稿并核验草稿管理页。
- 本地记录应注明"用户已手动调整页面内容"，避免把本地稿误当最终稿。
