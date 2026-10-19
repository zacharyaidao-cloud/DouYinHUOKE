'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseHistoryRequest, parseHistoryResponse, MAX_HISTORY_BYTES } = require('../lib/dm-protocol');
const { observeDmHistory, createDmHistoryObserver } = require('../lib/dm-history-observer');
const { defaults: d, message, request, response, int, data, join } = require('./helpers/im-history-fixture');
const record = (patch = {}, options = {}) => parseHistoryRequest(request(patch), { targetNumericUid: d.targetNumericUid, ...options });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('official cmd301/body301 and cmd1002/body1001 correlate prior own text, never a new receipt', () => {
  for (const command of [301, 1002]) {
    const parsed = parseHistoryResponse(response({ command }), record({ command }));
    assert.equal(parsed.state, 'already_sent'); assert.equal(parsed.outgoingTextCount, 1);
    assert.equal(parsed.state === 'confirmed_success', false);
    for (const privateValue of [d.targetNumericUid, d.selfNumericUid, d.conversationShortId, '合成旧消息']) assert(!JSON.stringify(parsed).includes(privateValue));
  }
  assert.equal(record({ command: 1002, bodyField: 1002 }), null, 'stranger command number is not its body field');
});
test('only explicit end of raw available history from max/older can prove no prior outbound', () => {
  const parsed = parseHistoryResponse(response({ messages: [] }), record());
  assert.equal(parsed.state, 'no_outbound'); assert.equal(parsed.complete, true);
  assert.match(parsed.evidence, /available-history/);
  const incoming = parseHistoryResponse(response({ messages: [message({ sender: d.targetNumericUid })] }), record());
  assert.equal(incoming.state, 'no_outbound');
  assert.equal(parseHistoryResponse(response({ messages: [message({ sender: d.targetNumericUid, index: null })] }), record()).state, 'unknown');
  for (const [query, payload] of [
    [{ anchor: '0' }, {}], [{ anchor: null }, {}], [{ anchor: '123' }, {}], [{ direction: 2 }, {}],
    [{ extraQuery: int(7, 0) }, {}], [{}, { hasMore: true }], [{}, { hasMore: null }],
    [{ command: 1002 }, { command: 1002 }]
  ]) {
    const value = parseHistoryResponse(response({ messages: [], ...payload }), record(query));
    assert.equal(value.state, 'unknown'); assert.equal(value.complete, false);
  }
});
test('reply messages and unclassified outgoing formats cannot be confused with proof of prior own text', () => {
  const incoming = parseHistoryResponse(response({ messages: [message({ sender: d.targetNumericUid })], hasMore: true }), record());
  assert.equal(incoming.state, 'unknown'); assert.equal(incoming.outgoingTextCount, 0);
  for (const patch of [{ messageType: 8 }, { content: '{"unverified":"payload"}' }]) {
    const parsed = parseHistoryResponse(response({ messages: [message(patch)] }), record());
    assert.equal(parsed.state, 'unknown'); assert.equal(parsed.unclassifiedOutgoingCount, 1);
  }
  const historicalDisabled = parseHistoryResponse(response({ messages: [message({ extra: int(12, 1) })] }), record());
  assert.equal(historicalDisabled.state, 'already_sent', 'historical presence is not delivery or visibility');
});
test('identity, sequence, inbox, short-id and sender must agree; forged or conflicting records stay unknown', () => {
  for (const patch of [{ status: 1 }, { sequenceId: '12' }, { selfNumericUid: null }, { selfNumericUid: d.targetNumericUid },
    { inboxType: 2 }, { command: 1002 }, { bodyField: 1002 }]) assert.equal(parseHistoryResponse(response(patch), record()), null);
  for (const patch of [{ sender: '700000000000000009' }, { serverId: '0' }, { conversationShortId: '99' },
    { conversationId: '0:1:11:22' }, { conversationType: 2 }, { extra: int(20, 1) }, { extra: data(50, 'opaque') }, { extra: data(51, 'opaque') }]) {
    assert.equal(parseHistoryResponse(response({ messages: [message(patch)] }), record()), null);
  }
  assert.equal(parseHistoryResponse(response(), { ...record() }), null);
  assert.equal(record({}, { targetNumericUid: 'sec-uid' }), null);
  assert.equal(record({}, { selfNumericUid: d.targetNumericUid }), null);
  for (const extraQuery of [int(9, 1), data(20, 'opaque'), data(8, Buffer.alloc(0))]) assert.equal(record({ extraQuery }), null);
  const known = record({}, { selfNumericUid: d.selfNumericUid });
  assert.equal(parseHistoryResponse(response({ selfNumericUid: null }), known).state, 'already_sent');
  assert.equal(parseHistoryResponse(response({ selfNumericUid: '0' }), known), null, 'present invalid sender cannot fall back to known identity');
  assert.equal(record({ command: 1002, query: join(int(1, d.conversationShortId), int(2, 2)) }), null);
});
test('repeated history messages are supported, duplicate critical scalars and unsafe sizes are rejected', () => {
  assert.equal(parseHistoryResponse(response({ messages: [message(), message({ serverId: '800000000000000009' })] }), record()).outgoingTextCount, 2);
  for (const patch of [{ extraEnvelope: int(2, d.sequenceId) }, { extraHistory: int(3, 0) },
    { messages: [message({ extra: int(7, d.selfNumericUid) })] }, { messages: Array(201).fill(message()) }]) assert.equal(parseHistoryResponse(response(patch), record()), null);
  assert.equal(parseHistoryResponse(Buffer.alloc(MAX_HISTORY_BYTES + 1), record()), null);
  assert.equal(parseHistoryResponse(response().subarray(0, -1), record()), null);
  assert.equal(parseHistoryResponse(Buffer.from('{"messages":[]}'), record()), null);
});
test('lastSentAt is milliseconds and only exposes a latest time with complete range and all outbound timestamps known', () => {
  const at = Date.UTC(2024, 0, 2), older = at - 86400000;
  const messages = [message({ createTime: older }), message({ serverId: '800000000000000008', createTime: at })];
  assert.equal(parseHistoryResponse(response({ messages }), record()).lastSentAt, at);
  for (const value of [null, 0, Math.floor(at / 1000), BigInt(at) * 1000n, Date.now() + 600000]) {
    const parsed = parseHistoryResponse(response({ messages: [message(value === null ? {} : { createTime: value })] }), record());
    assert.equal(parsed.state, 'already_sent'); assert.equal(parsed.lastSentAt, null);
  }
  assert.equal(parseHistoryResponse(response({ messages, hasMore: true }), record()).lastSentAt, null);
  assert.equal(parseHistoryResponse(response({ messages }), record({ anchor: '123' })).lastSentAt, null);
  assert.equal(parseHistoryResponse(response({ command: 1002, messages }), record({ command: 1002 })).lastSentAt, null);
  assert.equal(parseHistoryResponse(response({ messages: [...messages, message()] }), record()).lastSentAt, null);
});

