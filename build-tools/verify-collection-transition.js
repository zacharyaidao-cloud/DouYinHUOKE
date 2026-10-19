'use strict';
// Actual shipping engine, isolated profile, local responses and a rejecting
// loopback proxy. No real account, installed data or platform request is used.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), app = path.join(root, 'dy-lead-app-release');
const fixture = fs.mkdtempSync(path.join(__dirname, 'qa-collection-transition-'));
process.env.DY_LEAD_DATA_DIR = path.join(fixture, 'data');
const works = [
  { id: '7000000000000000801', type: 'video' },
  { id: '7000000000000000802', type: 'note' },
  { id: '7000000000000000803', type: 'video' }
];
const byId = new Map(works.map(work => [work.id, work]));
let engine, blocker;
(async () => {
  try {
    assert.match(fs.readFileSync(path.join(app, 'engine.js'), 'utf8'), /_0x[0-9a-f]+/i);
    engine = require(path.join(app, 'engine.js'));
    const store = require(path.join(app, 'store.js'));
    assert.equal(path.resolve(store.DATA_DIR), path.join(fixture, 'data'));
    blocker = net.createServer(socket => socket.destroy());
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const accountId = 'transition-qa';
    store.setAccounts([{ id: accountId, name: '本地图文切换验证', proxy: 'http://127.0.0.1:' + blocker.address().port }]);
    engine.configure({ authorize: async () => true });
    const alive = await engine.launchAccount(accountId, { headless: true });
    const { page, context } = alive;
    const clicks = new Map();
    await context.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.origin !== 'https://www.douyin.com') return route.abort();
      const match = /^\/(video|note)\/(\d+)$/.exec(u.pathname);
      if (match && byId.has(match[2])) {
        const id = match[2];
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
          <header><a href="/user/self"><img width="30" height="30" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XsAAAAASUVORK5CYII="></a></header>
          <button aria-label="评论" data-e2e="comment-button">评论</button>
          <section data-e2e="comment-list" hidden style="height:100px;overflow-y:auto"><div data-e2e="comment-item" style="height:1000px">本地模拟评论</div></section>
          <script>const list=document.querySelector('section');document.querySelector('button').onclick=()=>{list.hidden=false;fetch('/aweme/v1/web/comment/list/?aweme_id=${id}&cursor=60').then(r=>r.json());};
          list.addEventListener('scroll',()=>{fetch('/aweme/v1/web/comment/list/?aweme_id=${id}&cursor=70').then(r=>r.json());},{once:true});</script>
          </body></html>` });
      }
      if (u.pathname === '/aweme/v1/web/comment/list/' && byId.has(u.searchParams.get('aweme_id'))) {
        const id = u.searchParams.get('aweme_id'); clicks.set(id, (clicks.get(id) || 0) + 1);
        if (u.searchParams.get('cursor') === '70') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status_code: 0, cursor: 80, has_more: 0, total: byId.get(id).type === 'note' ? 0 : 137, comments: null }) });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status_code: 0, cursor: 70, has_more: 1, total: 137,
          comments: [{ cid: 'comment-' + id, level: 1, text: '本地模拟采集需求', user: { uid: id, sec_uid: 'qa_' + id, nickname: '模拟用户' } }] }) });
      }
      return route.abort();
    });
    await context.addCookies([{ name: 'sessionid', value: 'local-fixture-session', domain: '.douyin.com', path: '/', secure: true, httpOnly: true }]);
    const evaluate = page.evaluate.bind(page);
    let transitionInjected = false;
    page.evaluate = async (callback, args) => {
      // Reproduce the observed navigation exactly at the real login DOM read.
      // The callback then passes through login-state/task-login/collectOne.
      if (!transitionInjected && page.url() === 'https://www.douyin.com/video/' + works[1].id && callback.toString().includes('selfPage')) {
        transitionInjected = true;
        await page.goto('https://www.douyin.com/note/' + works[1].id, { waitUntil: 'domcontentloaded' });
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      }
      return evaluate(callback, args);
    };
    const settings = store.getSettings(); settings.collect.maxScrolls = 2;
    const scheduler = { checkStopped() {}, scheduleBoundary() {}, async run(_meta, operation) { return operation(); } };
    const baseline = page.listenerCount('response');
    for (const work of works) {
      const result = await engine.collectOne(accountId, page, { id: work.id, type: 'video', url: 'https://www.douyin.com/video/' + work.id }, settings, scheduler);
      assert.equal(result.complete, true); assert.equal(result.work.type, work.type);
      assert.equal(store.getVideos()[work.id].collectionState, 'complete');
      assert.equal(store.getVideos()[work.id].workType, work.type);
      assert.equal(clicks.get(work.id), 2); assert.equal(result.rounds, 1); assert.equal(result.lastCursor, 80); assert.equal(result.lastTotal, 137);
      assert.equal(store.getVideos()[work.id].collectionCheckpoint.noProgressRounds, 0); assert.equal(page.listenerCount('response'), baseline);
    }
    assert.equal(transitionInjected, true); assert.equal(store.getLeads().length, 3);
    store.setSearchResults([{ awemeId: works[1].id, workType: 'mixed', link: 'https://www.douyin.com/note/' + works[1].id }]);
    assert.equal(store.getSearchResults()[0].workType, 'note');
    store.setSearchResults([]);
    store.addSearchResults('本地综合搜索', 'mixed', works.map(work => ({ awemeId: work.id, workType: work.type, link: 'https://www.douyin.com/' + work.type + '/' + work.id })));
    assert.deepEqual(store.getSearchResults().map(work => work.workType), ['video', 'note', 'video']);
    const report = { ok: true, version: require(path.join(app, 'resources/app/package.json')).version,
      actualObfuscatedEngine: true, localResponsesOnly: true, videoNoteVideoCompleted: true,
      nullTerminalPageCompleted: true, zeroAndNonzeroTerminalTotalsCompleted: true, previousCommentTotalRetained: true, unnecessaryNoProgressRoundsAbsent: true,
      loginReadNavigationRechecked: true, legacyMixedTypeCorrectedOnRead: true, collectionListenersRemoved: true };
    fs.writeFileSync(path.join(__dirname, 'collection-transition-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (engine) await engine.shutdown();
    if (blocker) await new Promise(resolve => blocker.close(resolve));
    if (path.dirname(fixture) !== __dirname || !path.basename(fixture).startsWith('qa-collection-transition-')) throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
