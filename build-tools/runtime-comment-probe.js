'use strict';
// Read retained response bodies through the app's existing browser connection.
// No request is replayed, no browser control is performed, no raw body is saved.
exports.inspect = async accountId => {
  const r = process.mainModule.require.bind(process.mainModule);
  const engine = r('./engine.js'), playwright = r('playwright-core');
  const contexts = [...playwright.chromium._contexts];
  if (engine.taskState.accountId !== accountId || contexts.length !== 1) throw new Error('Account context changed');
  const context = contexts[0], pages = context.pages();
  if (pages.length !== 1) throw new Error('Expected one account page');
  const page = pages[0], work = engine.taskState.currentWork;
  const targetId = String(work && work.id || '');
  if (!/^\d{1,24}$/.test(targetId)) throw new Error('Missing current work');
  const responses = [...context._connection._objects.values()].reverse().filter(item => {
    if (item._type !== 'Response') return false;
    try {
      const u = new URL(item.url());
      return u.protocol === 'https:' && ['www.douyin.com', 'douyin.com'].includes(u.hostname)
        && u.pathname === '/aweme/v1/web/comment/list/' && u.searchParams.get('aweme_id') === targetId
        && item.frame().page() === page;
    } catch (_) { return false; }
  }).slice(0, 4);
  const facts = [];
  for (const response of responses) {
    const u = new URL(response.url());
    const base = { httpStatus: response.status(), requestCursor: u.searchParams.get('cursor') };
    let timer;
    try {
      const body = await Promise.race([response.body(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read timeout')), 3000); })]);
      if (body.length > 2 * 1024 * 1024) { facts.push({ ...base, tooLarge: true }); continue; }
      const j = JSON.parse(body.toString('utf8'));
      const commentsShape = !Object.hasOwn(j, 'comments') ? 'missing' : j.comments === null ? 'null' : Array.isArray(j.comments) ? 'array' : typeof j.comments;
      facts.push({ ...base, bytes: body.length, status_code: j.status_code, has_more: j.has_more, total: j.total, cursor: j.cursor,
        commentsShape, ...(Array.isArray(j.comments) ? { commentsCount: j.comments.length } : {}) });
    } catch (_) { facts.push({ ...base, unreadable: true }); }
    finally { clearTimeout(timer); }
  }
  return { at: new Date().toISOString(), running: engine.taskState.running, stage: engine.taskState.stage, workType: work.type, retainedResponses: facts };
};
