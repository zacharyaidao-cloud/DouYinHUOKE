'use strict';

/**
 * 搜索页响应解析：只从页面自己发出的带签名搜索接口响应里读取数据，
 * 不构造、不重放任何平台请求。响应原文不落盘，仅提取作品摘要字段。
 */

const SEARCH_PATH = /\/aweme\/v1\/web\/(?:general\/)?search\/(?:single|item)\/$/;

function identifier(value) {
  const text = value == null ? '' : String(value);
  return /^[\w-]{1,128}$/.test(text) ? text : '';
}

function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function asText(value) {
  return value == null ? '' : String(value).slice(0, 2000);
}

// The search tab describes the query, not each result's actual media type.
// Legacy records may contain "mixed" even when their parsed link is a note.
function searchWorkType(work, fallback = 'video') {
  try {
    const url = new URL(work && work.link);
    const match = /^\/(video|note)\/\d{1,24}\/?$/.exec(url.pathname);
    if (url.protocol === 'https:' && ['www.douyin.com', 'douyin.com'].includes(url.hostname) && match) return match[1];
  } catch (_) { /* Missing legacy link uses the explicit search fallback. */ }
  if (work && ['video', 'note'].includes(work.workType)) return work.workType;
  return fallback === 'note' ? 'note' : 'video';
}

/** 从候选对象中提取一个作品条目；不是作品返回 null */
function extractWork(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const info = raw.aweme_info && typeof raw.aweme_info === 'object' ? raw.aweme_info : raw;
  const awemeId = identifier(info.aweme_id);
  if (!awemeId) return null;
  const author = info.author && typeof info.author === 'object' ? info.author : {};
  const statistics = info.statistics && typeof info.statistics === 'object' ? info.statistics : {};
  const workType = info.aweme_type === 68 || info.images ? 'note' : 'video';
  return {
    awemeId,
    desc: asText(info.desc),
    authorName: asText(author.nickname),
    authorUid: identifier(author.sec_uid) || identifier(author.uid),
    commentCount: asInt(statistics.comment_count),
    diggCount: asInt(statistics.digg_count),
    workType,
    link: `https://www.douyin.com/${workType === 'note' ? 'note' : 'video'}/${awemeId}`
  };
}

/**
 * 解析搜索接口响应。
 * @returns {{ok:boolean, works:Array, cursor:string|null, hasMore:boolean, reason?:string}}
 */
function parseSearchResponse(json) {
  if (!json || typeof json !== 'object') return { ok: false, works: [], cursor: null, hasMore: false, reason: '响应不是有效对象' };
  if (json.status_code != null && ![0, '0'].includes(json.status_code)) {
    return { ok: false, works: [], cursor: null, hasMore: false, reason: `接口返回状态码 ${json.status_code}` };
  }
  let dataList = Array.isArray(json.data) ? json.data : [];
  // 部分版本把列表放在 log_pb 或 aweme_list 中
  if (!dataList.length && Array.isArray(json.aweme_list)) dataList = json.aweme_list;
  const works = [];
  for (const item of dataList) {
    const work = extractWork(item);
    if (work) works.push(work);
  }
  const cursorText = json.cursor != null ? String(json.cursor) : '';
  const cursor = /^\d+$/.test(cursorText) ? cursorText : null;
  const hasMore = [0, 1, '0', '1'].includes(json.has_more) ? Number(json.has_more) === 1 : false;
  return { ok: true, works, cursor, hasMore };
}

module.exports = { SEARCH_PATH, parseSearchResponse, extractWork, searchWorkType };
