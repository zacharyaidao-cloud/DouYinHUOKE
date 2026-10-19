'use strict';

// Actual engine -> production backend client -> Electron account host -> CDP.
// Every page/response is synthetic and fulfilled locally. A rejecting proxy
// remains active for the entire account session. No real platform is contacted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
// 受限环境：系统临时目录可能不可写（Playwright 工件目录创建被拒），重定向到构建目录。
const QA_TMP = path.join(__dirname, 'qa-tmp');
fs.mkdirSync(QA_TMP, { recursive: true });
process.env.TEMP = process.env.TMP = QA_TMP;
const argument = key => { const index = process.argv.indexOf(key); return index < 0 ? null : process.argv[index + 1]; };
const appDir = path.resolve(argument('--app-dir') || path.join(root, 'dy-lead-app'));
const sourceMode = appDir === path.join(root, 'dy-lead-app');
const hostModule = sourceMode ? path.join(root, 'desktop', 'account-browser-host.js') :
  path.join(appDir, 'resources', 'app', 'account-browser-host.js');
const ACCOUNT = 'embedded-outreach-qa';
const SELF_UID = '7000000000000000999';
const MESSAGE = '内嵌本地验证，您好{昵称}';
const targets = [1, 2].map(index => ({ id: `embedded-lead-${index}`, accountId: ACCOUNT,
  uid: `embedded-sec-uid-${index}`, UID: `700000000000000010${index}`, nickname: `隔离样例${index}`,
  homepage: `https://www.douyin.com/user/embedded-sec-uid-${index}`, demand: '本机合成线索',
  manualApproved: true, status: 'new', dmCount: 0 }));
const trackedFiles = ['engine.js', 'engine-actions.js', 'workflow.js', 'scheduler.js', 'store.js',
  'lib/embedded-browser-client.js', 'lib/outreach-browser.js', 'lib/action-receipts.js',
  'lib/dm-receipt-observer.js', 'lib/dm-history-observer.js', 'lib/profile-relation-observer.js', 'lib/dm-protocol.js'];
