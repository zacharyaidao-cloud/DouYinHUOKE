'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { observeProfileRelation } = require('../lib/profile-relation-observer');
const targetSecUid = 'MS4w-fixture-target', targetNumericUid = '900000000000000123';
const tick = () => new Promise(resolve => setImmediate(resolve));
const base = 'https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=' + targetSecUid;
const payload = (follow_status = 1, user = {}) => ({ status_code: 0, user: { sec_uid: targetSecUid, uid: targetNumericUid, follow_status, ...user } });
function fixture(options = {}) {
  const page = new EventEmitter(), frame = { page: () => page }; let reads = 0, clock = 1000;
  page.mainFrame = () => frame; page.isClosed = () => false;
  const observer = observeProfileRelation({ page, targetSecUid, targetNumericUid, now: () => clock, ...options });
  const request = (patch = {}) => ({ url: () => patch.url || base, method: () => patch.method || 'GET', frame: () => patch.frame || frame });
  const response = (req, patch = {}) => page.emit('response', { request: () => req, url: () => patch.url || req.url(),
    status: () => patch.status || 200, headers: () => ({ 'content-type': patch.type || 'application/json; charset=utf-8', ...patch.headers }),
    body: async () => { reads++; return patch.read ? patch.read() : patch.bytes || Buffer.from(JSON.stringify(patch.payload || payload())); } });
  const emit = (a = {}, b = {}) => { const req = request(a); page.emit('request', req); response(req, b); return req; };
  return { page, frame, observer, request, response, emit, reads: () => reads, setNow: value => { clock = value; } };
}
function cleaned(f) { f.observer.dispose(); for (const event of ['request', 'response', 'close']) assert.equal(f.page.listenerCount(event), 0); }

test('official profile follow_status 0/1/2 resolve current target relation with safe summaries', async () => {
  for (const [status, state] of [[0, 'not_following'], [1, 'following'], [2, 'following']]) {
    const f = fixture(), waiting = f.observer.wait({ timeoutMs: 1000 });
    f.emit({}, { payload: payload(status) });
    const result = await waiting;
    assert.deepEqual(result, { state, source: 'browser_profile_response', evidence: 'profile_follow_status_' + status });
    assert(!JSON.stringify(result).includes(targetSecUid)); assert(!JSON.stringify(result).includes(targetNumericUid));
    result.state = 'mutated'; assert.equal(f.observer.getSnapshot().state, state); cleaned(f);
  }
});

test('only matched current main-frame GET requests are observed, never old response alone', async () => {
  const f = fixture();
  f.response(f.request());
  for (const req of [{ method: 'POST' }, { frame: { page: () => f.page } },
    { url: base.replace('https:', 'http:') }, { url: base.replace('www.douyin.com', 'www.douyin.com.evil.test') },
    { url: base.replace('www.douyin.com', 'user:password@www.douyin.com') },
    { url: base.replace('/other/', '/self/') }, { url: base.replace(targetSecUid, 'other') },
    { url: base + '&sec_user_id=' + targetSecUid }, { url: base + '&uid=777' },
    { url: base + '&uid=' + targetNumericUid + '&uid=' + targetNumericUid }, { url: base + '#fragment' }]) f.emit(req);
  await tick(); assert.equal(f.reads(), 0); assert.equal(f.observer.getSnapshot().state, 'unknown'); cleaned(f);
});

test('response must be HTTP200 JSON for the same request URL and response target', async () => {
  for (const patch of [{ status: 403 }, { type: 'text/html' }, { url: base + '&different=1' },
    { headers: { 'content-length': '9999999' } }, { headers: { 'content-length': '-1' } }]) {
    const f = fixture(); f.emit({}, patch); await tick(); assert.equal(f.reads(), 0); cleaned(f);
  }
  for (const value of [{ status_code: 1, user: payload().user }, { user: payload().user },
    { status_code: '0', user: payload().user }, payload(1, { sec_uid: 'other' }), payload(1, { uid: '777' }),
    payload(1, { uid_str: '777' }), payload(1, { user_id: '777' }), payload(1, { uid: Number(targetNumericUid) }),
    { status_code: 0, user: [] }, { status_code: 0 }]) {
    const f = fixture(); f.emit({}, { payload: value }); await tick(); assert.equal(f.observer.getSnapshot().state, 'unknown'); cleaned(f);
  }
});

