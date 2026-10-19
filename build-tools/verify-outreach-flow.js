'use strict';

// Exercise the real shipping engine, scheduler, browser adapter and passive
// receipts. All accounts, messages and pages are synthetic. A rejecting local
// proxy and an allow-list of fulfilled browser routes prevent live traffic.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { makeSendRequest, makeSendResponse } = require('../dy-lead-app/tests/helpers/im-fixture');
const { request: makeHistoryRequest, response: makeHistoryResponse, message: makeHistoryMessage } = require('../dy-lead-app/tests/helpers/im-history-fixture');

const ROOT = path.resolve(__dirname, '..');
const sourceMode = process.argv.includes('--source');
const APP = path.join(ROOT, sourceMode ? 'dy-lead-app' : 'dy-lead-app-release');
const REPORT = path.join(__dirname, sourceMode ? 'outreach-flow-source-verification.json' : 'outreach-flow-build-verification.json');
const fixture = fs.mkdtempSync(path.join(__dirname, 'qa-outreach-flow-'));
process.env.DY_LEAD_DATA_DIR = path.join(fixture, 'data');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(APP, 'node_modules', 'playwright-core', '.local-browsers');
const ACCOUNT = 'outreach-isolated-qa';
const SESSION = 'local-outreach-fixture-session-not-a-real-cookie';
const SELF_UID = '7000000000000000999';
const MESSAGE = '本地隔离测试，您好{昵称}';
const targets = Array.from({ length: 17 }, (_, i) => ({
  id: 'outreach-fixture-' + (i + 1), accountId: ACCOUNT,
  uid: 'fixture-sec-uid-' + (i + 1), UID: '70000000000000001' + String(i + 1).padStart(2, '0'),
  nickname: '隔离样例' + (i + 1), homepage: 'https://www.douyin.com/user/fixture-sec-uid-' + (i + 1),
  demand: '本机隔离测试内容', manualApproved: true, status: 'new', dmCount: 0
}));
const primary = targets.slice(0, 3);
primary[1].followedAt = '2026-10-07 12:00:00'; primary[1].followState = 'confirmed_success';
primary[2].dmCount = 1; primary[2].dmLastAt = '2026-10-07 12:00:00'; primary[2].dmState = 'confirmed_success';
const unknown = targets.slice(3, 7);
for (const lead of unknown) { lead.followedAt = '2026-10-07 12:00:00'; lead.followState = 'confirmed_success'; }
for (const lead of targets.slice(7, 12)) { lead.followedAt = '2026-10-07 12:00:00'; lead.followState = 'confirmed_success'; }
const baselineTargets = targets.slice(0, 12), protocolTargets = targets.slice(9, 12), historyTargets = targets.slice(12);
const binaryTargets = [...protocolTargets, ...historyTargets];
const oldHistoryAt = Date.now() - 14 * 86400000;
function protocolOptions(lead) {
  const index = binaryTargets.findIndex(item => item.id === lead.id);
  assert(index >= 0, 'Only designated synthetic protocol targets may use the binary route');
  return { targetNumericUid: lead.UID, selfNumericUid: SELF_UID,
    sequenceId: String(9007199254741000n + BigInt(index)),
    conversationShortId: String(7000000000000000300n + BigInt(index)),
    clientMessageId: 'isolated-flow-client-' + index, inboxType: 1 };
}
function historyOptions(lead) {
  const index = historyTargets.findIndex(item => item.id === lead.id);
  assert(index >= 0, 'Only designated synthetic history targets may use the history route');
  const common = protocolOptions(lead);
  return { ...common, command: [301, 301, 1002, 1002, 301][index],
    sequenceId: String(BigInt(common.sequenceId) + 1000n),
    conversationId: `0:1:${[SELF_UID, lead.UID].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).join(':')}` };
}
function historyResponse(lead) {
  const index = historyTargets.findIndex(item => item.id === lead.id), common = historyOptions(lead);
  const messages = [0, 3].includes(index) ? [] : [makeHistoryMessage({ ...common, sender: SELF_UID, createTime: oldHistoryAt })];
  return makeHistoryResponse({ ...common, messages });
}

