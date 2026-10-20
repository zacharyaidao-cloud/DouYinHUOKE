'use strict';
/**
 * 核心流程 · ② 作品评论采集（视频 / 图文同一套流程）
 *
 * 动作与应收到的响应（2026-10-20/21 实测）：
 *   a. 打开 https://www.douyin.com/<video|note>/<id>
 *   b. 读页面内嵌的第一页评论：self.__pace_f 中的 comment:{statusCode,hasMore,total,cursor,comments:[…]}
 *      —— 图文直接打开时第一页评论只在这里，页面不会再请求 comment/list。
 *   c. 若内嵌 hasMore=1（或没有内嵌数据）：点开“评论”页签（图文默认停在“相关推荐”），
 *      再把评论列表滚到底，页面自己请求 GET /aweme/v1/web/comment/list/?aweme_id=<id>&cursor=<n>。
 *   d. 每页响应：status_code=0、comments[]、has_more、cursor、total。
 * 完成判定（满足任一）：
 *   - 主列表（不带 insert_ids 的请求）返回 has_more=0；
 *   - 内嵌第一页 hasMore=false；
 *   - 评论区出现“暂时没有更多评论”且最近一轮没有新响应（页面已无可加载内容）。
 * 未完成：连续 3 轮无新评论且无结束标记 → 记 interrupted；达到轮数上限 → partial。
 * 只收一级评论；去重键 = cid。
 */
const { openComments, scrollComments } = require('../lib/collection-browser');
const { readPageComments } = require('../lib/page-comments');

const pause = (page, min, max) => page.waitForTimeout(min + Math.round(Math.random() * (max - min)));

function normalize(comment, work) {
  const user = comment.user || {};
  return {
    awemeId: work.awemeId, workType: work.workType, workDesc: (work.desc || '').slice(0, 120),
    cid: String(comment.cid || ''), text: typeof comment.text === 'string' ? comment.text.trim() : '',
    createTime: Number(comment.create_time) || null, ipLabel: comment.ip_label || '', diggCount: comment.digg_count ?? null,
    replyCount: comment.reply_comment_total ?? null, isAuthor: [1, '1'].includes(comment.label_type) || (user.sec_uid && user.sec_uid === work.authorUid),
    user: { uid: String(user.uid || ''), secUid: user.sec_uid || '', nickname: user.nickname || '' }
  };
}

function endMarkerShown() {
  return Array.from(document.querySelectorAll('div,span,p')).some(element => element.childElementCount === 0
    && /^暂时没有更多评论$/.test((element.textContent || '').trim()) && element.getClientRects().length > 0);
}