function fixture({ manual = false, signal } = {}) {
  const page = new EventEmitter(), frame = { page: () => page }; let reads = 0, clock = 1000;
  page.mainFrame = () => frame; page.isClosed = () => false;
  const observer = (manual ? createDmHistoryObserver : observeDmHistory)({ page, targetNumericUid: d.targetNumericUid, signal, now: () => clock });
  const req = (patch = {}) => ({ url: () => patch.url || 'https://imapi.douyin.com/v1/message/get_by_conversation?token=private',
    method: () => patch.method || 'POST', frame: () => patch.frame || frame,
    headers: () => ({ 'content-type': patch.type || 'application/x-protobuf' }), postDataBuffer: () => patch.bytes || request(patch.payload) });
  const res = (item, patch = {}) => page.emit('response', { request: () => item, url: () => patch.url || item.url(),
    status: () => patch.status || 200, headers: () => ({ 'content-type': patch.type || 'application/x-protobuf', ...patch.headers }),
    body: async () => { reads++; return patch.read ? patch.read() : patch.bytes || response(patch.payload); } });
  const emit = (a = {}, b = {}) => { const item = req(a); page.emit('request', item); res(item, b); return item; };
  return { page, frame, observer, req, res, emit, reads: () => reads, setNow: value => { clock = value; } };
}
function cleaned(f) { f.observer.dispose(); for (const event of ['request', 'response', 'close']) assert.equal(f.page.listenerCount(event), 0); }
test('observer arms before UI opens and resolves positive history immediately with safe aggregate diagnostics', async () => {
  const f = fixture(); const wait = f.observer.wait({ timeoutMs: 1000 }); f.emit();
  assert.equal((await wait).state, 'already_sent'); assert.equal(f.observer.getSummary().outgoingTextCount, 1);
  const safe = JSON.stringify([f.observer.getSnapshot(), f.observer.getSummary()]);
  for (const marker of ['private', d.targetNumericUid, d.selfNumericUid, '合成旧消息']) assert(!safe.includes(marker));
  cleaned(f);
});
test('unknown stranger empty history waits bounded and never turns into no_outbound', async () => {
  const f = fixture(); f.emit({ url: 'https://imapi.douyin.com/v1/stranger/get_messages', payload: { command: 1002 } }, { payload: { command: 1002, messages: [] } });
  await tick(); assert.equal((await f.observer.wait({ timeoutMs: 2 })).state, 'unknown');
  assert.equal(f.observer.getSummary().hasMore, null); cleaned(f);
});
test('raw complete available-history response can resolve no_outbound; unsupported formats stay unknown', async () => {
  const f = fixture(); const wait = f.observer.wait({ timeoutMs: 1000 }); f.emit({}, { payload: { messages: [] } });
  assert.equal((await wait).state, 'no_outbound'); cleaned(f);
  const g = fixture(); g.emit({}, { bytes: Buffer.from('{}') }); await tick();
  assert.equal((await g.observer.wait({ timeoutMs: 2 })).state, 'unknown'); cleaned(g);
});
test('history must be a new exact endpoint main-frame request/response pair, not a send or arbitrary traffic', async () => {
  for (const patch of [{ url: 'http://imapi.douyin.com/v1/message/get_by_conversation' },
    { url: 'https://imapi.douyin.com.evil.invalid/v1/message/get_by_conversation' },
    { url: 'https://imapi.douyin.com/v1/message/send' }, { url: 'https://imapi.douyin.com/v1/stranger/get_messages' },
    { method: 'GET' }, { type: 'application/json' }, { frame: { page: () => ({}) } }]) {
    const f = fixture(); f.emit(patch); await tick(); assert.equal(f.reads(), 0); cleaned(f);
  }
  const f = fixture({ manual: true }); const old = f.req(); f.page.emit('request', old); f.observer.arm(); f.res(old);
  const valid = f.req(); f.page.emit('request', valid); f.res(f.req()); f.res(valid, { url: 'https://imapi.douyin.com/v1/message/get_by_conversation?token=changed' });
  await tick(); assert.equal(f.reads(), 0); cleaned(f);
});
test('stop, close, timeout and late body cannot change a frozen history outcome', async () => {
  for (const ending of ['abort', 'close', 'timeout', 'dispose']) {
    const controller = new AbortController(), f = fixture({ signal: controller.signal }); let finishBody;
    f.emit({}, { read: () => new Promise(resolve => { finishBody = resolve; }) }); await tick();
    const wait = f.observer.wait({ timeoutMs: ending === 'timeout' ? 2 : 1000 });
    if (ending === 'abort') controller.abort(); else if (ending === 'close') f.page.emit('close'); else if (ending === 'dispose') f.observer.dispose();
    assert.equal((await wait).state, 'unknown'); finishBody(response()); await tick();
    assert.equal(f.observer.getSnapshot().state, 'unknown'); cleaned(f);
  }
});
test('observed positive history cannot be erased by a later empty page and request count remains bounded', async () => {
  const f = fixture(); f.emit(); await tick(); f.emit({}, { payload: { messages: [], hasMore: true } }); await tick();
  assert.equal(f.observer.getSnapshot().state, 'already_sent'); cleaned(f);
  const g = fixture(); for (let n = 0; n < 30; n++) g.emit({ bytes: Buffer.from('unrecognized') });
  g.emit(); await tick(); assert.equal(g.reads(), 0); cleaned(g);
});

