'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSendRequest, parseSendResponse, MAX_BYTES } = require('../lib/dm-protocol');
const { defaults: d, int, data, join, makeSendRequest, makeSendResponse } = require('./helpers/im-fixture');
const options = () => ({ targetNumericUid: d.targetNumericUid, targetSecUid: 'synthetic-sec-id', message: d.message });
const request = (wire = {}, target = {}) => parseSendRequest(makeSendRequest(wire), { ...options(), ...target });

test('correlates synthetic 64-bit request, target, exact text, response sender and client', () => {
  const record = request();
  assert.ok(record);
  assert.equal(record.sequenceId, d.sequenceId);
  assert.equal(record.otherParticipantUid, d.selfNumericUid);
  assert.equal(record.senderVerified, false);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(record.message, undefined);
  const result = parseSendResponse(makeSendResponse(), record);
  assert.equal(result.state, 'confirmed_success');
  const safe = JSON.stringify(result);
  for (const privateValue of [d.message, d.targetNumericUid, d.selfNumericUid, d.clientMessageId, d.sequenceId]) {
    assert.equal(safe.includes(privateValue), false);
  }
});

test('supports known postscript JSON and omitted unused richTextInfos', () => {
  for (const content of [JSON.stringify({ text: d.message }), JSON.stringify({ aweType: 700, type: 0, text: d.message })]) {
    assert.ok(request({ content }));
  }
  assert.ok(request({ conversationShortId: null })); // new builder omits a nonpositive short id
});

test('requires numeric target independently from sec_uid and validates one-to-one identity', () => {
  for (const targetNumericUid of ['', undefined, 'synthetic-sec-id', '07', '9223372036854775808', d.selfNumericUid + '9']) {
    assert.equal(request({}, { targetNumericUid }), null);
  }
  for (const conversationId of [
    `0:1:${d.targetNumericUid}:${d.selfNumericUid}`, `0:1:${d.targetNumericUid}:${d.targetNumericUid}`,
    `0:2:${d.selfNumericUid}:${d.targetNumericUid}`, `0:1:11:22`,
    `0:1:${d.selfNumericUid}:${d.targetNumericUid}:33`
  ]) assert.equal(request({ conversationId }), null);
  assert.equal(request({ conversationType: 2 }), null);
  assert.equal(request({}, { selfNumericUid: d.targetNumericUid }), null);
  assert.equal(request({}, { selfNumericUid: '700000000000000004' }), null);
});

test('strongly matches sender: target as sender, unknown sender and forged records stay pending', () => {
  const candidate = request();
  assert.equal(parseSendResponse(makeSendResponse({ selfNumericUid: null }), candidate), null);
  assert.equal(parseSendResponse(makeSendResponse({ selfNumericUid: d.targetNumericUid }), candidate), null);
  assert.equal(parseSendResponse(makeSendResponse({ selfNumericUid: '700000000000000004' }), candidate), null);
  assert.equal(parseSendResponse(makeSendResponse(), { ...candidate }), null);
  const verified = request({}, { selfNumericUid: d.selfNumericUid });
  assert.equal(verified.senderVerified, true);
  assert.equal(parseSendResponse(makeSendResponse({ selfNumericUid: null }), verified).state, 'confirmed_success');
  assert.equal(parseSendResponse(makeSendResponse({ selfNumericUid: d.targetNumericUid }), verified), null);
});

test('matches exact text without trimming and rejects unsupported or ambiguous JSON content', () => {
  assert.equal(request({}, { message: d.message.trim() }), null);
  assert.equal(request({ messageType: 10001 }), null); // generic enum is not proof of product text shape
  const invalid = [d.message, JSON.stringify({ text: d.message, other: 1 }),
    JSON.stringify({ aweType: 703, type: 0, text: d.message }),
    JSON.stringify({ aweType: 700, type: 0, richTextInfos: [{ info: {} }], text: d.message }),
    `{"text":"wrong","text":${JSON.stringify(d.message)}}`,
    `{"te\\u0078t":"wrong","text":${JSON.stringify(d.message)}}`,
    JSON.stringify({ text: { value: d.message } }), '{"text":1}', 'null', '[]'];
  for (const content of invalid) assert.equal(request({ content }), null);
});

