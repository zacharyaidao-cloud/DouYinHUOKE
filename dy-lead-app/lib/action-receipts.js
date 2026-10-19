'use strict';

// Passive browser observations only. Never issue a request, replay an action,
// persist a payload/URL query, or infer success from HTTP 200/DOM appearance.
// The follow path/schema is a narrowly accepted candidate, not a guarantee that
// every current platform version uses this protocol. Unknown schemas stay pending.
const FOLLOW_PATH = '/aweme/v1/web/commit/follow/user/';
const MAX_BYTES = 64 * 1024;
const MAX_EVENTS = 32;
const DM_DIAGNOSTIC_WINDOW_MS = 5000;
const { observeDmSendReceipt } = require('./dm-receipt-observer');

function trustedAddress(raw) {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return null;
    const url = new URL(raw);
    return url.protocol === 'https:' && ['www.douyin.com', 'douyin.com'].includes(url.hostname)
      && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') ? url : null;
  } catch (_) { return null; }
}
function pending(reason) { return { state: 'pending_verification', reason, evidence: '' }; }
function remove(emitter, event, callback) {
  if (typeof emitter.off === 'function') emitter.off(event, callback);
  else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, callback);
}
function ownPage(request, page) {
  try {
    const frame = request.frame();
    return frame && frame.page() === page
      && (typeof page.mainFrame !== 'function' || frame === page.mainFrame());
  } catch (_) { return false; }
}
function parameters(request, url) {
  const values = new Map();
  const add = (key, value) => {
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  };
  for (const [key, value] of url.searchParams) add(key, value);
  const body = typeof request.postData === 'function' ? request.postData() : null;
  if (body != null && body !== '') {
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BYTES) return null;
    const headers = typeof request.headers === 'function' ? request.headers() : {};
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(String(headers['content-type'] || ''))) return null;
    for (const [key, value] of new URLSearchParams(body)) add(key, value);
  }
  if (Array.from(values.values()).some(items => items.length !== 1)) return null;
  return values;
}
function targetIdentity({ targetUid, targetSecUid, targetNumericUid }) {
  const sec = String(targetSecUid || targetUid || '');
  const numeric = targetNumericUid === undefined && /^[1-9]\d{0,31}$/.test(String(targetUid || ''))
    ? String(targetUid) : String(targetNumericUid || '');
  return { sec, numeric: /^[1-9]\d{0,31}$/.test(numeric) ? numeric : '' };
}
function matchesTarget(values, target, { requireFollowType = false, dm = false } = {}) {
  if (!values || !target.sec && !target.numeric) return false;
  const secKeys = dm ? ['sec_user_id', 'to_sec_user_id', 'recipient_sec_uid'] : ['sec_user_id'];
  const numericKeys = dm ? ['user_id', 'to_user_id', 'recipient_uid'] : ['user_id'];
  let found = false;
  for (const key of [...secKeys, ...numericKeys]) {
    if (!values.has(key)) continue;
    const items = values.get(key);
    const expected = numericKeys.includes(key) ? target.numeric : target.sec;
    if (!expected || items.length !== 1 || items[0] !== expected) return false;
    found = true;
  }
  if (!found) return false;
  if (requireFollowType) {
    const types = values.get('type');
    if (!types || types.length !== 1 || types[0] !== '1') return false;
  }
  return true;
}

