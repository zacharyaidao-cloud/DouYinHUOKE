'use strict';
/**
 * 作品资料入库：作品详情接口（/aweme/v1/web/aweme/detail/）与作品页内嵌数据两种来源。
 * 旧采集（engine.collectOne）与核心采集（engine-core-collect）共用，保证“视频描述 / 作者 / 统计 / 来源路径”字段一致。
 */
const { workDescription } = require('./work-metadata');
const { workIdFromLink } = require('./video-links');

const DETAIL_PATH = '/aweme/v1/web/aweme/detail/';

/** 详情接口的目标作品 aw（已按 aweme_id 核对）写入作品表，并把作者本人的评论标为作者。返回 { authorSecUid, descriptionState }。 */
function recordWorkDetail({ store, videoId, url, workType, aw, fmtTs, sourcePath = DETAIL_PATH }) {
  const stat = aw.statistics || {};
  const author = aw.author || {};
  const videos = store.getVideos();
  const previous = videos[videoId] || {};
  const authorSecUid = author.sec_uid || previous.authorSecUid || '';
  const content = workDescription(aw, previous, { source: 'api' });
  const textContributed = Object.keys(content.workRawText || {}).some(key => typeof aw[key] === 'string' && aw[key].trim() && content.workRawTextSources[key] === 'api' && content.workRawText[key] === aw[key]);
  const sourceObserved = textContributed || content.workTextState === 'empty' && !previous.workText && !previous.desc
    || !previous.workSourcePath && (content.imageCountSource === 'api' && content.imageCount !== '' || content.awemeTypeSource === 'api' && content.awemeType !== '');
  const workSourcePath = sourceObserved ? sourcePath : previous.workSourcePath || '';
  videos[String(aw.aweme_id)] = {
    ...previous,
    awemeId: String(aw.aweme_id),
    videoLink: url,
    workType,
    ...content,
    workSourcePath,
    workSourcePaths: sourceObserved ? [...new Set([...(Array.isArray(previous.workSourcePaths) ? previous.workSourcePaths : []), sourcePath])] : previous.workSourcePaths || [],
    workCapturedAt: sourceObserved ? store.nowStr() : previous.workCapturedAt || '',
    diggCount: stat.digg_count != null ? stat.digg_count : previous.diggCount,
    commentCount: stat.comment_count != null ? stat.comment_count : previous.commentCount,
    shareCount: stat.share_count != null ? stat.share_count : previous.shareCount,
    collectCount: stat.collect_count != null ? stat.collect_count : previous.collectCount,
    authorNickname: author.nickname || previous.authorNickname || '',
    authorSecUid,
    authorFollowerCount: author.follower_count != null ? author.follower_count : previous.authorFollowerCount,
    createTime: aw.create_time != null ? fmtTs(aw.create_time) : previous.createTime || '',
    durationSec: aw.duration != null ? Math.round(Number(aw.duration) / 1000) : previous.durationSec || '',
    capturedAt: store.nowStr()
  };
  store.setVideos(videos);
  const authorLeads = store.getLeads();
  let marked = false;
  for (const l of authorLeads) {
    if (authorSecUid && workIdFromLink(l.videoLink) === videoId && l.uid === authorSecUid && !l.isAuthor) { l.isAuthor = true; marked = true; }
  }
  if (marked) store.setLeads(authorLeads);
  return { authorSecUid, descriptionState: videos[videoId] && videos[videoId].descriptionState };
}

/** 作品页内嵌数据（readPageWorkMetadata 的结果）写入作品表；pageUrl 必须仍是该作品页。返回是否写入。 */
function recordPageMetadata({ store, videoId, url, workType, pageMetadata, pageUrl }) {
  const videos = store.getVideos(), current = videos[videoId] || {};
  if (!(pageMetadata && /^page/.test(pageMetadata.descriptionSource || '')
    && ['available', 'empty', 'missing'].includes(pageMetadata.descriptionState))) return false;
  const content = workDescription(pageMetadata, current, { source: pageMetadata.descriptionSource });
  const pageRaw = pageMetadata.workRawText || pageMetadata;
  const textContributed = Object.keys(content.workRawText || {}).some(key => typeof pageRaw[key] === 'string' && pageRaw[key].trim() && content.workRawTextSources[key] === pageMetadata.descriptionSource && content.workRawText[key] === pageRaw[key]);
  const sourceObserved = textContributed || content.workTextState === 'empty' && !current.workText && !current.desc
    || !current.workSourcePath && (content.imageCountSource === pageMetadata.descriptionSource && content.imageCount !== '' || content.awemeTypeSource === pageMetadata.descriptionSource && content.awemeType !== '');
  const actualPath = new URL(pageUrl).pathname.match(/^\/(?:video|note)\/(\d{1,24})\/?$/);
  if (!actualPath || actualPath[1] !== videoId) return false;
  const path = actualPath[0].replace(/\/$/, '');
  videos[videoId] = { ...current, awemeId: videoId, videoLink: url, workType,
    ...content,
    workSourcePath: sourceObserved ? path : current.workSourcePath || '',
    workSourcePaths: sourceObserved ? [...new Set([...(Array.isArray(current.workSourcePaths) ? current.workSourcePaths : []), path])] : current.workSourcePaths || [],
    workCapturedAt: sourceObserved ? store.nowStr() : current.workCapturedAt || '',
    descriptionCapturedAt: sourceObserved ? store.nowStr() : current.descriptionCapturedAt || '' };
  store.setVideos(videos);
  return true;
}

module.exports = { DETAIL_PATH, recordWorkDetail, recordPageMetadata };
