'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getEventListeners } = require('node:events');
const { TaskStopError } = require('../scheduler');
const { openComments, scrollComments, landingWork, trustedNavigation, navigateCollectionPage } = require('../lib/collection-browser');

test('分享落地保留图文并支持旧分享与作品弹窗地址，拒绝非作品和外域', () => {
  assert.equal(landingWork('https://www.douyin.com/note/456?share=1').url, 'https://www.douyin.com/note/456');
  assert.deepEqual(landingWork('https://www.iesdouyin.com/share/video/123/'), { id: '123', type: 'video', url: 'https://www.douyin.com/video/123', needsCanonicalNavigation: true });
  assert.equal(landingWork('https://www.douyin.com/?modal_id=123').id, '123');
  for (const address of ['http://www.douyin.com/video/123', 'https://www.douyin.com.evil.example/video/123', 'https://user:pass@www.douyin.com/video/123', 'https://www.douyin.com:9443/video/123', 'https://127.0.0.1/video/123']) assert.equal(trustedNavigation(address), false);
  for (const address of ['https://www.douyin.com/user/self', 'https://www.douyin.com/?modal_id=abc', 'https://evil.example/video/123', 'https://v.douyin.com/abc/']) assert.throws(() => landingWork(address), /有效作品/);
});

function navigationFixture(responses = {}, { extraRequests = [], gotoError, enableError, method = 'GET' } = {}) {
  const events = [], navigated = [], listeners = new Map(), paused = new Map();
  let sequence = 0;
  const session = {
    on: (name, callback) => listeners.set(name, callback),
    off: (name, callback) => { assert.equal(listeners.get(name), callback); listeners.delete(name); events.push('remove'); },
    detach: async () => events.push('detach'),
    send: async (method, args = {}) => {
      events.push({ method, args });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'Fetch.enable' && enableError) throw enableError;
      if (['Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest'].includes(method)) paused.get(args.requestId)?.(method);
      return {};
    }
  };
  const pause = event => new Promise(resolve => {
    paused.set(event.requestId, resolve);
    const handler = listeners.get('Fetch.requestPaused');
    assert(handler, 'CDP interception must remain installed until all paused requests settle');
    handler(event);
  });
  const request = (url, overrides = {}) => ({ requestId: 'synthetic-' + (++sequence), frameId: 'main-frame', resourceType: 'Document', request: { url, method }, ...overrides });
  const page = {
    context: () => ({ newCDPSession: async () => session }),
    goto: async url => {
      navigated.push(url);
      if (gotoError) throw gotoError;
      for (const extra of extraRequests.splice(0)) assert.equal(await pause(request(extra.url, extra)), 'Fetch.continueRequest');
      const req = request(url);
      if (await pause(req) === 'Fetch.failRequest') throw new Error('synthetic navigation aborted');
      const response = responses[url] || { status: 200 };
      const headers = [...(response.headers || []), ...(response.location ? [{ name: 'Location', value: response.location }] : [])];
      const result = await pause({ ...req, responseStatusCode: response.status, responseHeaders: headers });
      if (result === 'Fetch.failRequest') throw new Error('synthetic redirect aborted');
      return { url, status: result === 'Fetch.fulfillRequest' ? 200 : response.status };
    }
  };
  return { page, session, events, navigated, listeners };
}
const short = 'https://v.douyin.com/abc/', note = 'https://www.douyin.com/note/123';
function assertClean(f) {
  assert.equal(f.listeners.size, 0);
  assert.equal(f.events.at(-1), 'detach');
  const disabled = f.events.findIndex(event => event.method === 'Fetch.disable');
  assert(disabled >= 0);
  assert.equal(f.events[disabled + 1], 'remove');
}

test('HTTP五种跳转先检查Location和授权，再以同页新导航逐跳访问；会话头仅在内存保留', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const f = navigationFixture({ [short]: { status, location: note, headers: [{ name: 'Set-Cookie', value: 'synthetic-test=local' }, { name: 'Content-Length', value: '123' }, { name: 'Refresh', value: '0;url=https://evil.example/' }] } });
    let authorized = 0;
    const result = await navigateCollectionPage(f.page, short, { authorize: async () => { authorized++; }, checkStopped: () => {} });
    assert.equal(result.url, note); assert.deepEqual(f.navigated, [short, note]); assert.equal(authorized, 3);
    const replay = f.events.find(event => event.method === 'Fetch.fulfillRequest').args;
    assert.equal(replay.responseCode, 200); assert.equal(replay.body, '');
    assert(replay.responseHeaders.some(header => header.name === 'Set-Cookie'));
    assert(replay.responseHeaders.some(header => header.name === 'Cache-Control' && header.value === 'no-store'));
    assert(!replay.responseHeaders.some(header => /^(location|refresh|content-length)$/i.test(header.name)));
    assertClean(f);
  }
});

