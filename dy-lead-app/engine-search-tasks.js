'use strict';
const crypto = require('node:crypto');
const { TaskStopError } = require('./scheduler');
const { SEARCH_PATH, parseSearchResponse } = require('./lib/search-works');
const browserSearch = require('./lib/search-browser-actions');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeSearchInput(input, settings) {
  const keywords = (Array.isArray(input && input.keywords) ? input.keywords : String(input && input.keywords || '').split('\n'))
    .map(k => String(k).trim()).filter(Boolean).slice(0, 50);
  if (!keywords.length) throw new Error('请至少输入一个搜索关键词');
  const workType = ['video', 'note', 'mixed'].includes(input && input.workType) ? input.workType : 'video';
  const search = settings.search || {};
  const maxPages = Math.min(50, Math.max(1, Number(input && input.maxPages) || Number(search.maxPages) || 20));
  const minCommentCount = Math.max(0, Number(input && input.minCommentCount) || Number(search.minCommentCount) || 0);
  return { keywords, workType, maxPages, minCommentCount };
}

// 有界轮询：条件满足立即返回，超时返回最后一次结果（不抛错）。
async function waitFor(check, { timeoutMs, intervalMs = 250, scheduler }) {
  const until = Date.now() + timeoutMs;
  let value = await check();
  while (!value && Date.now() < until) {
    if (scheduler) scheduler.checkStopped();
    await sleep(intervalMs);
    value = await check();
  }
  return value;
}

/**
 * 搜索框真人式进入搜索页：打开首页 → 点搜索框 → 逐字输入 → 回车 → 按范围点页签。
 * 页面函数在 lib/search-browser-actions.js（不参与混淆，序列化后自包含）。
 * onBeforeTab：点页签前回调，用于清空“综合”页已收到的结果，避免混入。
 * 返回 { tabVerified }：范围页签是否确认切换（综合模式恒为 true）。
 */
