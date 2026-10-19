'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDmReceiptObserver } = require('../lib/action-receipts');
const { defaults, makeSendRequest, makeSendResponse, int, data, join } = require('./helpers/im-fixture');

function fixture({ signal, targetNumericUid = defaults.targetNumericUid } = {}) {
  const page = new EventEmitter(), frame = { page: () => page };
  let now = 1000, bodyReads = 0;
  page.mainFrame = () => frame; page.isClosed = () => false;
  const receipt = createDmReceiptObserver({ page, targetNumericUid, targetSecUid: 'fixture-target-sec', signal, now: () => now });
  const request = (options = {}) => ({
    url: () => options.url || 'https://imapi.douyin.com/v1/message/send?token=private-token',
    method: () => options.method || 'POST', frame: () => options.frame || frame,
    headers: () => ({ 'content-type': options.type || 'application/x-protobuf', cookie: 'private-cookie' }),
    postDataBuffer: () => options.bytes || makeSendRequest(options.payload),
  });
  const respond = (req, options = {}) => {
    page.emit('response', {
      request: () => req, url: () => options.url || req.url(), status: () => options.status || 200,
      headers: () => ({ 'content-type': options.type || 'application/x-protobuf', ...options.headers }),
      body: async () => { bodyReads++; return options.read ? options.read() : options.bytes || makeSendResponse(options.payload); }
    });
  };
  const arm = () => receipt.arm({ message: defaults.message, attemptId: 'local-test-attempt' });
  const send = (options = {}, response = {}) => { const req = request(options); page.emit('request', req); respond(req, response); return req; };
  return { page, frame, receipt, request, respond, arm, send, reads: () => bodyReads, setNow: t => { now = t; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function noListeners(f) {
  f.receipt.dispose();
  for (const event of ['request', 'response', 'requestfailed', 'close']) assert.equal(f.page.listenerCount(event), 0, event);
}

test('精确主页面protobuf请求与业务响应确认成功，等待随响应释放，诊断不含隐私', async () => {
  for (const path of ['/v1/message/send', '/v1/message/send/']) {
    const f = fixture(); f.arm();
    const wait = f.receipt.waitForObservation({ timeoutMs: 1000 });
    f.send({ url: 'https://imapi.douyin.com' + path + '?token=private-token' });
    assert.equal(await wait, true);
    assert.equal(f.receipt.getOutcome().state, 'confirmed_success');
    assert.match(f.receipt.getOutcome().reason, /服务端已接受/);
    assert.equal(f.receipt.events.filter(e => e.protocol).length, 1);
    assert.deepEqual(f.receipt.getReceiptSummary(), { recognizedRequests: 1, decodedResponses: 1, ambiguous: false });
    const metadata = f.receipt.getDiagnostics()[0];
    assert.equal(metadata.scope, 'transport_metadata');
    assert.equal(metadata.protocolEvaluation, 'not_performed');
    assert.equal(metadata.targetMatched, undefined);
    assert.equal(metadata.unsupportedProtocol, undefined);
    const publicOutput = JSON.stringify([f.receipt.getOutcome(), f.receipt.events, f.receipt.getDiagnostics(), f.receipt.getReceiptSummary()]);
    for (const text of [defaults.message, defaults.selfNumericUid, defaults.targetNumericUid, defaults.clientMessageId, 'private-token', 'private-cookie']) assert(!publicOutput.includes(text));
    noListeners(f);
  }
});

test('业务拒绝包括仅自己可见不能记录成功', async () => {
  for (const status of [1, 2, 3, 4]) {
    const f = fixture(); f.arm(); f.send({}, { payload: { status } }); await tick();
    assert.equal(f.receipt.getOutcome().state, 'confirmed_failure'); noListeners(f);
  }
});

test('protobuf重复拒绝的范围和检查码保留到最终回执', async () => {
  const f = fixture(); f.arm(); f.send({}, { payload: { status: 3, extraSend: join(int(5, 123), data(6, '请勿重复发送')) } });
  await tick();
  const result = f.receipt.getOutcome();
  assert.equal(result.state, 'confirmed_failure'); assert.equal(result.failureScope, 'recipient');
  assert.match(result.reason, /检查码：123/); noListeners(f);
});

test('HTTP200或无消息ID/未知状态/错发件人/错序列不确认', async () => {
  for (const response of [
    { bytes: Buffer.from('{}') }, { payload: { serverMessageId: null } },
    { payload: { selfNumericUid: null } }, { payload: { selfNumericUid: defaults.targetNumericUid } },
    { payload: { clientMessageId: 'other-client' } }, { payload: { sequenceId: '99' } },
    { payload: { status: 5 } }, { status: 500 }, { type: 'application/json' },
    { headers: { 'content-length': '131073' } }, { bytes: Buffer.alloc(131073) }
  ]) {
    const f = fixture(); f.arm(); f.send({}, response); await tick();
    assert.equal(f.receipt.getOutcome().state, 'pending_verification');
    assert.equal(await f.receipt.waitForObservation({ timeoutMs: 2 }), false); noListeners(f);
  }
});

test('账号频繁和陌生人当日上限保留范围与类型到最终业务回执', async () => {
  for (const [text, code] of [['操作频繁，请稍后再试', 'DM_ACCOUNT_FREQUENT'], ['今日陌生人私信达到上限', 'DM_ACCOUNT_DAILY_LIMIT']]) {
    const f = fixture(); f.arm(); f.send({}, { payload: { status: 3, extraSend: data(6, text) } }); await tick();
    const result = f.receipt.getOutcome();
    assert.equal(result.state, 'confirmed_failure'); assert.equal(result.failureScope, 'account'); assert.equal(result.failureCode, code);
    noListeners(f);
  }
});

test('错目标、错文本、未arm、非精确URL/POST/主frame的请求不读取响应正文', async () => {
  const cases = [
    { url: 'http://imapi.douyin.com/v1/message/send' }, { url: 'https://imapi.douyin.com.evil.invalid/v1/message/send' },
    { url: 'https://user@imapi.douyin.com/v1/message/send' }, { url: 'https://imapi.douyin.com:444/v1/message/send' },
    { url: 'https://imapi.douyin.com/v1/message/send-more' }, { url: 'https://imapi.douyin.com/v1/message/send#secret' },
    { method: 'GET' }, { frame: { page: () => ({}) } }, { type: 'text/plain' },
    { payload: { message: defaults.message.trim() } }, { payload: { targetNumericUid: '700000000000000009' } }
  ];
  for (const options of cases) {
    const f = fixture(); f.arm(); f.send(options); await tick();
    assert.equal(f.reads(), 0); assert.equal(f.receipt.getOutcome().state, 'pending_verification'); noListeners(f);
  }
  const f = fixture(); const old = f.request(); f.page.emit('request', old); f.arm(); f.respond(old); await tick();
  assert.equal(f.reads(), 0); noListeners(f);
  const g = fixture({ targetNumericUid: '' }); g.arm(); g.send(); await tick(); assert.equal(g.reads(), 0); noListeners(g);
});

test('真实响应形状的嵌套频繁提示经观察器保留账号范围，不能退化成普通失败', async () => {
  const check = JSON.stringify({ status_code: 7180, tips: '', status_msg: { msg_type: 1,
    msg_content: { tips: '给陌生人发送消息过于频繁，请稍后再发送陌生人消息', template: [] } }, raw_check_code: 2 });
  const f = fixture(); f.arm(); f.send({}, { payload: { status: 3, serverMessageId: null, extraSend: data(6, check) } }); await tick();
  const result = f.receipt.getOutcome();
  assert.equal(result.state, 'confirmed_failure'); assert.equal(result.failureScope, 'account'); assert.equal(result.failureCode, 'DM_ACCOUNT_FREQUENT');
  assert.match(result.evidence, /business=7180/); noListeners(f);
});

test('SDK可重试外层错误等待同client的新序列回执，不把首个错误当最终失败', async () => {
  const f = fixture(); f.arm(); f.send({}, { payload: { statusCode: 2 } }); await tick();
  assert.equal(f.receipt.getOutcome().state, 'pending_verification');
  f.send({ payload: { sequenceId: '9007199254740994' } }, { payload: { sequenceId: '9007199254740994' } }); await tick();
  assert.equal(f.receipt.getOutcome().state, 'confirmed_success'); assert.equal(f.receipt.getReceiptSummary().recognizedRequests, 2); noListeners(f);
});

test('一次点击窗口两个不同client消息保持歧义，不能凭相同文本任取成功', async () => {
  const f = fixture(); f.arm(); const one = f.request(), two = f.request({ payload: { clientMessageId: 'other-client' } });
  f.page.emit('request', one); f.page.emit('request', two); f.respond(one); f.respond(two); await tick();
  assert.equal(f.receipt.getOutcome().state, 'pending_verification'); assert.equal(f.receipt.getReceiptSummary().ambiguous, true); noListeners(f);
});

test('响应请求对象及原始URL必须一致，重复响应只生成一次结果', async () => {
  const f = fixture(); f.arm(); const req = f.request(); f.page.emit('request', req);
  f.respond(f.request()); f.respond(req, { url: 'https://imapi.douyin.com/v1/message/send?token=other' }); await tick();
  assert.equal(f.receipt.getOutcome().state, 'pending_verification'); assert.equal(f.reads(), 0);
  f.respond(req); f.respond(req); await tick(); assert.equal(f.receipt.events.filter(x => x.protocol).length, 1); noListeners(f);
});

test('慢正文停止/关闭/销毁后不得回写成功；等待及时释放', async () => {
  for (const ending of ['abort', 'close', 'dispose', 'expired']) {
    const controller = new AbortController(), f = fixture({ signal: controller.signal }); f.arm();
    let complete; const wait = f.receipt.waitForObservation({ timeoutMs: 4 });
    f.send({}, { read: () => new Promise(resolve => { complete = resolve; }) }); await tick();
    if (ending === 'abort') controller.abort();
    else if (ending === 'close') f.page.emit('close');
    else if (ending === 'dispose') f.receipt.dispose();
    else f.setNow(32000);
    assert.equal(await wait, false); complete(makeSendResponse()); await tick();
    assert.equal(f.receipt.getOutcome().state, 'pending_verification'); noListeners(f);
  }
});

test('超过2秒的合法回执仍可确认，观察期不是固定休眠或2秒猜测', async () => {
  const f = fixture(); f.arm(); const req = f.request(); f.page.emit('request', req); f.setNow(9500); f.respond(req); await tick();
  assert.equal(f.receipt.getOutcome().state, 'confirmed_success'); noListeners(f);
});

test('真正业务等待不被旧候选HTTP200提前释放，body完成后才确认', async () => {
  const f = fixture(); f.arm(); let resolved = false;
  const waiting = f.receipt.waitForReceipt({ timeoutMs: 1000 }).then(value => { resolved = true; return value; });
  const legacy = f.request({ url: 'https://www.douyin.com/aweme/v1/web/im/message/send/?sec_user_id=fixture-target-sec' });
  legacy.postData = () => null; f.page.emit('request', legacy); f.respond(legacy); await tick();
  assert.equal(f.receipt.events.length, 1); assert.equal(resolved, false);
  let body; f.send({}, { read: () => new Promise(resolve => { body = resolve; }) }); await tick();
  f.setNow(15000); assert.equal(resolved, false); body(makeSendResponse());
  assert.equal(await waiting, true); assert.equal(f.receipt.getOutcome().state, 'confirmed_success'); noListeners(f);
});

test('真正业务等待超时后封闭结果，迟到正文不改变本次结论', async () => {
  const f = fixture(); f.arm(); let body;
  f.send({}, { read: () => new Promise(resolve => { body = resolve; }) }); await tick();
  assert.equal(await f.receipt.waitForReceipt({ timeoutMs: 2 }), false);
  body(makeSendResponse()); await tick(); assert.equal(f.receipt.getOutcome().state, 'pending_verification'); noListeners(f);
});

test('候选请求上限防止无关流量无限解析；合法结果仍不保存消息/会话标识', async () => {
  const f = fixture(); f.arm();
  for (let i = 0; i < 40; i++) f.send({ bytes: Buffer.from('unknown') });
  f.send(); await tick(); assert.equal(f.reads(), 0); assert.equal(f.receipt.getOutcome().state, 'pending_verification'); noListeners(f);
});
