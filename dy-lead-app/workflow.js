const crypto = require('crypto');

const DM_STATES = ['confirmed_success', 'confirmed_failure', 'pending_verification'];
function businessId(settings = {}) { return String(settings.outreach && settings.outreach.businessId || settings.businessId || 'default'); }
function contactKey(lead, settings = {}) { return `${lead.businessId || businessId(settings)}|${String(lead.uid || '')}`; }
// 预检查/分发/执行都会对每条线索查“同一业务 + 同一 uid”的历史。
// 全库 filter 是 O(n²)（17k 线索约 30 秒），因此允许调用方传入一次性索引。
function historyIndex(leads, settings = {}) {
  const map = new Map();
  for (const lead of leads) {
    const key = contactKey(lead, settings);
    const rows = map.get(key);
    if (rows) rows.push(lead); else map.set(key, [lead]);
  }
  return map;
}
function safeHomepage(lead) {
  try {
    const u = new URL(lead.homepage);
    return u.protocol === 'https:' && u.hostname === 'www.douyin.com' && u.pathname === `/user/${encodeURIComponent(String(lead.uid))}` && !u.username && !u.password;
  } catch { return false; }
}
function aiInputHash(lead, videos = {}) { return crypto.createHash('sha256').update(JSON.stringify(require('./ai').leadInput(lead, videos))).digest('hex'); }
function intentEligibility(lead, settings, videos = {}) {
  // 关键词仅用于候选筛查，既不能覆盖 AI 否，也不能直接取得发送许可。
  if (lead.aiNeed === '否') return { ok: false, reason: 'AI 判断不宜联系' };
  if (['待确认', '待人工确认', '不确定'].includes(lead.aiNeed)) return { ok: false, reason: '旧版 AI 结果待确认，请使用当前二值规则重新判断' };
  if (lead.aiNeed === '是') {
    if (!settings) return { ok: false, reason: '缺少当前判断规则，无法核验 AI 结果' };
    if (lead.aiDone !== true) return { ok: false, reason: 'AI 判断未完成，请重新判断' };
    if (settings && lead.aiPromptVersion !== require('./ai').getRuleSet(settings).version) return { ok: false, reason: 'AI 判断规则版本已变化或来自旧版，请重新判断' };
    if (settings && lead.aiInputHash !== aiInputHash(lead, videos)) return { ok: false, reason: '线索内容或视频描述已变化，请重新判断' };
    if (settings && !require('./ai').isStoredResultCurrent(lead, require('./ai').getRuleSet(settings).version, videos)) return { ok: false, reason: 'AI 判断理由或记录不完整，请重新判断' };
    return { ok: true, source: 'ai' };
  }
  if (lead.aiNeed && lead.aiNeed !== '是') return { ok: false, reason: 'AI 判断结果无效，须重新判断' };
  if (lead.aiDone === true) return { ok: false, reason: 'AI 判断记录不完整，请重新判断' };
  if (lead.manualApproved === true) return { ok: true, source: 'manual' };
  return { ok: false, reason: lead.intent || lead.trigger ? '关键词候选尚未 AI 判断或人工确认' : '尚未 AI 判断或人工确认' };
}
function historyOf(lead, all, settings) {
  const key = contactKey(lead, settings);
  if (all instanceof Map) return all.get(key) || [];
  return all.filter(x => contactKey(x, settings) === key);
}
function contactPolicy(settings = {}) {
  const repeat = settings.dm && settings.dm.repeat || {};
  const enabled = repeat.enabled === undefined ? false : repeat.enabled;
  const intervalDays = repeat.intervalDays === undefined ? 7 : repeat.intervalDays;
  if (typeof enabled !== 'boolean' || typeof intervalDays !== 'number' || !Number.isFinite(intervalDays) || intervalDays < 1) throw new Error('重复私信规则无效，间隔至少为1天');
  return { repeat: { enabled, intervalDays }, historyUnknown: 'allow_initial' };
}
function followAccountId(lead) { return String(lead.followAttemptAccountId || lead.accountId || ''); }
function observedTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const text = value.trim(), timestamp = Date.parse(text.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(text) ? '' : '+08:00'));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}
// 分配锁只用于“本轮交给哪个账号”。必须有时效，否则中断后残留的锁会把用户永久排除。
const ALLOCATION_TTL_MS = 6 * 3600000;
function allocationExpired(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return true;
  const expiresAt = Number(entry.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt <= Number(now);
  const plannedAt = observedTime(entry.plannedAt);
  return !plannedAt || plannedAt + ALLOCATION_TTL_MS <= Number(now);
}
function dmHistoryEligibility(lead, all, settings, now = Date.now(), accountId = lead.accountId, options = {}) {
  const history = historyOf(lead, all, settings);
  if (history.some(row => row.dmState === 'pending_verification' || row.dmOutcome === 'pending_verification')) return { ok: false, reason: '上次发送待核验，禁止自动重发' };
  if (history.some(row => row.noDm && row.noDmConfirmed)) return { ok: false, reason: '已确认平台不允许私信该用户' };
  const observations = history.flatMap(row => [row.dmHistoryObserved, row.dmHistorySentObserved]).filter(row => row && typeof row === 'object');
  const current = history.map(row => row.dmHistoryObserved).filter(row => row && String(row.accountId) === String(accountId))
    .sort((a, b) => observedTime(b.checkedAtMs || b.checkedAt) - observedTime(a.checkedAtMs || a.checkedAt))[0];
  const checkedAt = observedTime(current && (current.checkedAtMs || current.checkedAt));
  const currentKnown = current && checkedAt > 0 && checkedAt <= now
    && (current.state === 'already_sent' || current.state === 'no_outbound' && current.complete === true);
  // Unknown website history follows allow_initial. It cannot clear local
  // pending/sent history or any positive website evidence retained below.
  let alreadySent = false, unknownSentTime = false, lastSentAt = 0;
  for (const row of history) {
    if (Number(row.dmCount) > 0 || row.dmState === 'confirmed_success' || row.dmOutcome === 'confirmed_success' || ['dm_sent', 'followed_dm'].includes(row.status)) {
      alreadySent = true;
      const at = observedTime(row.dmLastAt || row.dmSentAt);
      if (!at || at > now) unknownSentTime = true;
      else lastSentAt = Math.max(lastSentAt, at);
    }
  }
  for (const row of observations) if (row.state === 'already_sent') {
    alreadySent = true;
    const at = typeof row.lastSentAt === 'number' && Number.isFinite(row.lastSentAt) && row.lastSentAt > 0 && row.lastSentAt <= now ? row.lastSentAt : 0;
    if (!at) unknownSentTime = true;
    else lastSentAt = Math.max(lastSentAt, at);
  }
  if (!alreadySent) return { ok: true, historyState: currentKnown ? 'no_outbound' : 'unknown' };
  const policy = contactPolicy(settings);
  if (!policy.repeat.enabled) return { ok: false, reason: '当前业务已有私信历史（含网页及跨账号记录），重复联系未开启', historyState: 'already_sent' };
  if (unknownSentTime || !lastSentAt) return { ok: false, reason: '已有私信历史但最近发送时间未确认，禁止自动重复', historyState: 'already_sent' };
  if (now - lastSentAt < policy.repeat.intervalDays * 86400000) return { ok: false, reason: '尚未达到本次预检查的再次联系间隔', historyState: 'already_sent', lastSentAt };
  return { ok: true, historyState: 'already_sent', lastSentAt };
}
function latestTime(rows, field) {
  return Math.max(0, ...rows.map(x => {
    const n = Date.parse(String(x[field] || '').replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(String(x[field] || '')) ? '' : '+08:00'));
    return Number.isFinite(n) ? n : 0;
  }));
}
function eligibility(lead, kind, all, settings, now = Date.now(), videos = {}, options = {}) {
  if (!lead || !lead.uid || !safeHomepage(lead)) return { ok: false, reason: '主页链接无效或与用户不一致' };
  if (String(lead.businessId || 'default') !== businessId(settings)) return { ok: false, reason: '线索不属于当前业务范围' };
  const history = historyOf(lead, all, settings);
  if (history.some(x => x.doNotContact || x.replied || x.status === 'replied')) return { ok: false, reason: '用户已拒绝联系或已回复，转人工跟进' };
  if (lead.isAuthor && (kind === 'follow' || settings.dm.skipAuthor !== false)) return { ok: false, reason: '视频作者不参与自动触达' };
  const intent = intentEligibility(lead, settings, videos);
  if (!intent.ok) return intent;
  if (kind === 'follow') {
    if (!settings.follow.enabled) return { ok: false, reason: '关注功能未启用' };
    const accountId = String(options.accountId || lead.accountId || '');
    const ownHistory = history.filter(row => followAccountId(row) === accountId);
    if (ownHistory.some(x => x.followState === 'pending_verification' || x.followOutcome === 'pending_verification')) return { ok: false, reason: '当前账号上次关注待核验，禁止自动再次关注' };
    // Historical following can change on the website. The action layer checks
    // the current profile response before deciding whether to click follow.
    return intent;
  }
  if (!settings.dm.enabled) return { ok: false, reason: '私信功能未启用' };
  const dmHistory = dmHistoryEligibility(lead, all, settings, now, options.accountId || lead.accountId, { requireObserved: options.requireObservedDmHistory === true });
  return dmHistory.ok ? { ...intent, historyState: dmHistory.historyState } : dmHistory;
}
function uniqueContacts(leads, settings) {
  const seen = new Set();
  return leads.filter(l => { const key = contactKey(l, settings); if (seen.has(key)) return false; seen.add(key); return true; });
}
function getQuotas(settings, usage = {}) {
  const count = value => { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0; };
  const followLimit = count(settings.follow && settings.follow.dailyLimit), dmLimit = count(settings.dm && settings.dm.dailyLimit);
  const profileLimit = count((settings.outreach && settings.outreach.dailyProfileLimit) ?? (followLimit + dmLimit || 100));
  const quota = (limit, used) => ({ limit, used, remaining: Math.max(0, limit - used) });
  return {
    follow: quota(followLimit, Math.max(count(usage.follow), count(usage.followAttempts))),
    dm: quota(dmLimit, Math.max(count(usage.dm), count(usage.dmAttempts))),
    profile: quota(profileLimit, count(usage.profileVisits))
  };
}
function settingsFingerprint(settings, actions) {
  const fields = {
    businessId: businessId(settings), prompt: settings.ai && settings.ai.prompt,
    ruleVersion: require('./ai').getRuleSet(settings).version,
    dmTemplate: actions.dm ? settings.dm.template : '', contactPolicy: contactPolicy(settings), actions
  };
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
function validateDmOutcome(result) {
  if (!result || !DM_STATES.includes(result.state)) return { state: 'pending_verification', reason: '没有可验证的发送回执，需人工核验' };
  if (result.state !== 'pending_verification' && !result.evidence) return { state: 'pending_verification', reason: '回执缺少对应本次发送的证据，需人工核验' };
  return { state: result.state, reason: String(result.reason || '').slice(0, 200), evidence: String(result.evidence || '').slice(0, 300),
    ...(result.state === 'confirmed_failure' && ['recipient', 'account'].includes(result.failureScope) ? {
      failureScope: result.failureScope,
      ...(['DM_ACCOUNT_FREQUENT', 'DM_ACCOUNT_DAILY_LIMIT'].includes(result.failureCode) ? { failureCode: result.failureCode } : {})
    } : {}) };
}

module.exports = { DM_STATES, businessId, contactKey, historyIndex, safeHomepage, intentEligibility, eligibility, historyOf, uniqueContacts, latestTime, settingsFingerprint, validateDmOutcome, aiInputHash, getQuotas, contactPolicy, followAccountId, observedTime, dmHistoryEligibility, ALLOCATION_TTL_MS, allocationExpired };
