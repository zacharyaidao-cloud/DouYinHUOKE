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
const { selectWorkDetail, workDescription } = require('./lib/work-metadata');
const { readPageWorkMetadata } = require('./lib/page-work-metadata');
const { DETAIL_PATH, recordWorkDetail, recordPageMetadata } = require('./lib/work-record');

// 页面切换中（执行上下文被销毁 / 登录读取明确标记为页面切换）时短暂等待后重新确认，最多 3 次，与旧采集一致
const navigationRace = error => /Execution context was destroyed|Cannot find context with specified id/.test(String(error && error.message || ''));

function createCoreCollectOne({ store, workflow, setTask, legacyCollectOne, dedupeKey, matchIntent, checkPageHealth = null, fmtTs = sec => String(sec), sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
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
    // 每个作品打开后先复核登录：会话失效 / 验证 / 证据不足都暂停整个队列，并把同一原因写到账号卡片（旧采集同样行为）
    // 页面切换最多重试 3 次；页面明确“仍在加载”（SPA 正文未就绪）最多等 40 次 × 0.5 秒。登录提示、验证、证据不足立即停止。
    const afterOpen = checkPageHealth ? async current => {
      for (let transitions = 0, loadings = 0; ;) {
        scheduler.checkStopped();
        try { await checkPageHealth(current, accountId); return; } catch (error) {
          const loading = ['LOGIN_PENDING', 'LOGIN_UNCONFIRMED'].includes(error.code) && /账号页面尚未加载完成|抖音页面仍在加载/.test(error.message || '');
          const transition = !loading && (navigationRace(error) || error.code === 'LOGIN_UNCONFIRMED' && error.pageTransition === true);
          if (loading && ++loadings < 40) {
            setTask({ status: '作品页面尚在加载，等待浏览器确认账号状态，可随时停止' });
            await sleep(500);
            continue;
          }
          if (!transition || ++transitions > 3) throw error;
          setTask({ status: '作品页面正在切换，等待重新确认登录状态，可随时停止' });
          store.log(accountId, `采集：页面切换中，重新检查登录状态（${transitions}/3）`);
          await sleep(700 + Math.round(Math.random() * 600));
          try { await current.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch (_) { /* 继续重试 */ }
        }
      }
    } : null;
    // 作品资料：页面自己请求的作品详情接口（只收目标 aweme_id），与旧采集同一入库规则
    const detailTasks = new Set();
    const onDetail = response => {
      const task = (async () => {
        const address = new URL(response.url());
        if (!/(^|.)douyin.com$/.test(address.hostname) || address.pathname !== DETAIL_PATH) return;
        if (address.searchParams.get('aweme_id') && address.searchParams.get('aweme_id') !== work.id) return;
        if (response.status() < 200 || response.status() >= 300) return;
        const aw = selectWorkDetail(await response.json(), work.id);
        if (!aw || String(aw.aweme_id) !== work.id) return;
        const recorded = recordWorkDetail({ store, videoId: work.id, url: work.url, workType: work.type, aw, fmtTs, sourcePath: address.pathname });
        store.log(accountId, `采集：作品详情入库（描述${recorded.descriptionState === 'available' ? '已获取' : '待确认'}）`);
      })().catch(() => { /* 非目标或无法解析的详情响应忽略 */ });
      detailTasks.add(task); task.finally(() => detailTasks.delete(task));
    };
    page.on('response', onDetail);
    let result;
    try {
      const previous = store.getVideos()[work.id] || {};
      result = await collectWork(session, { awemeId: work.id, workType: work.type, desc: previous.desc || '', authorUid: previous.authorSecUid || '' },
        { maxRounds: Math.max(5, Number(settings.collect.maxScrolls) || 40), pacing: mergePacing({}).collect, afterOpen });
    } catch (error) {
      // 账号级停止（登录失效 / 验证 / 手动停止）：本作品记为中断，原因与任务、账号卡片一致，再交给队列暂停
      await Promise.allSettled([...detailTasks]);
      const videos = store.getVideos(), info = videos[work.id] || { awemeId: work.id };
      if (!info.desc && !info.descriptionState) Object.assign(info, workDescription(null, info));
      Object.assign(info, { awemeId: work.id, videoLink: work.url, workType: work.type, collectionState: 'interrupted',
        collectionReason: error && error.message || '采集中断' });
      videos[work.id] = info;
      try { store.setVideos(videos); } catch (_) { /* 以原错误为准 */ }
      throw error;
    } finally { session.detach(); page.off('response', onDetail); }
    await Promise.allSettled([...detailTasks]);
    scheduler.checkStopped();
    // 作品页内嵌数据（图文常不发详情接口）：只读当前作品页
    try {
      const pageMetadata = await page.evaluate(readPageWorkMetadata, work.id);
      recordPageMetadata({ store, videoId: work.id, url: work.url, workType: work.type, pageMetadata, pageUrl: page.url() });
    } catch (_) { /* 页面已离开或读取失败：保留接口资料 */ }
    const authorSecUid = (store.getVideos()[work.id] || {}).authorSecUid || '';

    // 写线索：沿用旧流程的字段与去重规则（dedupeKey = 作品+用户+评论文本，不分采集账号）
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
        isAuthor: !!row.isAuthor || !!authorSecUid && (c.user || {}).sec_uid === authorSecUid, intent: intent.hit, excluded: intent.excluded,
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
    if (!info.desc && !info.descriptionState) Object.assign(info, workDescription(null, info));
    Object.assign(info, { awemeId: work.id, videoLink: work.url, workType: work.type,
      collectionState: complete ? 'complete' : result.state === 'interrupted' ? 'interrupted' : 'partial',
      collectionReason: result.reason, collectionCheckpoint: { comments: result.comments.length, added, supplemented,
        rounds: result.stats.rounds, lastHasMore: result.stats.lastHasMore, commentResponseCount: result.stats.apiPages, noProgressRounds: result.stats.noProgressRounds,
        paginationSourceCount: result.stats.listCount, embeddedFirstPage: result.stats.embeddedRead, updatedAt: t } });
    videos[work.id] = info; store.setVideos(videos);
    store.log(accountId, `采集：作品 ${work.id}（${work.type === 'note' ? '图文' : '视频'}）${complete ? '完整' : '未完整'}：${result.reason}；一级评论 ${result.comments.length} 条，新增 ${added}，回填 ${supplemented}`);
    // 账号级事件：验证未完成 → 停止整个队列；其他作品级未完整由队列记录后继续
    if (/安全验证未完成/.test(result.reason)) throw new TaskStopError('抖音要求安全验证，请在账号窗口人工完成验证', 'PLATFORM_VERIFICATION');
    if (!complete && result.state === 'interrupted') throw Object.assign(new TaskStopError(result.reason, 'COLLECTION_NO_PROGRESS'), { workLevel: true });
    return { newLeads: added, complete, work, rounds: 0, lastCursor: null, lastTotal: null };
  };
}

module.exports = { createCoreCollectOne };
