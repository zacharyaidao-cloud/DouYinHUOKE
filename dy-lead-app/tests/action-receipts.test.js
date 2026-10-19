'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createFollowReceiptObserver, createDmReceiptObserver } = require('../lib/action-receipts');

// Request/response objects are synthetic. No browser, account, Cookie, or
// platform request is involved in these correlation/timeout regressions.
const PATH = '/aweme/v1/web/commit/follow/user/';
function fixture({ targetUid = 'target-sec', targetSecUid, targetNumericUid, timeoutMs = 12, signal } = {}) {
  const page = new EventEmitter(), frame = { page: () => page };
  page.mainFrame = () => frame;
  const request = ({ url = 'https://www.douyin.com' + PATH + '?sec_user_id=target-sec&type=1',
    method = 'POST', body = null, type = 'application/x-www-form-urlencoded', requestFrame = frame } = {}) => ({
      url: () => url, method: () => method, postData: () => body,
      headers: () => ({ 'content-type': type }), frame: () => requestFrame
    });
  const response = (req, { payload = { status_code: 0, follow_status: 1 }, status = 200,
    url = req.url(), bytes, body, headers = {} } = {}) => ({
      url: () => url, status: () => status, request: () => req,
      headers: () => headers,
      body: body || (async () => bytes || Buffer.from(JSON.stringify(payload)))
    });
  const collector = () => createFollowReceiptObserver({ page, targetUid, targetSecUid, targetNumericUid, timeoutMs, signal });
  return { page, request, response, collector };
}
function dispatch(f, observer, options = {}, reply = {}) {
  observer.arm(); const req = f.request(options);
  f.page.emit('request', req); f.page.emit('response', f.response(req, reply));
}
function noListeners(page) {
  for (const event of ['request', 'response', 'requestfailed', 'close']) assert.equal(page.listenerCount(event), 0, event);
}

test('关注仅确认本页本次POST、精确目标和明确成功字段，清理全部监听', async () => {
  for (const follow_status of [1, 2]) for (const body of [null, 'sec_user_id=target-sec&type=1']) {
    const f = fixture(), observer = f.collector();
    dispatch(f, observer, body ? { url: 'https://douyin.com' + PATH, body } : {}, { payload: { status_code: 0, follow_status } });
    const outcome = await observer.wait();
    assert.equal(outcome.state, 'confirmed_success'); assert.ok(outcome.evidence); noListeners(f.page);
    assert.doesNotMatch(JSON.stringify(outcome), /target-sec|Cookie|sec_user_id=/);
  }
  const f = fixture({ targetUid: '123456789' }), observer = f.collector();
  dispatch(f, observer, { url: 'https://www.douyin.com' + PATH + '?user_id=123456789&type=1' });
  assert.equal((await observer.wait()).state, 'confirmed_success'); noListeners(f.page);
});

test('错误目标、取消关注、重复或冲突参数、未知body类型均不能确认', async () => {
  const cases = [
    { url: 'https://www.douyin.com' + PATH + '?sec_user_id=other&type=1' },
    { url: 'https://www.douyin.com' + PATH + '?sec_user_id=target-sec&type=0' },
    { url: 'https://www.douyin.com' + PATH + '?sec_user_id=target-sec' },
    { url: 'https://www.douyin.com' + PATH + '?sec_user_id=target-sec&type=01' },
    { url: 'https://www.douyin.com' + PATH + '?sec_user_id=target-sec&sec_user_id=target-sec&type=1' },
    { url: 'https://www.douyin.com' + PATH + '?sec_user_id=target-sec&type=1&type=0' },
    { url: 'https://www.douyin.com' + PATH + '?sec_user_id=target-sec&type=1&aid=1&aid=1' },
    { body: 'type=1' },
    { body: 'sec_user_id=other' },
    { url: 'https://www.douyin.com' + PATH + '?user_id=target-sec&type=1' },
    { url: 'https://www.douyin.com' + PATH + '?sec_user_id=target-sec&user_id=123456789&type=1' },
    { url: 'https://www.douyin.com' + PATH, body: '{"sec_user_id":"target-sec","type":1}', type: 'application/json' },
    { method: 'GET' }
  ];
  for (const options of cases) {
    const f = fixture(), observer = f.collector(); dispatch(f, observer, options);
    assert.equal((await observer.wait()).state, 'pending_verification', JSON.stringify(options)); noListeners(f.page);
  }
});