test('requires actual body, client id and positive server id even when scalar status defaults to zero', () => {
  const record = request();
  assert.equal(parseSendResponse(makeSendResponse({ status: null, statusCode: null }), record).state, 'confirmed_success');
  for (const overrides of [
    { serverMessageId: null }, { serverMessageId: '0' }, { serverMessageId: '-1' },
    { clientMessageId: null }, { clientMessageId: '' }, { clientMessageId: 'another-client' },
    { body: null }, { body: Buffer.alloc(0) }, { sendBody: Buffer.alloc(0) },
    { body: data(101, Buffer.alloc(0)) }, { command: 101 }, { sequenceId: '9007199254740992' }, { inboxType: 2 }
  ]) assert.equal(parseSendResponse(makeSendResponse(overrides), record), null);
  assert.equal(parseSendResponse(Buffer.alloc(0), record), null);
  assert.equal(parseSendResponse(Buffer.from('{"status_code":0,"status":0}'), record), null);
});

test('reports explicit common send rejections without echoing server text or identifiers', () => {
  const record = request();
  for (const status of [1, 2, 3, 4]) {
    const result = parseSendResponse(makeSendResponse({ status, serverMessageId: null,
      extraSend: join(data(2, 'private-extra'), data(6, 'private-reason')) }), record);
    assert.equal(result.state, 'confirmed_failure');
    assert.match(result.evidence, new RegExp(`send=${status};`));
    assert.equal(JSON.stringify(result).includes('private-'), false);
    if (status === 4) assert.match(result.reason, /仅自己可见/);
  }
  for (const status of [5, 6, 7, 8, 999]) assert.equal(parseSendResponse(makeSendResponse({ status }), record), null);
});

test('outer errors and retry sequences remain unconfirmed until a matching successful attempt', () => {
  const record = request();
  for (const statusCode of [1, 2, 4, 5, 6, 11, 15, 16, 17, 19, 100, 500, 999]) {
    assert.equal(parseSendResponse(makeSendResponse({ statusCode }), record), null);
  }
  const retry = request({ sequenceId: '9007199254740994' });
  assert.equal(retry.clientMessageId, record.clientMessageId);
  assert.equal(parseSendResponse(makeSendResponse({ sequenceId: retry.sequenceId }), record), null);
  assert.equal(parseSendResponse(makeSendResponse({ sequenceId: retry.sequenceId }), retry).state, 'confirmed_success');
});

test('matched check_message classifies duplicate rejection; unknown check code stays an anomaly', () => {
  const record = request();
  const bytes = makeSendResponse({ status: 3, extraSend: join(int(5, '987654321098765'), data(6, '请勿重复发送')) });
  const duplicate = parseSendResponse(bytes, record);
  assert.equal(duplicate.state, 'confirmed_failure'); assert.equal(duplicate.failureScope, 'recipient');
  assert.match(duplicate.reason, /DM_DUPLICATE_MESSAGE/); assert.match(duplicate.reason, /987654321098765/);
  const unknown = parseSendResponse(makeSendResponse({ status: 3, extraSend: join(int(5, 999), data(6, '未识别业务失败')) }), record);
  assert.equal(unknown.failureScope, undefined); assert.match(unknown.reason, /检查码：999/);
  assert.equal(parseSendResponse(makeSendResponse({ status: 3, clientMessageId: 'another', extraSend: data(6, '请勿重复发送') }), record), null);
  assert.equal(parseSendResponse(makeSendResponse({ status: 3, extraSend: data(6, '操作频繁，请勿重复发送') }), record).failureScope, undefined);
  assert.equal(parseSendResponse(makeSendResponse({ status: 1, extraSend: data(6, '请勿重复发送') }), record).failureScope, undefined);
});