function observeRequests({ page, target, pathMatches, signal, onResponse, now = Date.now }) {
  let armedAt = null, active = true, requests = new WeakMap(), accepted = 0;
  const onRequest = request => {
    try {
      if (!active || armedAt === null || signal && signal.aborted || accepted >= MAX_EVENTS) return;
      const url = trustedAddress(request.url());
      if (!url || !pathMatches(url.pathname) || request.method() !== 'POST' || !ownPage(request, page)) return;
      const fields = parameters(request, url);
      if (!matchesTarget(fields, target, { requireFollowType: url.pathname === FOLLOW_PATH, dm: url.pathname !== FOLLOW_PATH })) return;
      const at = now(); if (at < armedAt) return;
      requests.set(request, { at, address: url.href }); accepted++;
    } catch (_) { /* malformed or unknown protocol evidence cannot confirm */ }
  };
  const response = item => {
    try {
      if (!active || armedAt === null || signal && signal.aborted) return;
      const request = item.request(), record = requests.get(request), url = trustedAddress(item.url());
      if (!record || !url || url.href !== record.address || !ownPage(request, page)) return;
      requests.delete(request);
      onResponse(item, { at: record.at, path: url.pathname });
    } catch (_) { /* unrelated response */ }
  };
  const close = () => dispose();
  const aborted = () => dispose();
  function dispose() {
    if (!active) return;
    active = false; requests = new WeakMap();
    remove(page, 'request', onRequest); remove(page, 'response', response); remove(page, 'close', close);
    if (signal) signal.removeEventListener('abort', aborted);
  }
  page.on('request', onRequest); page.on('response', response); page.on('close', close);
  if (signal) signal.addEventListener('abort', aborted, { once: true });
  return {
    arm() { if (active && !(signal && signal.aborted)) armedAt = now(); },
    active: () => active && !(signal && signal.aborted), dispose
  };
}

// This is transport metadata, independent of the strict cmd100 receipt parser.
// Not parsing a candidate here means "not evaluated", never a claim that the
// request failed target matching or that the protocol is unsupported. A parsed
// receipt is reported separately by getOutcome/getReceiptSummary.
function observeDmDiagnostics({ page, signal, now = Date.now }) {
  const entries = [];
  let armedAt = null, active = true, timer = null, requests = new WeakMap();
  const address = raw => {
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return null;
      const url = new URL(raw);
      return url.protocol === 'https:' && url.hostname === 'imapi.douyin.com'
        && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
        && url.pathname.startsWith('/v1/') && url.pathname.length <= 256 ? url : null;
    } catch (_) { return null; }
  };
  const safePath = pathname => {
    // Retain only generic operation words, never arbitrary slugs, IDs, encoded
    // values or user names. This describes an observed path; it predicts none.
    const words = new Set(['im', 'message', 'messages', 'send', 'batch', 'ack', 'pull', 'push',
      'get', 'list', 'read', 'query', 'create', 'update', 'delete', 'conversation', 'conversations']);
    const parts = pathname.slice(4).split('/');
    if (parts.length > 8) return '/v1/:path';
    return '/v1/' + parts.map(part => !part || words.has(part) ? part : ':segment').join('/');
  };
  const contentType = request => {
    try {
      const headers = typeof request.headers === 'function' ? request.headers() : {};
      const raw = String(headers['content-type'] || '');
      const type = raw.split(';', 1)[0].trim().toLowerCase();
      return ['application/json', 'application/x-protobuf', 'application/protobuf',
        'application/octet-stream', 'application/x-www-form-urlencoded', 'text/plain'].includes(type)
        ? type : raw ? 'other' : 'unknown';
    } catch (_) { return 'unknown'; }
  };
  const withinWindow = () => {
    if (!active || armedAt === null || signal && signal.aborted) return false;
    const elapsed = now() - armedAt;
    if (elapsed < 0 || elapsed > DM_DIAGNOSTIC_WINDOW_MS) { dispose(); return false; }
    return true;
  };
  const onRequest = request => {
    try {
      if (!withinWindow() || entries.length >= MAX_EVENTS || requests.has(request)
        || request.method() !== 'POST' || !ownPage(request, page)) return;
      const url = address(request.url());
      if (!url) return;
      const entry = { origin: url.origin, path: safePath(url.pathname), method: 'POST',
        contentType: contentType(request), status: null, at: now(), phase: 'request',
        scope: 'transport_metadata', protocolEvaluation: 'not_performed' };
      entries.push(entry); requests.set(request, entry);
    } catch (_) { /* Diagnostics must never affect the send attempt. */ }
  };
  const onResponse = response => {
    try {
      if (!withinWindow()) return;
      const request = response.request(), entry = requests.get(request), url = address(response.url());
      if (!entry || !url || !ownPage(request, page) || response.url() !== request.url()) return;
      const status = response.status();
      if (!Number.isInteger(status) || status < 100 || status > 599) return;
      entry.status = status; entry.phase = 'response'; entry.responseContentType = contentType(response);
      requests.delete(request);
    } catch (_) { /* No response body, error text or protocol payload is read. */ }
  };
  const onFailed = request => {
    try {
      if (!withinWindow()) return;
      const entry = requests.get(request);
      if (!entry || !ownPage(request, page)) return;
      entry.phase = 'failed'; requests.delete(request);
    } catch (_) { /* Do not persist transport failure text, which can contain URLs. */ }
  };
  const closed = () => dispose(), aborted = () => dispose();
  function dispose() {
    if (!active) return;
    active = false; clearTimeout(timer); requests = new WeakMap();
    remove(page, 'request', onRequest); remove(page, 'response', onResponse);
    remove(page, 'requestfailed', onFailed); remove(page, 'close', closed);
    if (signal) signal.removeEventListener('abort', aborted);
  }
  page.on('request', onRequest); page.on('response', onResponse);
  page.on('requestfailed', onFailed); page.on('close', closed);
  if (signal) signal.addEventListener('abort', aborted, { once: true });
  return {
    arm() {
      if (!active || armedAt !== null) return;
      if (signal && signal.aborted || typeof page.isClosed === 'function' && page.isClosed()) { dispose(); return; }
      armedAt = now(); timer = setTimeout(dispose, DM_DIAGNOSTIC_WINDOW_MS);
      if (typeof timer.unref === 'function') timer.unref();
    },
    snapshot: () => entries.map(entry => ({ ...entry })), dispose
  };
}