test('错误HTTPS主机、端口、候选路径、其他page与旧响应不形成回执', async () => {
  for (const url of [
    'http://www.douyin.com' + PATH, 'https://evil.douyin.com' + PATH,
    'https://www.douyin.com.evil.invalid' + PATH, 'https://user@www.douyin.com' + PATH,
    'https://www.douyin.com:444' + PATH, 'https://www.douyin.com' + PATH + 'extra/',
    'https://www.douyin.com' + PATH + '?sec_user_id=target-sec&type=1#fragment'
  ]) {
    const f = fixture(), observer = f.collector(); dispatch(f, observer, { url });
    assert.equal((await observer.wait()).state, 'pending_verification'); noListeners(f.page);
  }
  const f = fixture(), observer = f.collector();
  const old = f.request(); f.page.emit('request', old);
  observer.arm(); f.page.emit('response', f.response(old));
  const unrelated = f.request({ requestFrame: { page: () => ({}) } });
  f.page.emit('request', unrelated); f.page.emit('response', f.response(unrelated));
  f.page.emit('response', f.response(f.request()));
  assert.equal((await observer.wait()).state, 'pending_verification'); noListeners(f.page);
});

test('HTTP200、取消状态、错误码、未知schema和超大/坏响应体均不推测成功', async () => {
  for (const reply of [
    { payload: { status_code: 0 } }, { payload: { status_code: '0', follow_status: 1 } },
    { payload: { status_code: 0, follow_status: '1' } }, { payload: { status_code: 0, follow_status: 0 } },
    { payload: { status_code: 1, follow_status: 1 } }, { payload: { success: true } },
    { payload: { status_code: 0, follow_status: 1, sec_user_id: 'other' } },
    { status: 500 }, { bytes: Buffer.from('{broken') },
    { bytes: Buffer.alloc(65537), headers: { 'content-length': '1' } },
    { headers: { 'content-length': '65537' }, body: async () => { throw new Error('Oversized declared body must not be read'); } }
  ]) {
    const f = fixture(), observer = f.collector(); dispatch(f, observer, {}, reply);
    assert.equal((await observer.wait()).state, 'pending_verification'); noListeners(f.page);
  }
});

test('候选请求及事件个数有界，重复arm不能扩大当前窗口或重复注册监听', async () => {
  const f = fixture(), observer = f.collector();
  observer.arm(); observer.arm();
  for (let index = 0; index < 33; index++) {
    const req = f.request(); f.page.emit('request', req);
    f.page.emit('response', f.response(req, { payload: index === 32 ? { status_code: 0, follow_status: 1 } : { status_code: 0 } }));
  }
  assert.equal((await observer.wait()).state, 'pending_verification'); noListeners(f.page);
  const g = fixture(), large = g.collector();
  dispatch(g, large, { url: 'https://www.douyin.com' + PATH + '?sec_user_id=target-sec&type=1&padding=' + 'x'.repeat(65536) });
  assert.equal((await large.wait()).state, 'pending_verification'); noListeners(g.page);
});

test('永久挂起的响应体、停止与页面关闭均及时待核验，迟到响应不翻转结果', async () => {
  const f = fixture(), observer = f.collector();
  let completeBody;
  dispatch(f, observer, {}, { body: () => new Promise(resolve => { completeBody = resolve; }) });
  const result = await observer.wait(); assert.equal(result.state, 'pending_verification'); noListeners(f.page);
  completeBody(Buffer.from('{"status_code":0,"follow_status":1}'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await observer.wait()).state, 'pending_verification');
  for (const closed of [false, true]) {
    const controller = new AbortController(), g = fixture({ signal: controller.signal, timeoutMs: 15000 }), receipt = g.collector();
    receipt.arm(); if (closed) g.page.emit('close'); else controller.abort();
    assert.equal((await receipt.wait()).state, 'pending_verification'); noListeners(g.page);
  }
});

test('私信仅保留本次发送后同页目标匹配的候选IM响应元数据，不猜发送成功', () => {
  const f = fixture(), receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec' });
  const options = { url: 'https://www.douyin.com/aweme/v1/web/im/message/send/?sec_user_id=target-sec&private_query=must-not-log', body: 'message=must-not-log' };
  const before = f.request(options); f.page.emit('request', before); f.page.emit('response', f.response(before));
  receipt.arm();
  for (const patch of [{}, { url: 'https://www.douyin.com/aweme/v1/web/im/message/send/?sec_user_id=other' }, { url: 'https://www.douyin.com/aweme/v1/web/comment/list/?sec_user_id=target-sec' }]) {
    const request = f.request({ ...options, ...patch }); f.page.emit('request', request); f.page.emit('response', f.response(request));
  }
  assert.equal(receipt.events.length, 1); assert.equal(receipt.events[0].targetMatched, true);
  assert.doesNotMatch(JSON.stringify(receipt.events), /must-not-log|private_query|target-sec|message=/);
  assert.equal(receipt.events[0].path, '/aweme/v1/web/im/message/send/');
  receipt.dispose(); noListeners(f.page);
});

