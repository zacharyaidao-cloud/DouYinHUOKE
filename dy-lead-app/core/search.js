'use strict';
/**
 * 核心流程 · ① 关键词搜索
 *
 * 动作：打开 https://www.douyin.com/search/<关键词>（综合；type=video|note 为视频/图文页签）
 * 等待的响应（2026-10-20/21 实测）：
 *   第 1 页  GET /aweme/v1/web/general/search/stream/  offset=0  count=10   分块流式，多段 JSON
 *   第 2 页起 GET /aweme/v1/web/general/search/single/  offset=10,20…        页面空闲预取或滚动结果列表触发
 *   每条结果 data[].aweme_info：aweme_id、desc、create_time（发布时间，秒）、aweme_type(68=图文)、
 *   statistics.comment_count、author.sec_uid/nickname
 * 成功判定：第 1 页收到“有作品”的响应；第 N 页 = 收到 offset=(N-1)*10 的响应；has_more=0 提前结束。
 * 空首页：实测会先回 0 条（status_code=0），约 30 秒后页面自动重取到真结果 —— 第一页等到“有作品”为止，
 *        仍为空隔 20–30 秒重开一次；两次都空才判“无结果/被限流”。
 * 翻页：某页 10 秒内没到 → 再滚一次，最多 3 次；仍没到判“翻页停滞”结束本关键词（已得结果保留）。
 * 验证：页面出现验证弹层 → 等人工完成 → 重开搜索页。
 */
const { DEFAULT_PACING, between } = require('./pacing');

async function searchKeyword(session, keyword, { pages = 2, workType = 'mixed', pacing = DEFAULT_PACING.search, checkStopped = () => {}, onPage = () => {} } = {}) {
  const { page, trace } = session;
  const works = new Map();
  const offsets = new Set();
  let hasMore = true;
  const off = session.on(event => {
    if (event.type !== 'search' || event.keyword && event.keyword !== keyword) return;
    offsets.add(event.offset);
    for (const work of event.works) if (!works.has(work.awemeId)) works.set(work.awemeId, { ...work, keyword, page: Math.floor(event.offset / 10) + 1 });
    if (event.ok && event.offset >= Math.max(...offsets)) hasMore = event.hasMore;
  });
  const type = workType === 'video' || workType === 'note' ? `?type=${workType}` : '';
  const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}${type}`;
  const waitFor = async (condition, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { checkStopped(); if (condition()) return true; await page.waitForTimeout(250); }
    return condition();
  };
  let stopReason = '', refreshes = 0;
  // 实测：连续深翻后结果区会显示“服务异常，重新 [刷新] 拉取数据”，不再加载下一页；
  // 真人会点“刷新”，页面随即重新请求当前页。每个关键词最多点 3 次，仍不恢复就结束本关键词。
  const recoverServiceError = async () => {
    const notice = page.getByText(/服务异常/).first();
    if (!await notice.isVisible().catch(() => false)) return false;
    if (refreshes >= 3) { trace.step('search.service_error', { keyword, refreshes, action: '已达刷新上限' }); return false; }
    const button = page.getByText('刷新', { exact: true }).first();
    if (!await button.isVisible().catch(() => false)) { trace.step('search.service_error', { keyword, action: '未找到刷新按钮' }); return false; }
    refreshes++;
    await button.click({ timeout: 5000 }).catch(() => {});
    trace.step('search.service_error_refresh', { keyword, refreshes, receivedPages: offsets.size });
    await page.waitForTimeout(2000);
    return true;
  };
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      trace.step('search.open', { keyword, workType, attempt });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await waitFor(() => works.size > 0, pacing.firstPageWaitMs);
      if (!works.size && await recoverServiceError()) await waitFor(() => works.size > 0, pacing.firstPageWaitMs);
      const verifying = await session.verificationShown();
      if (works.size && !verifying) break;
      trace.step('search.first_page_missing', { gotFirstPage: offsets.has(0), works: works.size, verificationShown: verifying });
      if (verifying) {
        if (!await session.waitForHumanVerification()) return { keyword, ok: false, reason: '安全验证未完成', works: [] };
      } else if (attempt === 2) {
        return { keyword, ok: false, reason: offsets.has(0) ? '第一页两次为空（可能真无结果或被限流）' : '未收到第一页搜索响应', works: [] };
      } else await page.waitForTimeout(20000 + Math.round(Math.random() * 10000));
      offsets.clear(); works.clear(); hasMore = true;
    }
    for (let pageNo = 2; pageNo <= pages; pageNo++) {
      checkStopped();
      onPage({ pageNo: pageNo - 1, works: works.size });
      if (!hasMore) { stopReason = `第 ${pageNo - 1} 页 has_more=0`; break; }
      const offset = (pageNo - 1) * 10;
      for (let tries = 0; tries < 3 && !offsets.has(offset); tries++) {
        if (tries && await recoverServiceError()) { await waitFor(() => offsets.has(offset) || !hasMore, pacing.pageWaitMs); if (offsets.has(offset)) break; }
        await between(page, pacing.betweenPages);
        if (offsets.has(offset)) break;
        // 实测：结果页由文档整体滚动，脚本改 scrollTop 不会触发加载；鼠标停在结果区滚轮才会请求下一页
        await page.mouse.move(640, 520);
        for (let wheel = 0; wheel < 3 && !offsets.has(offset); wheel++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(600); }
        if (tries) trace.step('search.scroll_retry', { pageNo, tries });
        await waitFor(() => offsets.has(offset) || !hasMore, pacing.pageWaitMs);
        if (!offsets.has(offset) && await session.verificationShown()) {
          if (!await session.waitForHumanVerification()) { stopReason = '翻页中出现安全验证且未完成'; break; }
        }
      }
      if (stopReason) break;
      if (!offsets.has(offset)) {
        // 停滞时记录页面末尾的可见文字（如“服务异常”“没有更多了”），便于区分限流还是真到底
        const tail = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(-160)).catch(() => '');
        trace.step('search.stall', { keyword, pageNo, tail });
        stopReason = hasMore ? `第 ${pageNo} 页滚动 3 次仍未到（翻页停滞）` : `第 ${pageNo - 1} 页 has_more=0`; break;
      }
      if (pageNo % 5 === 0) trace.step('search.progress', { keyword, pageNo, works: works.size, hasMore });
    }
    const list = [...works.values()];
    const pagesReceived = [...offsets].length;
    trace.step('search.done', { keyword, works: list.length, pages: pagesReceived, stopReason: stopReason || `达到 ${pages} 页上限` });
    return { keyword, ok: true, works: list, pages: pagesReceived, stopReason };
  } finally { off(); }
}

/**
 * 搜索结果提前筛选：只留“最近 N 天发布”且“评论数 ≥ M”的作品，旧作品与评论少的作品不进入评论采集，
 * 节省访问次数、降低限额压力。发布时间来自搜索响应 aweme_info.create_time。
 */
function filterWorks(works, { publishedWithinDays = 30, minComments = 0, now = Date.now() } = {}) {
  const cutoff = publishedWithinDays > 0 ? now / 1000 - publishedWithinDays * 86400 : 0;
  const kept = [], dropped = { old: 0, fewComments: 0, noTime: 0 };
  for (const work of works) {
    if (Number(work.commentCount) < minComments) { dropped.fewComments++; continue; }
    if (cutoff) {
      if (!work.createTime) { dropped.noTime++; continue; }
      if (work.createTime < cutoff) { dropped.old++; continue; }
    }
    kept.push(work);
  }
  return { kept, dropped };
}

module.exports = { searchKeyword, filterWorks };
