'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { commentEvidence, parseCommentTimestamp } = require('../lib/comment-evidence');
const AI = require('../ai');
const workflow = require('../workflow');
const first = 1760000000, second = 1760100000;
const display = stamp => {
  const date = new Date(stamp * 1000), pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

test('raw create_time seconds accept safe integers only, never guess milliseconds', () => {
  for (const value of [first, String(first), ` ${first} `]) assert.equal(parseCommentTimestamp(value), first);
  assert.equal(parseCommentTimestamp(253402300799), 253402300799);
  for (const value of [undefined, null, '', ' ', false, true, 0, '0', -1, 'NaN', NaN, Infinity,
    1.5, '1.5', '1e9', '0x100', {}, [], first * 1000, 253402300800, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseCommentTimestamp(value), null);
  }
});

test('new comments store cid, display date and numeric raw seconds from one response', () => {
  assert.deepEqual(commentEvidence({ cid: 'new-comment', create_time: String(first) }),
    { commentId: 'new-comment', time: display(first), commentTimestamp: first });
  assert.deepEqual(commentEvidence({ cid: 'untimed', create_time: 'invalid' }), { commentId: 'untimed', time: '' });
  assert.deepEqual(commentEvidence({ create_time: first }), { time: display(first), commentTimestamp: first });
  assert.deepEqual(commentEvidence(null), {});
});

test('same cid keeps historical display, fills raw seconds and never rewrites business data', () => {
  const previous = { id: 4, commentId: 'same', time: '历史显示保持原样', demand: '原评论',
    fetchTime: '首次获取', aiNeed: '是', aiInputHash: 'original-hash', dmCount: 2, dmSentAt: '首次发送' };
  const snapshot = structuredClone(previous);
  const patch = commentEvidence({ cid: 'same', create_time: first }, previous);
  assert.deepEqual(patch, { commentTimestamp: first });
  assert.deepEqual(previous, snapshot, 'The helper is a pure patch builder');
  assert.deepEqual({ ...previous, ...patch }, { ...snapshot, commentTimestamp: first });
  assert.deepEqual(commentEvidence({ cid: 'same', create_time: second }, { ...previous, commentTimestamp: first }), {});
});

test('same cid fills missing display from the already selected raw timestamp', () => {
  assert.deepEqual(commentEvidence({ cid: 'same', create_time: second }, { commentId: 'same', commentTimestamp: first }),
    { time: display(first) });
  assert.deepEqual(commentEvidence({ cid: 'same', create_time: first }, { commentId: 'same', time: '', commentTimestamp: 'bad' }),
    { time: display(first), commentTimestamp: first });
});

test('same text with a different cid switches the complete selected time evidence', () => {
  const previous = { commentId: 'old', time: display(first), commentTimestamp: first, demand: '同文案', fetchTime: '首次采集' };
  const patch = commentEvidence({ cid: 'new', create_time: second }, previous);
  assert.deepEqual(patch, { commentId: 'new', time: display(second), commentTimestamp: second });
  assert.equal({ ...previous, ...patch }.fetchTime, '首次采集');
});

test('untimed different cid and missing cid cannot splice onto historical timed evidence', () => {
  const previous = { commentId: 'old', time: display(first), commentTimestamp: first };
  assert.deepEqual(commentEvidence({ cid: 'new', create_time: null }, previous), {});
  assert.deepEqual(commentEvidence({ create_time: second }, previous), {});
  assert.deepEqual(commentEvidence({ cid: 'new', create_time: 'bad' }, { time: '旧时间' }), {});
  assert.deepEqual(commentEvidence({ cid: 'new', create_time: 'bad' }, { time: '' }), { commentId: 'new' });
});

test('legacy rows are changed only when recollection supplies actual matching text evidence', () => {
  const previous = { id: 3, time: '旧时间', fetchTime: '不可冒充评论时间', demand: '同文案', dmState: 'confirmed_success' };
  const patch = commentEvidence({ cid: 'first-observed-id', create_time: first }, previous);
  assert.deepEqual(patch, { commentId: 'first-observed-id', time: display(first), commentTimestamp: first });
  assert.deepEqual(commentEvidence({ cid: 'first-observed-id' }, previous), {});
});

test('time/body changes invalidate the existing AI input hash without inventing another judgment', () => {
  const previous = { id: 8, uid: 'user-sec', UID: '123', nickname: '示例用户', demand: '同文案',
    commentId: 'old', time: display(first), commentTimestamp: first,
    aiNeed: '是', aiReason: '评论提出服务需求', aiDone: true, aiPromptVersion: 'synthetic-rule' };
  previous.aiInputHash = workflow.aiInputHash(previous);
  assert.equal(AI.isStoredResultCurrent(previous, 'synthetic-rule'), true);
  const supplemented = { ...previous, ...commentEvidence({ cid: 'old', create_time: first }, previous) };
  assert.equal(AI.isStoredResultCurrent(supplemented, 'synthetic-rule'), true);
  const changed = { ...previous, ...commentEvidence({ cid: 'new', create_time: second }, previous) };
  assert.equal(changed.aiInputHash, previous.aiInputHash);
  assert.equal(changed.aiNeed, previous.aiNeed);
  assert.equal(AI.isStoredResultCurrent(changed, 'synthetic-rule'), false);
  assert.equal(AI.isStoredResultCurrent({ ...previous, demand: '评论已改成不需要服务' }, 'synthetic-rule'), false);
});