test('sec_uid与数字UID各自匹配，双身份合法回执可确认，冲突及未知数字仍拒绝', async () => {
  const targetNumericUid = '1234567890123456789';
  const f = fixture({ targetSecUid: 'target-sec', targetNumericUid }), receipt = f.collector();
  dispatch(f, receipt, { url: 'https://www.douyin.com' + PATH,
    body: 'sec_user_id=target-sec&user_id=' + targetNumericUid + '&type=1' },
  { payload: { status_code: 0, follow_status: 1, sec_user_id: 'target-sec', user_id: targetNumericUid } });
  assert.equal((await receipt.wait()).state, 'confirmed_success'); noListeners(f.page);
  for (const [requestNumeric, replyNumeric] of [[targetNumericUid, '987654321'], ['987654321', targetNumericUid], [targetNumericUid, Number(targetNumericUid)]]) {
    const g = fixture({ targetSecUid: 'target-sec', targetNumericUid }), rejected = g.collector();
    dispatch(g, rejected, { body: 'user_id=' + requestNumeric },
      { payload: { status_code: 0, follow_status: 1, user_id: replyNumeric } });
    assert.equal((await rejected.wait()).state, 'pending_verification'); noListeners(g.page);
  }
  const g = fixture({ targetSecUid: 'target-sec', targetNumericUid }), numericOnly = g.collector();
  dispatch(g, numericOnly, { url: 'https://www.douyin.com' + PATH + '?user_id=' + targetNumericUid + '&type=1' });
  assert.equal((await numericOnly.wait()).state, 'confirmed_success'); noListeners(g.page);
});

test('私信候选元数据以分别验证的双身份关联，错收件人不记录', () => {
  const f = fixture(), receipt = createDmReceiptObserver({ page: f.page, targetSecUid: 'target-sec', targetNumericUid: '12345' });
  receipt.arm();
  for (const numeric of ['12345', '54321']) {
    const req = f.request({ url: 'https://www.douyin.com/aweme/v1/web/im/message/send/?to_sec_user_id=target-sec&to_user_id=' + numeric });
    f.page.emit('request', req); f.page.emit('response', f.response(req));
  }
  assert.equal(receipt.events.length, 1); assert.equal(receipt.events[0].targetMatched, true);
  receipt.dispose(); noListeners(f.page);
});

test('私信观察等待在本次目标响应到达后立即释放，但不构造发送成功', async () => {
  const f = fixture(), receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec' });
  receipt.arm();
  const pending = receipt.waitForObservation({ timeoutMs: 5000 });
  const request = f.request({ url: 'https://www.douyin.com/aweme/v1/web/im/message/send/?sec_user_id=target-sec' });
  f.page.emit('request', request); f.page.emit('response', f.response(request));
  assert.equal(await pending, true); assert.equal(receipt.events.length, 1);
  assert.equal(receipt.events[0].state, undefined); assert.equal(await receipt.waitForObservation(), true);
  receipt.dispose(); noListeners(f.page);
});

test('私信观察等待超时、停止、窗口关闭、销毁均可释放，不接受旧或错目标响应', async () => {
  for (const ending of ['timeout', 'abort', 'close', 'dispose']) {
    const controller = new AbortController(), f = fixture();
    const receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec', signal: controller.signal });
    const old = f.request({ url: 'https://www.douyin.com/aweme/v1/web/im/message/send/?sec_user_id=target-sec' });
    f.page.emit('request', old); receipt.arm();
    const wait = receipt.waitForObservation({ timeoutMs: ending === 'timeout' ? 5 : 5000 });
    f.page.emit('response', f.response(old));
    const wrong = f.request({ url: 'https://www.douyin.com/aweme/v1/web/im/message/send/?sec_user_id=other' });
    f.page.emit('request', wrong); f.page.emit('response', f.response(wrong));
    if (ending === 'abort') controller.abort();
    else if (ending === 'close') f.page.emit('close');
    else if (ending === 'dispose') receipt.dispose();
    assert.equal(await wait, false); assert.deepEqual(receipt.events, []);
    receipt.dispose(); noListeners(f.page);
  }
});