function pageHtml(lead) {
  const history = historyTargets.some(item => item.id === lead.id);
  const data = JSON.stringify({ sec: lead.uid, numeric: lead.UID, followed: !!lead.followedAt, binary: binaryTargets.some(item => item.id === lead.id),
    history: history ? historyOptions(lead).command : 0 });
  return `<!doctype html><html><head><meta charset="utf-8"><title>本地触达流程验证</title>
    <style>body{font:16px sans-serif;padding:24px}button,textarea{font:inherit;padding:12px;margin:8px}section{border:1px solid #777;padding:24px}[role=dialog]{padding:24px;border:1px solid #777}textarea{width:500px;height:80px}</style>
    </head><body><header><a href="/user/self">当前账号</a><button id="wrong-header-follow">关注</button></header>
    <main><section data-e2e="user-info"><h1>本地隔离目标用户</h1><button id="qa-follow"></button><button id="qa-open">私信</button></section>
    <aside class="recommend"><button id="wrong-related-follow">关注</button><button id="wrong-related-open">私信</button></aside>
    ${history ? `<div data-e2e="conversation-list" id="qa-message-list" style="display:none"><div role="listitem" data-e2e="conversation-row" data-recipient-sec-uid="${lead.uid}" id="qa-target-row" style="padding:20px;cursor:pointer">本地隔离目标会话</div></div>` : ''}
    <div role="dialog" data-e2e="message-panel" data-recipient-sec-uid="${lead.uid}" id="qa-conversation" style="display:none"><h2>本地隔离会话</h2><textarea aria-label="消息内容"></textarea><button id="qa-send" aria-label="发送消息"><svg width="24" height="24"><path d="M2 2L22 12L2 22Z"></path></svg></button><div role="log" class="message-history"></div></div></main>
    <script>
    const qa=${data};
    const note=(kind,event,extra={})=>window.qaRecord({kind,uid:qa.sec,trusted:event.isTrusted,...extra});
    const follow=document.getElementById('qa-follow'); follow.textContent=qa.followed?'已关注':'+ 关注';
    follow.addEventListener('click',event=>{note('follow',event);fetch('/aweme/v1/web/commit/follow/user/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({sec_user_id:qa.sec,user_id:qa.numeric,type:'1'})}).then(r=>r.json()).then(()=>{follow.textContent='已关注'});});
    document.getElementById('qa-open').addEventListener('click',event=>{note('open',event);document.getElementById(qa.history?'qa-message-list':'qa-conversation').style.display='block';});
    if(qa.history)document.getElementById('qa-target-row').addEventListener('click',async event=>{
      note('select',event);document.getElementById('qa-message-list').style.display='none';document.getElementById('qa-conversation').style.display='block';
      const bytes=await window.qaEncodeSyntheticHistory({uid:qa.sec});
      const endpoint=qa.history===301?'message/get_by_conversation':'stranger/get_messages';
      const response=await fetch('https://imapi.douyin.com/v1/'+endpoint,{method:'POST',headers:{'Content-Type':'application/x-protobuf'},body:Uint8Array.from(bytes)});
      await response.arrayBuffer();
    });
    const editor=document.querySelector('textarea'); editor.addEventListener('input',event=>note('input',event,{length:editor.value.length}));
    document.getElementById('qa-send').addEventListener('click',async event=>{
      note('send',event,{length:editor.value.length});
      if(qa.binary){
        const bytes=await window.qaEncodeSyntheticSend({uid:qa.sec,message:editor.value});
        const response=await fetch('https://imapi.douyin.com/v1/message/send',{method:'POST',headers:{'Content-Type':'application/x-protobuf'},body:Uint8Array.from(bytes)});
        await response.arrayBuffer();
        document.querySelector('[role=log]').textContent='本地合成二进制回执';
      }else{
        await fetch('/aweme/v1/web/im/message/send/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({sec_user_id:qa.sec,user_id:qa.numeric,content:editor.value})}).then(r=>r.json());
        document.querySelector('[role=log]').textContent='本地未解码回执';
      }
      editor.value='';
    });
    for(const id of ['wrong-header-follow','wrong-related-follow','wrong-related-open'])document.getElementById(id).addEventListener('click',event=>note('wrong-control',event));
    fetch('/aweme/v1/web/user/profile/self/').then(r=>r.json());
    fetch('/aweme/v1/web/user/profile/other/?sec_user_id='+encodeURIComponent(qa.sec)).then(r=>r.json());
    </script></body></html>`;
}

