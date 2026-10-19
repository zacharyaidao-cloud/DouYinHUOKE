'use strict';

// Exercise the shipping, obfuscated engine with a real Chromium and synthetic
// local responses. Every page request is fulfilled or aborted by a route; no
// installed data, real account, production Cookie or platform service is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'dy-lead-app-release');
const REPORT = path.join(__dirname, 'collection-build-verification.json');
const fixture = fs.mkdtempSync(path.join(__dirname, 'qa-collection-build-'));
const originalFetch = globalThis.fetch;
const aiRequests = [];
globalThis.fetch = async (address, options = {}) => {
  const url = String(address), method = options.method || 'GET';
  assert.equal(options.headers.Authorization, 'Bearer isolated-collection-ai');
  assert.equal(options.redirect, 'error');
  if (url === 'https://api.deepseek.com/models' && method === 'GET') {
    return { ok: true, status: 200, url, json: async () => ({ data: [{ id: 'deepseek-flash', context_window: 1048576, max_output_tokens: 393216 }] }) };
  }
  assert.equal(url, 'https://api.deepseek.com/chat/completions', 'Unknown Node network request blocked');
  assert.equal(method, 'POST');
  const body = JSON.parse(options.body), payload = JSON.parse(body.messages[1].content);
  assert(payload.items.length > 0);
  assert(payload.items.every(item => item.comment.startsWith('隔离测试具体需求 ')), 'Only collected synthetic comments reach AI');
  aiRequests.push(payload.items.length);
  const output = payload.items.map(item => ({ i: item.i, need: '是', reason: '隔离流程测试结果' })).reverse();
  return { ok: true, status: 200, url, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }) };
};
process.env.DY_LEAD_DATA_DIR = path.join(fixture, 'data');
const accountId = 'collection-build-qa';
const works = [
  { id: '7000000000000000001', kind: 'video' },
  { id: '7000000000000000002', kind: 'note' },
  { id: '7000000000000000003', kind: 'video', short: 'qa-video' },
  { id: '7000000000000000004', kind: 'note', short: 'qa-note' }
];
const workById = new Map(works.map(work => [work.id, work]));
const shortByPath = new Map(works.filter(work => work.short).map(work => ['/' + work.short + '/', work]));
const workTitle = work => '真实隔离作品标题 ' + work.kind;
const workBody = work => work.id === works[1].id ? '本地图文嵌入详情正文\n' + '完整图文段落😀\r\n'.repeat(4200) + '全文末尾证据' : '本地发行测试作品';

function accountHeader(mode = 'closed') {
  const avatar = '<img alt="本地测试头像" width="28" height="28" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XsAAAAASUVORK5CYII=">';
  const header = mode === 'context-only' ? '<header>本地作品页</header>' : `<header><a href="/user/self">${avatar}</a></header>`;
  if (mode !== 'open') return header;
  return header + `<section style="position:fixed;right:12px;top:40px;background:#eee;padding:12px"><div>${avatar}<span>本地测试账号</span></div><div><span>我的喜欢</span><span>125</span></div><div><span>我的收藏</span><span>17</span></div><div><span>观看历史</span><span>30天内</span></div><div><span>稍后再看</span><span>0</span></div><div><span>我的作品</span><span>47</span></div><div><span>退出登录</span></div></section>`;
}

function jsonHeaders() { return { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }; }
function comment(work, page) {
  return {
    cid: work.id + '-' + page, level: 1, text: '隔离测试具体需求 ' + page,
    // 评论时间取最近一小时，保证默认的“一周内”自动判断范围覆盖全部隔离评论
    create_time: Math.floor(Date.now() / 1000) - 3600, digg_count: 0, reply_comment_total: 0,
    user: { uid: work.id + page, sec_uid: 'qa_comment_' + work.id + '_' + page, nickname: '隔离测试用户', signature: '评论响应已有签名', follower_count: 0 }
  };
}

