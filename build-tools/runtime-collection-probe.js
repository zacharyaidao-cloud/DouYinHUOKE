'use strict';
// Diagnose retained pagination variants and visible scroll containers without
// clicking, scrolling, requesting platform data or reading comment/user text.
exports.inspect = async accountId => {
  const r = process.mainModule.require.bind(process.mainModule), engine = r('./engine.js'), playwright = r('playwright-core');
  const contexts = [...playwright.chromium._contexts];
  if (engine.taskState.accountId !== accountId || contexts.length !== 1 || contexts[0].pages().length !== 1) throw new Error('Account context changed');
  const context = contexts[0], page = context.pages()[0], targetId = String(engine.taskState.currentWork?.id || '');
  if (!/^\d{1,24}$/.test(targetId)) throw new Error('Missing current work');
  const responses = [...context._connection._objects.values()].filter(item => {
    try {
      const u = new URL(item.url());
      return item._type === 'Response' && u.protocol === 'https:' && ['www.douyin.com', 'douyin.com'].includes(u.hostname)
        && u.pathname === '/aweme/v1/web/comment/list/' && u.searchParams.get('aweme_id') === targetId && item.frame().page() === page;
    } catch (_) { return false; }
  }).slice(-20);
  const facts = [];
  for (const response of responses) {
    const u = new URL(response.url()), params = {};
    for (const key of ['cursor', 'count', 'sort_type', 'item_type', 'aweme_type', 'comment_type', 'channel', 'tab', 'source', 'pc_img_format']) {
      const value = u.searchParams.get(key); if (value !== null) params[key] = value.slice(0, 80);
    }
    const base = { httpStatus: response.status(), params, parameterNames: [...u.searchParams.keys()] };
    let timer;
    try {
      const body = await Promise.race([response.body(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read timeout')), 1000); })]);
      if (body.length > 2 * 1024 * 1024) { facts.push({ ...base, tooLarge: true }); continue; }
      const j = JSON.parse(body.toString('utf8'));
      facts.push({ ...base, status_code: j.status_code, has_more: j.has_more, total: j.total, cursor: j.cursor,
        commentsShape: !Object.hasOwn(j, 'comments') ? 'missing' : j.comments === null ? 'null' : Array.isArray(j.comments) ? 'array' : typeof j.comments,
        ...(Array.isArray(j.comments) ? { commentsCount: j.comments.length, cidCount: new Set(j.comments.map(c => c?.cid).filter(Boolean)).size } : {}) });
    } catch (_) { facts.push({ ...base, unreadable: true }); }
    finally { clearTimeout(timer); }
  }
  const dom = await page.evaluate(() => {
    const visible = e => !!e.getClientRects().length && !e.closest('[hidden],[aria-hidden="true"]') && !['none'].includes(getComputedStyle(e).display) && getComputedStyle(e).visibility !== 'hidden';
    const selector = '[data-e2e="comment-list"],[data-e2e="comment-list-container"],[data-e2e="comment-panel"],[data-e2e="comment-area"],[data-e2e="comment-content"],[class*="commentList"],[class*="CommentList"],[class*="comment-list"],[role="tabpanel"][id*="comment"],[role="region"][aria-label="评论"]';
    const markers = '[data-e2e="comment-item"],[data-e2e="comment-level-1"],[class*="commentItem"],[class*="CommentItem"]';
    const regions = [...document.querySelectorAll(selector)].map((e, index) => {
      const ancestors = []; let p = e;
      for (let i = 0; p && p !== document.body && i < 8; i++, p = p.parentElement) {
        const s = getComputedStyle(p), box = p.getBoundingClientRect();
        ancestors.push({ tag: p.tagName, e2e: p.getAttribute('data-e2e'), role: p.getAttribute('role'), visible: visible(p), overflowY: s.overflowY,
          clientHeight: p.clientHeight, scrollHeight: p.scrollHeight, scrollTop: p.scrollTop, x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) });
      }
      return { index, visible: visible(e), markers: e.querySelectorAll(markers).length, ancestors };
    }).slice(0, 12);
    return { readyState: document.readyState, commentMarkers: document.querySelectorAll(markers).length, regions };
  });
  return { at: new Date().toISOString(), running: engine.taskState.running, stage: engine.taskState.stage, currentWork: engine.taskState.currentWork, responses: facts, dom };
};
