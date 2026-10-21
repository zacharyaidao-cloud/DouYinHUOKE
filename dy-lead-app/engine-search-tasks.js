'use strict';
const crypto = require('node:crypto');
const { TaskStopError } = require('./scheduler');
const { SEARCH_PATH, parseSearchBody } = require('./lib/search-works');
const browserSearch = require('./lib/search-browser-actions');
const { Session } = require('./core/session');
const { searchKeyword, filterWorks } = require('./core/search');
const { mergePacing } = require('./core/pacing');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeSearchInput(input, settings) {
  const keywords = (Array.isArray(input && input.keywords) ? input.keywords : String(input && input.keywords || '').split('\n'))
    .map(k => String(k).trim()).filter(Boolean).slice(0, 50);
  if (!keywords.length) throw new Error('请至少输入一个搜索关键词');
  const workType = ['video', 'note', 'mixed'].includes(input && input.workType) ? input.workType : 'video';
  const search = settings.search || {};
  const maxPages = Math.min(50, Math.max(1, Number(input && input.maxPages) || Number(search.maxPages) || 20));
  const minCommentCount = Math.max(0, Number(input && input.minCommentCount) || Number(search.minCommentCount) || 0);
  // 只采最近 N 天发布的作品（0=不限）；界面未传时用设置值，默认 30 天
  const days = input && input.publishedWithinDays != null && input.publishedWithinDays !== '' ? Number(input.publishedWithinDays) : Number(search.publishedWithinDays ?? 30);
  const publishedWithinDays = Number.isFinite(days) && days > 0 ? Math.min(3650, days) : 0;
  return { keywords, workType, maxPages, minCommentCount, publishedWithinDays };
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
  await waitFor(() => page.evaluate(browserSearch.hasSearchTab, tabLabel).catch(() => false), { timeoutMs: 5000, scheduler });
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
      // 搜索动作与响应解析统一走核心流程 core/search.js（实测规格见 使用文档/正确流程规格）。
      const session = Session.attach(page, { step: (name, data) => store.log(accountId, '搜索：' + name + ' ' + JSON.stringify(data || {})), response() {} });
      const pacing = mergePacing({}).search;
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
          setTask({ stage: 'searching', status: `正在搜索「${keyword}」（${keywordIndex + 1}/${opts.keywords.length}）`,
            detail: `已搜索 ${summary.completed} 个关键词｜累计新增 ${summary.works} 个作品`, done: keywordIndex, total: opts.keywords.length });
          store.bumpDaily(accountId, 'searchAttempts');
          // 授权与停止检查（不发生页面动作）
          await scheduler.prepare({ accountId, kind: 'ui', uid: '' }, async () => {});
          const result = await searchKeyword(session, keyword, { pages: opts.maxPages, workType: opts.workType, pacing,
            checkStopped: () => scheduler.checkStopped(),
            onPage: ({ pageNo, works }) => {
              publish({ pages: pageNo });
              setTask({ status: `正在搜索「${keyword}」第 ${pageNo}/${opts.maxPages} 页，已读 ${works} 个作品`, done: keywordIndex, total: opts.keywords.length });
            } });
          scheduler.checkStopped();
          if (!result.ok) {
            store.log(accountId, `关键词搜索：${keyword} 未取得结果：${result.reason}`);
            if (/安全验证/.test(result.reason)) throw new TaskStopError('抖音要求安全验证，请在账号窗口人工完成验证', 'PLATFORM_VERIFICATION');
          }
          // 视频/图文范围只保留同类型；再按发布时间与评论数提前筛选，旧作品与评论少的不进入采集
          const typed = (result.works || []).filter(work => !(opts.workType === 'video' || opts.workType === 'note') || work.workType === opts.workType);
          const { kept, dropped } = filterWorks(typed, { publishedWithinDays: opts.publishedWithinDays, minComments: opts.minCommentCount });
          const added = store.addSearchResults(keyword, opts.workType, kept);
          if (result.ok || typed.length) store.recordKeywordSearch(keyword, { works: typed, kept, added, pages: result.pages || 0, workType: opts.workType,
            publishedWithinDays: opts.publishedWithinDays, minComments: opts.minCommentCount, stopReason: result.stopReason || result.reason || '' });
          summary.works += added;
          keywordIndex++;
          summary.completed = keywordIndex;
          publish({ works: summary.works, completed: keywordIndex });
          store.log(accountId, `关键词搜索：${keyword}（${opts.workType}）翻 ${result.pages || 0} 页（${result.stopReason || result.reason || '完成'}），读到 ${typed.length} 个作品；` +
            `筛掉发布超过 ${opts.publishedWithinDays || '不限'} 天 ${dropped.old} 个、评论少于 ${opts.minCommentCount} 的 ${dropped.fewComments} 个、无发布时间 ${dropped.noTime} 个；新增 ${added} 个`);
          checkpoint({ processedKeywords: [...(taskState.checkpoint?.processedKeywords || []), keyword], state: 'running' });
          if (keywordIndex < opts.keywords.length) {
            const base = Math.max(5, Number(settings.search.intervalSec) || 20);
            const jitter = Math.min(1, Math.max(0, Number(settings.search.intervalJitter) || 0.3));
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
        session.detach();
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
// navigateSearch 也供 build-tools/smoke-real.js 实网冒烟复用同一段搜索动作。
module.exports = { createSearchTasks, normalizeSearchInput, navigateSearch };