test('async and changed filtered content do not claim original synchronous acceptance', () => {
  const record = request();
  assert.equal(parseSendResponse(makeSendResponse({ extraSend: int(8, 1) }), record), null);
  assert.equal(parseSendResponse(makeSendResponse({ extraSend: data(7, JSON.stringify({ text: 'changed' })) }), record), null);
  assert.equal(parseSendResponse(makeSendResponse({ extraSend: data(7, 'unknown-content') }), record), null);
  assert.equal(parseSendResponse(makeSendResponse({ extraSend: join(int(8, 0), data(7, JSON.stringify({ text: d.message }))) }), record).state, 'confirmed_success');
});

test('matched account frequency and daily stranger limits are explicit account rejections', () => {
  const record = request();
  for (const [text, code] of [['操作频繁，请稍后再试', 'DM_ACCOUNT_FREQUENT'], ['今日陌生人私信达到上限', 'DM_ACCOUNT_DAILY_LIMIT']]) {
    const result = parseSendResponse(makeSendResponse({ status: 3, extraSend: data(6, text) }), record);
    assert.equal(result.state, 'confirmed_failure'); assert.equal(result.failureScope, 'account'); assert.equal(result.failureCode, code);
    assert.equal(parseSendResponse(makeSendResponse({ status: 3, clientMessageId: 'foreign', extraSend: data(6, text) }), record), null);
  }
  for (const text of ['给对方发送的消息已达上限，对方回复或互关后才能继续发送消息', '对方设置了仅和他互关的人可发消息，由于你不在范围内，暂无法给对方发送消息']) {
    assert.equal(parseSendResponse(makeSendResponse({ status: 3, extraSend: data(6, text) }), record).failureScope, 'recipient');
  }
});

test('optional response conversation fields cannot contradict the frozen request', () => {
  const record = request();
  const valid = join(data(1, record.conversationId), int(2, record.conversationShortId), int(3, 1), int(9, 1));
  assert.equal(parseSendResponse(makeSendResponse({ extraSend: data(10, valid) }), record).state, 'confirmed_success');
  for (const conversation of [data(1, '0:1:11:22'), int(2, '999'), int(3, 2), int(9, 2), join(data(1, record.conversationId), data(1, 'other'))]) {
    assert.equal(parseSendResponse(makeSendResponse({ extraSend: data(10, conversation) }), record), null);
  }
});

test('observed nested check_message frequency maps to account pause; arbitrary JSON text and code alone do not', () => {
  const record = request(), text = '给陌生人发送消息过于频繁，请稍后再发送陌生人消息';
  const check = JSON.stringify({ status_code: 7180, tips: '', status_msg: { msg_type: 1, msg_content: { tips: text, template: [] } }, raw_check_code: 2 });
  const overrides = { status: 3, serverMessageId: null, extraSend: join(int(5, 2), data(6, check)) };
  const result = parseSendResponse(makeSendResponse(overrides), record);
  assert.equal(result.state, 'confirmed_failure'); assert.equal(result.failureScope, 'account'); assert.equal(result.failureCode, 'DM_ACCOUNT_FREQUENT');
  assert.match(result.evidence, /check=2;business=7180/);
  assert.equal(parseSendResponse(makeSendResponse({ ...overrides, clientMessageId: 'foreign' }), record), null);
  assert.equal(parseSendResponse(makeSendResponse({ ...overrides, sequenceId: '99' }), record), null);
  for (const payload of [{ status_code: 7180, tips: '' }, { message: text }, { data: { tips: text } },
    { status_msg: { msg_type: 2, msg_content: { tips: text } } }, [text]]) {
    const generic = parseSendResponse(makeSendResponse({ ...overrides, extraSend: data(6, JSON.stringify(payload)) }), record);
    assert.equal(generic.state, 'confirmed_failure'); assert.equal(generic.failureScope, undefined);
  }
  const daily = parseSendResponse(makeSendResponse({ ...overrides, extraSend: data(6, JSON.stringify({ tips: '今日陌生人私信达到上限' })) }), record);
  assert.equal(daily.failureCode, 'DM_ACCOUNT_DAILY_LIMIT'); assert.equal(daily.failureScope, 'account');
  // Actual successful messages also had a nonzero check_message status_code:
  // status_code by itself must not override a matched send=0 + server ID.
  const accepted = parseSendResponse(makeSendResponse({ extraSend: data(6, JSON.stringify({ status_code: 22102, tips: '' })) }), record);
  assert.equal(accepted.state, 'confirmed_success');
});

