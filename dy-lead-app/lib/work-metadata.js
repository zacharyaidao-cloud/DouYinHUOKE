'use strict';

// Public reference: Evil0ctal/Douyin_TikTok_Download_API,
// src/dtk/platforms/douyin/parser.py and its video_image_album.json fixture.
// Keep the actual title and full body separate. A description's first line is
// not evidence of a platform title. Never use music, comments or OCR as text.
const TEXT_FIELDS = ['desc', 'item_title', 'itemTitle', 'caption'];
const text = value => typeof value === 'string' ? value.trim() : '';
const sourceRank = source => source === 'api' ? 3 : source === 'page_json' ? 2 : /^page/.test(source || '') ? 1 : 0;

function rawTextFields(record = {}, canonical = true) {
  const hasRaw = record.workRawText && typeof record.workRawText === 'object' && !Array.isArray(record.workRawText);
  const fields = {}, raw = hasRaw ? record.workRawText : {};
  for (const key of TEXT_FIELDS) {
    if (typeof raw[key] === 'string') fields[key] = raw[key];
    else if (!hasRaw && typeof record[key] === 'string' && !(canonical && !record[key].trim() && (record.workTextState || record.descriptionState) === 'missing')) fields[key] = record[key];
  }
  // Canonical fields have already been verified. Legacy title has not: older
  // versions generated it from the description, so it cannot become workTitle.
  if (canonical && !text(fields.item_title) && !text(fields.itemTitle) && text(record.workTitle)) fields.item_title = record.workTitle;
  if (canonical && !text(fields.desc) && !text(fields.caption) && text(record.workContent)) fields.desc = record.workContent;
  return fields;
}

function combineWorkText(title, body, caption) {
  const parts = [];
  if (title && title !== body && !body.startsWith(title + '\n') && !body.startsWith(title + '\r\n')) parts.push(title);
  if (body) parts.push(body);
  if (caption && !parts.includes(caption) && !body.split(/\r?\n/).some(line => line.trim() === caption) && caption !== title) parts.push('补充文字：\n' + caption);
  return parts.join('\n\n');
}

// Shared read-only adapter for storage, UI, AI and export. Full strings remain
// intact; each consumer decides how much to display or send to an AI model.
function workTextFields(record = {}) {
  const raw = rawTextFields(record);
  const sources = record.workRawTextSources && typeof record.workRawTextSources === 'object' ? record.workRawTextSources : {};
  const titleKey = ['item_title', 'itemTitle'].filter(key => text(raw[key])).sort((a, b) => sourceRank(sources[b] || record.workTextSource || record.descriptionSource) - sourceRank(sources[a] || record.workTextSource || record.descriptionSource))[0];
  const workTitle = titleKey ? text(raw[titleKey]) : '';
  const workContent = text(raw.desc) || text(raw.caption);
  const workText = combineWorkText(workTitle, workContent, text(raw.caption)) || text(record.workText);
  const explicit = Object.values(raw).some(value => typeof value === 'string');
  const priorState = record.workTextState || record.descriptionState;
  return {
    workTitle, workContent, workText,
    workTextState: workText ? 'available' : explicit || priorState === 'empty' ? 'empty' : 'missing',
    workTextSource: workText ? record.workTextSource || record.descriptionSource || 'history' : explicit || priorState === 'empty' ? record.workTextSource || record.descriptionSource || 'history' : ''
  };
}
function workIdentifier(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  return typeof value === 'string' && /^\d{1,24}$/.test(value) ? value : '';
}

function selectWorkDetail(payload, expectedWorkId, { allowList = false } = {}) {
  const id = workIdentifier(expectedWorkId);
  if (!id || !payload || typeof payload !== 'object' || Array.isArray(payload) || ![0, '0'].includes(payload.status_code)) return null;
  const candidates = [];
  if (payload.aweme_detail && typeof payload.aweme_detail === 'object' && !Array.isArray(payload.aweme_detail)) candidates.push(payload.aweme_detail);
  if (Array.isArray(payload.aweme_details)) candidates.push(...payload.aweme_details.slice(0, 1000));
  // aweme_list is a post/collection envelope, not interchangeable with detail.
  if (allowList && Array.isArray(payload.aweme_list)) candidates.push(...payload.aweme_list.slice(0, 1000));
  return candidates.find(item => item && typeof item === 'object' && !Array.isArray(item) && workIdentifier(item.aweme_id) === id) || null;
}

