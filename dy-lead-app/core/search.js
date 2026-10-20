'use strict';
/**
 * 核心流程 · ① 关键词搜索
 *
 * 动作：打开 https://www.douyin.com/search/<关键词>（综合；type=video|note 为视频/图文页签）
 * 等待的响应（2026-10-20/21 实测）：
 *   第 1 页  GET /aweme/v1/web/general/search/stream/  offset=0  count=10   分块流式，多段 JSON
 *   第 2 页起 GET /aweme/v1/web/general/search/single/  offset=10,20…        页面滚动或空闲时自动请求
 *   每条结果 data[].aweme_info：aweme_id、desc、aweme_type(68=图文)、statistics.comment_count、author.sec_uid
 * 成功判定：收到 offset=0 的响应且 works>0；翻到第 N 页 = 收到 offset=(N-1)*10 的响应，或 has_more=0。
 * 验证判定：status_code=0 但 0 条作品，同时页面出现验证弹层 → 人工验证后重新打开搜索页。
 */
const searchActions = require('../lib/search-browser-actions'); // 已绑定 lib/selectors.js 的 SEARCH 规则

const pause = (page, min, max) => page.waitForTimeout(min + Math.round(Math.random() * (max - min)));

async function searchKeyword(session, keyword, { pages = 2, workType = 'mixed', waitMs = 10000, firstPageWaitMs = 40000 } = {}) {
  const { page, trace } = session;
  const works = new Map();
  const offsets = new Set();
  let hasMore = true, lastEventAt = 0, emptyFirstPage = false;
  const off = session.on(event => {
    if (event.type !== 'search' || event.keyword && event.keyword !== keyword) return;
    lastEventAt = Date.now();
    offsets.add(event.offset);
    if (event.offset === 0 && event.ok && !event.works.length) emptyFirstPage = true;
    for (const work of event.works) if (!works.has(work.awemeId)) works.set(work.awemeId, { ...work, keyword, page: Math.floor(event.offset / 10) + 1 });
    if (event.ok) hasMore = event.hasMore;
  });
  const type = workType === 'video' || workType === 'note' ? `?type=${workType}` : '';
  const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}${type}`;
  const waitFor = async (condition, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (condition()) return true; await page.waitForTimeout(250); }
    return condition();
  };
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      trace.step('search.open', { keyword, workType, url, attempt });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // 实测：第一页流式响应可能先回一份 0 条的空结果（status_code=0），约 30 秒后页面再自动重取到真结果。
      // 所以第一页要等到“有作品”为止，空响应不等于没有结果。
      await waitFor(() => works.size > 0, firstPageWaitMs);
      const verifying = await session.verificationShown();
      if (offsets.has(0) && works.size && !verifying) break;
      trace.step('search.first_page_missing', { gotFirstPage: offsets.has(0), works: works.size, emptyFirstPage, verificationShown: verifying });
      if (!verifying && attempt === 2) return { keyword, ok: false, reason: offsets.has(0) ? '第一页两次为空（可能真无结果或被限流）' : '未收到第一页搜索响应', works: [] };
      if (!verifying) { await pause(page, 20000, 30000); offsets.clear(); continue; }
      if (!await session.waitForHumanVerification()) return { keyword, ok: false, reason: '安全验证未完成', works: [] };
      offsets.clear(); works.clear(); emptyFirstPage = false;
    }
    // 第 2 页起：先给页面自己预加载的机会，没有再滚动结果列表触发
    for (let pageNo = 2; pageNo <= pages && hasMore; pageNo++) {
      const offset = (pageNo - 1) * 10;
      if (!offsets.has(offset)) {
        await pause(page, 1500, 3000);
        if (!offsets.has(offset)) {
          const scrolled = await page.evaluate(searchActions.scrollSearchFeed, 1400).catch(error => ({ error: error.message }));
          trace.step('search.scroll', { pageNo, scrolled });
        }
        await waitFor(() => offsets.has(offset) || !hasMore, waitMs);
      }
      trace.step('search.page', { pageNo, received: offsets.has(offset), hasMore, totalWorks: works.size });
      if (!offsets.has(offset)) break;
    }
    const list = [...works.values()];
    trace.step('search.done', { keyword, works: list.length, pages: [...offsets].sort((a, b) => a - b).map(o => o / 10 + 1) });
    return { keyword, ok: true, works: list };
  } finally { off(); }
}

module.exports = { searchKeyword };