test('rejects duplicate critical fields in every envelope/body', () => {
  for (const extraEnvelope of [int(1, 100), int(2, d.sequenceId), int(6, 1), data(8, Buffer.alloc(0))]) {
    assert.equal(request({ extraEnvelope }), null);
  }
  for (const extraSend of [data(1, `0:1:${d.selfNumericUid}:${d.targetNumericUid}`), int(2, 1),
    int(3, d.conversationShortId), data(4, JSON.stringify({ text: d.message })), int(6, 7), data(8, d.clientMessageId)]) {
    assert.equal(request({ extraSend }), null);
  }
  assert.equal(request({ body: join(data(100, Buffer.alloc(0)), data(100, Buffer.alloc(0))) }), null);
  const record = request();
  for (const extraEnvelope of [int(1, 100), int(2, d.sequenceId), int(3, 0), int(5, 1), data(6, Buffer.alloc(0)), int(13, d.selfNumericUid)]) {
    assert.equal(parseSendResponse(makeSendResponse({ extraEnvelope }), record), null);
  }
  for (const extraSend of [int(1, '800000000000000001'), int(3, 0), data(4, d.clientMessageId), join(int(8, 0), int(8, 0))]) {
    assert.equal(parseSendResponse(makeSendResponse({ extraSend }), record), null);
  }
});

test('rejects references, mentions, encrypted identities and conflicting explicit recipient', () => {
  for (const extraSend of [int(9, 1), data(9, Buffer.alloc(0)), data(11, Buffer.alloc(0)), int(14, 1),
    int(33, d.selfNumericUid), data(50, 'opaque'), data(51, 'opaque'), data(52, 'opaque')]) {
    assert.equal(request({ extraSend }), null);
  }
  assert.ok(request({ extraSend: int(33, d.targetNumericUid) }));
});

test('skips credential and unknown fields without exposing or retaining them', () => {
  const marker = 'synthetic-secret-never-return';
  const record = request({ extraEnvelope: join(data(4, marker), data(15, Buffer.from([255, 255]))),
    extraSend: join(data(7, marker), data(5, Buffer.from([255, 255])), int(120, 42), data(121, marker)) });
  assert.ok(record);
  assert.equal(JSON.stringify(record).includes(marker), false);
  const outcome = parseSendResponse(makeSendResponse({ extraEnvelope: join(data(4, marker), data(8, Buffer.from([255])), data(110, marker)), extraSend: data(9, marker) }), record);
  assert.equal(outcome.state, 'confirmed_success');
  assert.equal(JSON.stringify(outcome).includes(marker), false);
});

test('rejects malformed wire data, truncation, overflow, invalid UTF8 and noncanonical varints', () => {
  const record = request();
  for (const bytes of [
    Buffer.from([0]), Buffer.from([8]), Buffer.from([8, 128, 0]), Buffer.from([11, 12]),
    Buffer.from([8, ...Array(10).fill(255)]), Buffer.from([66, 127]),
    join(data(1, '100'), int(2, d.sequenceId)), Buffer.alloc(MAX_BYTES + 1),
    makeSendRequest().subarray(0, -1)
  ]) {
    assert.equal(parseSendRequest(bytes, options()), null);
    assert.equal(parseSendResponse(bytes, record), null);
  }
  assert.equal(request({ sendBody: join(data(1, Buffer.from([255])), int(2, 1), data(4, '{}'), int(6, 7), data(8, d.clientMessageId)) }), null);
  assert.equal(parseSendRequest('not bytes', options()), null);
  assert.equal(request({ extraEnvelope: join(Array.from({ length: 1025 }, () => int(120, 1))) }), null);
});

test('honors byte offsets of Uint8Array views', () => {
  const bytes = makeSendRequest();
  const padded = join(Buffer.from([255]), bytes, Buffer.from([255]));
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 1, bytes.length);
  assert.ok(parseSendRequest(view, options()));
});