function createFollowReceiptObserver({ page, targetUid, targetSecUid, targetNumericUid, signal, timeoutMs = 5000, now = Date.now }) {
  const target = targetIdentity({ targetUid, targetSecUid, targetNumericUid });
  const timeout = Math.min(15000, Math.max(1, Number(timeoutMs) || 5000));
  let done = false, armed = false, timer = null, complete;
  const result = new Promise(resolve => { complete = resolve; });
  const finish = outcome => {
    if (done) return;
    done = true; clearTimeout(timer);
    observer.dispose(); remove(page, 'close', closed);
    if (signal) signal.removeEventListener('abort', aborted);
    complete(outcome);
  };
  const closed = () => finish(pending('账号窗口已关闭，本次关注待核验，禁止自动重试'));
  const aborted = () => finish(pending('任务已停止，本次关注待核验，禁止自动重试'));
  const observer = observeRequests({ page, target, pathMatches: path => path === FOLLOW_PATH, signal, now,
    onResponse(response) {
      // Body reads may never resolve. The attempt's timer/abort settles the
      // result and late bodies cannot change a disposed attempt.
      Promise.resolve().then(async () => {
        if (done || !observer.active() || response.status() !== 200) return;
        const headers = typeof response.headers === 'function' ? response.headers() : {};
        const length = Number(headers['content-length']);
        if (Number.isFinite(length) && (length < 0 || length > MAX_BYTES)) return;
        const bytes = await response.body();
        if (done || !observer.active() || !Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) return;
        const payload = JSON.parse(bytes.toString('utf8'));
        if (!payload || Array.isArray(payload) || payload.status_code !== 0 || ![1, 2].includes(payload.follow_status)) return;
        if (payload.sec_user_id !== undefined && payload.sec_user_id !== target.sec) return;
        if (payload.user_id !== undefined && (!target.numeric
          || typeof payload.user_id === 'number' && !Number.isSafeInteger(payload.user_id)
          || String(payload.user_id) !== target.numeric)) return;
        finish({ state: 'confirmed_success', reason: '', evidence: '本次同页目标关注 POST 返回 status_code=0 且 follow_status=1/2' });
      }).catch(() => { /* decode failure leaves pending */ });
    }
  });
  page.on('close', closed);
  if (signal) signal.addEventListener('abort', aborted, { once: true });
  return {
    arm() {
      if (done || armed) return;
      if (signal && signal.aborted) { aborted(); return; }
      armed = true;
      observer.arm();
      timer = setTimeout(() => finish(pending('未取得本次目标明确关注回执，需人工核验，禁止自动重试')), timeout);
    },
    wait: () => result,
    dispose() { finish(pending('本次关注没有明确网络回执，需人工核验，禁止自动重试')); }
  };
}