async function navigateSearch(page, keyword, workType, scheduler, { onBeforeTab = () => {} } = {}) {
  const browserSearch = require('./lib/search-browser-actions');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const findBox = () => page.evaluate(browserSearch.findSearchInputRect).catch(() => null);
  let box = await waitFor(findBox, { timeoutMs: 6000, scheduler });
  if (!box) {
    await page.evaluate(browserSearch.openSearchEntry).catch(() => {});
    box = await waitFor(findBox, { timeoutMs: 3000, scheduler });
  }
  if (!box) throw new Error('首页搜索框不可用，本次未执行搜索');
  await page.mouse.click(box.x, box.y);
  await sleep(500);
  await page.keyboard.type(keyword, { delay: 50 + Math.round(Math.random() * 70) });
  await sleep(400);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 12; i++) {
    scheduler.checkStopped();
    await sleep(500);
    if (/\/search\//.test(page.url())) break;
  }
  if (!/\/search\//.test(page.url())) {
    // 回车未触发跳转时，点搜索按钮兜底
    await page.evaluate(browserSearch.clickSearchButton).catch(() => {});
    for (let i = 0; i < 16; i++) {
      scheduler.checkStopped();
      await sleep(500);
      if (/\/search\//.test(page.url())) break;
    }
  }
  if (!/\/search\//.test(page.url())) throw new Error('搜索后未进入结果页，本次未执行搜索');
  // 视频/图文范围：点击对应页签（综合默认不动），并确认已切换
  if (workType !== 'video' && workType !== 'note') return { tabVerified: true };
  const tabLabel = workType === 'video' ? '视频' : '图文';
  const typeInUrl = () => new URL(page.url()).searchParams.get('type') === workType;
  if (typeInUrl()) return { tabVerified: true };
  // 页签区随结果渲染出现，给它几秒
  await waitFor(() => page.evaluate(label => Array.from(document.querySelectorAll('[role="tab"],div,span,a'))
    .some(e => e.offsetParent !== null && (e.textContent || '').replace(/\s+/g, '') === label), tabLabel).catch(() => false), { timeoutMs: 5000, scheduler });
  onBeforeTab();
  const result = await page.evaluate(browserSearch.clickSearchTab, tabLabel).catch(() => null);
  if (result && result.already) return { tabVerified: true };
  const verified = await waitFor(typeInUrl, { timeoutMs: 6000, scheduler });
  return { tabVerified: !!verified, tabMethod: result && result.method || 'error' };
}

/** 关键词搜索找作品：只被动读取搜索页自己的带签名接口响应，不构造任何平台请求。 */
function createSearchTasks({ store, taskState, setTask, failTask, makeScheduler, checkpoint, getAlive, launchAccount, checkPageHealth }) {
  async function searchTask(accountId, input) {
    if (taskState.running) return failTask('已有任务在运行');
    const settings = store.getSettings();
    let opts;
    try { opts = normalizeSearchInput(input, settings); } catch (error) { return failTask(error.message); }
    const runId = crypto.randomUUID();
    const summary = { runId, accountId: String(accountId), keywordCount: opts.keywords.length, currentKeyword: '',
      pages: 0, works: 0, status: 'running', completed: 0, total: opts.keywords.length, stopReason: '' };
    const publish = patch => { Object.assign(summary, patch); setTask({ searchSummary: { ...summary } }); };
    setTask({ kind: 'search', running: true, accountId: String(accountId), stage: 'searching',
      status: `准备搜索 ${opts.keywords.length} 个关键词`, done: 0, total: opts.keywords.length, detail: '', errors: [], searchSummary: { ...summary } });
    try {
      const scheduler = makeScheduler(settings);
      checkpoint({ id: runId, kind: 'search', accountId: String(accountId), planId: null,
        keywords: opts.keywords, processedKeywords: [], state: 'running', stopReason: null });
      let alive = getAlive(accountId);
      if (!alive || alive.headless === true || (typeof alive.page?.isClosed === 'function' && alive.page.isClosed())) {
        alive = await launchAccount(accountId, { checkStopped: () => scheduler.checkStopped() });
      }
      const page = alive.page;
      const worksBuffer = [];
      let hasMore = false;
      const onResponse = async response => {
        try {
          const address = new URL(response.url());
          if (!/(^|\.)douyin\.com$/.test(address.hostname)) return;
          if (!SEARCH_PATH.test(address.pathname)) return;
          const json = await response.json().catch(() => null);
          const parsed = parseSearchResponse(json);
          if (!parsed.ok) return;
          hasMore = parsed.hasMore;
          for (const work of parsed.works) worksBuffer.push(work);
        } catch (e) { /* 单条响应异常不影响任务，翻页无进展会停止 */ }
      };
      page.on('response', onResponse);
      try {
        let keywordIndex = 0;
        for (const keyword of opts.keywords) {
          scheduler.checkStopped();
          const usage = store.getDailyUsage(accountId);
          const limit = Math.max(1, Number(settings.search.dailySearchLimit) || 30);
          if (Math.max(Number(usage.searchAttempts) || 0, Number(usage.search) || 0) >= limit) {
            summary.stopReason = `达到每日搜索上限（${limit}）`;
            break;
          }
          publish({ currentKeyword: keyword });
          setTask({ status: `正在搜索「${keyword}」（${keywordIndex + 1}/${opts.keywords.length}）`,
            detail: `已搜索 ${summary.completed} 个关键词｜累计找到 ${summary.works} 个作品`, done: keywordIndex, total: opts.keywords.length });
          store.bumpDaily(accountId, 'searchAttempts');
          worksBuffer.length = 0; hasMore = false;
          let navError = '';
          try {
            await scheduler.prepare({ accountId, kind: 'ui', uid: '' }, async () => {
              scheduler.checkStopped();
              const nav = await navigateSearch(page, keyword, opts.workType, scheduler, {
                // 切页签前清空“综合”页已到的结果，只保留目标范围的响应
                onBeforeTab: () => { worksBuffer.length = 0; hasMore = false; }
              });
              store.log(accountId, `关键词搜索：${keyword} 已通过首页搜索框进入结果页` + (nav.tabVerified ? '' : `；范围页签未确认切换（${nav.tabMethod}），入库时按作品类型过滤`));
            });
          } catch (error) {
            if (error instanceof TaskStopError) throw error;
            navError = error.message || '进入搜索页失败';
          }
          if (navError) {
            store.log(accountId, `关键词搜索：${keyword} 未执行：${navError}`);
            setTask({ status: `「${keyword}」未执行：${navError}`, detail: '请人工查看账号浏览器首页搜索框，稍后重试' });
            await sleep(1500);
            keywordIndex++;
            summary.completed = keywordIndex;
            publish({ works: summary.works, completed: keywordIndex });
            checkpoint({ processedKeywords: [...(taskState.checkpoint?.processedKeywords || []), keyword], state: 'running' });
            if (keywordIndex < opts.keywords.length) {
              const gap = Math.round(Math.max(10, Number(settings.search.intervalSec) || 60) * 1000);
              const until = Date.now() + gap;
              setTask({ stage: 'waiting_search', waitingReason: 'search', status: `下一关键词间隔，剩余 ${Math.ceil(gap / 1000)} 秒，可随时停止`, waitingUntil: new Date(until).toISOString() });
              while (Date.now() < until) {
                scheduler.checkStopped();
                await sleep(Math.min(1000, until - Date.now()));
              }
              setTask({ waitingUntil: null, waitingReason: '' });
            }
            continue;
          }
          // 等待首屏结果响应（最多约 20 秒）
          for (let i = 0; i < 40 && worksBuffer.length === 0; i++) {
            scheduler.checkStopped();
            await sleep(500);
          }
          await checkPageHealth(page, accountId, '');
          scheduler.checkStopped();
          if (worksBuffer.length === 0) {
            const existing = store.getSearchResults().filter(w => String(w.keyword) === String(keyword)).length;
            const hint = existing > 0
              ? `本次未收到搜索接口响应（可能触发平台限流或验证），历史已有 ${existing} 条该关键词结果仍可使用；建议稍后重试或人工查看账号浏览器`
              : '搜索页未返回作品响应，可能触发平台验证或限流；请人工查看账号浏览器，稍后再试';
            store.log(accountId, `关键词搜索：${keyword}（${opts.workType}）未收到作品响应，` + hint);
            setTask({ status: `「${keyword}」未收到搜索响应：${hint}`, detail: '已停止本关键词，可稍后重新搜索' });
            await sleep(1500);
            keywordIndex++;
            summary.completed = keywordIndex;
            publish({ works: summary.works, completed: keywordIndex });
            checkpoint({ processedKeywords: [...(taskState.checkpoint?.processedKeywords || []), keyword], state: 'running' });
            if (keywordIndex < opts.keywords.length) {
              const gap = Math.round(Math.max(10, Number(settings.search.intervalSec) || 60) * 1000);
              const until = Date.now() + gap;
              setTask({ stage: 'waiting_search', waitingReason: 'search', status: `下一关键词间隔，剩余 ${Math.ceil(gap / 1000)} 秒，可随时停止`, waitingUntil: new Date(until).toISOString() });
              while (Date.now() < until) {
                scheduler.checkStopped();
                await sleep(Math.min(1000, until - Date.now()));
              }
              setTask({ waitingUntil: null, waitingReason: '' });
            }
            continue;
          }
          // 自然滚动触发分页，拦截每页响应；每页实时更新界面进度
          let idlePages = 0;
          for (let p = 1; p <= opts.maxPages; p++) {
            scheduler.checkStopped();
            await scheduler.before({ accountId, kind: 'scroll', operation: 'search_scroll', uid: '' });
            const before = worksBuffer.length;
            const scrollInfo = await page.evaluate(browserSearch.scrollSearchFeed, 1400).catch(() => null);
            if (p === 1 && scrollInfo) store.log(accountId, `关键词搜索：${keyword} 滚动容器=${scrollInfo.container}`);
            let progressed = false;
            for (let i = 0; i < 20; i++) {
              scheduler.checkStopped();
              await sleep(400);
              if (worksBuffer.length > before) { progressed = true; break; }
              if (!hasMore && worksBuffer.length === before && i >= 5) break;
            }
            publish({ pages: p });
            setTask({ stage: 'searching', status: `正在搜索「${keyword}」第 ${p}/${opts.maxPages} 页，已读 ${worksBuffer.length} 个作品`,
              detail: `累计新增 ${summary.works + worksBuffer.filter(w => Number(w.commentCount) >= opts.minCommentCount).length} 个待存作品（保存前去重）`, done: keywordIndex, total: opts.keywords.length });
            if (!progressed && !hasMore && worksBuffer.length === before) break;
            // 单页偶尔慢不代表到底：连续 2 页都没有新响应才停止，避免空转
            idlePages = progressed ? 0 : idlePages + 1;
            if (idlePages >= 2 && before > 0) break;
          }
          await checkPageHealth(page, accountId, '');
          scheduler.checkStopped();
          const seenIds = new Set();
          const filtered = worksBuffer.filter(work => {
            if (seenIds.has(work.awemeId)) return false;
            seenIds.add(work.awemeId);
            // 视频/图文范围只保留同类型作品（页签未确认切换时兜底）
            if ((opts.workType === 'video' || opts.workType === 'note') && work.workType !== opts.workType) return false;
            return Number(work.commentCount) >= opts.minCommentCount;
          });
          const added = store.addSearchResults(keyword, opts.workType, filtered);
          summary.works += added;
          keywordIndex++;
          summary.completed = keywordIndex;
          publish({ works: summary.works, completed: keywordIndex });
          store.log(accountId, `关键词搜索：${keyword}（${opts.workType}）翻页 ${Math.min(opts.maxPages, summary.pages)} 页，新增 ${added} 个作品`);
          checkpoint({ processedKeywords: [...(taskState.checkpoint?.processedKeywords || []), keyword], state: 'running' });
          // 关键词之间的强制间隔（默认 60 秒 ± 抖动），可随时停止
          if (keywordIndex < opts.keywords.length) {
            const base = Math.max(10, Number(settings.search.intervalSec) || 60);
            const jitter = Math.min(1, Math.max(0, Number(settings.search.intervalJitter) || 0.2));
            const gap = Math.round(base * (1 + (Math.random() * 2 - 1) * jitter) * 1000);
            const until = Date.now() + gap;
            setTask({ stage: 'waiting_search', waitingReason: 'search', status: `下一关键词间隔，剩余 ${Math.ceil(gap / 1000)} 秒，可随时停止`, waitingUntil: new Date(until).toISOString() });
            while (Date.now() < until) {
              scheduler.checkStopped();
              await sleep(Math.min(1000, until - Date.now()));
            }
            setTask({ waitingUntil: null, waitingReason: '' });
          }
        }
        summary.status = summary.stopReason ? 'paused' : 'completed';
        publish({ completedAt: store.nowStr() });
        checkpoint({ state: summary.stopReason ? 'paused' : 'completed', stopReason: summary.stopReason, completedAt: store.nowStr(), searchSummary: { ...summary } });
        setTask({ running: false, stage: 'search_done',
          status: summary.stopReason || `搜索结束：完成 ${summary.completed} 个关键词｜新增 ${summary.works} 个作品`,
          detail: '勾选作品后可一键加入采集队列', done: summary.completed, total: opts.keywords.length });
        return { ok: true, runId, keywords: summary.completed, works: summary.works, stopReason: summary.stopReason };
      } finally {
        page.off('response', onResponse);
      }
    } catch (error) {
      const stopped = error instanceof TaskStopError || taskState.stopRequested;
      summary.status = stopped ? 'paused' : 'error';
      summary.stopReason = error.message;
      publish({ completedAt: store.nowStr() });
      store.log(accountId, '搜索停止：' + error.message);
      setTask({ running: false, stage: 'search_paused', status: '搜索已暂停：' + error.message });
      checkpoint({ state: stopped ? 'paused' : 'error', stopReason: error.message, searchSummary: { ...summary } });
      return { ok: false, runId, error: error.message };
    }
  }
  return { searchTask };
}
module.exports = { createSearchTasks, normalizeSearchInput };