test('keepAlive retains late history after initial wait without adding another fixed wait', async () => {
  const f = fixture();
  assert.equal((await f.observer.wait({ timeoutMs: 2, keepAlive: true })).state, 'unknown');
  assert.equal(f.page.listenerCount('request'), 1);
  f.emit(); await tick();
  assert.equal(f.observer.getSnapshot().state, 'already_sent');
  f.observer.dispose();
  const reads = f.reads(); f.emit(); await tick();
  assert.equal(f.reads(), reads, 'frozen observer must not read post-send traffic');
  cleaned(f);
});

test('keepAlive permits positive later history to replace an earlier empty page and freezes on stop', async () => {
  const controller = new AbortController(), f = fixture({ signal: controller.signal });
  f.emit({}, { payload: { messages: [] } }); await tick();
  assert.equal((await f.observer.wait({ timeoutMs: 2, keepAlive: true })).state, 'no_outbound');
  f.emit(); await tick();
  assert.equal(f.observer.getSnapshot().state, 'already_sent');
  controller.abort(); cleaned(f);
  assert.equal(f.observer.getSnapshot().state, 'already_sent');
});

test('keepAlive cannot accept a delayed response body after explicit pre-send freeze', async () => {
  const f = fixture(); let finishBody;
  assert.equal((await f.observer.wait({ timeoutMs: 2, keepAlive: true })).state, 'unknown');
  f.emit({}, { read: () => new Promise(resolve => { finishBody = resolve; }) }); await tick();
  f.observer.dispose(); finishBody(response()); await tick();
  assert.equal(f.observer.getSnapshot().state, 'unknown'); cleaned(f);
});