function workHtml(work) {
  const hidden = work.kind === 'note' ? 'hidden' : '';
  const embeddedOnly = work.id === works[1].id;
  const embeddedData = encodeURIComponent(JSON.stringify({ app: { videoDetail: { id: work.id } } }));
  const streamData = '7:' + JSON.stringify([null, null, null, { awemeId: work.id, statusCode: 0, aweme: { detail: {
    awemeId: work.id, awemeType: 68, mediaType: 2, itemTitle: workTitle(work), desc: workBody(work),
    images: [{ width: 1248, height: 1456, uri: 'synthetic-note', urlList: ['https://qa-images.invalid/synthetic.webp'], downloadUrlList: [], video: null }]
  } } }]) + '\n';
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    ${accountHeader(work.id === works[2].id ? 'context-only' : work.kind === 'note' ? 'open' : 'closed')}<h1>本地隔离${work.kind === 'note' ? '图文' : '视频'}作品</h1>
    ${embeddedOnly ? `<script id="RENDER_DATA" type="application/json">${embeddedData}</script><script>self.__pace_f=[];</script><script>self.__pace_f.push(${JSON.stringify([1, streamData])});</script>` : ''}
    <div role="tablist"><button id="qa-recommend-tab" role="tab" aria-selected="${work.kind === 'note'}">相关推荐</button><button id="qa-comment-tab" role="tab" aria-controls="qa-comment-panel" aria-selected="${work.kind !== 'note'}">评论(3)</button></div>
    <div id="qa-recommendations" data-e2e="scroll-list" ${work.kind !== 'note' ? 'hidden' : ''} style="height:180px;overflow:auto"><div data-e2e="recommend-list" style="height:3000px">本地推荐作品</div></div>
    <div id="qa-comment-panel" role="tabpanel" data-e2e="comment-list" ${hidden} style="height:180px;overflow:auto;border:1px solid black"><div style="height:5000px">长文字／图片评论：讨论安全验证、扫码登录和账号限制<button>登录</button><span>退出登录</span></div></div>
    <script>
      window.qaCommentRequests = [];
      window.qaCommentOpenClicks = 0;
      window.qaRecommendationScrolls = 0;
      window.qaPaginationBottoms = [];
      const id = ${JSON.stringify(work.id)};
      const panel = document.querySelector('[data-e2e="comment-list"]');
      const recommendations = document.getElementById('qa-recommendations');
      recommendations.addEventListener('scroll', () => window.qaRecommendationScrolls++);
      let nextCursor = 20, paging = false, paginationComplete = false;
      const comments = cursor => {
        window.qaCommentRequests.push(cursor);
        return fetch('/aweme/v1/web/comment/list/?aweme_id=' + id + '&cursor=' + cursor).then(response => response.json()).then(data => {
          if (cursor !== 0) {
            const batch = document.createElement('div');
            batch.style.height = '5000px'; batch.textContent = '下一页长文字／图片评论';
            panel.appendChild(batch);
          }
          nextCursor = data.cursor; paginationComplete = data.has_more === 0;
          return data;
        });
      };
      const initial = [];
      if (${!embeddedOnly}) initial.push(fetch('/aweme/v1/web/aweme/detail/?aweme_id=' + id).then(response => response.json()));
      if (!panel.hidden) initial.push(comments(0));
      window.qaInitialLoaded = Promise.all(initial);
      document.getElementById('qa-comment-tab').addEventListener('click', () => {
        window.qaCommentOpenClicks++;
        if (!panel.hidden) return;
        panel.hidden = false; recommendations.hidden = true;
        document.getElementById('qa-comment-tab').setAttribute('aria-selected', 'true');
        document.getElementById('qa-recommend-tab').setAttribute('aria-selected', 'false');
        window.qaOpenedPageLoaded = comments(0);
      });
      panel.addEventListener('scroll', () => {
        const remaining = panel.scrollHeight - panel.clientHeight - panel.scrollTop;
        if (!paginationComplete && !paging && remaining <= 2) {
          paging = true;
          window.qaPaginationBottoms.push({ cursor: nextCursor, remaining, extent: panel.scrollHeight });
          window.qaNextPageLoaded = comments(nextCursor).finally(() => { paging = false; });
        }
      });
    </script></body></html>`;
}

function slowWorkHtml(work) {
  const html = workHtml(work);
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'));
  // The initial body is truly empty. Keep all deferred markup in the head,
  // including escaped script tags, so it cannot invent body-ready evidence.
  const literal = JSON.stringify(body).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><script>(() => {
    let scheduled = false, fallback;
    window.qaScheduleHydration = () => {
      if (scheduled) return;
      scheduled = true; clearTimeout(fallback);
      setTimeout(() => {
        document.body.innerHTML = ${literal};
        // innerHTML does not execute scripts. Activate the original fixture
        // scripts only after the delayed DOM is present, exactly once.
        for (const deferred of Array.from(document.body.querySelectorAll('script'))) {
          const script = document.createElement('script');
          for (const attribute of deferred.attributes) script.setAttribute(attribute.name, attribute.value);
          script.textContent = deferred.textContent; deferred.replaceWith(script);
        }
        window.qaSlowHydrated = true;
      }, 200);
    };
    // The first real empty-body inspection starts the 200 ms delay below.
    // Also bound the fixture if that inspection never occurs.
    fallback = setTimeout(window.qaScheduleHydration, 1000);
  })()</script></head><body></body></html>`;
}

function ownProfileHtml() {
  return '<!doctype html><html><body>' + accountHeader() + '<button>编辑资料</button><span>作品</span><span>喜欢</span><span>收藏</span></body></html>';
}

function outreachHtml() {
  return `<!doctype html><html><body>
    ${accountHeader('context-only')}<h1>本地隔离用户主页</h1>
    <section data-e2e="user-detail"><button id="qa-follow">关注</button><button id="qa-open-dm">私信</button></section>
    <div id="qa-conversation" data-e2e="message-panel" style="display:none"><div data-e2e="chat-header"><a href="/user/qa_action_user">本地动作测试用户</a></div><div contenteditable="true" style="min-height:24px"></div><button id="qa-send">发送</button></div>
    <script>
      window.qaActions = { follows: 0, openDm: 0, inputs: 0, sends: 0 };
      document.getElementById('qa-follow').addEventListener('click', event => {
        window.qaActions.follows++; event.currentTarget.textContent = '已关注';
        window.qaFollowReceipt = fetch('/aweme/v1/web/commit/follow/user/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'sec_user_id=qa_action_user&type=1' }).then(response => response.json());
      });
      document.getElementById('qa-open-dm').addEventListener('click', () => { window.qaActions.openDm++; document.getElementById('qa-conversation').style.display = 'block'; });
      document.querySelector('[contenteditable="true"]').addEventListener('input', () => window.qaActions.inputs++);
      document.getElementById('qa-send').addEventListener('click', () => window.qaActions.sends++);
    </script></body></html>`;
}

