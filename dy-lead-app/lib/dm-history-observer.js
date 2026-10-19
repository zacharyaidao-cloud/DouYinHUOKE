'use strict';

// Observe only the browser's own history request/response pairs. There is no
// fetch/replay/cursor driving here and no payload or participant ID is logged.
const { parseHistoryRequest, parseHistoryResponse, MAX_BYTES, MAX_HISTORY_BYTES } = require('./dm-protocol');
const PATHS = new Map([[301, '/v1/message/get_by_conversation'], [1002, '/v1/stranger/get_messages']]);
// Lifetime spans UI readiness; wait() controls a separate short response wait.
// This is not an action delay and a confirmed historical result releases early.
const MAX_REQUESTS = 24, MAX_WINDOW_MS = 30000;
const unknown = reason => ({ state: 'unknown', lastSentAt: null, reason, evidence: '', source: 'none', complete: false, completeHistoryProven: false });
function address(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 65536) return null;
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'imapi.douyin.com' && !url.username && !url.password && !url.hash
      && (!url.port || url.port === '443') && Array.from(PATHS.values()).some(path => [path, path + '/'].includes(url.pathname)) ? url : null;
  } catch (_) { return null; }
}
function ownPage(request, page) {
  try { const frame = request.frame(); return !!frame && frame === page.mainFrame() && frame.page() === page; }
  catch (_) { return false; }
}
function binaryType(item) {
  try { return ['application/x-protobuf', 'application/protobuf', 'application/octet-stream'].includes(String(item.headers()['content-type'] || '').split(';', 1)[0].trim().toLowerCase()); }
  catch (_) { return false; }
}
function remove(page, event, listener) { if (typeof page.off === 'function') page.off(event, listener); else page.removeListener(event, listener); }

function createDmHistoryObserver({ page, targetNumericUid, selfNumericUid, signal, now = Date.now }) {
  let active = true, armedAt = null, requests = new WeakMap(), seen = 0, recognizedRequests = 0, decodedResponses = 0;
  let observedPages = 0, observedMessages = 0, outgoingTextCount = 0, hasMore = null;
  let result = unknown('尚未取得当前目标的可确认历史响应'), waiting = null, settle = null, armTimer = null;
  const within = () => active && armedAt !== null && !(signal && signal.aborted) && now() >= armedAt && now() - armedAt <= MAX_WINDOW_MS;
  const snapshot = () => ({ ...result });
  function dispose() {
    if (!active) return;
    active = false; requests = new WeakMap(); clearTimeout(armTimer);
    for (const [event, listener] of [['request', onRequest], ['response', onResponse], ['close', closed]]) remove(page, event, listener);
    if (signal) signal.removeEventListener('abort', aborted);
    if (settle) settle();
  }
  const onRequest = request => {
    try {
      if (!within() || seen >= MAX_REQUESTS || requests.has(request) || request.method() !== 'POST' || !ownPage(request, page) || !binaryType(request)) return;
      const url = address(request.url()); if (!url) return;
      seen++;
      const bytes = request.postDataBuffer();
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) return;
      const options = { targetNumericUid, ...(selfNumericUid === undefined ? {} : { selfNumericUid }) };
      const record = parseHistoryRequest(bytes, options);
      if (!record || ![PATHS.get(record.command), PATHS.get(record.command) + '/'].includes(url.pathname)) return;
      requests.set(request, { record, address: url.href }); recognizedRequests++;
    } catch (_) { /* Unknown request schema is not no-history evidence. */ }
  };
  const onResponse = response => {
    let pair;
    try {
      if (!within()) return;
      const request = response.request(), url = address(response.url()); pair = requests.get(request);
      if (!pair || !url || url.href !== pair.address || !ownPage(request, page)) return;
      requests.delete(request);
      if (response.status() !== 200 || !binaryType(response)) return;
      const length = Number(response.headers()['content-length']);
      if (Number.isFinite(length) && (length < 0 || length > MAX_HISTORY_BYTES)) return;
    } catch (_) { return; }
    Promise.resolve().then(async () => {
      if (!within()) return;
      const bytes = await response.body();
      if (!within() || !Buffer.isBuffer(bytes) || bytes.length > MAX_HISTORY_BYTES) return;
      decodedResponses++;
      const parsed = parseHistoryResponse(bytes, pair.record); if (!parsed) return;
      observedPages++; observedMessages += parsed.observedMessages; outgoingTextCount += parsed.outgoingTextCount;
      hasMore = parsed.hasMore;
      // A later empty or unrelated page can never erase positive history.
      if (result.state !== 'already_sent' && (parsed.state === 'already_sent' || result.state !== 'no_outbound')) result = { ...parsed };
      if (['already_sent', 'no_outbound'].includes(result.state) && settle) settle();
    }).catch(() => {});
  };
  const closed = () => { if (result.state !== 'already_sent') result = unknown('账号窗口已关闭，历史状态未知'); dispose(); };
  const aborted = () => { if (result.state !== 'already_sent') result = unknown('任务已停止，历史状态未知'); dispose(); };
  page.on('request', onRequest); page.on('response', onResponse); page.on('close', closed);
  if (signal) signal.addEventListener('abort', aborted, { once: true });
  return {
    arm() {
      if (!active || armedAt !== null) return;
      if (signal && signal.aborted || typeof page.isClosed === 'function' && page.isClosed()) { dispose(); return; }
      armedAt = now(); armTimer = setTimeout(dispose, MAX_WINDOW_MS); if (typeof armTimer.unref === 'function') armTimer.unref();
    },
    getOutcome: snapshot,
    getSnapshot: snapshot,
    getSummary: () => ({ recognizedRequests, decodedResponses, observedPages, observedMessages, outgoingTextCount, hasMore, completeHistoryProven: result.complete === true }),
    wait({ timeoutMs = 5000, keepAlive = false } = {}) {
      if (waiting) return waiting;
      if (['already_sent', 'no_outbound'].includes(result.state) || !active || armedAt === null) {
        if (!keepAlive) dispose();
        return Promise.resolve(snapshot());
      }
      waiting = new Promise(resolve => {
        let timer;
        settle = () => {
          if (!settle) return;
          settle = null; waiting = null; clearTimeout(timer);
          // Releasing the initial readiness wait need not discard history
          // that arrives while the editor is being filled. The caller freezes
          // this bounded observer before Send so new sends cannot become old history.
          if (!keepAlive) dispose();
          resolve(snapshot());
        };
        const remaining = Math.max(0, Math.min(MAX_WINDOW_MS, MAX_WINDOW_MS - (now() - armedAt)));
        timer = setTimeout(settle, Math.min(remaining, Math.max(1, Number(timeoutMs) || 5000)));
      });
      return waiting;
    },
    dispose
  };
}

function observeDmHistory(options) { const observer = createDmHistoryObserver(options); observer.arm(); return observer; }
module.exports = { createDmHistoryObserver, observeDmHistory };
