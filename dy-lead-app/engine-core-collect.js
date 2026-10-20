'use strict';
/**
 * 软件采集任务的“采一个作品”步骤：走核心流程 core/collect.js（实测规格见 使用文档/正确流程规格 第 2 节），
 * 再按软件原有的线索字段规则写入 leads / videos。队列、每日上限、冷却、断点与采后 AI 仍由 engine-collection-tasks 负责。
 *
 * 与旧 collectOne 同一签名，可直接替换。短链等需要先跳转解析的链接仍交给旧实现（legacyCollectOne）。
 */
const { TaskStopError } = require('./scheduler');
const { Session } = require('./core/session');
const { collectWork } = require('./core/collect');
const { mergePacing } = require('./core/pacing');
const { userMetadata } = require('./lib/user-metadata');
const { commentEvidence } = require('./lib/comment-evidence');

function createCoreCollectOne({ store, workflow, setTask, legacyCollectOne, dedupeKey, matchIntent }) {
  return async function collectOneCore(accountId, page, workInput, settings, scheduler, beforeCollect = () => '', onCommentLeads = () => {}, collectionRunId = '') {
    const item = typeof workInput === 'object' ? { ...workInput } : { id: String(workInput), type: 'video' };
    if (!item.id || !['video', 'note'].includes(item.type)) {
      return legacyCollectOne(accountId, page, workInput, settings, scheduler, beforeCollect, onCommentLeads, collectionRunId);
    }
    const work = { id: String(item.id), type: item.type, url: `https://www.douyin.com/${item.type}/${item.id}`, force: item.force };
    const skipReason = beforeCollect(work) || '';
    if (skipReason) return { newLeads: 0, skipped: true, skipReason, work };
    if (work.type !== item.type) work.url = `https://www.douyin.com/${work.type}/${work.id}`;
    // 作品之间的节奏与授权检查沿用软件调度器（设置里的“作品间隔”）
    await scheduler.before({ accountId, kind: 'video', videoId: work.id });
    setTask({ stage: 'collecting_comments', currentWork: { id: work.id, url: work.url }, status: '正在采集作品评论' });

    const session = Session.attach(page, {
      step: (name, data) => {
        if (['collect.done', 'collect.open_comments', 'collect.embedded', 'collect.response_rejected'].includes(name)) store.log(accountId, `采集：${name} ${JSON.stringify(data || {})}`);
        if (name === 'collect.round') setTask({ status: `翻页采集第 ${data.round} 轮，已收 ${data.apiPages} 页评论响应` });
      },
      response() {}
    });
    let result;
    try {
      const previous = store.getVideos()[work.id] || {};
      result = await collectWork(session, { awemeId: work.id, workType: work.type, desc: previous.desc || '', authorUid: previous.authorSecUid || '' },
        { maxRounds: Math.max(5, Number(settings.collect.maxScrolls) || 40), pacing: mergePacing({}).collect });
    } finally { session.detach(); }
    scheduler.checkStopped();

    // 写线索：沿用旧流程的字段与去重规则（dedupeKey = 账号+作品+用户+评论文本）
    const leads = store.getLeads();
    const seen = new Map(leads.map(lead => [dedupeKey(lead), lead]));
    let maxId = leads.reduce((max, lead) => Math.max(max, Number(lead.id) || 0), 0);
    const t = store.nowStr(), sourcePath = '/aweme/v1/web/comment/list/';
    let added = 0, supplemented = 0;
    const ids = [];
    for (const row of result.comments) {
      const c = row.raw || {};
      const text = typeof c.text === 'string' ? c.text.trim() : '';
      if (settings.collect.skipEmptyText && !text) continue;
      const captured = { ...userMetadata(c.user || {}, { sourcePath, capturedAt: t }), commentLevel: 1, commentSourcePath: sourcePath, commentCapturedAt: t };
      if (typeof c.ip_label === 'string' && c.ip_label.trim()) captured.region = c.ip_label;
      const intent = matchIntent(text, settings.keywords);
      const lead = {
        id: maxId + 1, uid: '', account: '', UID: '', nickname: '', signature: '', homepage: '',
        trigger: intent.kw, demand: text, ...commentEvidence(c), region: c.ip_label || '', videoLink: work.url, fetchTime: t,
        isAuthor: !!row.isAuthor, intent: intent.hit, excluded: intent.excluded,
        diggCount: c.digg_count != null ? c.digg_count : '', replyCount: c.reply_comment_total != null ? c.reply_comment_total : '',
        status: 'new', accountId: String(accountId), businessId: workflow.businessId(settings),
        ...(collectionRunId ? { collectionRunId } : {}), ...captured
      };
      if (!lead.uid) continue;
      const key = dedupeKey(lead);
      if (seen.has(key)) {
        const existing = seen.get(key);
        Object.assign(existing, captured, commentEvidence(c, existing));
        if (collectionRunId) existing.collectionRunId = collectionRunId;
        ids.push(String(existing.id)); supplemented++;
        continue;
      }
      maxId++; seen.set(key, lead); leads.push(lead); ids.push(String(lead.id)); added++;
    }
    if (added || supplemented) { store.setLeads(leads); onCommentLeads(ids, { added, supplemented }); }

    const complete = result.state === 'complete';
    const videos = store.getVideos(), info = videos[work.id] || { awemeId: work.id };
    Object.assign(info, { awemeId: work.id, videoLink: work.url, workType: work.type,
      collectionState: complete ? 'complete' : result.state === 'interrupted' ? 'interrupted' : 'partial',
      collectionReason: result.reason, collectionCheckpoint: { comments: result.comments.length, added, supplemented, updatedAt: t } });
    videos[work.id] = info; store.setVideos(videos);
    store.log(accountId, `采集：作品 ${work.id}（${work.type === 'note' ? '图文' : '视频'}）${complete ? '完整' : '未完整'}：${result.reason}；一级评论 ${result.comments.length} 条，新增 ${added}，回填 ${supplemented}`);
    // 账号级事件：验证未完成 → 停止整个队列；其他作品级未完整由队列记录后继续
    if (/安全验证未完成/.test(result.reason)) throw new TaskStopError('抖音要求安全验证，请在账号窗口人工完成验证', 'PLATFORM_VERIFICATION');
    if (!complete && result.state === 'interrupted') throw Object.assign(new TaskStopError(result.reason, 'COLLECTION_NO_PROGRESS'), { workLevel: true });
    return { newLeads: added, complete, work, rounds: 0, lastCursor: null, lastTotal: null };
  };
}

module.exports = { createCoreCollectOne };