test('外域、HTTP、伪造子域、端口和凭证Location在下一请求发起前被拒绝', async () => {
  for (const location of ['https://evil.example/', 'http://www.douyin.com/video/123', 'https://www.douyin.com.evil.example/video/123', 'https://www.douyin.com:9443/video/123', 'https://u:p@www.douyin.com/video/123', 'https://www.douyin.com/video/123\r\nX-Test: invalid']) {
    const f = navigationFixture({ [short]: { status: 302, location } });
    let authorized = 0;
    await assert.rejects(navigateCollectionPage(f.page, short, { authorize: async () => { authorized++; }, checkStopped: () => {} }), error => error.code === 'PAGE_REDIRECT');
    assert.equal(authorized, 1); assert.deepEqual(f.navigated, [short]);
    assert(f.events.some(event => event.method === 'Fetch.failRequest'));
    assertClean(f);
  }
});

test('授权撤销或停止在HTTP Location释放前原样阻断，暂停请求先拒绝再清理', async () => {
  for (const stoppedOnRedirect of [false, true]) {
    const f = navigationFixture({ [short]: { status: 302, location: note } });
    let authorized = 0, stopped = false;
    const expected = Object.assign(new Error('synthetic revoked or stopped'), { code: stoppedOnRedirect ? 'TASK_STOPPED' : 'AUTH_REQUIRED' });
    await assert.rejects(navigateCollectionPage(f.page, short, {
      authorize: async () => { if (++authorized === 2) { if (stoppedOnRedirect) stopped = true; else throw expected; } },
      checkStopped: () => { if (stopped) throw expected; }
    }), error => error === expected);
    assert.deepEqual(f.navigated, [short]);
    assert(f.events.findIndex(event => event.method === 'Fetch.failRequest') < f.events.findIndex(event => event.method === 'Fetch.disable'));
    assertClean(f);
  }
});

test('相对Location正确解析，循环最多十次主文档请求且不会释放第十一跳', async () => {
  const f = navigationFixture({ [short]: { status: 302, location: '/other/' }, 'https://v.douyin.com/other/': { status: 302, location: short } });
  let authorized = 0;
  await assert.rejects(navigateCollectionPage(f.page, short, { authorize: async () => { authorized++; }, checkStopped: () => {} }), /跳转异常/);
  assert.equal(f.navigated.length, 10); assert.equal(authorized, 19);
  assert.equal(f.navigated[1], 'https://v.douyin.com/other/');
  assertClean(f);
});