async function collectWork(session, work, { maxRounds = 30, roundWaitMs = 8000 } = {}) {
  const { page, trace } = session;
  const comments = new Map();
  let primaryHasMore = null, apiPages = 0, lastApiAt = 0, embeddedRead = false, minPrimaryCursor = null;
  const add = (list, origin) => {
    let added = 0;
    for (const raw of list || []) {
      if (![1, '1', undefined, null].includes(raw.level)) continue; // 只要一级评论
      const item = normalize(raw, work);
      if (!item.cid || !item.user.secUid || comments.has(item.cid)) continue;
      comments.set(item.cid, { ...item, origin });
      added++;
    }
    return added;
  };
  const off = session.on(event => {
    if (event.type !== 'comments' || event.awemeId !== work.awemeId) return;
    const body = event.body;
    if (event.status !== 200 || !body || ![0, '0'].includes(body.status_code)) { trace.step('collect.response_rejected', { status: event.status, status_code: body?.status_code }); return; }
    apiPages++; lastApiAt = Date.now();
    const added = add(Array.isArray(body.comments) ? body.comments : [], 'api');
    if (!event.insertIds && [0, 1, '0', '1'].includes(body.has_more)) primaryHasMore = Number(body.has_more);
    if (!event.insertIds) minPrimaryCursor = minPrimaryCursor === null ? event.requestCursor : Math.min(minPrimaryCursor, event.requestCursor);
    trace.step('collect.page', { requestCursor: event.requestCursor, added, has_more: body.has_more, primaryHasMore, total: body.total });
  });
  const url = `https://www.douyin.com/${work.workType === 'note' ? 'note' : 'video'}/${work.awemeId}`;
  let state = 'partial', reason = '';
  try {
    trace.step('collect.open', { awemeId: work.awemeId, type: work.workType, url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pause(page, 1200, 2000);
    if (await session.verificationShown()) {
      if (!await session.waitForHumanVerification()) return { work, state: 'interrupted', reason: '安全验证未完成', comments: [...comments.values()] };
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    // 内嵌数据随页面流式到达，打开后立刻读可能还没有（实测 2.8 秒时读为空，漏掉第一页 20 条）。
    // 最多重读 6 次、间隔 1 秒；仍没有就按“无内嵌”处理，靠下面的游标连续性兜底。
    const readEmbedded = async () => {
      let result = { ok: false, reason: 'not_read' };
      for (let attempt = 0; attempt < 6; attempt++) {
        result = await page.evaluate(readPageComments, work.awemeId).catch(error => ({ ok: false, reason: error.message }));
        if (result.ok || result.reason !== 'no_embedded_comments') break;
        await page.waitForTimeout(1000);
      }
      return result;
    };
    const embedded = await readEmbedded();
    if (embedded.ok) {
      const added = add(embedded.payload.comments, 'embedded');
      embeddedRead = true;
      if (primaryHasMore === null) primaryHasMore = embedded.payload.has_more;
      trace.step('collect.embedded', { added, has_more: embedded.payload.has_more, total: embedded.payload.total });
    } else trace.step('collect.embedded_missing', { reason: embedded.reason });

    if (primaryHasMore !== 0) {
      const panel = await page.evaluate(openComments).catch(error => ({ state: 'error', error: error.message }));
      trace.step('collect.open_comments', panel);
      await pause(page, 1500, 2500);
      let idle = 0;
      for (let round = 1; round <= maxRounds && primaryHasMore !== 0; round++) {
        const before = comments.size, pagesBefore = apiPages;
        const scrolled = await page.evaluate(scrollComments).catch(error => ({ state: 'error', error: error.message }));
        const until = Date.now() + roundWaitMs;
        while (Date.now() < until && apiPages === pagesBefore && primaryHasMore !== 0) await page.waitForTimeout(250);
        const ended = primaryHasMore === 0 || await page.evaluate(endMarkerShown).catch(() => false);
        idle = comments.size === before && apiPages === pagesBefore ? idle + 1 : 0;
        trace.step('collect.round', { round, scroll: scrolled.state, newComments: comments.size - before, apiPages, primaryHasMore, endMarker: ended && primaryHasMore !== 0 });
        if (primaryHasMore === 0) break;
        if (ended && apiPages === pagesBefore) { state = 'complete'; reason = '评论区显示“暂时没有更多评论”'; break; }
        if (idle >= 3) { state = 'interrupted'; reason = '连续 3 轮无新评论且无结束标记'; break; }
        await pause(page, 1800, 3500);
      }
    }
    // 完整性：主列表最早收到的是 cursor>0 的页，又没读到内嵌第一页 → 第一页漏了，再读一次内嵌数据
    if (minPrimaryCursor !== null && minPrimaryCursor > 0 && !embeddedRead) {
      const retry = await readEmbedded();
      if (retry.ok) { embeddedRead = true; const added = add(retry.payload.comments, 'embedded'); trace.step('collect.embedded_late', { added }); }
    }
    const firstPageMissing = minPrimaryCursor !== null && minPrimaryCursor > 0 && !embeddedRead;
    if (primaryHasMore === 0 && firstPageMissing) { state = 'partial'; reason = `第一页缺失（最早收到的评论页游标为 ${minPrimaryCursor}）`; }
    else if (primaryHasMore === 0) { state = 'complete'; reason = '平台返回 has_more=0'; }
    else if (!reason) reason = `达到 ${maxRounds} 轮上限`;
  } catch (error) {
    state = 'interrupted'; reason = error.message;
  } finally { off(); }
  const list = [...comments.values()];
  trace.step('collect.done', { awemeId: work.awemeId, state, reason, comments: list.length, apiPages });
  return { work, state, reason, comments: list };
}

module.exports = { collectWork };
