'use strict';

// Passive, current-page profile evidence only. This observer never fetches,
// replays, clicks, or treats a missing relationship field as "not following".
// Official PC IM rM: Unknown=-1, UnFollow=0, Followed=1, FollowEach=2,
// Requested=4 (official-pcim.0ccd0cf4.js; protocol research notes).
const MAX_WINDOW_MS = 30000, MAX_REQUESTS = 24, MAX_BYTES = 512 * 1024;
const unknown = () => ({ state: 'unknown', source: 'none', evidence: '' });
function numericUid(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return /^(?:[1-9]\d{0,31})$/.test(String(value)) ? String(value) : null;
}
function address(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 65536) return null;
    const url = new URL(raw);
    return url.protocol === 'https:' && ['www.douyin.com', 'douyin.com'].includes(url.hostname)
      && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
      && ['/aweme/v1/web/user/profile/other/', '/aweme/v1/web/user/profile/other'].includes(url.pathname) ? url : null;
  } catch (_) { return null; }
}
function ownPage(request, page) {
  try { const frame = request.frame(); return !!frame && frame === page.mainFrame() && frame.page() === page; }
  catch (_) { return false; }
}
function remove(page, event, listener) {
  if (typeof page.off === 'function') page.off(event, listener); else page.removeListener(event, listener);
}
function idsAgree(values, target) {
  const present = values.filter(value => value !== undefined);
  const normalized = present.map(numericUid);
  return normalized.every(Boolean) && new Set(normalized).size <= 1 && (!target || normalized.every(value => value === target));
}

function observeProfileRelation({ page, targetSecUid, targetNumericUid, signal, now = Date.now }) {
  const sec = typeof targetSecUid === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(targetSecUid) ? targetSecUid : null;
  const target = targetNumericUid === undefined || targetNumericUid === null || targetNumericUid === '' ? null : numericUid(targetNumericUid);
  const validTarget = !!sec && (targetNumericUid === undefined || targetNumericUid === null || targetNumericUid === '' || !!target);
  const armedAt = now();
  let active = true, requests = new WeakMap(), seen = 0, latestAccepted = 0;
  let result = unknown(), waiting = null, settle = null, lifetime;
  const snapshot = () => ({ ...result });
  const within = () => active && !(signal && signal.aborted) && now() >= armedAt && now() - armedAt <= MAX_WINDOW_MS;
  function dispose() {
    if (!active) return;
    active = false; requests = new WeakMap(); clearTimeout(lifetime);
    for (const [event, listener] of [['request', onRequest], ['response', onResponse], ['close', closed]]) remove(page, event, listener);
    if (signal) signal.removeEventListener('abort', aborted);
    if (settle) settle();
  }
  const onRequest = request => {
    try {
      if (!within() || seen >= MAX_REQUESTS || requests.has(request) || request.method() !== 'GET' || !ownPage(request, page)) return;
      const url = address(request.url()); if (!url) return;
      seen++;
      if (url.searchParams.getAll('sec_user_id').length !== 1 || url.searchParams.get('sec_user_id') !== sec) return;
      const ids = ['uid', 'user_id'].flatMap(key => url.searchParams.getAll(key));
      if (['uid', 'user_id'].some(key => url.searchParams.getAll(key).length > 1) || !idsAgree(ids, target)) return;
      requests.set(request, { address: url.href, order: seen, numericUid: ids.length ? numericUid(ids[0]) : target });
    } catch (_) { /* Unknown request identity is not relationship evidence. */ }
  };
  const onResponse = response => {
    let pair;
    try {
      if (!within()) return;
      const request = response.request(), url = address(response.url()); pair = requests.get(request);
      if (!pair || !url || pair.address !== url.href || !ownPage(request, page)) return;
      requests.delete(request);
      const headers = response.headers();
      if (response.status() !== 200 || String(headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') return;
      const length = Number(headers['content-length']);
      if (Number.isFinite(length) && (length < 0 || length > MAX_BYTES)) return;
    } catch (_) { return; }
    Promise.resolve().then(async () => {
      if (!within()) return;
      const bytes = await response.body();
      if (!within() || !Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || pair.order < latestAccepted) return;
      const payload = JSON.parse(bytes.toString('utf8'));
      if (!payload || Array.isArray(payload) || payload.status_code !== 0) return;
      const user = payload.user;
      if (!user || Array.isArray(user) || typeof user !== 'object' || user.sec_uid !== sec
        || !idsAgree([user.uid, user.uid_str, user.user_id], pair.numericUid) || ![0, 1, 2].includes(user.follow_status)) return;
      latestAccepted = pair.order;
      result = { state: user.follow_status === 0 ? 'not_following' : 'following', source: 'browser_profile_response',
        evidence: 'profile_follow_status_' + user.follow_status };
      if (settle) settle();
    }).catch(() => {});
  };
  const closed = () => { result = unknown(); dispose(); };
  const aborted = () => { result = unknown(); dispose(); };
  page.on('request', onRequest); page.on('response', onResponse); page.on('close', closed);
  if (signal) signal.addEventListener('abort', aborted, { once: true });
  if (!validTarget || signal && signal.aborted || typeof page.isClosed === 'function' && page.isClosed()) dispose();
  else { lifetime = setTimeout(dispose, MAX_WINDOW_MS); if (typeof lifetime.unref === 'function') lifetime.unref(); }
  return {
    getSnapshot: snapshot,
    wait({ timeoutMs = 1500 } = {}) {
      if (waiting) return waiting;
      if (result.state !== 'unknown' || !active) { dispose(); return Promise.resolve(snapshot()); }
      waiting = new Promise(resolve => {
        let timer;
        settle = () => { if (!settle) return; settle = null; clearTimeout(timer); dispose(); resolve(snapshot()); };
        const remaining = Math.max(0, MAX_WINDOW_MS - (now() - armedAt));
        const requested = Number(timeoutMs);
        timer = setTimeout(settle, Math.min(remaining, Number.isFinite(requested) ? Math.max(0, requested) : 1500));
      });
      return waiting;
    },
    dispose
  };
}
module.exports = { observeProfileRelation };
