'use strict';

// Passive, per-click correlation only. This module never sends or replays a
// platform request. Request bodies stay in memory and never enter diagnostics.
const { parseSendRequest, parseSendResponse } = require('./dm-protocol');
const MAX_BYTES = 128 * 1024;
const MAX_REQUESTS = 32;
// Matches the observed official SDK's HTTP timeout, but is a total attempt
// ceiling: response arrival releases immediately; automatic SDK retries beyond
// this ceiling remain pending rather than being resent by our application.
const WINDOW_MS = 30000;

function address(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 65536) return null;
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'imapi.douyin.com'
      && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
      && ['/v1/message/send', '/v1/message/send/'].includes(url.pathname) ? url : null;
  } catch (_) { return null; }
}
function ownPage(request, page) {
  try { const frame = request.frame(); return !!frame && frame.page() === page && frame === page.mainFrame(); }
  catch (_) { return false; }
}
function binaryType(item) {
  try {
    const type = String(item.headers()['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    return ['application/x-protobuf', 'application/protobuf', 'application/octet-stream'].includes(type);
  } catch (_) { return false; }
}
function remove(page, event, fn) {
  if (typeof page.off === 'function') page.off(event, fn);
  else page.removeListener(event, fn);
}

function observeDmSendReceipt({ page, targetNumericUid, targetSecUid, signal, now = Date.now, onOutcome = () => {} }) {
  let active = true, armedAt = null, message = null, requests = new WeakMap();
  let accepted = 0, seen = 0, completed = 0, result = null, messageIdentity = null, ambiguous = false;
  const withinWindow = () => active && armedAt !== null && !(signal && signal.aborted)
    && now() >= armedAt && now() - armedAt <= WINDOW_MS;
  const onRequest = request => {
    try {
      if (!withinWindow() || typeof message !== 'string' || !message || seen >= MAX_REQUESTS
        || request.method() !== 'POST' || !ownPage(request, page) || requests.has(request)) return;
      const url = address(request.url());
      if (!url || !binaryType(request)) return;
      seen++;
      if (typeof request.postDataBuffer !== 'function') return;
      const bytes = request.postDataBuffer();
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) return;
      const record = parseSendRequest(bytes, { targetNumericUid, targetSecUid, message });
      if (!record) return;
      // SDK retries can use a fresh sequence with the same client message ID.
      // Multiple distinct messages inside one click window are ambiguous.
      if (messageIdentity !== null && messageIdentity !== record.clientMessageId) {
        ambiguous = true; result = null; return;
      }
      messageIdentity = record.clientMessageId;
      requests.set(request, { record, address: url.href });
      accepted++;
    } catch (_) { /* Unknown protocol remains pending. */ }
  };
  const onResponse = response => {
    let pair;
    try {
      if (!withinWindow() || ambiguous || result) return;
      const request = response.request(); pair = requests.get(request);
      const url = address(response.url());
      if (!pair || !url || url.href !== pair.address || !ownPage(request, page)) return;
      requests.delete(request);
      if (response.status() !== 200 || !binaryType(response)) return;
      const length = Number(response.headers()['content-length']);
      if (Number.isFinite(length) && (length < 0 || length > MAX_BYTES)) return;
    } catch (_) { return; }
    Promise.resolve().then(async () => {
      if (!withinWindow() || ambiguous || result) return;
      const bytes = await response.body();
      if (!withinWindow() || ambiguous || result || !Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) return;
      completed++;
      const parsed = parseSendResponse(bytes, pair.record);
      if (!parsed || !['confirmed_success', 'confirmed_failure'].includes(parsed.state) || !parsed.evidence) return;
      result = { state: parsed.state, reason: parsed.reason || '', evidence: parsed.evidence,
        ...(['recipient', 'account'].includes(parsed.failureScope) ? { failureScope: parsed.failureScope, failureCode: parsed.failureCode } : {}) };
      onOutcome({ ...result });
    }).catch(() => { /* Body/decoding failures cannot confirm success or trigger a retry. */ });
  };
  const closed = () => dispose(), aborted = () => dispose();
  function dispose() {
    if (!active) return;
    active = false; message = null; requests = new WeakMap();
    remove(page, 'request', onRequest); remove(page, 'response', onResponse); remove(page, 'close', closed);
    if (signal) signal.removeEventListener('abort', aborted);
  }
  page.on('request', onRequest); page.on('response', onResponse); page.on('close', closed);
  if (signal) signal.addEventListener('abort', aborted, { once: true });
  return {
    arm(options = {}) {
      if (!active || armedAt !== null || signal && signal.aborted) return;
      armedAt = now(); message = typeof options.message === 'string' ? options.message : null;
    },
    outcome() { return ambiguous ? null : result && { ...result }; },
    remainingMs: () => armedAt === null ? 0 : Math.max(0, Math.min(WINDOW_MS, WINDOW_MS - (now() - armedAt))),
    summary: () => ({ recognizedRequests: accepted, decodedResponses: completed, ambiguous }),
    dispose
  };
}

module.exports = { observeDmSendReceipt };