test('IM主域未知协议只保存白名单诊断，配对更新HTTP响应，不读取正文或推测目标', async () => {
  const f = fixture(), receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec', now: () => 1000 });
  receipt.arm();
  const req = f.request({ url: 'https://imapi.douyin.com/v1/message/send/?token=must-not-log&recipient_uid=secret-user',
    type: 'Application/X-Protobuf; token=must-not-log', body: 'private-message' });
  req.postData = () => { throw new Error('Diagnostic must not inspect the request body'); };
  req.headers = () => ({ 'content-type': 'Application/X-Protobuf; token=must-not-log', cookie: 'must-not-log', authorization: 'must-not-log' });
  f.page.emit('request', req);
  assert.deepEqual(receipt.getDiagnostics(), [{ origin: 'https://imapi.douyin.com', path: '/v1/message/send/',
    method: 'POST', contentType: 'application/x-protobuf', status: null, at: 1000, phase: 'request',
    scope: 'transport_metadata', protocolEvaluation: 'not_performed' }]);
  const detached = receipt.getDiagnostics(); detached[0].phase = 'confirmed_success'; detached.push({ secret: true });
  assert.equal(receipt.getDiagnostics()[0].phase, 'request'); assert.equal(receipt.getDiagnostics().length, 1);
  f.page.emit('response', f.response(req, { status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8; token=must-not-log', 'set-cookie': 'must-not-log' },
    body: () => { throw new Error('Unknown protocol body must not be read'); } }));
  assert.equal(receipt.getDiagnostics().length, 1); assert.equal(receipt.getDiagnostics()[0].phase, 'response');
  assert.equal(receipt.getDiagnostics()[0].status, 200); assert.equal(receipt.getDiagnostics()[0].protocolEvaluation, 'not_performed');
  assert.equal(receipt.getDiagnostics()[0].responseContentType, 'application/json');
  assert.deepEqual(receipt.events, []); assert.equal(await receipt.waitForObservation({ timeoutMs: 5 }), false);
  assert.doesNotMatch(JSON.stringify(receipt.getDiagnostics()), /must-not-log|token|secret-user|private-message|confirmed_success|cookie|authorization/i);
  receipt.dispose(); noListeners(f.page);
});

test('IM诊断记录发出但无响应及请求失败，重复响应不能创建或改变其他记录', () => {
  const f = fixture(), receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec' });
  receipt.arm();
  const first = f.request({ url: 'https://imapi.douyin.com/v1/message/send/' });
  const second = f.request({ url: 'https://imapi.douyin.com/v1/message/send/' });
  f.page.emit('request', first); f.page.emit('request', second);
  f.page.emit('response', f.response(second, { status: 403 }));
  f.page.emit('response', f.response(second, { status: 200 }));
  f.page.emit('response', f.response(f.request({ url: first.url() })));
  assert.deepEqual(receipt.getDiagnostics().map(entry => [entry.phase, entry.status]), [['request', null], ['response', 403]]);
  first.failure = () => { throw new Error('Failure details may contain private URLs'); };
  f.page.emit('requestfailed', first);
  f.page.emit('response', f.response(first));
  assert.deepEqual(receipt.getDiagnostics().map(entry => [entry.phase, entry.status]), [['failed', null], ['response', 403]]);
  receipt.dispose(); noListeners(f.page);
});

test('IM诊断只接受arm后同页主frame的精确HTTPS主机POST，旧及重定向响应被拒绝', () => {
  const f = fixture(), receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec' });
  const endpoint = 'https://imapi.douyin.com/v1/message/send/';
  const old = f.request({ url: endpoint }); f.page.emit('request', old);
  receipt.arm(); f.page.emit('response', f.response(old));
  const excluded = [
    { url: 'http://imapi.douyin.com/v1/message/send/' },
    { url: 'https://imapi.douyin.com.evil.invalid/v1/message/send/' },
    { url: 'https://other.douyin.com/v1/message/send/' },
    { url: 'https://user@imapi.douyin.com/v1/message/send/' },
    { url: 'https://imapi.douyin.com:444/v1/message/send/' },
    { url: endpoint + '#secret' }, { url: 'https://imapi.douyin.com/v2/message/send/' },
    { url: 'https://imapi.douyin.com/v1' }, { url: endpoint + 'x'.repeat(257) },
    { url: endpoint + '?padding=' + 'x'.repeat(65536) },
    { method: 'GET' }, { method: 'PUT' },
    { requestFrame: { page: () => f.page } }, { requestFrame: { page: () => ({}) } }
  ];
  for (const patch of excluded) {
    const req = f.request({ url: endpoint, ...patch }); f.page.emit('request', req); f.page.emit('response', f.response(req));
  }
  assert.deepEqual(receipt.getDiagnostics(), []);
  const req = f.request({ url: endpoint + '?token=one' }); f.page.emit('request', req);
  f.page.emit('response', f.response(req, { url: endpoint + '?token=other' }));
  f.page.emit('response', f.response(req, { url: 'https://outside.invalid/v1/message/send/' }));
  assert.equal(receipt.getDiagnostics()[0].phase, 'request');
  receipt.dispose(); noListeners(f.page);
});

