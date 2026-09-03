# DY 通用提取模板

## 基础 Evaluate 模板

```js
() => {
  const pickText = (el, sels) => {
    for (const s of sels) {
      const v = el.querySelector?.(s)?.textContent?.trim();
      if (v) return v;
    }
    return '';
  };

  const num = (v) => {
    const m = String(v || '')
      .replace(/,/g, '')
      .match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  };

  return [...document.querySelectorAll('[data-e2e="feed-active-video"], [class*="video-item"], [class*="card"], li, [data-item]')]
    .slice(0, 20)
    .map((el) => ({
      title: pickText(el, ['[data-e2e="video-desc"]', '.title', '.note-title', 'h1', 'h2', 'h3']),
      hook: pickText(el, ['.desc', '.description', '.summary', '.intro', '[data-e2e="video-desc"] span']),
      author: pickText(el, ['[data-e2e="video-author-nickname"]', '.author', '.user-name', '[class*="author"]']),
      likes: num(pickText(el, ['[data-e2e="like-count"]', '.like-count', '.likes', '[class*="like"] span'])),
      comments: num(pickText(el, ['[data-e2e="comment-count"]', '.comment-count', '.comments', '[class*="comment"] span'])),
      shares: num(pickText(el, ['[data-e2e="share-count"]', '.share-count', '[class*="share"] span'])),
      tags: pickText(el, ['[data-e2e="video-tag"]', '.tag-list', '.tags', 'a[href*="/hashtag/"]']),
    }))
    .filter(x => x.title || x.hook);
}
```

## 视频详情页提取模板

```js
() => {
  const pickText = (sel) => {
    const el = document.querySelector(sel);
    return el?.textContent?.trim() || '';
  };

  const num = (v) => {
    const m = String(v || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  };

  return {
    title: pickText('[data-e2e="video-desc"]') || pickText('.title'),
    author: pickText('[data-e2e="video-author-nickname"]') || pickText('.author'),
    likes: num(pickText('[data-e2e="like-count"]') || pickText('.like-count')),
    comments: num(pickText('[data-e2e="comment-count"]') || pickText('.comment-count')),
    shares: num(pickText('[data-e2e="share-count"]') || pickText('.share-count')),
    collects: num(pickText('[data-e2e="collect-count"]') || pickText('.collect-count')),
    tags: [...document.querySelectorAll('[data-e2e="video-tag"], a[href*="/hashtag/"]')]
      .map(el => el.textContent.trim())
      .filter(Boolean),
    coverUrl: document.querySelector('meta[property="og:image"]')?.content ||
              document.querySelector('video')?.poster || '',
  };
}
```

## 账号主页提取模板

```js
() => {
  const pickText = (sel) => {
    const el = document.querySelector(sel);
    return el?.textContent?.trim() || '';
  };

  const num = (v) => {
    const m = String(v || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  };

  const videos = [...document.querySelectorAll('[data-e2e="user-post-list"] [class*="video"], [class*="video-list"] [class*="item"]')]
    .slice(0, 15)
    .map((el) => ({
      title: el.querySelector('[class*="title"], [class*="desc"]')?.textContent?.trim() || '',
      plays: num(el.querySelector('[class*="play"], [class*="count"]')?.textContent?.trim() || ''),
    }));

  return {
    nickname: pickText('[data-e2e="user-info-nickname"]') || pickText('[class*="nickname"]'),
    uniqueId: pickText('[data-e2e="user-info-unique-id"]') || pickText('[class*="unique-id"]'),
    desc: pickText('[data-e2e="user-info-desc"]') || pickText('[class*="desc"]'),
    fans: num(pickText('[data-e2e="user-info-fans-count"]') || pickText('[class*="fans"]')),
    follow: num(pickText('[data-e2e="user-info-follow-count"]') || pickText('[class*="follow"]')),
    likes: num(pickText('[data-e2e="user-info-like-count"]') || pickText('[class*="like"]')),
    recentVideos: videos,
  };
}
```

## 使用建议

- 先确认字段存在；缺失返回空字符串，避免脚本失败。
- 先做 20 条以内试跑，再扩大样本规模。
- 抖音页面使用 `data-e2e` 属性作为主要 selector，较 class 名更稳定。
- 需复用时可按页面结构调整 selector，参考 `dy-selectors.md`。
- 抖音 SPA 架构下页面可能动态加载，`openclaw browser evaluate` 前确认内容已渲染。
- 所有 JS 模板通过 `openclaw browser evaluate <js_function>` 执行，详见 `dy-openclaw-browser-guide.md` §2.4。
