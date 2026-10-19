'use strict';
const { projectLead } = require('./lib/lead-fields');
const { workIdFromLink } = require('./lib/video-links');
const AI = require('./ai');
const { parseCommentTimestamp } = require('./lib/comment-evidence');
const AI_FILTERS = ['ai_todo', 'ai_yes', 'ai_no', 'ai_stale', 'ai_excluded'];
const FILTERS = ['all', ...AI_FILTERS, 'trigger', 'ai', 'unfollowed', 'undm', 'pending'];
const CONTACT_FILTERS = ['all', 'new', 'followed', 'sent', 'pending', 'failed', 'blocked', 'replied'];
function aiExclusionReason(lead, videos = {}) {
  const author = (videos[workIdFromLink(lead.videoLink)] || {}).authorSecUid;
  if (lead.isAuthor || author && String(lead.uid) === String(author)) return '作品作者不参与 AI 判断';
  if (!String(lead.demand || '').trim()) return '评论为空，无法进行 AI 判断';
  return '';
}
function isCommentUser(lead, videos = {}) { return !aiExclusionReason(lead, videos); }
// 列表、AI 范围和预检查共用同一套筛选，避免界面与任务范围不一致。
function normalizeFilters(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('筛选条件必须为对象');
  if (raw.f != null && raw.f !== '' && !FILTERS.includes(raw.f)) throw new Error('筛选模式无效');
  const f = FILTERS.includes(raw.f) ? raw.f :
    raw.trigger === '1' ? 'trigger' : raw.ai === '1' ? 'ai' : raw.unfollowed === '1' ? 'unfollowed' : raw.undm === '1' ? 'undm' : 'all';
  const commentDays = raw.commentDays == null || raw.commentDays === '' ? 0 : Number(raw.commentDays);
  if (![0, 1, 3, 7].includes(commentDays) || raw.commentDays != null && !['number', 'string'].includes(typeof raw.commentDays)) throw new Error('评论时间范围只允许全部、1天、3天或7天');
  const contact = raw.contact == null || raw.contact === '' ? 'all' : raw.contact;
  if (!CONTACT_FILTERS.includes(contact)) throw new Error('触达状态筛选无效');
  return { f, commentDays, contact, s: String(raw.s || raw.status || ''), q: String(raw.q || '').trim().toLowerCase(),
    ...(raw.collectionRunId ? { collectionRunId: String(raw.collectionRunId) } : {}),
    author: raw.author, intent: raw.intent, minAiScore: raw.minAiScore };
}
function aiCategory(lead, videos = {}, options = {}) {
  if (aiExclusionReason(lead, videos)) return 'ai_excluded';
  const version = options.ruleVersion || (options.settings ? AI.getRuleSet(options.settings).version : '');
  if (AI.isStoredResultCurrent(lead, version, videos)) return lead.aiNeed === '是' ? 'ai_yes' : 'ai_no';
  const historical = lead.aiDone === true || ['aiNeed', 'aiReason', 'aiJudgedAt', 'aiPromptVersion', 'aiInputHash'].some(key => String(lead[key] || '').trim())
    || lead.aiScore != null && lead.aiScore !== '';
  return historical ? 'ai_stale' : 'ai_todo';
}
function ownsFollowHistory(lead) { return String(lead.followAttemptAccountId || lead.accountId || '') === String(lead.accountId || ''); }
function actionState(lead, kind) {
  if (kind === 'follow' && !ownsFollowHistory(lead)) return '';
  return lead[kind + 'State'] || lead[kind + 'Outcome']
    || (lead.status === kind + '_pending' ? 'pending_verification' : lead.status === kind + '_failed' ? 'confirmed_failure' : '');
}
function hasSentHistory(lead) {
  return Number(lead.dmCount) > 0 || lead.dmState === 'confirmed_success' || lead.dmOutcome === 'confirmed_success' || ['dm_sent', 'followed_dm'].includes(lead.status)
    || [lead.dmHistoryObserved, lead.dmHistorySentObserved].some(observed => observed && observed.state === 'already_sent');
}
function hasFollowHistory(lead) {
  return ownsFollowHistory(lead) && (lead.followedAt || lead.followState === 'confirmed_success' || lead.followOutcome === 'confirmed_success' || ['followed', 'followed_dm'].includes(lead.status))
    || lead.followObserved && lead.followObserved.state === 'following' && !!lead.accountId && String(lead.followObserved.accountId) === String(lead.accountId);
}
function contactCategory(lead) {
  if (lead.doNotContact || lead.status === 'do_not_contact' || lead.noDm && lead.noDmConfirmed) return 'blocked';
  if (lead.replied || lead.status === 'replied') return 'replied';
  const outcomes = [actionState(lead, 'dm'), actionState(lead, 'follow')];
  if (outcomes.includes('pending_verification')) return 'pending';
  if (outcomes.includes('confirmed_failure')) return 'failed';
  if (hasSentHistory(lead)) return 'sent';
  if (hasFollowHistory(lead)) return 'followed';
  return 'new';
}
function commentTimeMs(value) {
  // Legacy timestamps have no offset; interpret those as China local time.
  // Parse explicitly so server/browser locale and Date.parse quirks cannot
  // silently include malformed or unknown comment times in a recent range.
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', fraction = '', zone = '+08:00'] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const base = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], Number(fraction.padEnd(3, '0')));
  const date = new Date(base);
  if ([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].some((v, i) => v !== parts[i])) return null;
  const offsetHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3)), offsetMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (offsetHour > 23 || offsetMinute > 59) return null;
  return base - (zone[0] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60000;
}
function leadCommentTimeMs(lead) {
  const timestamp = lead.commentTimestamp;
  if (timestamp == null || timestamp === '') return commentTimeMs(lead.time);
  const seconds = parseCommentTimestamp(timestamp);
  return seconds === null ? null : seconds * 1000;
}
function filterLeads(leads, videos = {}, raw = {}, options = {}) {
  const filters = normalizeFilters(raw);
  const now = options.now == null ? Date.now() : Number(options.now);
  if (!Number.isFinite(now)) throw new Error('筛选截止时间无效');
  const classification = { ...options, ruleVersion: options.ruleVersion || (options.settings ? AI.getRuleSet(options.settings).version : '') };
  let result = leads.map(l => projectLead(l, videos)).filter(l => {
    if (filters.collectionRunId && (l.collectionRunId !== filters.collectionRunId || !isCommentUser(l, videos))) return false;
    if (['dm_failed', 'follow_failed', 'dm_pending', 'follow_pending'].includes(filters.s)) {
      const [kind, suffix] = filters.s.split('_');
      if (actionState(l, kind) !== (suffix === 'failed' ? 'confirmed_failure' : 'pending_verification')) return false;
      if (kind === 'dm' && suffix === 'failed' && (hasSentHistory(l) || l.noDm && l.noDmConfirmed)) return false;
    } else if (filters.s && l.status !== filters.s) return false;
    if (filters.q && ![l.nickname, l.demand, l.UID, l.uid, l.account, l.workText].some(v => String(v || '').toLowerCase().includes(filters.q))) return false;
    if (filters.commentDays) {
      const timestamp = leadCommentTimeMs(l);
      if (timestamp === null || timestamp > now || timestamp < now - filters.commentDays * 86400000) return false;
    }
    if (filters.contact !== 'all' && contactCategory(l) !== filters.contact) return false;
    if (AI_FILTERS.includes(filters.f) && aiCategory(l, videos, classification) !== filters.f) return false;
    if (filters.f === 'trigger' && !l.trigger) return false;
    if (filters.f === 'ai' && l.aiNeed !== '是') return false;
    if (filters.f === 'unfollowed' && hasFollowHistory(l)) return false;
    if (filters.f === 'undm' && hasSentHistory(l)) return false;
    if (filters.f === 'pending' && l.dmState !== 'pending_verification' && l.dmOutcome !== 'pending_verification' && !(ownsFollowHistory(l) && (l.followState === 'pending_verification' || l.followOutcome === 'pending_verification'))) return false;
    if (filters.author != null && Boolean(l.isAuthor) !== Boolean(filters.author)) return false;
    if (filters.intent != null && Boolean(l.intent) !== Boolean(filters.intent)) return false;
    if (filters.minAiScore != null && Number(l.aiScore || 0) < Number(filters.minAiScore)) return false;
    return true;
  });
  if (Object.hasOwn(options, 'leadIds')) {
    if (!Array.isArray(options.leadIds)) throw new Error('线索范围必须是列表');
    const ids = new Set(options.leadIds.map(String));
    result = result.filter(l => ids.has(String(l.id)));
  }
  if (options.limit != null) result = result.slice(-Math.max(0, Number(options.limit)));
  return result;
}
function aiFacetCounts(leads, videos = {}, raw = {}, options = {}) {
  const counts = { all: 0, ai_todo: 0, ai_yes: 0, ai_no: 0, ai_stale: 0, ai_excluded: 0 };
  const classification = { ...options, ruleVersion: options.ruleVersion || (options.settings ? AI.getRuleSet(options.settings).version : '') };
  for (const lead of filterLeads(leads, videos, { ...normalizeFilters(raw), f: 'all' }, { ...classification, limit: undefined })) {
    counts.all++; counts[aiCategory(lead, videos, classification)]++;
  }
  return counts;
}
module.exports = { filterLeads, normalizeFilters, isCommentUser, aiExclusionReason, aiCategory, contactCategory, commentTimeMs, aiFacetCounts };