function createDmReceiptObserver({ page, targetUid, targetSecUid, targetNumericUid, signal, now = Date.now }) {
  const target = targetIdentity({ targetUid, targetSecUid, targetNumericUid });
  const events = [];
  const diagnostic = observeDmDiagnostics({ page, signal, now });
  let settleObservation = null, observationWait = null, disposed = false;
  let settleReceipt = null, receiptWait = null;
  const protocol = observeDmSendReceipt({ page, targetNumericUid: target.numeric, targetSecUid: target.sec, signal, now,
    onOutcome(outcome) {
      if (disposed) return;
      events.push({ path: '/v1/message/send', protocol: 'im-protobuf-cmd100', targetMatched: true,
        state: outcome.state, evidence: outcome.evidence, at: now() });
      if (settleReceipt) settleReceipt(true);
      if (settleObservation) settleObservation(true);
    }
  });
  // Legacy candidate metadata stays non-authoritative. In particular it may
  // not release waitForReceipt while the verified protobuf body is in flight.
  const observer = observeRequests({ page, target, signal, now,
    pathMatches: path => /^\/(?:aweme\/v1\/web\/(?:im|message|private_message)\/|im\/(?:v\d+\/)?)(?:message\/)?send\/$/.test(path),
    onResponse(response, metadata) {
      if (events.length >= MAX_EVENTS) return;
      events.push({ path: metadata.path, status: response.status(), at: metadata.at, targetMatched: true });
      if (settleObservation) settleObservation(true);
    }
  });
  return {
    arm(options) { observer.arm(); diagnostic.arm(); protocol.arm(options); }, events,
    getOutcome: () => protocol.outcome() || pending('尚未取得本次目标消息的明确业务回执，需人工核验，禁止自动重发'),
    getReceiptSummary: () => protocol.summary(),
    getDiagnostics: () => diagnostic.snapshot(),
    waitForReceipt({ timeoutMs = 30000 } = {}) {
      if (receiptWait) return receiptWait;
      if (protocol.outcome()) { protocol.dispose(); return Promise.resolve(true); }
      if (disposed || signal && signal.aborted || typeof page.isClosed === 'function' && page.isClosed()) return Promise.resolve(false);
      const waitMs = Math.min(protocol.remainingMs(), Math.max(1, Number(timeoutMs) || 30000));
      if (waitMs <= 0) { protocol.dispose(); return Promise.resolve(false); }
      receiptWait = new Promise(resolve => {
        let timer;
        const aborted = () => finish(false), closed = () => finish(false);
        const finish = observed => {
          if (!settleReceipt) return;
          settleReceipt = null; clearTimeout(timer); protocol.dispose();
          remove(page, 'close', closed);
          if (signal) signal.removeEventListener('abort', aborted);
          resolve(observed);
        };
        settleReceipt = finish;
        page.on('close', closed);
        if (signal) signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => finish(false), waitMs);
      });
      return receiptWait;
    },
    waitForObservation({ timeoutMs = 2000 } = {}) {
      if (events.length) return Promise.resolve(true);
      if (disposed || signal && signal.aborted || typeof page.isClosed === 'function' && page.isClosed()) return Promise.resolve(false);
      if (observationWait) return observationWait;
      observationWait = new Promise(resolve => {
        let timer;
        const aborted = () => finish(false), closed = () => finish(false);
        const finish = observed => {
          if (!settleObservation) return;
          settleObservation = null; clearTimeout(timer);
          remove(page, 'close', closed);
          if (signal) signal.removeEventListener('abort', aborted);
          resolve(observed);
        };
        settleObservation = finish;
        page.on('close', closed);
        if (signal) signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => finish(false), Math.min(8000, Math.max(1, Number(timeoutMs) || 2000)));
      });
      return observationWait;
    },
    dispose() { disposed = true; if (settleReceipt) settleReceipt(false); if (settleObservation) settleObservation(false); observer.dispose(); diagnostic.dispose(); protocol.dispose(); }
  };
}

module.exports = { createFollowReceiptObserver, createDmReceiptObserver };
