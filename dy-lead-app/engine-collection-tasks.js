'use strict';
const crypto = require('node:crypto');
const AI = require('./ai');
const { TaskStopError } = require('./scheduler');
const { isCommentUser, filterLeads, commentTimeMs } = require('./lead-query');
const { parseCommentTimestamp } = require('./lib/comment-evidence');

// Failures confined to one work: record it as interrupted and move on. Every
// other error (login, verification, closed page, stop, local save) stops the queue.
const WORK_LEVEL_ERRORS = new Set(['COLLECTION_NO_PROGRESS', 'COMMENT_PANEL_NOT_FOUND', 'COMMENT_RESPONSE_MISSING', 'TARGET_MISMATCH', 'INVALID_VIDEO_LINK']);
const MAX_CONSECUTIVE_WORK_FAILURES = 3;
// 自动判断默认只处理最近一周内的评论（设置 ai.autoJudgeWindowDays 可调，0=全部）
const aiWindowDays = settings => [0, 1, 3, 7].includes(Number(settings.ai.autoJudgeWindowDays)) ? Number(settings.ai.autoJudgeWindowDays) : 7;
// Same comment-time evidence lead-query uses for its time window.
const hasCommentTime = row => row.commentTimestamp == null || row.commentTimestamp === ''
  ? commentTimeMs(row.time) !== null : parseCommentTimestamp(row.commentTimestamp) !== null;