function hashes() {
  return Object.fromEntries([...trackedFiles.map(file => [file, path.join(appDir, file)]),
    ['desktop/account-browser-host.js', hostModule], ['verify-embedded-outreach.js', __filename]]
    .map(([name, file]) => [name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
}

if (!process.versions.electron && !process.argv.includes('--client')) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('child_process').spawnSync(path.join(__dirname, 'electron-runtime-44.6.0', 'electron.exe'),
    [__filename, '--app-dir', appDir], { cwd: root, windowsHide: true, env, encoding: 'utf8', timeout: 180000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error) console.error(result.error.message);
  if (result.status !== 0 && result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status === 0 && !result.error ? 0 : 1;
} else if (process.argv.includes('--client')) runEngine().catch(error => {
  process.send?.({ type: 'qa-result', result: { ok: false, error: error.stack, diagnostics: error.testDiagnostics } });
});
else runHost().catch(error => { console.error(error.stack); require('electron').app.exit(1); });

async function runHost() {
  const { app, BrowserWindow } = require('electron');
  const { createAccountBrowserHost } = require(hostModule);
  const runDir = fs.mkdtempSync(path.join(__dirname, 'qa-embedded-outreach-'));
  const dataDir = path.join(runDir, 'data');
  const initialHashes = hashes();
  app.setPath('userData', path.join(runDir, 'electron-user-data'));
  app.enableSandbox();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1360, height: 880,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL('data:text/html,<title>isolated embedded outreach</title>');
  let child, opened = 0, closed = 0;
  const inputTiming = [], slowCommands = [], pendingCommands = new Map();
  let hostRendering;
  const host = createAccountBrowserHost({ window, appRoot: runDir,
    profileRoot: path.join(dataDir, 'electron-profiles'),
    sendEvent: packet => {
      if (packet.event.method === 'Host.closed') closed++;
      if (child?.connected) child.send({ type: 'embedded:event', ...packet });
    }
  });
  // 受限环境：刚复制出的发布目录 node.exe 可能被系统策略限制文件操作，
  // 客户端工作进程改用源码 node.exe 作解释器，加载的仍是指定 appDir 的发布代码。
  child = require('child_process').spawn(path.join(root, 'dy-lead-app', 'node.exe'), [__filename, '--client', '--app-dir', appDir], {
    cwd: root, windowsHide: true, env: { ...process.env, DY_LEAD_DATA_DIR: dataDir, DY_LEAD_EMBEDDED_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => void finish({ ok: false, error: 'Embedded engine verification timed out' }), 150000);
  let finished = false;
  async function finish(result) {
    if (finished) return;
    finished = true; clearTimeout(timer);
    await host.dispose();
    if (result.ok) {
      try {
        assert.deepEqual(hashes(), initialHashes, 'Sources changed during verification');
        assert.equal(opened, 1, 'Two users must reuse one embedded account page');
        assert.equal(closed, 1, 'Engine shutdown closes the account host exactly once');
      } catch (error) { result = { ...result, ok: false, error: error.message }; }
    }
    const report = { ...result, mode: sourceMode ? 'source' : 'release', appDirectory: appDir,
      sourceHashes: initialHashes, electron: process.versions.electron, chromium: process.versions.chrome,
      hostOpens: opened, hostCloses: closed,
      hostRendering, ...(!result.ok ? { inputTiming, slowCommands, pendingCommands: [...pendingCommands.values()] } : {}),
      routeInstrumentation: 'Playwright context.route through the production host; no CDP test shim',
      livePlatform: false, liveDmRequestsSent: 0, syntheticProtocolOnly: true, productionDataRead: false };
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2));
    const reportPath = path.join(__dirname, `embedded-outreach-${sourceMode ? 'source' : 'build'}-verification.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, resultPath: path.join(runDir, 'result.json') }));
    child.kill(); window.destroy(); app.exit(report.ok ? 0 : 1);
  }
  child.on('message', async message => {
    if (message.type === 'qa-result') return finish(message.result);
    if (message.type !== 'embedded:request') return;
    try {
      const { id, op, accountId, generation, payload } = message;
      assert.equal(accountId, ACCOUNT, 'Only the isolated fixture account can be opened');
      let result;
      if (op === 'open') {
        assert.equal(payload.profileDir, path.join(dataDir, 'electron-profiles', ACCOUNT));
        assert.match(payload.proxy?.server || '', /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.equal(payload.visible, true);
        result = await host.open({ ...payload, accountId, generation });
        const views = window.contentView.children.filter(view => view.webContents?.debugger?.isAttached());
        assert.equal(views.length, 1);
        const wc = views[0].webContents;
        hostRendering = { windowVisible: window.isVisible(), viewVisible: views[0].getVisible(),
          backgroundThrottling: wc.getBackgroundThrottling(), bounds: views[0].getBounds() };
        assert.equal((await wc.debugger.sendCommand('Target.getTargetInfo')).targetInfo.targetId, result.targetId);
        opened++;
      } else if (op === 'show') result = host.show(accountId, { generation });
      else if (op === 'close') result = await host.close({ accountId, generation });
      else if (op === 'command') {
        const start = Date.now();
        pendingCommands.set(id, { method: payload.method, start });
        try { result = await host.command({ accountId, generation, command: payload }); }
        finally {
          pendingCommands.delete(id);
          const timing = { method: payload.method, start, elapsedMs: Date.now() - start };
          if (payload.method.startsWith('Input.')) inputTiming.push({ ...timing, type: payload.params?.type });
          if (timing.elapsedMs >= 100) slowCommands.push(timing);
        }
      }
      else throw new Error('Unsupported fixture operation');
      if (child.connected) child.send({ type: 'embedded:reply', id, result });
    } catch (error) {
      if (child.connected) child.send({ type: 'embedded:reply', id: message.id, error: { code: -32000, message: error.message } });
    }
  });
  child.on('exit', code => { if (!finished) void finish({ ok: false, error: `Engine child exited ${code}` }); });
}

function protocolOptions(lead) {
  const index = targets.indexOf(lead);
  return { targetNumericUid: lead.UID, selfNumericUid: SELF_UID, sequenceId: String(9007199254741000n + BigInt(index)),
    conversationShortId: String(7000000000000000300n + BigInt(index)), clientMessageId: `embedded-synthetic-${index}`, inboxType: 1 };
}
function historyOptions(lead) {
  const options = protocolOptions(lead);
  return { ...options, command: 301, sequenceId: String(BigInt(options.sequenceId) + 1000n),
    conversationId: `0:1:${[SELF_UID, lead.UID].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).join(':')}` };
}
function pageHtml(lead) {
  const data = JSON.stringify({ sec: lead.uid, numeric: lead.UID, following: targets.indexOf(lead) === 1 });
  const asset = `tos-cn-i-0813c001_embeddedAvatarAsset${targets.indexOf(lead) + 1}23456789`;
  const other = targets.find(target => target !== lead);
  const otherAsset = `tos-cn-i-0813c001_embeddedAvatarAsset${targets.indexOf(other) + 1}23456789`;
  const row = (id, name, avatar) => `<div data-e2e="conversation-item" id="${id}" style="height:64px;cursor:pointer"><div class="conversationConversationItemrowArea1" style="display:flex;align-items:center;height:100%"><div class="commonIMAvataravatarContainer"><img width="36" height="36" src="https://p26.douyinpic.com/img/aweme-avatar/${avatar}~c5_100x100.webp"></div><div class="conversationConversationItemtitle">${name}</div></div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>内嵌本机触达验证</title>
    <style>body{font:16px sans-serif;padding:24px}button{font:inherit;padding:12px;margin:8px}section{border:1px solid #777;padding:24px}[hidden]{display:none!important}</style>
    </head><body><header><button id="wrong-follow">关注</button></header><main>
    <div id="profile"><div data-e2e="user-info"><span data-e2e="live-avatar"><img width="48" height="48" src="https://p3.douyinpic.com/img/aweme-avatar/${asset}~c5_300x300.jpeg"></span><h1>${lead.nickname}</h1>
      <div><button id="frame-user-info-share-button">分享</button><div><button id="open"><span class="semi-button-content">私信</span></button><button id="follow" data-e2e="user-info-follow-btn"></button></div></div>
    </div></div>
    <aside class="recommend"><button id="wrong-open">私信</button></aside>
    <aside id="drawer" hidden style="position:fixed;right:10px;top:10px;width:380px;height:570px;overflow:hidden;background:#fff">
      <div data-e2e="im-dialog" style="width:100%;height:100%"><div id="imSaasContainerId" class="StackLayoutStackLayoutV2wrapper" style="position:relative;height:100%">
        <div data-stack-layer="list" id="list" style="position:absolute;inset:0">${row('wrong-row', other.nickname, otherAsset)}${row('row', lead.nickname, asset)}</div>
        <div data-stack-layer="chat" id="chat" hidden style="position:absolute;inset:0;background:white">
          <div class="StackLayoutStackTitleBartitleBar" style="height:64px;background:#ddd"><div class="StackLayoutStackChatHeaderinfoContainer"><div class="StackLayoutStackChatHeaderuser"><div data-apm-action="个人页卡片"><img width="36" height="36" src="https://p26.douyinpic.com/img/aweme-avatar/${asset}~c5_168x168.webp"></div><div class="StackLayoutStackChatHeadertitle">${lead.nickname}</div></div></div></div>
          <div data-e2e="msg-input" class="messageMsgInputinputColumn"><div class="messageMsgInputinputRow"><div class="messageEditorimChatEditorContainer"><div id="editor" contenteditable="true" data-slate-editor="true" data-placeholder="发送消息" role="textbox" style="white-space:pre-wrap;min-height:50px;width:320px"></div></div>
          <div class="messageMsgInputinputAction"><svg id="send" class="messageMsgInputpublishBtn e2e-send-msg-btn" width="28" height="28" style="cursor:pointer"><path d="M14 3L24 15H18V26H10V15H4Z"></path></svg></div></div></div><div role="log"></div>
        </div></div></div></aside></main>
    <script>const qa=${data};const note=(kind,event,extra={})=>window.qaRecord({kind,uid:qa.sec,trusted:event.isTrusted,...extra});
    const follow=document.getElementById('follow');follow.textContent=qa.following?'已关注':'+ 关注';
    follow.onclick=event=>{note('follow',event);fetch('/aweme/v1/web/commit/follow/user/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({sec_user_id:qa.sec,user_id:qa.numeric,type:'1'})}).then(r=>r.json()).then(()=>follow.textContent='已关注')};
    document.getElementById('open').onclick=event=>{note('open',event);document.getElementById('drawer').hidden=false};
    document.getElementById('row').onclick=async event=>{note('select',event);document.getElementById('chat').hidden=false;const bytes=await window.qaHistory({uid:qa.sec});await(await fetch('https://imapi.douyin.com/v1/message/get_by_conversation',{method:'POST',headers:{'Content-Type':'application/x-protobuf'},body:Uint8Array.from(bytes)})).arrayBuffer()};
    const editor=document.getElementById('editor');editor.oninput=event=>{note('input',event,{length:editor.innerText.length});document.getElementById('send').classList.add('messageMsgInputpublishRedBtn')};
    document.getElementById('send').onclick=async event=>{note('send',event,{length:editor.innerText.length});const bytes=await window.qaSend({uid:qa.sec,message:editor.innerText});await(await fetch('https://imapi.douyin.com/v1/message/send',{method:'POST',headers:{'Content-Type':'application/x-protobuf'},body:Uint8Array.from(bytes)})).arrayBuffer();editor.textContent='';document.querySelector('[role=log]').textContent='本地合成响应'};
    for(const id of ['wrong-follow','wrong-open','wrong-row'])document.getElementById(id).onclick=event=>note('wrong',event);
    fetch('/aweme/v1/web/user/profile/self/').then(r=>r.json());fetch('/aweme/v1/web/user/profile/other/?sec_user_id='+encodeURIComponent(qa.sec)).then(r=>r.json());
    </script></body></html>`;
}

async function runEngine() {
  const net = require('net');
  const { makeSendRequest, makeSendResponse } = require('../dy-lead-app/tests/helpers/im-fixture');
  const { request: historyRequest, response: historyResponse } = require('../dy-lead-app/tests/helpers/im-history-fixture');
  const chromium = require(path.join(appDir, 'node_modules', 'playwright-core')).chromium;
  const originalLaunch = chromium.launchPersistentContext;
  chromium.launchPersistentContext = () => { throw new Error('The embedded test must never launch external Chromium'); };
  let rejectedProxyConnections = 0;
  const blocker = net.createServer(socket => { rejectedProxyConnections++; socket.destroy(); });
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const rejectingProxy = `http://127.0.0.1:${blocker.address().port}`;
  let engine;
  const nativeEvents = [], requests = [], routeErrors = [], pageErrors = [], authorizations = [], recipientEvidence = [];
  let legacyNavigations = 0, forbiddenRouteRequests = 0;
  try {
    if (!sourceMode) for (const file of trackedFiles.filter(file => !file.startsWith('lib/')))
      assert.match(fs.readFileSync(path.join(appDir, file), 'utf8'), /_0x[0-9a-f]+/i, `Actual obfuscated release required: ${file}`);
    engine = require(path.join(appDir, 'engine.js'));
    const store = require(path.join(appDir, 'store.js'));
    assert.equal(path.resolve(store.DATA_DIR), path.resolve(process.env.DY_LEAD_DATA_DIR));
    store.setAccounts([{ id: ACCOUNT, name: '内嵌本机合成账号', browserMode: 'embedded', proxy: rejectingProxy, loginState: '未登录' }]);
    store.setLeads(targets.map(lead => ({ ...lead })));
    const settings = store.getSettings();
    settings.follow = { ...settings.follow, enabled: true, dailyLimit: 160 };
    settings.dm = { ...settings.dm, enabled: true, dailyLimit: 80, template: MESSAGE, skipAuthor: true,
      repeat: { enabled: false, intervalDays: 7 } };
    settings.action = { pacingVersion: 1, userIntervalSec: 0, userIntervalJitter: 0 };
    settings.human = { ...settings.human, workPeriods: [], breakEvery: 0, maxConsecutiveErrors: 3 };
    store.setSettings(settings);
    engine.configure({ authorize: async metadata => { authorizations.push({ kind: metadata.kind, uid: metadata.uid }); return { ok: true }; } });
    const alive = await engine.launchAccount(ACCOUNT, { headless: false });
    assert.equal(alive.embedded, true);
    const { context, page } = alive;
    page.on('pageerror', error => pageErrors.push(error.message));
    await context.exposeBinding('qaRecord', (source, event) => {
      const lead = targets.find(item => item.uid === event.uid);
      assert(lead); assert.equal(source.page, page); assert.equal(source.frame.url(), lead.homepage);
      nativeEvents.push({ kind: event.kind, uid: event.uid, trusted: event.trusted, length: event.length, at: Date.now() });
    });
    await context.exposeBinding('qaSend', (source, event) => {
      const lead = targets.find(item => item.uid === event.uid);
      assert(lead); assert.equal(source.frame.url(), lead.homepage);
      assert.equal(event.message, engine.applyTemplate(MESSAGE, lead));
      const diagnostic = require(path.join(appDir, 'lib', 'outreach-browser')).getDiagnostic(page);
      assert.equal(diagnostic.conversationRowEvidence, 'dom_profile_name');
      assert.equal(diagnostic.recipientEvidence, 'dom_profile_name');
      recipientEvidence.push({ uid: lead.uid, recipient: diagnostic.recipientEvidence, row: diagnostic.conversationRowEvidence });
      return Array.from(makeSendRequest({ ...protocolOptions(lead), message: event.message }));
    });
    await context.exposeBinding('qaHistory', (source, event) => {
      const lead = targets.find(item => item.uid === event.uid);
      assert(lead); assert.equal(source.frame.url(), lead.homepage);
      return Array.from(historyRequest(historyOptions(lead)));
    });
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        if (url.protocol !== 'https:') return route.abort();
        if (['iesdouyin.com', 'www.iesdouyin.com'].includes(url.hostname) && request.isNavigationRequest()) {
          if (url.pathname === '/fixture-redirect') return route.fulfill({ status: 302,
            headers: { location: 'https://untrusted.invalid/fixture-denied' }, body: '' });
          assert.equal(url.pathname, '/share/video/12345678');
          legacyNavigations++;
          return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Local legacy share</title>' });
        }
        if (url.hostname === 'untrusted.invalid' || url.hostname.includes('iesdouyin')) {
          forbiddenRouteRequests++; return route.abort();
        }
        if (['p3.douyinpic.com', 'p26.douyinpic.com'].includes(url.hostname) &&
          /^\/img\/aweme-avatar\/tos-cn-i-0813c001_embeddedAvatarAsset[12]23456789~c5_\d+x\d+\.(?:jpeg|webp)$/.test(url.pathname))
          return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
        if (url.hostname === 'imapi.douyin.com' && ['/v1/message/send', '/v1/message/get_by_conversation'].includes(url.pathname)) {
          const cors = { 'access-control-allow-origin': 'https://www.douyin.com', 'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type', 'access-control-max-age': '0' };
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
          assert.equal(request.method(), 'POST'); assert.equal(request.headers().origin, 'https://www.douyin.com');
          const lead = targets.find(item => item.homepage === request.frame().url());
          assert(lead, 'Each protocol request belongs to the current profile, never the preceding target');
          const history = url.pathname.endsWith('/get_by_conversation');
          if (history) {
            assert.deepEqual(request.postDataBuffer(), historyRequest(historyOptions(lead)));
            assert.equal(nativeEvents.filter(row => row.uid === lead.uid && row.kind === 'select').length, 1);
            assert.equal(nativeEvents.filter(row => row.uid === lead.uid && row.kind === 'input').length, 0);
          } else {
            assert.deepEqual(request.postDataBuffer(), makeSendRequest({ ...protocolOptions(lead), message: engine.applyTemplate(MESSAGE, lead) }));
            assert(authorizations.some(row => row.kind === 'dm' && row.uid === lead.uid));
          }
          requests.push({ kind: history ? 'history' : 'dm', uid: lead.uid });
          return route.fulfill({ status: 200, headers: cors, contentType: 'application/x-protobuf', body: history
            ? historyResponse({ ...historyOptions(lead), messages: [] }) : makeSendResponse({ ...protocolOptions(lead), status: 0 }) });
        }
        if (url.hostname !== 'www.douyin.com') return route.abort();
        if (request.isNavigationRequest() && url.pathname.startsWith('/user/')) {
          const lead = targets.find(item => item.homepage === url.href); assert(lead);
          assert.equal(authorizations.at(-1)?.kind, 'profile_redirect'); assert.equal(authorizations.at(-1)?.uid, lead.uid);
          requests.push({ kind: 'profile', uid: lead.uid });
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml(lead) });
        }
        if (url.pathname === '/aweme/v1/web/user/profile/self/') return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ status_code: 0, is_login: true, user: { uid: SELF_UID } }) });
        if (url.pathname === '/aweme/v1/web/user/profile/other/') {
          const lead = targets.find(item => item.uid === url.searchParams.get('sec_user_id')); assert(lead);
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status_code: 0,
            user: { uid: lead.UID, sec_uid: lead.uid, nickname: lead.nickname, follow_status: targets.indexOf(lead) === 1 ? 1 : 0 } }) });
        }
        if (url.pathname === '/aweme/v1/web/commit/follow/user/') {
          const fields = new URLSearchParams(request.postData());
          assert.equal(fields.get('sec_user_id'), targets[0].uid); assert.equal(fields.get('user_id'), targets[0].UID);
          assert.equal(fields.get('type'), '1'); assert.equal(request.method(), 'POST');
          requests.push({ kind: 'follow', uid: targets[0].uid });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status_code: 0,
            follow_status: 1, sec_user_id: targets[0].uid, user_id: targets[0].UID }) });
        }
        return route.abort();
      } catch (error) { routeErrors.push(error.message); await route.abort().catch(() => {}); }
    });
    await context.addCookies([{ name: 'sessionid', value: 'synthetic-embedded-session-not-real', domain: '.douyin.com',
      path: '/', expires: -1, secure: true, httpOnly: true }]);
    const plan = engine.createPlan(ACCOUNT, 'outreach', { leadIds: targets.map(lead => lead.id), filters: { f: 'all' }, owner: 'embedded-qa' });
    assert.equal(plan.count, 2); assert.equal(plan.schemaVersion, 3); assert.equal(plan.requiresRelationCheck, true);
    const result = await engine.outreachTask(ACCOUNT, { planId: plan.planId, follow: plan.actions.follow, dm: plan.actions.dm });
    const detail = [result.error, ...engine.taskState.errors.map(error => error.error), ...routeErrors, ...pageErrors].filter(Boolean).join('; ');
    assert.equal(result.ok, true, detail); assert.equal(result.followCount, 1, detail); assert.equal(result.dmCount, 2, detail);
    assert.equal(result.pendingCount, 0, detail); assert.equal(result.failedCount, 0, detail); assert.equal(result.skipped, 1, detail);
    assert.equal(engine.taskState.done, 2); assert.equal(engine.taskState.running, false);
    assert.equal((await engine.launchAccount(ACCOUNT, { headless: false })).context, context); assert.equal(context.pages().length, 1);
    const saved = targets.map(target => store.getLeads().find(lead => lead.id === target.id));
    assert.equal(saved[0].followState, 'confirmed_success'); assert.ok(saved[0].followedAt);
    assert.equal(saved[1].followObserved.state, 'following'); assert.equal(saved[1].followObserved.accountId, ACCOUNT);
    assert.equal(saved[1].followedAt, undefined, 'Already following is observed, not counted as a new follow');
    assert.notEqual(saved[0].dmAttemptId, saved[1].dmAttemptId);
    for (const [index, lead] of saved.entries()) {
      assert.equal(lead.dmState, 'confirmed_success'); assert.equal(lead.dmCount, 1); assert.ok(lead.dmSentAt);
      assert.match(lead.dmEvidence, /im-protobuf:.*send=0/); assert.equal(lead.dmAttemptAccountId, ACCOUNT);
      assert.equal(lead.dmHistoryObserved.state, 'no_outbound'); assert.equal(lead.dmHistoryObserved.complete, true);
      assert.equal(lead.dmMessageHash, crypto.createHash('sha256').update(engine.applyTemplate(MESSAGE, targets[index])).digest('hex'));
      for (const kind of ['profile', 'history', 'dm']) assert.equal(requests.filter(row => row.uid === lead.uid && row.kind === kind).length, 1);
      for (const kind of ['open', 'select', 'send']) assert.equal(nativeEvents.filter(row => row.uid === lead.uid && row.kind === kind).length, 1);
      assert(nativeEvents.some(row => row.uid === lead.uid && row.kind === 'input' && row.length > 0));
    }
    assert.deepEqual(requests.filter(row => row.kind === 'profile').map(row => row.uid), targets.map(lead => lead.uid));
    assert.deepEqual(requests.filter(row => row.kind === 'dm').map(row => row.uid), targets.map(lead => lead.uid));
    assert.deepEqual(recipientEvidence.map(row => row.uid), targets.map(lead => lead.uid));
    assert.equal(nativeEvents.filter(row => row.kind === 'follow').length, 1);
    assert.equal(nativeEvents.filter(row => row.kind === 'wrong').length, 0);
    assert(nativeEvents.every(row => row.trusted === true));
    assert.deepEqual(routeErrors, []); assert.deepEqual(pageErrors, []);
    const diagnostic = require(path.join(appDir, 'lib', 'outreach-browser')).getDiagnostic(page);
    assert.equal(diagnostic.conversationRowEvidence, 'dom_profile_name');
    assert.equal(diagnostic.recipientEvidence, 'dom_profile_name');
    const usage = store.getDailyUsage(ACCOUNT);
    assert.equal(usage.followAttempts, 1); assert.equal(usage.follow, 1); assert.equal(usage.dmAttempts, 2); assert.equal(usage.dm, 2);
    assert.equal(engine.createPlan(ACCOUNT, 'dm', { leadIds: targets.map(lead => lead.id), filters: { f: 'all' } }).count, 0);
    // Navigation-boundary cases are independent of the two-user action task.
    // Exercise them after action assertions so intentionally cancelled loads
    // cannot become an artificial prerequisite for a fresh outreach task.
    for (const hostname of ['iesdouyin.com', 'www.iesdouyin.com']) {
      await page.goto(`https://${hostname}/share/video/12345678`);
      assert.equal(await page.title(), 'Local legacy share');
    }
    for (const address of ['http://iesdouyin.com/share/video/12345678', 'https://sub.iesdouyin.com/share/video/12345678',
      'https://iesdouyin.com.untrusted.invalid/share/video/12345678', 'https://iesdouyin.com:444/share/video/12345678',
      'https://user:fixture@iesdouyin.com/share/video/12345678']) {
      const previousUrl = page.url();
      await assert.rejects(page.goto(address));
      assert.equal(page.url(), previousUrl);
    }
    await assert.rejects(page.goto('https://iesdouyin.com/fixture-redirect'));
    assert.notEqual(new URL(page.url()).hostname, 'untrusted.invalid');
    assert.equal(legacyNavigations, 2);
    assert.equal(forbiddenRouteRequests, 0, 'Forbidden domains must be stopped by the host before fixture routes run');
    await engine.shutdown();
    process.send({ type: 'qa-result', result: { ok: true, users: 2, profileVisits: 2,
      nativeFollowClicks: 1, nativeConversationEntryClicks: 2, nativeConversationRowClicks: 2, nativeSendClicks: 2,
      confirmedFollowSuccess: 1, observedAlreadyFollowing: 1, confirmedDmSuccess: 2, dmFailures: 0, dmPending: 0,
      nativeTrustedEvents: true, noRecipientMixing: true, noAutomaticResend: true,
      defaultReceiptVerifier: true, engineEmbeddedLaunch: true, externalChromiumLaunches: 0,
      historyCheckedBeforeFill: true, taskCompleted: true, internalUserInfoActions: true,
      listAndChatMountedTogether: true, recipientEvidence: 'dom_profile_name', conversationRowEvidence: 'dom_profile_name',
      allowedLegacyNavigations: legacyNavigations, deniedNavigationVariants: 5, externalRedirectBlocked: true, rejectedProxyConnections } });
  } catch (error) {
    error.testDiagnostics = { targets: targets.map((target, index) => ({ ordinal: index + 1,
      events: nativeEvents.filter(row => row.uid === target.uid).map(row => ({ kind: row.kind, at: row.at })),
      requests: requests.filter(row => row.uid === target.uid).map(row => row.kind) })) };
    throw error;
  } finally {
    if (engine) await engine.shutdown();
    chromium.launchPersistentContext = originalLaunch;
    await new Promise(resolve => blocker.close(resolve));
  }
}