test('IM诊断路径和MIME不输出动态标识、任意slug或header参数', () => {
  const f = fixture(), receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec' });
  receipt.arm();
  for (const [path, type, expectedPath, expectedType] of [
    ['/v1/message/7693579483274183025/secretusername/%E7%94%A8%E6%88%B7/', 'application/json; profile=private-header', '/v1/message/:segment/:segment/:segment/', 'application/json'],
    ['/v1/secret-token', 'secret-mime/private-header', '/v1/:segment', 'other'],
    ['/v1/a/b/c/d/e/f/g/h/i', '', '/v1/:path', 'unknown']
  ]) {
    const req = f.request({ url: 'https://imapi.douyin.com' + path, type });
    f.page.emit('request', req);
    const entry = receipt.getDiagnostics().at(-1);
    assert.equal(entry.path, expectedPath); assert.equal(entry.contentType, expectedType);
    f.page.emit('response', f.response(req, { headers: { 'content-type': type } }));
    assert.equal(receipt.getDiagnostics().at(-1).responseContentType, expectedType);
  }
  assert.doesNotMatch(JSON.stringify(receipt.getDiagnostics()), /7693579483274183025|secretusername|%E7|private-header|secret-token|secret-mime/);
  receipt.dispose(); noListeners(f.page);
});

test('IM候选不会提前释放目标回执等待，已匹配旧接口仍正常立即释放', async () => {
  const f = fixture(), receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec' });
  receipt.arm();
  let settled = false;
  const wait = receipt.waitForObservation({ timeoutMs: 5000 }).then(value => { settled = true; return value; });
  const candidate = f.request({ url: 'https://imapi.douyin.com/v1/message/send/?sec_user_id=target-sec' });
  f.page.emit('request', candidate); f.page.emit('response', f.response(candidate));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  const matched = f.request({ url: 'https://www.douyin.com/aweme/v1/web/im/message/send/?sec_user_id=target-sec' });
  f.page.emit('request', matched); f.page.emit('response', f.response(matched));
  assert.equal(await wait, true); assert.equal(receipt.events.length, 1); assert.equal(receipt.events[0].targetMatched, true);
  assert.equal(receipt.getDiagnostics().length, 1); assert.equal(receipt.getDiagnostics()[0].protocolEvaluation, 'not_performed');
  receipt.dispose(); noListeners(f.page);
});

test('IM诊断最多32次请求且不因重复arm延长5秒窗口，迟到响应不能更新诊断', () => {
  const f = fixture(); let time = 1000;
  const receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec', now: () => time });
  receipt.arm();
  const accepted = [];
  for (let index = 0; index < 40; index++) {
    const req = f.request({ url: 'https://imapi.douyin.com/v1/message/send/' });
    accepted.push(req); f.page.emit('request', req);
  }
  assert.equal(receipt.getDiagnostics().length, 32);
  time = 5999; receipt.arm();
  f.page.emit('response', f.response(accepted[31]));
  assert.equal(receipt.getDiagnostics()[31].phase, 'response');
  time = 6001; f.page.emit('response', f.response(accepted[0]));
  assert.equal(receipt.getDiagnostics()[0].phase, 'request');
  assert.equal(f.page.listenerCount('requestfailed'), 0, 'Expired diagnostics remove their own listeners');
  receipt.dispose(); noListeners(f.page);
});

test('IM诊断在停止、关闭及dispose后不接受新请求，原快照仍可用于日志', () => {
  for (const ending of ['abort', 'close', 'dispose']) {
    const controller = new AbortController(), f = fixture();
    const receipt = createDmReceiptObserver({ page: f.page, targetUid: 'target-sec', signal: controller.signal });
    receipt.arm();
    const req = f.request({ url: 'https://imapi.douyin.com/v1/message/send/' }); f.page.emit('request', req);
    if (ending === 'abort') controller.abort();
    else if (ending === 'close') f.page.emit('close');
    else receipt.dispose();
    f.page.emit('response', f.response(req));
    const late = f.request({ url: req.url() }); f.page.emit('request', late); f.page.emit('response', f.response(late));
    assert.equal(receipt.getDiagnostics().length, 1); assert.equal(receipt.getDiagnostics()[0].phase, 'request');
    receipt.dispose(); noListeners(f.page);
  }
});