function workDescription(detail, previous = {}, { source = 'api' } = {}) {
  const raw = rawTextFields(previous), sources = {};
  const previousSources = previous.workRawTextSources && typeof previous.workRawTextSources === 'object' && !Array.isArray(previous.workRawTextSources) ? previous.workRawTextSources : {};
  for (const key of Object.keys(raw)) sources[key] = previousSources[key] || previous.workTextSource || previous.descriptionSource || 'history';
  const incoming = detail && typeof detail === 'object' ? source === 'api'
    ? Object.fromEntries(TEXT_FIELDS.filter(key => typeof detail[key] === 'string').map(key => [key, detail[key]]))
    : rawTextFields(detail, false) : {};
  for (const key of Object.keys(incoming)) {
    // Missing, blank and lower-priority values never erase actual stored text.
    if (Object.prototype.hasOwnProperty.call(raw, key) && sourceRank(source) < sourceRank(sources[key])) continue;
    if (text(raw[key]) && !text(incoming[key])) continue;
    raw[key] = incoming[key]; sources[key] = source;
  }
  const nonblankSources = Object.keys(raw).filter(key => text(raw[key])).map(key => sources[key]);
  const selectedSources = nonblankSources.length ? nonblankSources : Object.values(sources);
  const dominantSource = selectedSources.slice().sort((a, b) => sourceRank(b) - sourceRank(a))[0] || previous.workTextSource || previous.descriptionSource || '';
  const normalized = workTextFields({ ...previous, workRawText: raw, workRawTextSources: sources, workTextSource: dominantSource });
  const desc = normalized.workContent;
  let imageCount = previous.imageCount ?? '', imageCountSource = previous.imageCountSource || previous.descriptionSource || '';
  const images = detail && (Array.isArray(detail.images) ? detail.images : detail.image_post_info && Array.isArray(detail.image_post_info.images) ? detail.image_post_info.images : null);
  const observedImageCount = images ? images.length : /^page/.test(source) && detail && Number.isSafeInteger(detail.imageCount) && detail.imageCount >= 0 ? detail.imageCount : null;
  if (observedImageCount !== null && (imageCount === '' || sourceRank(source) >= sourceRank(imageCountSource))) { imageCount = observedImageCount; imageCountSource = source; }
  let awemeType = previous.awemeType ?? '', awemeTypeSource = previous.awemeTypeSource || previous.descriptionSource || '';
  const actualType = detail && (detail.aweme_type ?? detail.awemeType);
  if (typeof actualType === 'number' && Number.isSafeInteger(actualType) && actualType >= 0 && (awemeType === '' || sourceRank(source) >= sourceRank(awemeTypeSource))) { awemeType = actualType; awemeTypeSource = source; }
  return {
    ...normalized,
    workRawText: raw, workRawTextSources: sources,
    desc,
    title: normalized.workTitle || (typeof previous.title === 'string' ? previous.title : ''),
    descriptionState: normalized.workTextState,
    descriptionSource: normalized.workTextSource,
    descriptionReason: normalized.workText ? '' : normalized.workTextState === 'empty' ? '平台作品文字字段为空，AI 上下文未提供作品描述' : '浏览器尚未返回该作品的有效文字，AI 上下文未提供作品描述',
    imageCount, imageCountSource, awemeType, awemeTypeSource
  };
}

function parseWorkMetadata(payload, expectedWorkId, previous = {}, options = {}) {
  const detail = selectWorkDetail(payload, expectedWorkId, options);
  return detail ? { awemeId: workIdentifier(expectedWorkId), ...workDescription(detail, previous, options) } : null;
}

module.exports = { selectWorkDetail, workDescription, parseWorkMetadata, workTextFields };