test('missing, requested, unknown or string follow_status never implies no relationship', async () => {
  for (const status of [undefined, null, -1, 3, 4, '0', '1', true, {}]) {
    const f = fixture(); f.emit({}, { payload: payload(1, { follow_status: status }) }); await tick();
    assert.equal(f.observer.getSnapshot().state, 'unknown'); cleaned(f);
  }
});

test('sec identity remains sufficient without optional UID; present request and response UID must agree', async () => {
  const noUid = fixture({ targetNumericUid: undefined });
  noUid.emit({}, { payload: payload(1, { uid: undefined }) }); await tick();
  assert.equal(noUid.observer.getSnapshot().state, 'following'); cleaned(noUid);
  const conflict = fixture({ targetNumericUid: undefined });
  conflict.emit({ url: base + '&user_id=777' }); await tick();
  assert.equal(conflict.observer.getSnapshot().state, 'unknown'); cleaned(conflict);
  const safeNumber = fixture({ targetNumericUid: '123' });
  safeNumber.emit({ url: base + '&uid=123' }, { payload: payload(0, { uid: 123 }) }); await tick();
  assert.equal(safeNumber.observer.getSnapshot().state, 'not_following'); cleaned(safeNumber);
});

test('malformed/oversized payloads remain unknown and latest accepted request wins over delayed older body', async () => {
  for (const bytes of [Buffer.from('{bad'), Buffer.alloc(512 * 1024 + 1), Buffer.from('null'), Buffer.from('[]')]) {
    const f = fixture(); f.emit({}, { bytes }); await tick(); assert.equal(f.observer.getSnapshot().state, 'unknown'); cleaned(f);
  }
  const f = fixture(); let release;
  f.emit({}, { read: () => new Promise(resolve => { release = resolve; }) }); await tick();
  f.emit({}, { payload: payload(2) }); await tick();
  release(Buffer.from(JSON.stringify(payload(0)))); await tick();
  assert.equal(f.observer.getSnapshot().evidence, 'profile_follow_status_2'); cleaned(f);
});

test('short wait is bounded, disposes listeners, and ignores bodies completing after timeout', async () => {
  const f = fixture(); let release;
  f.emit({}, { read: () => new Promise(resolve => { release = resolve; }) }); await tick();
  assert.equal((await f.observer.wait({ timeoutMs: 1 })).state, 'unknown');
  release(Buffer.from(JSON.stringify(payload()))); await tick();
  assert.equal(f.observer.getSnapshot().state, 'unknown'); cleaned(f);
});

test('abort, page close, explicit dispose and already aborted signals release waiting callers', async () => {
  for (const mode of ['abort', 'close', 'dispose']) {
    const controller = new AbortController(), f = fixture({ signal: controller.signal });
    const waiting = f.observer.wait({ timeoutMs: 1000 });
    if (mode === 'abort') controller.abort(); else if (mode === 'close') f.page.emit('close'); else f.observer.dispose();
    assert.equal((await waiting).state, 'unknown'); cleaned(f);
  }
  const controller = new AbortController(); controller.abort();
  const f = fixture({ signal: controller.signal }); assert.equal((await f.observer.wait()).state, 'unknown'); cleaned(f);
});

test('expired lifetime, invalid targets and candidate bounds do not keep observing', async () => {
  const expired = fixture(); expired.setNow(31001); expired.emit(); await tick();
  assert.equal(expired.reads(), 0); assert.equal((await expired.observer.wait({ timeoutMs: 1 })).state, 'unknown'); cleaned(expired);
  for (const options of [{ targetSecUid: '' }, { targetSecUid: '../other' }, { targetNumericUid: 'not-numeric' }, { targetNumericUid: Number(targetNumericUid) }]) {
    const f = fixture(options); f.emit(); await tick(); assert.equal(f.reads(), 0); assert.equal((await f.observer.wait()).state, 'unknown'); cleaned(f);
  }
  const bounded = fixture(); for (let i = 0; i < 30; i++) bounded.emit({}, { payload: payload(4) }); await tick();
  assert.equal(bounded.reads(), 24); cleaned(bounded);
});