(async () => {
  let engine, transportBlocker;
  try {
    fs.rmSync(REPORT, { force: true });
    const engineFile = path.join(APP, 'engine.js');
    assert(fs.existsSync(engineFile), 'Build the release before running collection verification');
    const shippingCode = fs.readFileSync(engineFile, 'utf8');
    assert.match(shippingCode, /_0x[0-9a-f]+/i, 'Collection verification must load the actual obfuscated release engine');
    engine = require(engineFile);
    const store = require(path.join(APP, 'store.js'));
    assert.equal(path.resolve(store.DATA_DIR), path.join(fixture, 'data'), 'Release data must stay in the throwaway fixture');
    // A loopback-only rejecting proxy is a second boundary below Playwright:
    // even a redirect bypassing route interception cannot reach an origin.
    transportBlocker = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
      transportBlocker.once('error', reject);
      transportBlocker.listen(0, '127.0.0.1', resolve);
    });
    const rejectingProxy = 'http://127.0.0.1:' + transportBlocker.address().port;
    store.setAccounts([{ id: accountId, name: '隔离发行采集测试', proxy: rejectingProxy }]);
    const settings = store.getSettings();
    Object.assign(settings.collect, { scrollIntervalSec: 0, scrollJitter: 0, maxScrolls: 8, cooldownHours: 24, dailyVideoLimit: 20, linkIntervalSec: 0, linkIntervalJitter: 0 });
    settings.action = { userIntervalSec: 0, userIntervalJitter: 0, pacingVersion: 1 };
    settings.collect.autoAiAfterCollect = true;
    settings.dm.template = '仅本地隔离测试，不发送至真实用户';
    Object.assign(settings.ai, { enabled: true, apiKey: 'isolated-collection-ai', model: 'deepseek-flash' });
    store.setSettings(settings);
    engine.configure({ authorize: async () => true, dmVerifier: async () => ({ state: 'pending_verification', reason: '隔离测试没有真实平台回执' }) });
    // Outreach must request a visible account window. Start the isolated
    // browser in that mode so its local routes survive the engine's reuse.
    const alive = await engine.launchAccount(accountId, { headless: false });
    const { context, page } = alive;
    const { inspectLoginState } = require(path.join(APP, 'lib', 'login-state.js'));
    const workLoginEvidence = new Set();
    const requests = { documents: new Map(), comments: new Map(), paginationBottoms: new Map(), shortRedirects: 0, aborted: 0, nextPage: 0, boundaryTargets: 0, foreignTargets: 0 };
    let baselineListeners = 0, activeCollectionListenerSeen = false;
    await context.route('**/*', async route => {
      const request = route.request(), address = new URL(request.url());
      // There is intentionally no route.continue()/fetch(): unknown requests
      // abort, and every supported response is manufactured here.
      if (address.protocol !== 'https:' || !['www.douyin.com', 'douyin.com', 'v.douyin.com'].includes(address.hostname)) {
        if (address.hostname === 'qa-foreign.example') requests.foreignTargets++;
        requests.aborted++; await route.abort(); return;
      }
      if (address.hostname === 'v.douyin.com') {
        const status = address.pathname.match(/^\/qa-navigation-(301|302|303|307|308)\/$/);
        if (status) {
          await route.fulfill({ status: Number(status[1]), headers: { location: 'https://www.douyin.com/user/qa_navigation_landing' } }); return;
        }
        if (address.pathname === '/qa-navigation-foreign/') {
          await route.fulfill({ status: 302, headers: { location: 'https://qa-foreign.example/denied' } }); return;
        }
        const work = shortByPath.get(address.pathname);
        if (!work) { requests.aborted++; await route.abort(); return; }
        requests.shortRedirects++;
        // The production CDP boundary cancels automatic HTTP redirects and
        // authorizes a fresh same-page navigation for each allowed Location.
        const destination = 'https://www.douyin.com/' + work.kind + '/' + work.id;
        await route.fulfill({ status: 302, headers: { location: destination } }); return;
      }
      const workPath = address.pathname.match(/^\/(video|note)\/(\d+)\/?$/);
      if (request.isNavigationRequest() && workPath) {
        const work = workById.get(workPath[2]);
        assert(work, 'Unexpected synthetic work navigation');
        assert.equal(workPath[1], work.kind, 'A note must remain a note instead of being rewritten into video');
        requests.documents.set(work.id, (requests.documents.get(work.id) || 0) + 1);
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: work.id === works[1].id ? slowWorkHtml(work) : workHtml(work) }); return;
      }
      if (address.pathname === '/user/self') {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: ownProfileHtml() }); return;
      }
      if (address.pathname === '/user/qa_navigation_landing') {
        requests.boundaryTargets++;
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: ownProfileHtml() }); return;
      }
      if (address.pathname === '/user/qa_action_user') {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: outreachHtml() }); return;
      }
      if (address.pathname === '/aweme/v1/web/commit/follow/user/') {
        assert.equal(request.method(), 'POST');
        assert.equal(request.postData(), 'sec_user_id=qa_action_user&type=1');
        await route.fulfill({ status: 200, headers: jsonHeaders(), body: '{"status_code":0,"follow_status":1}' }); return;
      }
      if (address.pathname === '/aweme/v1/web/user/profile/self/') {
        await route.fulfill({ status: 200, headers: jsonHeaders(), body: '{"status_code":0,"is_login":true,"user":{"uid":"7000000000000000999","sec_uid":"qa_current_account_user"}}' }); return;
      }
      if (address.pathname === '/aweme/v1/web/user/profile/other/') {
        const uid = address.searchParams.get('sec_user_id');
        assert.equal(uid, 'qa_comment_' + works[0].id + '_1');
        await route.fulfill({ status: 200, headers: jsonHeaders(), body: JSON.stringify({ status_code: 0, user: { sec_uid: uid, signature: '已有主页响应补充签名', follower_count: 8 } }) }); return;
      }
      if (address.pathname === '/aweme/v1/web/aweme/detail/') {
        const work = workById.get(address.searchParams.get('aweme_id'));
        assert(work, 'Unexpected synthetic detail response');
        await route.fulfill({ status: 200, headers: jsonHeaders(), body: JSON.stringify({ status_code: 0, aweme_detail: { aweme_id: work.id, aweme_type: work.kind === 'note' ? 68 : 0, item_title: workTitle(work), desc: workBody(work), author: { sec_uid: 'qa_author_' + work.id, nickname: '本地测试作者' }, statistics: { comment_count: 3, digg_count: 0 } } }) }); return;
      }
      if (address.pathname === '/aweme/v1/web/comment/list/') {
        const work = workById.get(address.searchParams.get('aweme_id')), cursor = Number(address.searchParams.get('cursor') || 0);
        assert(work, 'Unexpected synthetic comments response');
        const collectingOnMainPage = request.frame().page() === page && page.listenerCount('response') > baselineListeners;
        if (cursor !== 999 && collectingOnMainPage) {
          activeCollectionListenerSeen = true;
          const key = work.id + ':' + cursor;
          requests.comments.set(key, (requests.comments.get(key) || 0) + 1);
          if (cursor === 20 || cursor === 40) {
            requests.nextPage++;
            const bottom = await request.frame().page().evaluate(() => window.qaPaginationBottoms.at(-1));
            assert.equal(bottom.cursor, cursor, 'Only reaching the current comment-list bottom may request another page');
            assert(bottom.remaining <= 2 && bottom.extent >= 5000, 'Long/image comments must really reach the bottom, not merely move 800 px');
            requests.paginationBottoms.set(key, bottom);
          }
        }
        await route.fulfill({ status: 200, headers: jsonHeaders(), body: JSON.stringify({ status_code: 0, comments: [comment(work, cursor === 0 ? 1 : cursor === 20 ? 2 : cursor === 40 ? 3 : 4)], has_more: cursor === 0 || cursor === 20 ? 1 : 0, cursor: cursor === 0 ? 20 : cursor === 20 ? 40 : 60, total: 3 }) }); return;
      }
      requests.aborted++; await route.abort();
    });
    await context.addCookies([{ name: 'sessionid', value: 'synthetic-local-qa-session-only', domain: '.douyin.com', path: '/', secure: true, httpOnly: true, expires: -1 }]);
    await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => fetch('/aweme/v1/web/user/profile/self/').then(response => response.json()));
    await page.waitForTimeout(100);
    assert((await inspectLoginState(page)).evidence.includes('successful_self_profile_response'), 'The actual browser self-profile response must have priority over the simultaneous avatar');
    assert.equal(await engine.isLoggedIn(page), true, 'Synthetic session plus trusted self-page proof must be recognized');
    // --source-navigation is only for checking this isolated boundary before
    // rebuilding. The normal pipeline exercises the release module itself.
    const navigationApp = process.argv.includes('--source-navigation') ? path.join(ROOT, 'dy-lead-app') : APP;
    const { navigateCollectionPage } = require(path.join(navigationApp, 'lib', 'collection-browser.js'));
    for (const status of [301, 302, 303, 307, 308]) {
      let authorizations = 0;
      await navigateCollectionPage(page, 'https://v.douyin.com/qa-navigation-' + status + '/', { authorize: async () => { authorizations++; }, checkStopped: () => {} });
      assert.equal(page.url(), 'https://www.douyin.com/user/qa_navigation_landing');
      assert.equal(authorizations, 3, 'Initial request, Location and target request must each check authorization');
    }
    const targetsBeforeDenial = requests.boundaryTargets;
    await assert.rejects(navigateCollectionPage(page, 'https://v.douyin.com/qa-navigation-foreign/', { authorize: async () => {}, checkStopped: () => {} }), error => error.code === 'PAGE_REDIRECT');
    assert.equal(requests.foreignTargets, 0, 'Foreign Location must be rejected before any target request');
    const revoked = Object.assign(new Error('本地合成授权已撤销'), { code: 'AUTH_REQUIRED' });
    for (const denyAt of [2, 3]) {
      let authorizationCalls = 0;
      await assert.rejects(navigateCollectionPage(page, 'https://v.douyin.com/qa-navigation-302/', { authorize: async () => { if (++authorizationCalls === denyAt) throw revoked; }, checkStopped: () => {} }), error => error === revoked);
    }
    const stopped = Object.assign(new Error('本地合成停止'), { code: 'TASK_STOPPED' });
    let stopping = false;
    await assert.rejects(navigateCollectionPage(page, 'https://v.douyin.com/qa-navigation-302/', { authorize: async () => { stopping = true; }, checkStopped: () => { if (stopping) throw stopped; } }), error => error === stopped);
    assert.equal(requests.boundaryTargets, targetsBeforeDenial, 'Denied and stopped redirects must not reach the target page');
    await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded' });
    assert.equal(await engine.isLoggedIn(page), true, 'Temporary CDP interception must be removed and Playwright routes must still work');
    if (process.argv.includes('--source-navigation')) {
      console.log('PASS: source navigation boundary checks real HTTP 301/302/303/307/308, foreign Location, revocation, stop and cleanup in isolated Chromium');
      return;
    }
    const callbackNames = new Set();
    const commentOpenStates = new Map(), recommendationScrolls = new Map();
    let slowEmptyBodyRead = false, slowLoadingStatusSeen = false;
    const browserActions = require(path.join(APP, 'lib', 'browser-actions.js'));
    const expectedCallbacks = new Set([browserActions.readPageHealth.name]);
    const evaluate = page.evaluate.bind(page);
    page.evaluate = async (callback, arg) => {
      if (typeof callback === 'function' && expectedCallbacks.has(callback.name)) callbackNames.add(callback.name);
      const value = await evaluate(callback, arg);
      if (page.url().includes('/note/' + works[1].id)) {
        if (engine.taskState.status === '作品页面尚在加载，等待浏览器确认账号状态，可随时停止') slowLoadingStatusSeen = true;
        if (value && typeof value === 'object' && Object.hasOwn(value, 'bodyReady') && value.bodyReady === false) {
          slowEmptyBodyRead = true;
          await evaluate(() => window.qaScheduleHydration());
        }
      }
      if (typeof callback === 'function' && callback.name === 'openComments') {
        const id = page.url().match(/\/(?:video|note)\/(\d+)/)[1];
        if (!arg || arg.probe !== true) commentOpenStates.set(id, value.state);
        const fixtureState = await evaluate(() => ({ opens: window.qaCommentOpenClicks, recommendations: window.qaRecommendationScrolls }));
        recommendationScrolls.set(id, fixtureState.recommendations);
        assert.equal(fixtureState.opens, arg && arg.probe === true ? 0 : workById.get(id).kind === 'note' ? 1 : 0, 'Read-only probes must not click; notes explicitly open comments once');
      }
      if (typeof callback === 'function' && callback.name === 'scrollComments') {
        assert.equal(value.state, 'scrolled'); assert.equal(value.moved, true);
        const id = page.url().match(/\/(?:video|note)\/(\d+)/)[1];
        recommendationScrolls.set(id, await evaluate(() => window.qaRecommendationScrolls));
      }
      if (value && typeof value === 'object' && Object.hasOwn(value, 'accountMenu')) {
        if (value.accountMenu) workLoginEvidence.add('plain-private-menu');
        if (value.ownAvatar) workLoginEvidence.add('icon-only-top-self-link');
        if (!value.accountMenu && !value.ownAvatar && /\/(video|note)\//.test(page.url())) workLoginEvidence.add('closed-menu-context-proof');
      }
      return value;
    };
    baselineListeners = page.listenerCount('response');
    const input = [
      'https://www.douyin.com/video/' + works[0].id,
      'https://www.douyin.com/note/' + works[1].id,
      '2.38 复制打开抖音，看看【本地测试作品】 https://v.douyin.com/qa-video/ 07/13 :1pm ytR:/',
      '1.23 复制打开抖音，看看【本地测试图文】 https://v.douyin.com/qa-note/ 04/24 :6pm',
      'https://www.douyin.com/video/' + works[0].id + '?from=duplicate',
      'https://www.douyin.com/note/' + works[3].id
    ].join('\n');
    const result = await engine.collectTask(accountId, input);
    if (!result.ok) {
      const login = await require(path.join(APP, 'lib', 'login-state.js')).inspectLoginState(page);
      const cookies = await context.cookies([page.url()]);
      const signals = await page.evaluate(() => ({
        visibleLogout: Array.from(document.querySelectorAll('button,a,[role="button"],[role="menuitem"],[tabindex]')).some(element => element.getClientRects().length && /^(退出登录|退出登陆)$/.test((element.textContent || '').trim())),
        visibleLogin: Array.from(document.querySelectorAll('button,a,[role="button"]')).some(element => element.getClientRects().length && /^(登录|扫码登录)$/.test((element.textContent || '').trim())),
        bodyReady: !!(document.body && (document.body.innerText || document.body.textContent || '').trim()),
        loaded: document.readyState !== 'loading'
      }));
      console.error(JSON.stringify({ fixtureLoginState: login.state, evidence: login.evidence, signalBooleans: signals, syntheticCookieMetadata: cookies.map(cookie => ({ name: cookie.name, domain: cookie.domain, path: cookie.path, expires: cookie.expires, secure: cookie.secure })), worksNavigated: [...requests.documents.keys()].length, worksFirstPageCaptured: [...requests.comments.keys()].filter(key => key.endsWith(':0')).length }, null, 2));
    }
    assert.equal(result.ok, true, result.error);
    assert.equal(result.processed, 4, 'Resolved short links and full links must deduplicate by work ID');
    assert.equal(result.completed, 4); assert.equal(result.partial, 0);
    assert.equal(result.newLeads, 12, 'Each work must capture the initial page and two pages after reaching the growing comment list bottom');
    assert.equal(store.getLeads().length, 12);
    assert(result.ai && result.ai.ok, 'Shipping collection must hand off to the actual batch AI engine');
    assert.equal(aiRequests.reduce((sum, n) => sum + n, 0), 12);
    assert(aiRequests.some(n => n > 1), 'Collection hand-off must batch comments');
    const AI = require(path.join(APP, 'ai.js'));
    assert(store.getLeads().every(row => AI.isCurrentResult(row, store.getSettings(), store.getVideos())));
    assert.equal(engine.taskState.collectionSummary.aiPendingCount, 0);
    assert.equal(engine.taskState.collectionSummary.aiStatus, 'completed');
    assert.equal(engine.taskState.stage, 'review_ready');
    assert.equal(store.getAccounts()[0].loginStatus, 'authenticated', 'Collection and account-card login state must agree');
    assert.equal(slowEmptyBodyRead, true, 'The shipping login inspector must really see an empty SPA body before hydration');
    assert.equal(slowLoadingStatusSeen, true, 'Only explicit page-loading evidence should wait and then resume the same verified browser session');
    assert(store.getAccounts()[0].loginCheckedAt, 'Collection must update the visible last-inspected time');
    assert.deepEqual(workLoginEvidence, new Set(['plain-private-menu', 'icon-only-top-self-link', 'closed-menu-context-proof']), 'Real Chromium must test plain menus, icon-only avatars and closed-menu session reuse');
    const videos = store.getVideos();
    for (const work of works) {
      assert(requests.documents.get(work.id) >= 1, 'Each synthetic work must really be navigated');
      assert.equal(requests.comments.get(work.id + ':0'), 1, 'First comment page must be captured once per work');
      assert.equal(requests.comments.get(work.id + ':20'), 1, 'Second comment page must be triggered by real panel scrolling');
      assert.equal(requests.comments.get(work.id + ':40'), 1, 'The next scroll must reach the bottom after page height grows');
      assert(requests.paginationBottoms.get(work.id + ':40').extent > requests.paginationBottoms.get(work.id + ':20').extent, 'A second page must grow the comment container before another scroll');
      assert.equal(videos[work.id].videoLink, 'https://www.douyin.com/' + work.kind + '/' + work.id, 'History must preserve the resolved work kind');
      assert.equal(videos[work.id].collectionState, 'complete');
      assert.equal(videos[work.id].collectionCheckpoint.lastHasMore, 0);
      assert.equal(videos[work.id].collectionCheckpoint.commentResponseCount, 3);
      assert.equal(videos[work.id].collectionCheckpoint.noProgressRounds, 0);
      assert.equal(videos[work.id].desc, workBody(work));
      assert.equal(videos[work.id].workTitle, workTitle(work));
      assert.equal(videos[work.id].workContent, workBody(work));
      assert.equal(videos[work.id].workText, workTitle(work) + '\n\n' + workBody(work));
      assert.equal(videos[work.id].workSourcePath, work.id === works[1].id ? '/note/' + work.id : '/aweme/v1/web/aweme/detail/');
      assert(videos[work.id].workCapturedAt);
      assert.equal(videos[work.id].descriptionSource, work.id === works[1].id ? 'page_json' : 'api');
      assert.equal(commentOpenStates.get(work.id), work.kind === 'note' ? 'opened' : 'ready');
      assert.equal(recommendationScrolls.get(work.id), 0, 'Generic recommendation scroll-list must never be scrolled');
      assert.equal(videos[work.id].scanCount, 1);
      assert(store.getLeads().filter(lead => lead.videoLink === videos[work.id].videoLink).length === 3, 'Lead history must preserve the resolved work link');
    }
    const { projectLead, publicLeadFields, createLeadWorkbook } = require(path.join(APP, 'lib', 'lead-fields.js'));
    const mainFields = publicLeadFields().fields.filter(field => field.defaultVisible);
    assert.deepEqual(mainFields.map(field => field.label), ['编号', '评论时间', 'UID', '用户名称', 'AI判断', 'AI评分', 'AI理由', '触发词', '需求内容', '视频描述', '主页链接']);
    for (const lead of store.getLeads()) {
      const id = lead.videoLink.match(/\/(?:video|note)\/(\d+)/)[1];
      assert(lead.commentId); assert.equal(lead.commentLevel, 1);
      assert.equal(lead.commentSourcePath, '/aweme/v1/web/comment/list/');
      assert(lead.commentCapturedAt); assert.equal(lead.userSourcePath, '/aweme/v1/web/comment/list/');
      assert.equal(lead.signature, '评论响应已有签名'); assert.equal(lead.followerCount, 0);
      assert.equal(lead.profileCapturedAt, undefined, 'Nested comment user data must not imply an extra profile visit');
      assert.equal(projectLead(lead, videos).fieldValues.videoDesc, videos[id].workText);
    }
    const XLSX = require(path.join(APP, 'lib', 'xlsx.full.min.js'));
    const { writeLeadXlsx } = require(path.join(APP, 'lib', 'lead-xlsx-format.js'));
    const exported = XLSX.read(writeLeadXlsx(XLSX, createLeadWorkbook(XLSX, store.getLeads(), videos)), { type: 'buffer' });
    assert.deepEqual(exported.SheetNames, ['获客线索']);
    const exportSheet = exported.Sheets['获客线索'];
    const exportRange = XLSX.utils.decode_range(exportSheet['!autofilter'].ref);
    assert.equal(exportRange.s.r, 3); assert.equal(exportRange.e.r, store.getLeads().length + 3);
    const exportRows = XLSX.utils.sheet_to_json(exportSheet, { header: 1, defval: '', blankrows: true });
    const fullHeaderRow = exportRows.findIndex(row => row[0] === '记录类型' && row[2] === '字段key');
    assert(fullHeaderRow >= 0, 'Long text section must remain on the single worksheet');
    const fullRows = exportRows.slice(fullHeaderRow + 1);
    const longLead = store.getLeads().find(lead => lead.videoLink.endsWith(works[1].id));
    assert.equal(fullRows.filter(row => row[0] === '线索' && row[1] === String(longLead.id) && row[2] === 'videoDesc').sort((a, b) => a[4] - b[4]).map(row => JSON.parse(row[8])).join(''), videos[works[1].id].workText, 'Shipping XLSX must retain the complete long note including original line endings');
    // An already-observed profile response supplements the same user; the
    // engine itself does not initiate any additional profile traversal.
    await page.evaluate(uid => fetch('/aweme/v1/web/user/profile/other/?sec_user_id=' + uid).then(response => response.json()), 'qa_comment_' + works[0].id + '_1');
    for (let i = 0; i < 40 && !store.getLeads().find(lead => lead.uid === 'qa_comment_' + works[0].id + '_1').profileCapturedAt; i++) await page.waitForTimeout(25);
    const supplementedUser = store.getLeads().find(lead => lead.uid === 'qa_comment_' + works[0].id + '_1');
    assert.equal(supplementedUser.signature, '已有主页响应补充签名');
    assert.equal(supplementedUser.followerCount, 8);
    assert.equal(supplementedUser.profileSourcePath, '/aweme/v1/web/user/profile/other/');
    assert(supplementedUser.profileCapturedAt);
    assert.equal(requests.nextPage, 8); assert(requests.shortRedirects >= 2);
    assert(activeCollectionListenerSeen, 'Collection response listener must have been active');
    assert.equal(page.listenerCount('response'), baselineListeners, 'Collection must remove its response listener on completion');
    await page.evaluate(id => fetch('/aweme/v1/web/comment/list/?aweme_id=' + id + '&cursor=999').then(response => response.json()), works[3].id);
    await page.waitForTimeout(100);
    assert.equal(store.getLeads().length, 12, 'Browsing after completion must not add comments to the finished collection');

    // A historical generic video URL may refer to the same image work. Its
    // query string and old route must not defeat comment deduplication on a
    // forced note rescan in the actual shipping engine.
    const historicalNote = works[1], historicalLeads = store.getLeads();
    const legacyLead = historicalLeads.find(lead => lead.videoLink === 'https://www.douyin.com/note/' + historicalNote.id);
    assert(legacyLead, 'The isolated note history must exist before simulating the legacy renderer');
    legacyLead.videoLink = 'https://www.douyin.com/video/' + historicalNote.id + '?from=legacy';
    store.setLeads(historicalLeads);
    const oldNavigations = requests.documents.get(historicalNote.id);
    const oldScrolledPages = requests.comments.get(historicalNote.id + ':20');
    const rescan = await engine.collectTask(accountId, [{ url: 'https://www.douyin.com/note/' + historicalNote.id, force: true }]);
    assert.equal(rescan.ok, true, rescan.error); assert.equal(rescan.processed, 1); assert.equal(rescan.completed, 1);
    assert.equal(rescan.newLeads, 0, 'Legacy video/note routes for one work must not duplicate existing comments');
    assert.equal(store.getLeads().length, 12);
    assert.equal(requests.documents.get(historicalNote.id), oldNavigations + 1);
    assert.equal(requests.comments.get(historicalNote.id + ':20'), oldScrolledPages + 1);
    assert.equal(page.listenerCount('response'), baselineListeners);

    // Use the shipping engine's real fixed-plan/action path with local buttons.
    // This also exercises native locator actions through the obfuscated caller.
    const actionLead = { id: 999000, accountId, uid: 'qa_action_user', homepage: 'https://www.douyin.com/user/qa_action_user', nickname: '本地动作测试用户', demand: '本地明确需求', manualApproved: true, businessId: 'default', status: 'new' };
    store.setLeads([...store.getLeads(), actionLead]);
    const plan = engine.createPlan(accountId, 'outreach', { leadIds: [actionLead.id] });
    assert.equal(plan.ok, true); assert.equal(plan.count, 1);
    const outcome = await engine.outreachTask(accountId, { planId: plan.id });
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.followCount, 1); assert.equal(outcome.pendingCount, 1); assert.equal(outcome.dmCount, 0);
    assert.deepEqual(await page.evaluate(() => window.qaActions), { follows: 1, openDm: 1, inputs: 1, sends: 1 });
    assert.deepEqual(callbackNames, expectedCallbacks, 'The active shipping health callback must run successfully in Chromium');
    const saved = store.getLeads().find(lead => lead.id === actionLead.id);
    assert.equal(saved.followState, 'confirmed_success'); assert.equal(saved.dmState, 'pending_verification');
    assert(saved.followAttemptId, 'The matching follow attempt identifier must survive the real engine persistence path');
    assert.equal(store.getDailyUsage(accountId).dm, 0, 'An unknown receipt must not count as successful delivery');
    const pendingPlan = engine.createPlan(accountId, 'outreach', { leadIds: [actionLead.id] });
    assert.equal(pendingPlan.count, 1, 'Current follow relationship may still be checked while delivery remains pending');
    assert.deepEqual(pendingPlan.leads[0].actions, { follow: true, dm: false }, 'Pending delivery must never be scheduled for automatic resend');
    assert.equal(engine.createPlan(accountId, 'dm', { leadIds: [actionLead.id] }).count, 0, 'A DM-only plan must exclude pending delivery');
    assert.equal(page.listenerCount('response'), baselineListeners, 'Private-message observation listener must also be removed');
    assert.deepEqual((await context.cookies()).map(cookie => cookie.name), ['sessionid'], 'No real platform Cookie may appear in the synthetic profile');
    await context.clearCookies();
    const denied = await engine.collectTask(accountId, [{ url: 'https://www.douyin.com/video/' + works[0].id, force: true }]);
    assert.equal(denied.ok, false, 'Removing the current session must pause collection even if the old avatar remains');
    assert.equal(store.getAccounts()[0].loginStatus, 'unknown', 'Insufficient evidence must remain unknown instead of inventing a logged-out result');
    assert.equal(denied.error, store.getAccounts()[0].loginMessage, 'Task and account card must show exactly the same reason');
    assert.equal(store.getVideos()[works[0].id].collectionState, 'interrupted');
    assert.equal(store.getVideos()[works[0].id].collectionReason, denied.error);
    assert.equal((await inspectLoginState(page)).loggedIn, false);
    const report = {
      ok: true,
      actualObfuscatedReleaseEngine: true,
      releaseEngineSha256: crypto.createHash('sha256').update(shippingCode).digest('hex'),
      realChromium: true,
      visibleAccountBrowserRequested: true,
      isolatedDataAndProfile: true,
      allPageRequestsIntercepted: true,
      fallbackExternalTransportBlocked: true,
      platformRequestsMade: false,
      paidAiRequestsMade: false,
      automaticCollectionAiPipelineVerified: true,
      automaticAiUsesOnlyCapturedComments: true,
      automaticAiActualSavedResultsVerified: true,
      syntheticSessionAndSelfPageConfirmed: true,
      plainAccountMenuAndIconOnlySelfAvatarConfirmed: true,
      closedMenuReusesOnlySameVerifiedContextSession: true,
      commentLoginAndVerificationTextIgnored: true,
      taskAndAccountLoginStateSynchronized: true,
      removedSessionPausesWithAccurateUnknownReason: true,
      emptyBodySlowSpaLoadingWaitsThenCollectsSameSession: true,
      fullVideoCollection: true,
      noteNavigationAndHistoryPreserved: true,
      shortVideoAndNoteRedirects: true,
      shortLinksUseInterceptedFreshNavigation: true,
      http302RedirectFixtureUsed: true,
      allFiveHttpRedirectStatusesAuthorizedPerHop: true,
      foreignRedirectBlockedBeforeTargetRequest: true,
      revokedAndStoppedRedirectsNeverReachTarget: true,
      cdpCleanupPreservesPlaywrightRouting: true,
      mixedQueueDeduplicated: true,
      legacyVideoNoteHistoryDeduplicatedOnForcedRescan: true,
      firstAndScrolledCommentPagesCaptured: true,
      longAndImageCommentsOnlyLoadAtCurrentBottom: true,
      growingCommentContainerLoadsMultipleCursorPages: true,
      inactiveNoteCommentsExplicitlyOpenedBeforeFirstResponse: true,
      genericRecommendationListNeverScrolled: true,
      paginationProgressReportedFromTargetResponses: true,
      noteDescriptionFromExistingTargetPageWhenDetailRequestAbsent: true,
      noteUsesActualObservedStreamEnvelopeAndCamelCaseWorkId: true,
      structuredVideoAndNoteDetailDescriptionsPreferApi: true,
      actualTitlesAndLongNoteBodiesCapturedWithoutTruncation: true,
      fourInformationGroupsCarryObservedProvenance: true,
      nestedCommentUserDataRequiresNoAdditionalVisit: true,
      observedProfileResponseSupplementsSameUser: true,
      sharedElevenPrimaryFieldsAndWorkJoinVerified: true,
      longNoteXlsxJsonSegmentsExactlyReconstructed: true,
      hasMoreZeroCompletenessConfirmed: true,
      responseListenersRemoved: true,
      activeShippingHealthCallbackExecuted: true,
      nativeLocatorOutreachActionsExecuted: true,
      followConfirmedByMatchingPostResponse: true,
      unknownPrivateMessageReceiptRemainsPending: true,
      pendingMessageAutomaticResendBlocked: true
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log('PASS: actual obfuscated release uses self/follow responses, collects video/note/share-link queues and runs active action callbacks in isolated Chromium; all responses local');
  } finally {
    globalThis.fetch = originalFetch;
    if (engine) await engine.shutdown();
    if (transportBlocker) await new Promise(resolve => transportBlocker.close(resolve));
    if (path.dirname(fixture) !== __dirname || !path.basename(fixture).startsWith('qa-collection-build-')) throw new Error('Unsafe collection fixture cleanup');
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
