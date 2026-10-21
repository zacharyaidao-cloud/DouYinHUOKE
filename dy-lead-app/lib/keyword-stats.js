'use strict';
/**
 * 关键词统计：每次搜索记录“这个词返回了什么”，再结合采集结果算出这个词带来了多少评论与需求。
 *
 * 存储（keyword-stats.json）：{ [关键词]: { keyword, searchCount, lastSearchAt, lastRun, awemeIds } }
 *   lastRun：上次搜索的范围与结果计数（返回作品数、最近一周发布数、通过筛选数、新增数、翻页数）
 *   awemeIds：这个词累计搜到过的作品 ID（同一作品可能被多个词搜到，各词都算）
 * 汇总时按作品 ID 关联：作品表（已采集）、线索表（评论 / AI 需求 / 关键词命中 / 已私信）。
 */
const { workIdFromLink } = require('./video-links');

const WEEK_SEC = 7 * 86400;
const MAX_IDS = 3000;

/** 记录一次关键词搜索。works：本次读到的作品（已按范围过滤），kept：通过发布时间/评论数筛选的，added：新加入结果列表的数量 */
function recordKeywordRun(raw, keyword, { works = [], kept = [], added = 0, pages = 0, workType = '', publishedWithinDays = 0, minComments = 0, stopReason = '', at = '', nowSec = Date.now() / 1000 } = {}) {
  const stats = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const key = String(keyword || '').trim();
  if (!key) return stats;
  const entry = stats[key] || { keyword: key, searchCount: 0, awemeIds: [] };
  const ids = new Set(Array.isArray(entry.awemeIds) ? entry.awemeIds.map(String) : []);
  for (const work of works) if (work && work.awemeId) ids.add(String(work.awemeId));
  const withinWeek = works.filter(work => Number(work.createTime) > 0 && nowSec - Number(work.createTime) <= WEEK_SEC).length;
  stats[key] = {
    ...entry,
    keyword: key,
    searchCount: (Number(entry.searchCount) || 0) + 1,
    lastSearchAt: at,
    lastRun: { at, workType, pages: Number(pages) || 0, publishedWithinDays, minComments,
      total: works.length, withinWeek, kept: kept.length, added: Number(added) || 0, stopReason: String(stopReason || '') },
    awemeIds: [...ids].slice(-MAX_IDS)
  };
  return stats;
}

/** 汇总每个关键词的数据，按上次搜索时间倒序。searchResults：搜索结果列表（每个作品带首次搜到它的关键词），用来补上统计功能上线前的老关键词。 */
function summarizeKeywords(raw, leads = [], videos = {}, searchResults = []) {
  const stats = { ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  for (const work of Array.isArray(searchResults) ? searchResults : []) {
    const key = String(work && work.keyword || '').trim();
    if (!key || !work.awemeId) continue;
    const entry = stats[key] = stats[key] ? { ...stats[key] } : { keyword: key, searchCount: 0, lastSearchAt: '', awemeIds: [], fromHistory: true };
    const ids = new Set((entry.awemeIds || []).map(String)); ids.add(String(work.awemeId)); entry.awemeIds = [...ids];
    if (entry.fromHistory && String(work.foundAt || '') > String(entry.lastSearchAt || '')) entry.lastSearchAt = String(work.foundAt);
  }
  const byWork = new Map();
  for (const lead of leads) {
    const id = workIdFromLink(lead && lead.videoLink);
    if (!id) continue;
    if (!byWork.has(id)) byWork.set(id, []);
    byWork.get(id).push(lead);
  }
  const rows = Object.values(stats).map(entry => {
    const ids = Array.isArray(entry.awemeIds) ? entry.awemeIds.map(String) : [];
    let collected = 0, comments = 0, aiDemand = 0, keywordDemand = 0, contacted = 0;
    const demandUsers = new Set(), contactedUsers = new Set();
    for (const id of ids) {
      const video = videos[id];
      if (video && (video.lastCollectAt || video.collectionState)) collected++;
      for (const lead of byWork.get(id) || []) {
        if (lead.isAuthor) continue;
        comments++;
        if (lead.aiNeed === '是') { aiDemand++; demandUsers.add(lead.uid || lead.UID || lead.id); }
        if (lead.intent === true && !lead.excluded) keywordDemand++;
        if (lead.dmState === 'confirmed_success' && !contactedUsers.has(lead.uid)) { contacted++; contactedUsers.add(lead.uid); }
      }
    }
    const run = entry.lastRun || {};
    return {
      keyword: entry.keyword, searchCount: Number(entry.searchCount) || 0, lastSearchAt: entry.lastSearchAt || '', fromHistory: !!entry.fromHistory,
      lastTotal: Number(run.total) || 0, lastWithinWeek: Number(run.withinWeek) || 0, lastKept: Number(run.kept) || 0,
      lastAdded: Number(run.added) || 0, lastPages: Number(run.pages) || 0, lastWorkType: run.workType || '',
      lastPublishedWithinDays: Number(run.publishedWithinDays) || 0, lastMinComments: Number(run.minComments) || 0,
      worksFound: ids.length, worksCollected: collected, comments, aiDemand, aiDemandUsers: demandUsers.size, keywordDemand, contacted
    };
  });
  return rows.sort((a, b) => String(b.lastSearchAt).localeCompare(String(a.lastSearchAt)));
}

module.exports = { recordKeywordRun, summarizeKeywords };
