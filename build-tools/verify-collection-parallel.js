'use strict';
// Actual release engine with local native browser responses. The profile and
// all persisted data are temporary, and a loopback proxy rejects transmission.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), app = path.join(root, 'dy-lead-app-release');
const fixture = fs.mkdtempSync(path.join(__dirname, 'qa-collection-parallel-'));
process.env.DY_LEAD_DATA_DIR = path.join(fixture, 'data');
const workId = '7000000000000000816';
const image = { pc_img_format: 'webp', count: '10', item_type: '0' }, located = { ...image, insert_ids: '' };
const rows = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => ({ cid: 'cid-' + (first + index), level: 1, text: '本地评论-' + (first + index), user: { uid: String(first + index), sec_uid: 'fixture-user-' + (first + index), nickname: '模拟用户' } }));
const makePage = (requestCursor, cursor, params, comments) => ({ requestCursor, params, body: { status_code: 0, has_more: 1, total: 212, cursor, comments } });
const initial = [makePage(20, 40, { count: '20', item_type: '0' }, rows(21, 38)), makePage(0, 10, located, rows(1, 10)), makePage(10, 20, located, rows(11, 20))];
const next = [makePage(40, 50, image, rows(41, 50)), makePage(20, 30, located, rows(21, 28)), makePage(30, 40, located, rows(29, 38)),
  makePage(40, 50, located, rows(41, 50)), makePage(50, 60, image, rows(51, 60)), { requestCursor: 60, params: image, body: { status_code: 0, comments: null, has_more: 0, total: 212, cursor: 70 } }];
const pages = [...initial, ...next];
const address = entry => '/aweme/v1/web/comment/list/?' + new URLSearchParams({ aweme_id: workId, cursor: String(entry.requestCursor), ...entry.params });
let engine, blocker;
(async () => {
  try {
    assert.match(fs.readFileSync(path.join(app, 'engine.js'), 'utf8'), /_0x[0-9a-f]+/i);
    engine = require(path.join(app, 'engine.js')); const store = require(path.join(app, 'store.js'));
    assert.equal(path.resolve(store.DATA_DIR), path.join(fixture, 'data'));
    blocker = net.createServer(socket => socket.destroy()); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const accountId = 'parallel-qa';
    store.setAccounts([{ id: accountId, name: '本地图文并行分页验证', proxy: 'http://127.0.0.1:' + blocker.address().port }]);
    engine.configure({ authorize: async () => true });
    const { page, context } = await engine.launchAccount(accountId, { headless: true });
    const requests = [];
    await context.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.origin !== 'https://www.douyin.com') return route.abort();
      if (u.pathname === '/note/' + workId) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
        <header><a href="/user/self"><img width="30" height="30" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XsAAAAASUVORK5CYII="></a></header>
        <button aria-label="评论" data-e2e="comment-button">评论</button>
        <section data-e2e="comment-list" hidden style="height:100px;overflow-y:auto"><div data-e2e="comment-item" style="height:1000px">模拟评论</div></section>
        <script>const initial=${JSON.stringify(initial.map(address))},next=${JSON.stringify(next.map(address))};
          const list=document.querySelector('section'),content=document.querySelector('[data-e2e="comment-item"]');let step=0,busy=false;window.initialDone=false;
          document.querySelector('button').onclick=async()=>{list.hidden=false;for(const url of initial)await fetch(url).then(r=>r.json());window.initialDone=true;};
          list.addEventListener('scroll',async()=>{if(busy||!window.initialDone||step>=next.length)return;busy=true;await fetch(next[step++]).then(r=>r.json());content.style.height=(1000+step*400)+'px';busy=false;});
        </script></body></html>` });
      const entry = pages.find(entry => u.pathname + u.search === address(entry));
      if (!entry) return route.abort();
      requests.push({ cursor: entry.requestCursor, located: Object.hasOwn(entry.params, 'insert_ids') });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(entry.body) });
    });
    await context.addCookies([{ name: 'sessionid', value: 'local-fixture-session', domain: '.douyin.com', path: '/', secure: true, httpOnly: true }]);
    const scheduler = { checkStopped() {}, scheduleBoundary() {}, async run(meta, operation) {
      if (meta.kind === 'scroll') await page.waitForFunction(() => window.initialDone, { timeout: 5000 });
      return operation();
    } };
    const settings = store.getSettings(); settings.collect.maxScrolls = 120;
    const baseline = page.listenerCount('response');
    const result = await engine.collectOne(accountId, page, { id: workId, type: 'note', url: 'https://www.douyin.com/note/' + workId }, settings, scheduler);
    const saved = store.getVideos()[workId];
    // Initial native responses may settle during the first scroll wait. That
    // adds one startup round, while all six actual next-page loads still run.
    assert.equal(result.complete, true); assert(result.rounds >= 6 && result.rounds <= 7); assert.equal(result.lastCursor, 70); assert.equal(result.lastTotal, 212);
    assert.equal(saved.collectionState, 'complete'); assert.equal(saved.collectionCheckpoint.paginationSourceCount, 3); assert.equal(saved.collectionCheckpoint.noProgressRounds, 0);
    assert.equal(store.getLeads().length, 58); assert.equal(requests.length, 9); assert.equal(page.listenerCount('response'), baseline);
    const report = { ok: true, version: require(path.join(app, 'resources/app/package.json')).version, actualObfuscatedEngine: true,
      localResponsesOnly: true, livePlatform: false, productionDataRead: false, observedParallelSequenceCompleted: true,
      duplicateCommentsRetainedOnce: true, nonzeroTotalNullTerminalCompleted: true, sourceCount: 3, scrollRounds: result.rounds, finalCursor: result.lastCursor, noProgressRounds: 0, listenersRemoved: true };
    fs.writeFileSync(path.join(__dirname, 'collection-parallel-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally {
    if (engine) await engine.shutdown();
    if (blocker) await new Promise(resolve => blocker.close(resolve));
    if (path.dirname(fixture) !== __dirname || !path.basename(fixture).startsWith('qa-collection-parallel-')) throw new Error('Unexpected cleanup target');
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