test('非主框架资源不消耗导航授权；主文档非GET不自动重放；初始化和goto错误均清理', async () => {
  const f = navigationFixture({}, { extraRequests: [{ url: 'https://cdn.example/frame', frameId: 'child-frame' }] });
  let authorized = 0;
  await navigateCollectionPage(f.page, note, { authorize: async () => { authorized++; }, checkStopped: () => {} });
  assert.equal(authorized, 1); assertClean(f);
  const post = navigationFixture({}, { method: 'POST' });
  await assert.rejects(navigateCollectionPage(post.page, note, { authorize: async () => { throw new Error('POST must not be authorized'); }, checkStopped: () => {} }), error => error.code === 'PAGE_REDIRECT');
  assert(!post.events.some(event => event.method === 'Fetch.continueRequest'));
  assertClean(post);
  for (const options of [{ gotoError: new Error('synthetic goto failed') }, { enableError: new Error('synthetic CDP unavailable') }]) {
    const g = navigationFixture({}, options);
    await assert.rejects(navigateCollectionPage(g.page, note, { authorize: async () => {}, checkStopped: () => {} }), /synthetic/);
    assertClean(g);
  }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stoppingOptions(controller, expected = new TaskStopError()) {
  return {
    signal: controller.signal,
    authorize: async () => {},
    checkStopped: () => { if (controller.signal.aborted) throw expected; }
  };
}

test('导航开始前已停止不建立CDP会话，并保留调用方停止错误', async () => {
  const f = navigationFixture(), controller = new AbortController();
  const expected = new TaskStopError('synthetic stopped before navigation');
  f.page.context = () => { throw new Error('a stopped task must not create a CDP session'); };
  controller.abort();
  await assert.rejects(navigateCollectionPage(f.page, note, stoppingOptions(controller, expected)), error => error === expected);
  await assert.rejects(navigateCollectionPage(f.page, note, { ...stoppingOptions(controller), checkStopped: () => {} }), error => error instanceof TaskStopError);
  assert.equal(f.events.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('主文档无响应时停止立即退出；CDP停止失败和迟到goto拒绝不会泄漏', { timeout: 2000 }, async () => {
  for (const stopFails of [false, true]) {
    const f = navigationFixture(), controller = new AbortController();
    const entered = deferred(), stalled = deferred(), expected = new TaskStopError('synthetic user stopped');
    const originalSend = f.session.send;
    f.session.send = async (method, args) => {
      const result = await originalSend(method, args);
      if (method === 'Page.stopLoading' && stopFails) throw new Error('synthetic closed CDP session');
      return result;
    };
    f.page.goto = async url => { f.navigated.push(url); entered.resolve(); return stalled.promise; };
    const operation = navigateCollectionPage(f.page, note, stoppingOptions(controller, expected));
    const rejected = assert.rejects(operation, error => error === expected);
    await entered.promise;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort();
    await rejected;
    assert.equal(f.events.filter(event => event.method === 'Page.stopLoading').length, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assertClean(f);
    stalled.reject(new Error('synthetic late navigation cancellation'));
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('授权请求未返回时停止先拒绝暂停文档，再清理会话；迟到授权不释放导航', { timeout: 2000 }, async () => {
  const f = navigationFixture(), controller = new AbortController();
  const entered = deferred(), authorization = deferred(), expected = new TaskStopError('synthetic stopped during authorization');
  const operation = navigateCollectionPage(f.page, note, {
    ...stoppingOptions(controller, expected),
    authorize: () => { entered.resolve(); return authorization.promise; }
  });
  const rejected = assert.rejects(operation, error => error === expected);
  await entered.promise;
  controller.abort();
  await rejected;
  assert(f.events.some(event => event.method === 'Fetch.failRequest'));
  assert(!f.events.some(event => event.method === 'Fetch.continueRequest'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertClean(f);
  authorization.reject(new Error('synthetic late authorization failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('CDP启用期间停止也清理监听器；迟到协议错误已处理', { timeout: 2000 }, async () => {
  const f = navigationFixture(), controller = new AbortController();
  const entered = deferred(), enabling = deferred(), originalSend = f.session.send;
  f.session.send = async (method, args) => {
    const result = await originalSend(method, args);
    if (method === 'Fetch.enable') { entered.resolve(); return enabling.promise; }
    return result;
  };
  const operation = navigateCollectionPage(f.page, note, stoppingOptions(controller));
  const rejected = assert.rejects(operation, error => error instanceof TaskStopError);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(f.navigated.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertClean(f);
  enabling.reject(new Error('synthetic late enable failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('正常完成用户主页导航后移除停止监听器，后续停止不影响已结束页面', async () => {
  const f = navigationFixture(), controller = new AbortController();
  const profile = 'https://www.douyin.com/user/synthetic-user';
  const result = await navigateCollectionPage(f.page, profile, stoppingOptions(controller));
  assert.equal(result.url, profile);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertClean(f);
  const finishedEvents = f.events.length;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.length, finishedEvents);
});

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(__dirname, '..', 'node_modules', 'playwright-core', '.local-browsers');
const { chromium } = require('playwright-core');
const browserPath = [chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(file => fs.existsSync(file));

test('实际 Chromium：长文字和图片评论以当前底部触发分页，下一页增长后继续翻页', { timeout: 60000, skip: !browserPath }, async t => {
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  try {
    for (const type of ['video', 'note']) {
      await t.test(`${type} 评论区域每页高 5000 px，只在距底 2 px 内加载，不滚推荐或整页`, async () => {
        await page.setContent(`<!doctype html><html><body style="margin:0">
          <div role="tablist"><button role="tab">相关推荐</button><button id="entry" role="tab" aria-controls="comments">评论(3)</button></div>
          <div id="reco" data-e2e="scroll-list" style="height:180px;overflow:auto"><div data-e2e="recommend-list" style="height:5000px">推荐列表</div></div>
          <div id="comments" data-e2e="comment-list" role="tabpanel" ${type === 'note' ? 'hidden' : ''} style="height:180px;overflow:auto"><div style="height:5000px">长文字与图片评论</div></div>
          <div style="height:3000px">页面其他内容</div><script>(()=>{
            window.qaClicks=0;window.qaCursors=${type === 'note' ? '[]' : '[0]'};window.qaBottoms=[];
            const panel=document.querySelector('#comments'),reco=document.querySelector('#reco');
            document.querySelector('#entry').addEventListener('click',()=>{window.qaClicks++;if(!panel.hidden)return;panel.hidden=false;reco.hidden=true;window.qaCursors.push(0)});
            panel.addEventListener('scroll',()=>{const remaining=panel.scrollHeight-panel.clientHeight-panel.scrollTop;if(remaining>2||window.qaCursors.length>=3)return;const cursor=window.qaCursors.length*20;window.qaBottoms.push({cursor,remaining,height:panel.scrollHeight});window.qaCursors.push(cursor);const batch=document.createElement('div');batch.style.height='5000px';batch.textContent='下一页长文字与图片评论';panel.appendChild(batch)});
          })()</script></body></html>`);
        const before = await page.evaluate(() => ({ clicks: window.qaClicks, cursors: window.qaCursors }));
        assert.equal((await page.evaluate(openComments, { probe: true })).state, type === 'note' ? 'available' : 'ready');
        assert.deepEqual(await page.evaluate(() => ({ clicks: window.qaClicks, cursors: window.qaCursors })), before, 'A pure DOM probe may not open comments or generate a page request');
        assert.equal((await page.evaluate(openComments)).state, type === 'note' ? 'opened' : 'ready');
        for (let batch = 2; batch <= 3; batch++) {
          assert.deepEqual(await page.evaluate(scrollComments), { state: 'scrolled', moved: true, hasRegion: true });
          await page.waitForFunction(count => window.qaCursors.length === count, batch, { timeout: 1000 });
        }
        const state = await page.evaluate(() => ({ clicks: window.qaClicks, cursors: window.qaCursors, bottoms: window.qaBottoms, reco: document.querySelector('#reco').scrollTop, window: window.scrollY }));
        assert.equal(state.clicks, type === 'note' ? 1 : 0);
        assert.deepEqual(state.cursors, [0, 20, 40]);
        assert.deepEqual(state.bottoms.map(item => item.height), [5000, 10000]);
        assert(state.bottoms.every(item => item.remaining <= 2));
        assert.equal(state.reco, 0); assert.equal(state.window, 0);
      });
    }
    await t.test('一帧内追加的页面内容先布局后滚动，已到底只返回 at_end', async () => {
      await page.setContent('<div id="comments" data-e2e="comment-list" style="height:180px;overflow:auto"><div id="batch" style="height:900px">评论</div></div>');
      await page.evaluate(() => { const panel = document.querySelector('#comments'); panel.scrollTop = panel.scrollHeight; requestAnimationFrame(() => { document.querySelector('#batch').style.height = '5000px'; }); });
      assert.deepEqual(await page.evaluate(scrollComments), { state: 'scrolled', moved: true, hasRegion: true });
      assert.equal(await page.locator('#comments').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop), 0);
      assert.deepEqual(await page.evaluate(scrollComments), { state: 'at_end', moved: false, hasRegion: true });
    });
    await t.test('后台窗口停帧由 50 ms 兜底，仍仅滚评论且不挂起', async () => {
      await page.setContent('<div data-e2e="comment-list" style="height:180px;overflow:auto"><div style="height:5000px">评论</div></div>');
      const result = await page.evaluate(async source => {
        const frame = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
        window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {};
        try { return await (0, eval)('(' + source + ')')(); }
        finally { window.requestAnimationFrame = frame; window.cancelAnimationFrame = cancel; }
      }, scrollComments.toString());
      assert.deepEqual(result, { state: 'scrolled', moved: true, hasRegion: true });
    });
  } finally { await context.close(); await browser.close(); }
});