(async () => {
  let engine, chromium, originalLaunch, blocker, progressTimer;
  const opened = [], requests = [], nativeEvents = [], authorizations = [], progress = [], pageErrors = [], routingErrors = [], phases = [];
  let authorizationMode = 'allowed', latestAuthorization = null;
  try {
    fs.rmSync(REPORT, { force: true });
    const hashes = {};
    for (const file of ['engine.js', 'engine-actions.js', 'workflow.js', 'scheduler.js', 'lib/collection-browser.js', 'lib/outreach-browser.js', 'lib/action-receipts.js', 'lib/dm-receipt-observer.js', 'lib/dm-history-observer.js', 'lib/profile-relation-observer.js', 'lib/dm-protocol.js']) {
      const code = fs.readFileSync(path.join(APP, file), 'utf8');
      if (!sourceMode && !file.startsWith('lib/')) assert.match(code, /_0x[0-9a-f]+/i, 'Load the actual obfuscated release file: ' + file);
      hashes[file] = crypto.createHash('sha256').update(code).digest('hex');
    }
    chromium = require(path.join(APP, 'node_modules', 'playwright-core')).chromium;
    originalLaunch = chromium.launchPersistentContext;
    blocker = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
    const rejectingProxy = 'http://127.0.0.1:' + blocker.address().port;
    chromium.launchPersistentContext = async (profile, options) => {
      assert.equal(path.resolve(profile), path.join(fixture, 'data', 'chrome-profiles', ACCOUNT));
      assert.equal(options.headless, false, 'Outreach must use the visible account browser from the start');
      assert.equal(options.chromiumSandbox, true);
      assert.equal(options.proxy.server, rejectingProxy, 'Every origin remains behind the rejecting proxy');
      assert(fs.existsSync(options.executablePath), 'Use the browser selected by the actual engine');
      assert.equal(opened.length, 0, 'All tasks must reuse one visible account context');
      const context = await originalLaunch.call(chromium, profile, options);
      opened.push(context);
      try {
        await context.exposeBinding('qaRecord', (source, event) => {
          try {
            assert.equal(source.page.context(), context);
            assert(targets.some(lead => lead.uid === event.uid));
            nativeEvents.push({ kind: event.kind, uid: event.uid, trusted: event.trusted, length: event.length });
            phases.push({ kind: event.kind, uid: event.uid });
          } catch (error) { routingErrors.push(error.message); }
        });
        await context.exposeBinding('qaEncodeSyntheticSend', (source, event) => {
          assert.equal(source.page.context(), context);
          const lead = binaryTargets.find(item => item.uid === event.uid);
          assert(lead, 'Only a synthetic protocol target may encode a binary fixture');
          assert.equal(source.frame.url(), lead.homepage, 'The binary send belongs to the current profile');
          assert.equal(event.message, engine.applyTemplate(MESSAGE, lead), 'Encode the text actually filled by the production browser adapter');
          return Array.from(makeSendRequest({ ...protocolOptions(lead), message: event.message }));
        });
        await context.exposeBinding('qaEncodeSyntheticHistory', (source, event) => {
          assert.equal(source.page.context(), context);
          const lead = historyTargets.find(item => item.uid === event.uid);
          assert(lead, 'Only a synthetic history target may encode a history fixture');
          assert.equal(source.frame.url(), lead.homepage);
          return Array.from(makeHistoryRequest(historyOptions(lead)));
        });
        context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
        for (const page of context.pages()) page.on('pageerror', error => pageErrors.push(error.message));
        await context.route('**/*', async route => {
          try {
          const request = route.request(), url = new URL(request.url());
          if (url.protocol !== 'https:') return route.abort();
          if (url.hostname === 'imapi.douyin.com' && ['/v1/message/get_by_conversation', '/v1/stranger/get_messages'].includes(url.pathname) && !url.search) {
            const cors = { 'access-control-allow-origin': 'https://www.douyin.com', 'access-control-allow-methods': 'POST, OPTIONS',
              'access-control-allow-headers': 'content-type', 'access-control-max-age': '0' };
            assert.equal(request.headers().origin, 'https://www.douyin.com');
            if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
            assert.equal(request.method(), 'POST');
            assert.equal(request.headers()['content-type'], 'application/x-protobuf');
            const lead = historyTargets.find(item => item.homepage === request.frame().url());
            assert(lead, 'History must originate from the current synthetic target frame');
            const command = historyOptions(lead).command;
            assert.equal(url.pathname, command === 301 ? '/v1/message/get_by_conversation' : '/v1/stranger/get_messages');
            assert.deepEqual(request.postDataBuffer(), makeHistoryRequest(historyOptions(lead)));
            assert.equal(nativeEvents.filter(item => item.kind === 'select' && item.uid === lead.uid).length, 1, 'History loads only after the UI enters the selected conversation');
            assert.equal(nativeEvents.filter(item => item.kind === 'input' && item.uid === lead.uid).length, 0, 'The production engine has not filled before checking website history');
            requests.push({ kind: 'history', uid: lead.uid, method: 'POST', command });
            phases.push({ kind: 'history-response', uid: lead.uid });
            return route.fulfill({ status: 200, headers: cors, contentType: 'application/x-protobuf', body: historyResponse(lead) });
          }
          if (url.hostname === 'imapi.douyin.com' && url.pathname === '/v1/message/send' && !url.search) {
            const cors = { 'access-control-allow-origin': 'https://www.douyin.com', 'access-control-allow-methods': 'POST, OPTIONS',
              'access-control-allow-headers': 'content-type', 'access-control-max-age': '0' };
            assert.equal(request.headers().origin, 'https://www.douyin.com');
            if (request.method() === 'OPTIONS') {
              assert.equal(request.headers()['access-control-request-method'], 'POST');
              requests.push({ kind: 'dm-preflight', method: 'OPTIONS' });
              return route.fulfill({ status: 204, headers: cors, body: '' });
            }
            assert.equal(request.method(), 'POST');
            assert.equal(request.headers()['content-type'], 'application/x-protobuf');
            const lead = binaryTargets.find(item => item.homepage === request.frame().url());
            assert(lead, 'Binary sends must come from the current synthetic target frame');
            assert(authorizations.findLast(item => item.kind === 'dm' && item.uid === lead.uid));
            assert.equal(authorizationMode, 'allowed');
            assert.deepEqual(request.postDataBuffer(), makeSendRequest({ ...protocolOptions(lead), message: engine.applyTemplate(MESSAGE, lead) }));
            const index = protocolTargets.findIndex(item => item.id === lead.id);
            const response = makeSendResponse({ ...protocolOptions(lead), status: index === 1 ? 3 : 0,
              ...(index === 2 ? { clientMessageId: 'wrong-client-identity' } : {}) });
            requests.push({ kind: 'dm', uid: lead.uid, method: 'POST', protocol: 'synthetic-protobuf', expectedOutcome: index < 0 ? 'confirmed_success' : ['confirmed_success', 'confirmed_failure', 'pending_verification'][index] });
            return route.fulfill({ status: 200, headers: cors, contentType: 'application/x-protobuf', body: response });
          }
          if (url.hostname !== 'www.douyin.com') return route.abort();
          if (url.pathname.startsWith('/user/') && request.isNavigationRequest()) {
            const lead = targets.find(item => url.pathname === '/user/' + item.uid);
            if (!lead) return route.abort();
            assert.equal(latestAuthorization?.kind, 'profile_redirect', 'Real profile navigation must pass the production redirect authorization');
            assert.equal(latestAuthorization?.uid, lead.uid, 'Navigation authorization must belong to the current frozen target');
            requests.push({ kind: 'profile', uid: lead.uid, method: request.method() });
            return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml(lead) });
          }
          if (url.pathname === '/aweme/v1/web/user/profile/self/' && request.method() === 'GET') {
            requests.push({ kind: 'self' });
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status_code: 0, is_login: true, user: { uid: SELF_UID } }) });
          }
          if (url.pathname === '/aweme/v1/web/user/profile/other/' && request.method() === 'GET') {
            const lead = targets.find(item => item.uid === url.searchParams.get('sec_user_id'));
            assert(lead, 'Only the current synthetic profile may return passive data');
            requests.push({ kind: 'other', uid: lead.uid });
            const followStatus = historyTargets.includes(lead) ? lead === historyTargets[0] ? 1 : 0 : undefined;
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status_code: 0, user: { uid: lead.UID, sec_uid: lead.uid, nickname: lead.nickname, signature: '隔离资料回填样例', follow_status: followStatus } }) });
          }
          const kind = url.pathname === '/aweme/v1/web/commit/follow/user/' ? 'follow'
            : url.pathname === '/aweme/v1/web/im/message/send/' ? 'dm' : '';
          if (!kind) return route.abort();
          assert.equal(request.method(), 'POST');
          const fields = new URLSearchParams(request.postData());
          const lead = targets.find(item => item.uid === fields.get('sec_user_id'));
          assert(lead, 'Outgoing actions must retain the synthetic recipient');
          assert.equal(fields.get('user_id'), lead.UID, 'Numeric UID is distinct from sec_uid and remains exact text');
          assert(authorizations.findLast(item => item.kind === kind && item.uid === lead.uid), 'The current target action must be authorized before its native browser request');
          assert.equal(authorizationMode, 'allowed', 'A revoked or stopped task cannot issue a request');
          if (kind === 'follow') assert.equal(fields.get('type'), '1');
          else assert.equal(fields.get('content'), engine.applyTemplate(MESSAGE, lead));
          requests.push({ kind, uid: lead.uid, method: request.method() });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(kind === 'follow'
            ? { status_code: 0, follow_status: 1, sec_user_id: lead.uid, user_id: lead.UID }
            : { fixture_protocol: 'unknown_im', opaque_result: true }) });
          } catch (error) { routingErrors.push(error.message); await route.abort().catch(() => {}); }
        });
        await context.addCookies([{ name: 'sessionid', value: SESSION, domain: '.douyin.com', path: '/', expires: -1, secure: true, httpOnly: true }]);
        return context;
      } catch (error) { await context.close(); throw error; }
    };
    engine = require(path.join(APP, 'engine.js'));
    const store = require(path.join(APP, 'store.js'));
    assert.equal(path.resolve(store.DATA_DIR), path.join(fixture, 'data'));
    store.setAccounts([{ id: ACCOUNT, name: '本地隔离流程账号', proxy: rejectingProxy, loginState: '未登录' }]);
    store.setLeads(targets.map(lead => ({ ...lead })));
    const settings = store.getSettings();
    settings.follow = { ...settings.follow, enabled: true, dailyLimit: 160 };
    settings.dm = { ...settings.dm, enabled: true, dailyLimit: 80, template: MESSAGE, skipAuthor: true, repeat: { enabled: false, intervalDays: 7 } };
    // Skip only configured QA cooldowns. Actual navigation, native controls,
    // the engine's response waits, and the default DM verifier still execute.
    settings.action = { pacingVersion: 1, userIntervalSec: 0, userIntervalJitter: 0 };
    settings.human = { ...settings.human, workPeriods: [], breakEvery: 0, maxConsecutiveErrors: 3 };
    store.setSettings(settings);
    engine.configure({ authorize: async metadata => {
      latestAuthorization = { kind: metadata.kind, uid: metadata.uid };
      authorizations.push(latestAuthorization);
      if (metadata.kind === 'dm' && authorizationMode === 'denied') return { ok: false, error: '本地隔离授权已撤销' };
      if (metadata.kind === 'dm' && authorizationMode === 'stop') engine.stopTask();
      return { ok: true };
    } });
    // No dmVerifier injection: the actual conservative production default is
    // essential to catching a false continuous-error pause after unknown IM.
    progressTimer = setInterval(() => {
      const task = engine.taskState;
      const value = JSON.stringify([task.running, task.status, task.done, task.total, task.consecutiveErrors]);
      if (value !== progress.at(-1)) progress.push(value);
    }, 100);
    async function run(kind, leads) {
      const plan = engine.createPlan(ACCOUNT, kind, { leadIds: leads.map(lead => lead.id), filters: { f: 'all', s: '', q: '' }, owner: 'isolated-qa' });
      assert.equal(plan.count, leads.length, 'The real fixed plan must include the exact selected recipients');
      assert.equal(plan.schemaVersion, 3);
      assert.equal(plan.requiresRelationCheck, true);
      assert.deepEqual(plan.contactPolicy, { repeat: store.getSettings().dm.repeat, historyUnknown: 'allow_initial' });
      return engine[kind + 'Task'](ACCOUNT, { planId: plan.planId, follow: plan.actions.follow, dm: plan.actions.dm });
    }
    const mixedResult = await run('outreach', primary);
    assert.equal(mixedResult.ok, true, 'Mixed fixed-plan task failed: ' + [mixedResult.error, ...engine.taskState.errors.map(item => item.error), ...routingErrors].filter(Boolean).join('; ')); assert.equal(mixedResult.followCount, 2); assert.equal(mixedResult.dmCount, 0);
    assert.equal(mixedResult.pendingCount, 2); assert.equal(mixedResult.failedCount, 0);
    assert.equal(engine.taskState.done, 3); assert.equal(engine.taskState.running, false);
    const savedPrimary = store.getLeads().filter(lead => primary.some(item => item.id === lead.id));
    assert.equal(savedPrimary[0].followState, 'confirmed_success'); assert(savedPrimary[0].followedAt);
    assert.equal(savedPrimary[1].followedAt, primary[1].followedAt, 'Do not click or recount an existing follow');
    assert.equal(savedPrimary[2].dmCount, 1, 'A previously messaged user must not receive another automatic DM');
    for (const lead of savedPrimary.slice(0, 2)) assert.equal(lead.dmState, 'pending_verification');
    assert.deepEqual(primary.map(lead => requests.filter(item => item.kind === 'profile' && item.uid === lead.uid).length), [1, 1, 1]);
    assert.deepEqual(primary.map(lead => requests.filter(item => item.kind === 'follow' && item.uid === lead.uid).length), [1, 0, 1]);
    assert.deepEqual(primary.map(lead => requests.filter(item => item.kind === 'dm' && item.uid === lead.uid).length), [1, 1, 0]);

    const unknownResult = await run('dm', unknown);
    assert.equal(unknownResult.ok, true, 'Four unknown IM receipts must not falsely trip the continuous-error guard: ' + (unknownResult.error || engine.taskState.errors.map(item => item.error).join('; ')));
    assert.equal(unknownResult.pendingCount, 4); assert.equal(unknownResult.failedCount, 0);
    assert.equal(engine.taskState.done, 4); assert.equal(engine.taskState.consecutiveErrors, 0);
    for (const lead of store.getLeads().filter(item => unknown.some(row => row.id === item.id))) {
      assert.equal(lead.dmState, 'pending_verification'); assert.equal(lead.dmOutcome, 'pending_verification');
      assert.equal(lead.dmCount, 0); assert(lead.dmAttemptId);
    }
    const pendingPlan = engine.createPlan(ACCOUNT, 'dm', { leadIds: [...primary.slice(0, 2), ...unknown].map(lead => lead.id), filters: { f: 'all' }, owner: 'isolated-qa' });
    assert.equal(pendingPlan.count, 0, 'Unknown attempts lock automatic resend until a human resolves the result');
    assert.equal(requests.filter(item => item.kind === 'dm').length, 6);

    const protocolResult = await run('dm', protocolTargets);
    assert.equal(protocolResult.ok, true, 'Synthetic protobuf flow failed: ' + [protocolResult.error, ...engine.taskState.errors.map(item => item.error), ...routingErrors, ...pageErrors].filter(Boolean).join('; '));
    assert.equal(protocolResult.dmCount, 1); assert.equal(protocolResult.failedCount, 1); assert.equal(protocolResult.pendingCount, 1);
    assert.equal(engine.taskState.done, 3); assert.equal(engine.taskState.running, false);
    const savedProtocol = protocolTargets.map(target => store.getLeads().find(lead => lead.id === target.id));
    assert.deepEqual(savedProtocol.map(lead => lead.dmState), ['confirmed_success', 'confirmed_failure', 'pending_verification']);
    assert.deepEqual(savedProtocol.map(lead => lead.dmOutcome), ['confirmed_success', 'confirmed_failure', 'pending_verification']);
    assert.deepEqual(savedProtocol.map(lead => lead.dmCount), [1, 0, 0]);
    assert(savedProtocol[0].dmSentAt && savedProtocol[0].dmLastAt);
    assert.match(savedProtocol[0].dmEvidence, /im-protobuf:.*send=0/);
    assert.match(savedProtocol[1].dmEvidence, /im-protobuf:.*send=3/);
    assert.match(savedProtocol[1].dmFailedReason, /消息检查未通过/);
    for (const lead of savedProtocol.slice(1)) assert.equal(Boolean(lead.dmSentAt || lead.dmLastAt), false, 'Failure and wrong-client receipts cannot create success timestamps');
    for (const lead of savedProtocol) {
      assert(lead.dmAttemptId); assert.equal(lead.dmAttemptAccountId, ACCOUNT);
      assert.equal(lead.dmMessageHash, crypto.createHash('sha256').update(engine.applyTemplate(MESSAGE, lead)).digest('hex'));
      assert.equal(requests.filter(item => item.kind === 'dm' && item.uid === lead.uid).length, 1);
      assert.equal(nativeEvents.filter(item => item.kind === 'send' && item.uid === lead.uid).length, 1, 'Each protocol outcome starts from exactly one native click');
    }
    const protocolRepeatPlan = engine.createPlan(ACCOUNT, 'dm', { leadIds: [protocolTargets[0].id, protocolTargets[2].id], filters: { f: 'all' }, owner: 'isolated-qa' });
    assert.equal(protocolRepeatPlan.count, 0, 'Confirmed and wrong-client pending attempts cannot be automatically resent');
    assert.equal(requests.filter(item => item.kind === 'dm' && item.protocol === 'synthetic-protobuf').length, 3);

    const beforeBlockedSend = requests.filter(item => item.kind === 'dm').length;
    authorizationMode = 'denied';
    const deniedResult = await run('dm', [targets[7]]);
    assert.equal(deniedResult.ok, false); assert.match(deniedResult.error, /授权/);
    assert.equal(requests.filter(item => item.kind === 'dm').length, beforeBlockedSend);
    assert.equal(engine.taskState.running, false);
    authorizationMode = 'stop';
    const stoppedResult = await run('dm', [targets[8]]);
    assert.equal(stoppedResult.ok, false); assert.match(stoppedResult.error, /停止/);
    assert.equal(requests.filter(item => item.kind === 'dm').length, beforeBlockedSend);
    assert.equal(engine.taskState.running, false);
    assert.equal(engine.stopTask().ok, true, 'Stopping is still available after authorization loss or a completed stop');
    authorizationMode = 'allowed';

    assert.equal(opened.length, 1); assert.equal(opened[0].pages().length, 1);
    assert.deepEqual(baselineTargets.map(lead => requests.filter(item => item.kind === 'profile' && item.uid === lead.uid).length), Array(12).fill(1), 'Each original user receives exactly one profile navigation');
    assert.equal(nativeEvents.filter(item => item.kind === 'follow').length, 2);
    assert.equal(nativeEvents.filter(item => item.kind === 'send').length, 9);
    assert.equal(new Set(nativeEvents.filter(item => item.kind === 'input' && item.length > 0).map(item => item.uid)).size, 11, 'All message preparations must actually fill their own recipient editor');
    assert(nativeEvents.filter(item => ['follow', 'open', 'input', 'send'].includes(item.kind)).every(item => item.trusted === true), 'Browser controls must generate native trusted events');
    assert.equal(nativeEvents.filter(item => item.kind === 'wrong-control').length, 0, 'Header and recommended-user controls are never clicked');
    assert.equal(pageErrors.length, 0);
    assert.deepEqual(routingErrors, [], 'No local route or native-event verification may fail silently');
    assert.equal(store.getDailyUsage(ACCOUNT).followAttempts, 2);
    assert.equal(store.getDailyUsage(ACCOUNT).follow, 2);
    assert.equal(store.getDailyUsage(ACCOUNT).dmAttempts, 9);
    assert.equal(store.getDailyUsage(ACCOUNT).dm, 1);

    // Fresh website evidence is separate from action receipts. These five
    // users have no local action/history state before their profile visit.
    const saved = lead => store.getLeads().find(item => item.id === lead.id);
    const actionCount = (kind, lead) => nativeEvents.filter(item => item.kind === kind && item.uid === lead.uid).length;
    const runError = result => [result.error, ...engine.taskState.errors.map(item => item.error), ...routingErrors, ...pageErrors].filter(Boolean).join('; ');
    for (const lead of historyTargets) {
      assert.equal(saved(lead).dmHistoryObserved, undefined);
      assert.equal(saved(lead).followObserved, undefined);
    }
    const observedFollowResult = await run('outreach', [historyTargets[0]]);
    assert.equal(observedFollowResult.ok, true, runError(observedFollowResult));
    assert.equal(observedFollowResult.followCount, 0); assert.equal(observedFollowResult.dmCount, 1);
    assert.equal(observedFollowResult.skipped, 1); assert.equal(observedFollowResult.pendingCount, 0); assert.equal(observedFollowResult.failedCount, 0);
    assert.equal(actionCount('follow', historyTargets[0]), 0, 'Current profile follow_status=1 must skip the unfollowed-looking fixture control');
    assert.equal(actionCount('send', historyTargets[0]), 1, 'Already following must not block an independent DM');
    assert.equal(saved(historyTargets[0]).followObserved.state, 'following');
    assert.equal(saved(historyTargets[0]).followObserved.source, 'browser_profile_response');
    assert.equal(saved(historyTargets[0]).followedAt, undefined, 'Website relationship evidence cannot create a new local follow receipt');
    assert.equal(saved(historyTargets[0]).dmHistoryObserved.state, 'no_outbound');
    assert.equal(saved(historyTargets[0]).dmHistoryObserved.complete, true);
    console.log('PASS: observed follow_status=1 skips follow, confirmed target history checked, DM proceeds');

    const usageBeforeHistorySkip = { ...store.getDailyUsage(ACCOUNT) };
    const skippedHistoryResult = await run('dm', historyTargets.slice(1, 3));
    assert.equal(skippedHistoryResult.ok, true, runError(skippedHistoryResult));
    assert.equal(skippedHistoryResult.dmCount, 0); assert.equal(skippedHistoryResult.pendingCount, 0);
    assert.equal(skippedHistoryResult.failedCount, 0); assert.equal(skippedHistoryResult.skipped, 2);
    assert.equal(engine.taskState.done, 2);
    for (const lead of historyTargets.slice(1, 3)) {
      const row = saved(lead);
      assert.equal(actionCount('open', lead), 1); assert.equal(actionCount('select', lead), 1);
      assert.equal(actionCount('input', lead), 0, 'Known prior own history prevents native filling');
      assert.equal(actionCount('send', lead), 0, 'Known prior own history prevents native sending');
      assert.equal(row.dmHistoryObserved.state, 'already_sent'); assert.equal(row.dmHistorySentObserved.state, 'already_sent');
      assert.equal(row.dmCount, 0); assert.equal(row.dmState, undefined); assert.equal(row.dmAttemptId, undefined);
      assert.equal(row.dmSentAt, undefined); assert.equal(row.dmLastAt, undefined);
    }
    assert.equal(saved(historyTargets[1]).dmHistoryObserved.lastSentAt, oldHistoryAt, 'Complete cmd301 history preserves the verified millisecond timestamp');
    assert.equal(saved(historyTargets[2]).dmHistoryObserved.lastSentAt, null, 'Cmd1002 never claims completeness or a latest timestamp');
    assert.equal(store.getDailyUsage(ACCOUNT).dmAttempts, usageBeforeHistorySkip.dmAttempts);
    assert.equal(store.getDailyUsage(ACCOUNT).dm, usageBeforeHistorySkip.dm);
    console.log('PASS: cmd301 and cmd1002 prior own text skip before fill/send without consuming DM quota');

    const initialUnknownResult = await run('dm', [historyTargets[3]]);
    assert.equal(initialUnknownResult.ok, true, runError(initialUnknownResult));
    assert.equal(initialUnknownResult.dmCount, 1); assert.equal(initialUnknownResult.pendingCount, 0); assert.equal(initialUnknownResult.failedCount, 0);
    assert.equal(actionCount('input', historyTargets[3]), 1); assert.equal(actionCount('send', historyTargets[3]), 1);
    assert.equal(saved(historyTargets[3]).dmHistoryObserved, undefined, 'Unknown stranger history is silent, not stored as a failure or unknown marker');
    assert.equal(saved(historyTargets[3]).dmHistorySentObserved, undefined);
    assert.equal(saved(historyTargets[3]).dmState, 'confirmed_success', 'Only the later send receipt confirms this first send');
    console.log('PASS: unknown website history permits initial send and creates no unknown history state');

    const frozenPlan = engine.createPlan(ACCOUNT, 'dm', { leadIds: [historyTargets[4].id], filters: { f: 'all' }, owner: 'isolated-qa' });
    assert.equal(frozenPlan.schemaVersion, 3); assert.equal(frozenPlan.count, 1);
    assert.deepEqual(frozenPlan.contactPolicy, { repeat: { enabled: false, intervalDays: 7 }, historyUnknown: 'allow_initial' });
    const repeatSettings = store.getSettings(); repeatSettings.dm.repeat = { enabled: true, intervalDays: 7 }; store.setSettings(repeatSettings);
    const requestsBeforePolicyChange = requests.length;
    const changedPlanResult = await engine.dmTask(ACCOUNT, { planId: frozenPlan.planId });
    assert.equal(changedPlanResult.ok, false); assert.match(changedPlanResult.error, /重复联系规则已改变/);
    assert.equal(requests.length, requestsBeforePolicyChange, 'Changed repeat policy must reject a frozen plan before browser navigation');
    assert.equal(actionCount('open', historyTargets[4]), 0);
    const repeatResult = await run('dm', [historyTargets[4]]);
    assert.equal(repeatResult.ok, true, runError(repeatResult));
    assert.equal(repeatResult.dmCount, 1); assert.equal(repeatResult.pendingCount, 0); assert.equal(repeatResult.failedCount, 0);
    assert.equal(saved(historyTargets[4]).dmHistoryObserved.state, 'already_sent');
    assert.equal(saved(historyTargets[4]).dmHistoryObserved.lastSentAt, oldHistoryAt);
    assert.equal(actionCount('input', historyTargets[4]), 1); assert.equal(actionCount('send', historyTargets[4]), 1);
    assert.equal(saved(historyTargets[4]).dmCount, 1, 'Historical messages are observations and cannot be counted as new tool sends');
    console.log('PASS: plan3 freezes repeat policy; a new plan allows a 14-day-old complete history with a 7-day interval');

    for (const lead of historyTargets) {
      assert.equal(actionCount('open', lead), 1); assert.equal(actionCount('select', lead), 1, 'ensure/fill must reuse the selected conversation');
      assert.equal(requests.filter(item => item.kind === 'history' && item.uid === lead.uid).length, 1);
      const order = phases.filter(item => item.uid === lead.uid).map(item => item.kind);
      assert(order.indexOf('select') > order.indexOf('open'));
      assert(order.indexOf('history-response') > order.indexOf('select'));
      if (actionCount('input', lead)) assert(order.indexOf('input') > order.indexOf('history-response'), 'The history response precedes actual filling');
    }
    assert.deepEqual(targets.map(lead => requests.filter(item => item.kind === 'profile' && item.uid === lead.uid).length), Array(17).fill(1));
    assert.equal(opened.length, 1); assert.equal(opened[0].pages().length, 1);
    assert.equal(nativeEvents.filter(item => item.kind === 'send').length, 12);
    assert.equal(nativeEvents.filter(item => item.kind === 'follow').length, 2);
    assert.equal(nativeEvents.filter(item => item.kind === 'wrong-control').length, 0);
    assert(nativeEvents.filter(item => ['follow', 'open', 'select', 'input', 'send'].includes(item.kind)).every(item => item.trusted === true));
    assert.equal(store.getDailyUsage(ACCOUNT).followAttempts, 2); assert.equal(store.getDailyUsage(ACCOUNT).follow, 2);
    assert.equal(store.getDailyUsage(ACCOUNT).dmAttempts, 12); assert.equal(store.getDailyUsage(ACCOUNT).dm, 4);
    assert.equal(pageErrors.length, 0); assert.deepEqual(routingErrors, []);
    for (const kind of ['browser', 'visit', 'profile_redirect', 'ui', 'follow', 'dm']) assert(authorizations.some(item => item.kind === kind));
    assert(progress.some(value => value.includes('用户主页')));
    assert.equal(progress.some(value => value.includes('连续 3')), false);
    const packageFile = sourceMode ? path.join(ROOT, 'desktop', 'package.json') : path.join(APP, 'resources', 'app', 'package.json');
    const report = { ok: true, version: JSON.parse(fs.readFileSync(packageFile, 'utf8')).version,
      actualObfuscatedReleaseEngine: !sourceMode, filesSha256: hashes,
      isolatedDataAndProfile: true, noInstalledCustomerDataAccess: true, rejectingLoopbackProxyEnabled: true,
      browserRequestsFulfilledLocallyOrAborted: true, noLivePlatformRequests: true, realHeadedAccountBrowser: true,
      actualBrowserAdapterNativeClicksAndInput: true, accountContextsCreated: opened.length,
      syntheticUserProfilesVisitedOnce: targets.length, mixedActionUsersCompleted: 3,
      followRequestsConfirmedForBothNumericAndSecUid: 2, existingFollowSkipped: true, existingDmSkipped: true,
      defaultDmVerifierUsed: true, unknownDmAttemptsRemainPending: 6, consecutiveUnknownDmUsersCompleted: 4,
      unknownDmDoesNotTriggerFalsePause: true, pendingDmExcludedFromRepeatPlan: true,
      syntheticProtobufProtocolVerified: true, syntheticProtobufTargets: 3,
      syntheticProtobufOutcomes: { confirmedSuccess: 1, confirmedFailure: 1, pendingVerification: 1 },
      syntheticProtobufRejectionStatus: 3, wrongClientReceiptRemainsPending: true,
      syntheticProtobufNativeSendClicks: 3, syntheticProtobufResponseBodiesReadByProductionObserver: true,
      syntheticProtobufCorsPreflightsFulfilled: requests.filter(item => item.kind === 'dm-preflight').length,
      frozenPlanSchemaVersion: 3, repeatPolicyChangeRejectedBeforeNavigation: true,
      observedProfileFollowingSkipsClickAndAllowsDm: true,
      websiteHistoryCheckedAfterTargetConversationReadyBeforeFill: true,
      syntheticHistoryCommands: [301, 1002], syntheticHistoryUsers: 5, syntheticHistoryNativeRowSelections: 5,
      knownWebsiteHistorySkippedBeforeFillAndSend: 2, historySkipsDoNotConsumeDmQuota: true,
      unknownWebsiteHistoryAllowsInitialSendWithoutUnknownWrite: true,
      verifiedOldWebsiteHistoryAllowsRepeatWithFrozenInterval: true,
      liveDmVerified: false, liveDmRequestsSent: 0,
      authorizationImmediatelyBeforeOutgoingRequests: true, productionProfileNavigationWithRedirectAuthorization: true, revokedAuthorizationBlockedSend: true,
      stopBeforeSendBlockedRequest: true, stopRemainsCallable: true, wrongRecipientControlsClicked: 0,
      actualDmConfirmedSuccessCount: 4, actualDmConfirmedFailureCount: 1, actualDmPendingCount: 7,
      outgoingDmAttempts: 12, nativeTrustedSendClicks: 12 };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log('PASS: ' + (sourceMode ? 'source' : 'actual obfuscated release') + ' outreach fixed plans: 17 local profiles, 12 native DM clicks; original 12-user coverage retained plus 5 relationship/history cases; live DM not verified, all browser responses local');
  } finally {
    clearInterval(progressTimer);
    if (engine) await engine.shutdown();
    if (chromium && originalLaunch) chromium.launchPersistentContext = originalLaunch;
    await Promise.allSettled(opened.map(context => context.close()));
    if (blocker) await new Promise(resolve => blocker.close(resolve));
    if (path.dirname(fixture) !== __dirname || !path.basename(fixture).startsWith('qa-outreach-flow-')) throw new Error('Unsafe outreach-flow fixture cleanup');
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
