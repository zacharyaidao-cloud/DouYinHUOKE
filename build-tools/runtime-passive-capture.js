'use strict';
// Diagnostic observer only. No click, fill, navigation, request or business
// state mutation is permitted here. Original request/response bytes stay local
// in memory; only bounded, allowlisted facts enter the capture journal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const KEY = Symbol.for('huamao.passiveCapture');
function clean(value) {
  return String(value || '').slice(0, 500).replace(/https?:\/\/\S+/gi, '[网址]')
    .replace(/\b(?:Bearer\s+)?eyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[认证数据]')
    .replace(/\b(?:token|password|authorization|cookie|api[_-]?key|signature)\s*[:=]\s*[^\s,;]+/gi, '[认证字段]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号]');
}
function wireFields(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 512 * 1024) throw new Error('protocol_size');
  let at = 0, count = 0; const out = new Map();
  const integer = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (at >= bytes.length) throw new Error('truncated');
      const b = bytes[at++]; if (i === 9 && b > 1) throw new Error('overflow');
      value |= BigInt(b & 127) << BigInt(i * 7); if (!(b & 128)) return value;
    }
    throw new Error('varint');
  };
  while (at < bytes.length) {
    if (++count > 1024) throw new Error('field_limit');
    const tag = integer(), field = Number(tag >> 3n), kind = Number(tag & 7n);
    if (!field || field > 0x1fffffff) throw new Error('field');
    let value;
    if (kind === 0) value = integer();
    else if (kind === 2) { const size = integer(); if (size > BigInt(bytes.length - at)) throw new Error('length'); value = bytes.subarray(at, at + Number(size)); at += Number(size); }
    else if (kind === 1 || kind === 5) { at += kind === 1 ? 8 : 4; if (at > bytes.length) throw new Error('fixed'); }
    else throw new Error('wire_type');
    if (out.has(field)) out.set(field, null); else out.set(field, value);
  }
  return out;
}
const stringField = (map, field) => Buffer.isBuffer(map.get(field)) && map.get(field).length <= 16384 ? map.get(field).toString('utf8') : '';
const integerField = (map, field) => typeof map.get(field) === 'bigint' ? map.get(field).toString() : null;
function summarizeIm(bytes, response, alias = () => '[编号]') {
  try {
    const envelope = wireFields(bytes), command = integerField(envelope, 1);
    const summary = { protocol: 'protobuf', command, sequenceAlias: alias(integerField(envelope, 2)), outerStatus: response ? integerField(envelope, 3) ?? '0' : undefined,
      outerStatusExplicit: response ? envelope.has(3) : undefined, outerMessage: response ? clean(stringField(envelope, 4)) : undefined,
      fieldNumbers: [...envelope.keys()] };
    let send, text = '';
    if (command === '100') {
      const body = wireFields(envelope.get(response ? 6 : 8)), raw = body.get(100); send = wireFields(raw);
      summary.clientAlias = alias(stringField(send, response ? 4 : 8));
      if (response) Object.assign(summary, { sendStatus: integerField(send, 3) ?? '0', sendStatusExplicit: send.has(3), checkCode: integerField(send, 5),
        checkMessage: clean(stringField(send, 6)), asyncResult: integerField(send, 8), serverMessageIdPresent: typeof send.get(1) === 'bigint' && send.get(1) > 0n });
      else {
        const content = JSON.parse(stringField(send, 4)); text = typeof content.text === 'string' ? content.text : '';
        summary.messageLength = text.length; summary.messageAlias = alias(text);
        summary.conversationAlias = alias(stringField(send, 1));
      }
    }
    return { summary, text };
  } catch (_) { return { summary: { protocol: 'unknown_or_changed', decoded: false }, text: '' }; }
}
function summarizeJson(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { shape: typeof value };
  out.topLevelFields = Object.keys(value).slice(0, 40);
  if (Object.hasOwn(value, 'comments')) out.commentsShape = value.comments === null ? 'null' : Array.isArray(value.comments) ? 'array' : typeof value.comments;
  const allowed = ['status_code', 'status', 'status_msg', 'status_message', 'error_code', 'error_msg', 'check_code', 'check_message', 'follow_status', 'has_more', 'total', 'cursor', 'offset'];
  for (const [prefix, row] of [['', value], ['data.', value.data], ['extra.', value.extra]]) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const key of allowed) if (typeof row[key] === 'number' || typeof row[key] === 'boolean' || typeof row[key] === 'string') out[prefix + key] = typeof row[key] === 'string' ? clean(row[key]) : row[key];
    for (const key of ['data', 'aweme_list', 'comments', 'user_list', 'messages']) if (Array.isArray(row[key])) out[prefix + key + 'Count'] = row[key].length;
  }
  return out;
}
function family(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return null;
    if (url.hostname === 'imapi.douyin.com' && /^\/v1\//.test(url.pathname)) return { family: 'im', path: url.pathname };
    if (!['www.douyin.com', 'douyin.com'].includes(url.hostname)) return null;
    const p = url.pathname;
    if (/^\/aweme\/v1\/web\/(?:general\/)?search\/(?:single|item)\/$/.test(p)) return { family: 'search', path: p };
    if (p === '/aweme/v1/web/comment/list/') return { family: 'comments', path: p };
    if (p === '/aweme/v1/web/aweme/detail/') return { family: 'work_detail', path: p };
    if (p === '/aweme/v1/web/commit/follow/user/') return { family: 'follow', path: p };
    if (/^\/aweme\/v1\/web\/user\/(?:profile\/other|profile\/self|info)\/$/.test(p)) return { family: 'profile', path: p };
    return null;
  } catch (_) { return null; }
}
function domProbe(config) {
  if (window[config.key]) return;
  let alive = true, scheduled = false; const seen = new Set();
  const emit = event => { if (alive && typeof window[config.binding] === 'function') window[config.binding](event).catch(() => {}); };
  const click = event => {
    if (!event.isTrusted) return;
    const e = event.target?.closest?.('button,a,[role="button"]'); if (!e) return;
    const text = (e.textContent || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim();
    const operation = /^(?:\+\s*)?关注$/.test(text) ? 'follow' : /^(私信|发私信|发消息)$/.test(text) ? 'open_dm' : /^(发送|发送消息)$/.test(text) ? 'send' : /^(搜索|视频|图文|综合|评论)$/.test(text) ? text : null;
    if (operation) emit({ type: 'native_click', operation, trusted: true, tag: e.tagName, disabled: !!e.disabled });
  };
  const input = event => {
    if (!event.isTrusted) return;
    const e = event.target; if (!e || e.type === 'password') return;
    const marker = [e.getAttribute?.('placeholder'), e.getAttribute?.('aria-label'), e.getAttribute?.('data-e2e')].join(' ');
    const category = /搜索/.test(marker) ? 'search' : /msg-input|消息|私信/.test(marker) || e.isContentEditable && e.closest('[data-e2e="im-dialog"],[data-e2e="message-panel"],[data-e2e="im-chat"]') ? 'message' : /评论/.test(marker) ? 'comment' : null;
    if (category) emit({ type: 'native_input', category, trusted: true, length: String(e.value ?? e.textContent ?? '').length });
  };
  const notices = () => {
    scheduled = false; if (!alive) return;
    const selector = '[role="alert"],[aria-live="assertive"],[class*="toast" i],[data-e2e="global-toast"],[data-stack-layer="chat"] p,[data-stack-layer="chat"] span,[class*="error" i],[data-e2e*="error"],[data-e2e*="retry"]';
    const serviceText = /^(?:服务异常(?:[，,\s]*刷新拉取数据)?|刷新拉取数据|加载失败(?:[，,\s]*请重试)?|网络异常(?:[，,\s]*请重试)?)$/;
    const candidates = new Set(document.querySelectorAll(selector));
    for (const e of document.querySelectorAll('p,span,button')) if (serviceText.test((e.textContent || '').trim())) candidates.add(e);
    for (const e of [...candidates].slice(0, 400)) {
      if (!e.getClientRects().length || e.closest('[data-e2e="msg-item-content"],[data-e2e="comment-item"],[data-e2e="comment-level-1"],[class*="commentItem"],[class*="CommentItem"],[contenteditable],textarea,input')) continue;
      const platformTip = e.classList.contains('MessageBoxTipsMessagetext')
        && e.closest('.MessageBoxTipsMessagecontent')?.closest('.MessageBoxTipsMessagelayout');
      if (e.closest('.messageMessageBoxmessageBox') && !platformTip) continue;
      const text = (e.textContent || '').trim();
      if (!text || text.length > 300 || !/频繁|上限|互关|无法发送|重复发送|稍后再试|安全验证|完成验证|服务异常|刷新拉取数据|加载失败|网络异常/.test(text) || seen.has(text)) continue;
      seen.add(text); if (seen.size > 100) seen.delete(seen.values().next().value);
      emit({ type: 'system_notice', text, source: e.matches(selector) ? 'visible_platform_notice' : 'visible_service_error_candidate' });
    }
  };
  const observer = new MutationObserver(() => { if (!scheduled && alive) { scheduled = true; setTimeout(notices, 200); } });
  const stop = () => { alive = false; document.removeEventListener('click', click, true); document.removeEventListener('input', input, true); observer.disconnect(); delete window[config.key]; };
  window[config.key] = stop;
  window[config.binding]({ type: 'probe_ready' }).then(active => {
    if (!active) return stop(); document.addEventListener('click', click, true); document.addEventListener('input', input, true);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); notices();
  }).catch(stop);
}
async function start(options) {
  if (globalThis[KEY]?.active()) throw new Error('A passive capture is already running');
  const appDir = path.resolve(options.appDir), outputDir = path.resolve(options.outputDir), accountId = String(options.accountId);
  const r = process.mainModule.require.bind(process.mainModule), engine = r('./engine.js'), store = r('./store.js'), playwright = r('playwright-core');
  const protocol = r('./lib/dm-protocol.js'), accounts = store.getAccounts();
  if (!accounts.some(account => String(account.id) === accountId && account.browserMode !== 'embedded')) throw new Error('Selected external account not found');
  const contexts = [...playwright.chromium._contexts];
  // Caller has also verified the browser process's exact profile directory.
  if (contexts.length !== 1 || engine.taskState.accountId && String(engine.taskState.accountId) !== accountId) throw new Error('Cannot uniquely bind the existing account browser');
  const context = contexts[0], durationMs = Math.min(60 * 60000, Math.max(60000, Number(options.durationMs) || 60 * 60000));
  fs.mkdirSync(outputDir, { recursive: true });
  const journal = path.join(outputDir, 'events.jsonl'), statusPath = path.join(outputDir, 'status.json'), stopPath = path.join(outputDir, 'stop-request');
  if (fs.existsSync(journal)) throw new Error('Capture destination already used');
  const startedAt = new Date().toISOString(), salt = crypto.randomBytes(32), alias = value => value ? crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 16) : null;
  const binding = '__hmCapture_' + crypto.randomBytes(8).toString('hex'), key = binding + '_cleanup', config = { binding, key };
  let active = true, eventCount = 0, byteCount = 0, requestCount = 0, errorCount = 0, queue = [], snapshot = '', stateFingerprint = '', lastEventAt = startedAt;
  const counters = {}, pages = new Map(), requests = new WeakMap();
  const record = (type, data = {}) => {
    if (!active) return;
    try {
      if (type !== 'capture_stopped' && (eventCount >= 12000 || byteCount > 20 * 1024 * 1024)) { stop('capture_limit'); return; }
      const text = JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), eventId: ++eventCount, type, accountId, ...data }) + '\n';
      lastEventAt = new Date().toISOString(); byteCount += Buffer.byteLength(text); queue.push(text); counters[type] = (counters[type] || 0) + 1;
    } catch (_) { errorCount++; }
  };
  const flush = () => { if (!queue.length) return; try { fs.appendFileSync(journal, queue.join(''), 'utf8'); queue = []; } catch (_) { errorCount++; queue = []; } };
  const writeStatus = () => { try { fs.writeFileSync(statusPath, JSON.stringify({ active, startedAt, expiresAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), accountId, events: eventCount, bytes: byteCount, counters, errorCount, lastEventAt, journal }, null, 2)); } catch (_) { errorCount++; } };
  const originalLog = store.log, originalSetLeads = store.setLeads;
  const scrub = text => clean(text).split(engine.taskState.currentLead?.nickname || '\u0000').join('[当前用户]');
  function wrappedLog(id, line) {
    const result = originalLog.call(store, id, line);
    if (!active || String(id) !== accountId && String(id) !== 'system') return result;
    if (String(id) === 'system' && engine.taskState.accountId && String(engine.taskState.accountId) !== accountId) return result;
    if (/AI_AUDIT/.test(String(line))) {
      try {
        const row = JSON.parse(String(line).slice(String(line).indexOf('AI_AUDIT') + 8).trim()), out = {};
        for (const field of ['event', 'runId', 'batchNo', 'batchCount', 'leadId', 'outcome', 'mode', 'count', 'yes', 'no', 'failed', 'skipped', 'retryNo', 'delayMs', 'selectedCount', 'pendingCount', 'force', 'filter', 'executionMaxCount', 'requestTimeoutSec', 'splitKind', 'chunkSize', 'chunkCount', 'leftCount', 'rightCount', 'completionRequestCount', 'modelRequestCount', 'providerRetryCount', 'targetRatio', 'recoveryTier', 'strategy', 'fromStrategy', 'firstBatchCount']) if (['string', 'number', 'boolean'].includes(typeof row[field])) out[field] = typeof row[field] === 'string' ? clean(row[field]) : row[field];
        if (['provider_retry', 'request_failed', 'paused', 'retry_split', 'budget_recovery', 'budget_strategy_skipped'].includes(row.event) && typeof row.reason === 'string') out.failureReason = clean(row.reason);
        record('ai_event', out);
      } catch (_) { record('ai_event', { parsed: false }); }
    } else if (!/浏览器已启动|代理:|user-data:/.test(String(line))) record('application_log', { message: scrub(line), leadId: engine.taskState.currentLead?.id || null, stage: engine.taskState.stage });
    return result;
  }
  store.log = wrappedLog;
  function wrappedSetLeads(rows) {
    const result = originalSetLeads.call(store, rows);
    try {
      const t = engine.taskState, id = t.currentLead?.id;
      if (!active || String(t.accountId) !== accountId || !id || !Array.isArray(rows)) return result;
      const row = rows.find(item => String(item.id) === String(id)); if (!row) return result;
      const facts = { leadId: String(id), stage: t.stage };
      for (const field of ['status', 'followState', 'followedAt', 'followAttemptAt', 'dmState', 'dmSentAt', 'dmAttemptAt', 'followFailedReason', 'dmFailedReason']) {
        if (typeof row[field] === 'string') facts[field] = scrub(row[field]);
      }
      for (const action of ['follow', 'dm']) {
        const outcome = row[action + 'Outcome'];
        if (outcome && typeof outcome === 'object') {
          const summary = {};
          for (const field of ['state', 'reason', 'failureScope', 'failureCode']) if (typeof outcome[field] === 'string') summary[field] = scrub(outcome[field]);
          facts[action + 'Outcome'] = summary;
        }
      }
      record('lead_result_saved', facts);
    } catch (_) { errorCount++; }
    return result;
  }
  store.setLeads = wrappedSetLeads;
  const attach = async page => {
    if (!active || pages.has(page)) return;
    const pageId = pages.size + 1;
    const onRequest = request => {
      const info = family(request.url()); if (!active || !info) return;
      try {
        if (request.frame().page() !== page) return;
        const pair = { id: ++requestCount, at: Date.now(), ...info, method: request.method() };
        const type = String(request.headers()['content-type'] || '').split(';')[0];
        if (info.family === 'im' && /protobuf|octet-stream/.test(type)) {
          const bytes = request.postDataBuffer();
          if (bytes && bytes.length <= 65536) {
            const parsed = summarizeIm(bytes, false, alias); pair.im = parsed.summary;
            const id = engine.taskState.currentLead?.id;
            const lead = id && store.getLeads().find(row => String(row.id) === String(id));
            if (lead?.UID && parsed.text) pair.protocolRecord = protocol.parseSendRequest(bytes, { targetNumericUid: String(lead.UID), targetSecUid: String(lead.uid), message: parsed.text });
          }
        }
        requests.set(request, pair);
        const workId = new URL(request.url()).searchParams.get('aweme_id');
        if (['comments', 'work_detail'].includes(pair.family) && /^\d{1,24}$/.test(workId || '')) pair.workAlias = alias(workId);
        if (pair.family === 'comments') {
          const params = new URL(request.url()).searchParams;
          pair.pagination = { locatedCommentsParameter: params.has('insert_ids'), imageFormat: ['webp', 'jpeg', 'jpg', 'png', 'avif'].includes(params.get('pc_img_format')) ? params.get('pc_img_format') : params.has('pc_img_format') ? 'other' : 'absent' };
          for (const key of ['cursor', 'count', 'sort_type', 'comment_type', 'item_type']) {
            const value = params.get(key); if (/^\d{1,12}$/.test(value || '') && Number.isSafeInteger(Number(value))) pair.pagination[key] = Number(value);
          }
        }
        record('request', { pageId, requestId: pair.id, family: pair.family, path: pair.path, workAlias: pair.workAlias, method: pair.method, pagination: pair.pagination, im: pair.im, stage: engine.taskState.stage, leadId: engine.taskState.currentLead?.id || null });
      } catch (_) { errorCount++; }
    };
    const onResponse = async response => {
      const request = response.request(), pair = requests.get(request); if (!active || !pair) return;
      try {
        const headers = response.headers(), contentType = String(headers['content-type'] || '').split(';')[0].slice(0, 100);
        const facts = { pageId, requestId: pair.id, family: pair.family, path: pair.path, workAlias: pair.workAlias, httpStatus: response.status(), contentType, elapsedMs: Date.now() - pair.at };
        if (Number(headers['content-length']) > 2 * 1024 * 1024) { record('response', { ...facts, omitted: 'size_limit' }); return; }
        const bytes = await response.body(); if (!active) return;
        facts.bytes = bytes.length;
        if (bytes.length > 2 * 1024 * 1024) facts.omitted = 'size_limit';
        else if (pair.family === 'im' && /protobuf|octet-stream/.test(contentType)) {
          facts.im = summarizeIm(bytes, true, alias).summary;
          facts.requestSequenceMatched = !!pair.im?.sequenceAlias && pair.im.sequenceAlias === facts.im.sequenceAlias;
          if (pair.protocolRecord) { const outcome = protocol.parseSendResponse(bytes, pair.protocolRecord); facts.correlatedOutcome = outcome ? { state: outcome.state, reason: clean(outcome.reason), failureScope: outcome.failureScope, failureCode: outcome.failureCode } : { state: 'unconfirmed' }; }
        } else if (/json/.test(contentType)) { try { facts.business = summarizeJson(JSON.parse(bytes.toString('utf8'))); } catch (_) { facts.decodeError = 'json_invalid'; } }
        record('response', facts);
      } catch (_) { if (active) record('response_read_failed', { requestId: pair.id, family: pair.family, path: pair.path }); }
    };
    const onFailed = request => { const pair = requests.get(request); if (pair) { const failure = request.failure()?.errorText || ''; record('request_failed', { requestId: pair.id, family: pair.family, path: pair.path, failureCode: (failure.match(/net::ERR_[A-Z_]+/) || [null])[0] }); } };
    const onNavigation = frame => { if (frame !== page.mainFrame()) return; try { const u = new URL(frame.url()), work = /^\/(video|note)\/(\d{1,24})\/?$/.exec(u.pathname); record('navigation', { pageId, origin: u.origin, kind: /^\/search\//.test(u.pathname) ? 'search' : /^\/user\//.test(u.pathname) ? 'profile' : work ? 'work' : u.pathname === '/' ? 'home' : 'other', workType: work ? work[1] : null, workAlias: work ? alias(work[2]) : null, targetAlias: alias(u.pathname) }); } catch (_) {} };
    const onClose = () => record('page_closed', { pageId });
    pages.set(page, { onRequest, onResponse, onFailed, onNavigation, onClose });
    page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailed); page.on('framenavigated', onNavigation); page.on('close', onClose);
    await page.evaluate(domProbe, config).catch(() => record('dom_probe_unavailable', { pageId }));
    record('page_attached', { pageId });
  };
  let flushTimer, stateTimer, limitTimer;
  function stop(reason = 'operator_stop') {
    if (!active) return;
    record('capture_stopped', { reason }); active = false;
    clearInterval(flushTimer); clearInterval(stateTimer); clearTimeout(limitTimer);
    if (store.log === wrappedLog) store.log = originalLog;
    if (store.setLeads === wrappedSetLeads) store.setLeads = originalSetLeads;
    context.off('page', attach);
    for (const [page, handlers] of pages) {
      page.off('request', handlers.onRequest); page.off('response', handlers.onResponse); page.off('requestfailed', handlers.onFailed); page.off('framenavigated', handlers.onNavigation); page.off('close', handlers.onClose);
      if (!page.isClosed()) void page.evaluate(k => { if (typeof window[k] === 'function') window[k](); }, key).catch(() => {});
    }
    flush(); writeStatus();
  }
  const sampleState = () => {
    if (fs.existsSync(stopPath)) { stop(); return; }
    const t = engine.taskState;
    if (t.accountId && String(t.accountId) !== accountId) return;
    const item = { running: !!t.running, kind: t.kind, stage: t.stage, done: t.done, total: t.total, leadId: t.currentLead?.id || null, currentUserIndex: t.currentUserIndex, workAlias: alias(t.currentWork?.id), currentWorkIndex: t.currentWorkIndex, totalWorks: t.totalWorks, waitingReason: t.waitingReason, message: scrub(t.status) };
    const next = JSON.stringify(item);
    if (next !== stateFingerprint) { stateFingerprint = next; record('task_state', item); }
    const checkpoint = t.checkpoint;
    if (checkpoint && String(checkpoint.accountId) === accountId) {
      const cp = { taskId: checkpoint.id, kind: checkpoint.kind, state: checkpoint.state, currentLeadId: checkpoint.kind === 'collect' ? null : checkpoint.currentLeadId, processedCount: checkpoint.kind === 'collect' ? checkpoint.processedVideoIds?.length : checkpoint.processedLeadIds?.length, currentWorkAlias: checkpoint.kind === 'collect' ? alias(checkpoint.currentVideoId) : null, stopReason: clean(checkpoint.stopReason) };
      const s = JSON.stringify(cp); if (s !== snapshot) { snapshot = s; record('checkpoint', cp); }
    }
  };
  try {
    await context.exposeBinding(binding, (_, event) => {
      if (!active) return false;
      if (!event || typeof event !== 'object') return active;
      if (event.type === 'native_click' && event.trusted === true && ['follow', 'open_dm', 'send', '搜索', '视频', '图文', '综合', '评论'].includes(event.operation)) record('native_click', { operation: event.operation, trusted: true, disabled: !!event.disabled });
      if (event.type === 'native_input' && ['search', 'message', 'comment'].includes(event.category) && Number.isInteger(event.length) && event.length >= 0 && event.length <= 100000) record('native_input', { category: event.category, length: event.length });
      if (event.type === 'system_notice' && typeof event.text === 'string' && event.text.length <= 300) record('system_notice', { text: clean(event.text), source: event.source === 'visible_service_error_candidate' ? event.source : 'visible_platform_notice' });
      return active;
    });
    await context.addInitScript({ content: '(' + domProbe.toString() + ')(' + JSON.stringify(config) + ')' });
    context.on('page', attach);
    await Promise.all(context.pages().map(attach));
    globalThis[KEY] = { active: () => active, stop };
    record('capture_started', { version: String(options.version || r('./resources/app/package.json').version), mode: 'passive', durationMs, authenticationFieldsRecorded: false, messageTextRecorded: false });
    sampleState(); flush(); writeStatus();
    flushTimer = setInterval(() => { flush(); writeStatus(); }, 1000);
    stateTimer = setInterval(() => { try { sampleState(); } catch (_) { errorCount++; } }, 500);
    limitTimer = setTimeout(() => stop('time_limit'), durationMs);
    for (const timer of [flushTimer, stateTimer, limitTimer]) timer.unref?.();
    return { active: true, accountId, outputDir, pages: pages.size, expiresAt: new Date(Date.parse(startedAt) + durationMs).toISOString() };
  } catch (error) { stop('initialization_failed'); throw error; }
}
module.exports = { start, clean, family, summarizeIm, summarizeJson };