// One server-owned pipeline. UI polling never starts a second AI task.
function createCollectionTasks({ store, taskState, setTask, failTask, makeScheduler, checkpoint,
  parseVideoList, getAlive, launchAccount, collectOne, runAi }) {
  async function collectTask(accountId, input) {
    if (taskState.running) return failTask('已有任务在运行');
    const settings = store.getSettings();
    let list;
    try { list = parseVideoList(input); } catch (error) { return failTask(error.message); }
    if (!list.length) return failTask('没有有效的抖音作品链接');
    const runId = crypto.randomUUID(), captured = new Set(), processedIds = new Set();
    let newLeads = 0, processed = 0, skipped = 0, completed = 0, partial = 0, interrupted = 0, failureStreak = 0, stopReason = '';
    let summary = { runId, accountId: String(accountId), workCount: list.length, status: 'collecting',
      autoAi: settings.collect.autoAiAfterCollect !== false, aiStatus: 'pending', commentLeadCount: 0,
      newLeads: 0, processed: 0, completed: 0, partial: 0, skipped: 0, interrupted: 0 };
    const publish = patch => { summary = { ...summary, ...patch }; setTask({ collectionSummary: summary }); };
    const snapshot = () => {
      const videos = store.getVideos();
      return store.getLeads().filter(row => captured.has(String(row.id)) && isCommentUser(row, videos));
    };
    const capture = (ids, counts = {}) => {
      for (const id of ids) captured.add(String(id));
      newLeads += Math.max(0, Number(counts.added) || 0);
      publish({ newLeads, commentLeadCount: snapshot().length });
    };
    // Pending counts only rows inside the AI run's own comment-time window;
    // rows outside it are reported separately instead of looking unfinished.
    const aiProgress = (attempt = {}) => {
      const currentSettings = store.getSettings(), videos = store.getVideos(), rows = snapshot();
      const windowDays = summary.aiWindowDays ?? aiWindowDays(currentSettings);
      const inWindow = new Set(filterLeads(rows, videos, { f: 'all', commentDays: windowDays }, { settings: currentSettings, now: Date.now() }).map(row => String(row.id)));
      const valid = rows.filter(row => AI.isCurrentResult(row, currentSettings, videos));
      const outside = rows.filter(row => !AI.isCurrentResult(row, currentSettings, videos) && !inWindow.has(String(row.id)));
      return { aiPendingCount: rows.length - valid.length - outside.length,
        aiOutOfWindowCount: outside.filter(hasCommentTime).length,
        aiNoTimestampCount: outside.filter(row => !hasCommentTime(row)).length, aiCounts: {
          yes: valid.filter(row => row.aiNeed === '是').length,
          no: valid.filter(row => row.aiNeed === '否').length,
          failed: attempt.failCount || 0, skipped: attempt.skipped || 0
        } };
    };
    const outsideNote = progress => [progress.aiOutOfWindowCount ? `超出时间窗未判断 ${progress.aiOutOfWindowCount} 条` : '',
      progress.aiNoTimestampCount ? `缺评论时间未判断 ${progress.aiNoTimestampCount} 条` : ''].filter(Boolean).join('，');
    setTask({ kind: 'collect', running: true, accountId: String(accountId), stage: 'opening_work',
      status: `准备采集 ${list.length} 个作品，完成后${summary.autoAi ? '自动判断本次评论用户' : '查看评论用户'}`,
      done: 0, total: list.length, detail: '', errors: [], collectionSummary: summary });
    try {
      const scheduler = makeScheduler(settings);
      checkpoint({ id: runId, kind: 'collect', accountId: String(accountId), planId: null,
        videoIds: list.filter(item => item.id).map(item => item.id), workLinks: list.map(item => item.url),
        processedVideoIds: [], state: 'running', stopReason: null });
      let alive = getAlive(accountId);
      if (!alive || alive.headless === true || (typeof alive.page?.isClosed === 'function' && alive.page.isClosed())) {
        alive = await launchAccount(accountId, { checkStopped: () => scheduler.checkStopped() });
      }
      scheduler.checkStopped();
      const planned = new Map(list.filter(item => item.id).map(item => [item.id, item]));
      const cooldown = Number(settings.collect.cooldownHours ?? 24) * 3600000;
      const checkWork = work => {
        const queued = planned.get(work.id);
        if (queued) {
          work.force = work.force || queued.force;
          if (queued.type === 'note') { work.type = 'note'; work.url = queued.url; }
        }
        if (processedIds.has(work.id)) return '同一作品已在本次队列采集，跳过重复链接';
        const info = store.getVideos()[work.id] || {};
        const last = info.lastCollectAt ? Date.parse(String(info.lastCollectAt).replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(info.lastCollectAt) ? '' : '+08:00')) : 0;
        return !work.force && !['partial', 'interrupted'].includes(info.collectionState) && last && Date.now() - last < cooldown
          ? '作品已在重采冷却期；需要重采时勾选“强制重采”' : '';
      };
      for (let index = 0; index < list.length; index++) {
        scheduler.checkStopped();
        const item = { ...list[index] }, usage = store.getDailyUsage(accountId);
        if (Math.max(Number(usage.videos) || 0, Number(usage.collectAttempts) || 0) >= settings.collect.dailyVideoLimit) {
          stopReason = `达到每日作品采集上限（${settings.collect.dailyVideoLimit}）`; break;
        }
        const skip = item.id ? checkWork(item) : '';
        if (skip) {
          skipped++; publish({ skipped });
          store.log(accountId, '采集队列：' + skip);
          continue;
        }
        setTask({ stage: 'opening_work', currentWorkIndex: index + 1, totalWorks: list.length,
          currentWork: { id: item.id || '', url: item.url }, status: `正在处理作品 ${index + 1}/${list.length}`,
          detail: `已处理 ${processed} 个｜新增 ${newLeads} 条评论`, done: processed, total: list.length });
        store.bumpDaily(accountId, 'collectAttempts');
        let result;
        try { result = await collectOne(accountId, alive.page, item, settings, scheduler, checkWork, capture, runId); }
        catch (error) {
          if (!WORK_LEVEL_ERRORS.has(error && error.code) || taskState.stopRequested) throw error;
          // collectOne has already saved this work as interrupted with its reason.
          scheduler.scheduleBoundary('collect');
          interrupted++; failureStreak++;
          if (item.id) processedIds.add(item.id);
          publish({ interrupted });
          store.log(accountId, `采集队列：作品 ${index + 1}/${list.length} 未完成（${error.message}）`);
          if (failureStreak >= MAX_CONSECUTIVE_WORK_FAILURES) {
            stopReason = `连续 ${failureStreak} 个作品采集失败，已暂停：${error.message}`; break;
          }
          continue;
        }
        // A resolved duplicate short URL was still visited; wait before the next actual work.
        scheduler.scheduleBoundary('collect');
        if (result.skipped) { skipped++; publish({ skipped }); continue; }
        if (taskState.stopRequested) { stopReason = '已手动停止'; break; }
        failureStreak = 0;
        processed++; processedIds.add(result.work.id);
        if (result.complete) completed++; else partial++;
        const videos = store.getVideos(), info = videos[result.work.id] || {};
        Object.assign(info, { awemeId: result.work.id, videoLink: result.work.url, workType: result.work.type,
          lastCollectAt: store.nowStr(), scanCount: (Number(info.scanCount) || 0) + 1 });
        videos[result.work.id] = info; store.setVideos(videos); store.bumpDaily(accountId, 'videos');
        checkpoint({ processedVideoIds: [...processedIds], currentVideoId: null, state: 'running' });
        publish({ newLeads, processed, completed, partial, skipped, commentLeadCount: snapshot().length });
      }
      const rows = snapshot();
      publish({ status: stopReason ? 'paused' : 'completed', newLeads, processed, completed, partial, skipped, interrupted,
        commentLeadCount: rows.length, completedAt: store.nowStr(), stopReason });
      checkpoint({ state: stopReason ? 'paused' : 'completed', stopReason, completedAt: store.nowStr(), collectionSummary: summary });
      setTask({ running: false, stage: 'collected', status: stopReason || `采集结束：完整 ${completed} 个｜部分 ${partial} 个｜跳过 ${skipped} 个${interrupted ? `｜中断 ${interrupted} 个` : ''}`,
        detail: `本次 ${rows.length} 条评论用户记录，新增 ${newLeads} 条`, done: processed, total: list.length });
      const result = { ok: true, runId, newLeads, processed, completed, partial, skipped, interrupted, commentLeadCount: rows.length };
      if (stopReason || taskState.stopRequested || !summary.autoAi || !rows.length) {
        publish({ aiStatus: 'skipped', aiMessage: stopReason || (!summary.autoAi ? '自动判断未开启' : '本次没有可判断的评论用户') });
        return result;
      }
      const currentSettings = store.getSettings(), videos = store.getVideos();
      if (!currentSettings.ai.enabled || !currentSettings.ai.apiKey) {
        publish({ aiStatus: 'blocked', aiMessage: '评论已保存，请先配置并启用 DeepSeek，再判断本次评论用户' });
        setTask({ status: '采集已完成，AI 设置待完成', detail: summary.aiMessage });
        return result;
      }
      const pending = rows.filter(row => !AI.isCurrentResult(row, currentSettings, videos));
      if (!pending.length) {
        publish({ ...aiProgress(), aiStatus: 'completed', aiMessage: '本次评论已有当前有效判断，无需重复请求' });
        setTask({ stage: 'review_ready', status: '采集与判断已完成，可筛选后预检查', detail: summary.aiMessage });
        return result;
      }
      // No await between the stop check and runAi: stop cannot disappear at hand-off.
      if (taskState.stopRequested) { publish({ aiStatus: 'skipped', aiMessage: '已停止，未启动AI' }); return result; }
      const windowDays = aiWindowDays(currentSettings);
      publish({ aiWindowDays: windowDays }); publish({ aiStatus: 'running', aiPendingCount: aiProgress().aiPendingCount });
      const aiResult = await runAi({ leadIds: pending.map(row => String(row.id)), filters: { f: 'all', commentDays: windowDays } });
      const progress = aiProgress(aiResult);
      const successful = aiResult.ok && !aiResult.partial && !taskState.stopRequested && progress.aiPendingCount === 0;
      const note = outsideNote(progress);
      publish({ ...progress, aiStatus: successful ? 'completed' : 'paused', aiMessage: (aiResult.error || (successful ? '本次评论判断完成' : `还有 ${progress.aiPendingCount} 条待判断，可检查日志后继续`)) + (note ? `（${note}）` : '') });
      setTask({ running: false, stage: successful ? 'review_ready' : 'ai_paused', status: successful ? '采集与AI判断完成，请筛选并预检查执行名单' : '采集已完成，AI判断暂停',
        detail: `本次评论 ${rows.length} 条｜AI 是 ${summary.aiCounts.yes}｜否 ${summary.aiCounts.no}｜失败 ${summary.aiCounts.failed}` });
      return { ...result, ai: aiResult };
    } catch (error) {
      const stopped = error instanceof TaskStopError || taskState.stopRequested;
      if (summary.status === 'completed' && summary.aiStatus === 'running') {
        publish({ ...aiProgress(), aiStatus: 'paused', aiMessage: error.message });
        setTask({ running: false, stage: 'ai_paused', status: '采集已完成，AI判断暂停：' + error.message });
        return { ok: true, runId, newLeads, processed, completed, partial, skipped, ai: { ok: false, error: error.message } };
      }
      publish({ status: stopped ? 'paused' : 'error', aiStatus: 'skipped', aiMessage: '采集已中断，未自动启动AI',
        commentLeadCount: snapshot().length, stopReason: error.message });
      store.log(accountId, '采集停止：' + error.message);
      setTask({ running: false, stage: 'collection_paused', status: '采集已暂停：' + error.message });
      checkpoint({ state: stopped ? 'paused' : 'error', stopReason: error.message, collectionSummary: summary });
      return { ok: false, runId, error: error.message };
    }
  }
  return { collectTask };
}
module.exports = { createCollectionTasks };
