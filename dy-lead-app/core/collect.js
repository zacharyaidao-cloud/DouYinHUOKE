'use strict';
/**
 * 核心流程 · ② 作品评论采集（视频 / 图文同一套流程）
 *
 * 动作与应收到的响应（2026-10-20/21 实测）：
 *   a. 打开 https://www.douyin.com/<video|note>/<id>
 *   b. 读页面内嵌的第一页评论（self.__pace_f 中 comment:{statusCode,hasMore,total,cursor,comments}）。
 *      图文直接打开时第一页只在这里；内嵌数据随页面流式到达，读不到时每秒重读，最多 6 次。视频没有内嵌评论。
 *   c. 还有更多时打开评论区：
 *      - 图文右侧默认停在“相关推荐”，评论页签是普通 div（文字“评论(173)”），页面加载几秒后才出现 → 最多等 10 秒重试；
 *      - 视频评论区默认展开。
 *      打开后可见列表为 data-e2e="comment-list"（可滚动）；把它滚到底，页面请求下一页。
 *   d. 页面里可能同时有两条评论列表：
 *      - 后台预取列表：comment/list 不带 insert_ids（图文未打开评论时也会自动请求 cursor=20、40…，has_more 时有时无，不可靠）；
 *      - 可见列表：点开评论页签后请求的 comment/list 带 insert_ids，从 cursor=0 开始，每页 10 条，随滚动推进。
 *      两条列表的评论都收（按 cid 去重）；**完成与否只看“我们的滚动所推动的列表”**。
 * 完成判定（任一）：
 *   ① 滚动所推动的列表（滚动后最近一次响应所属的列表）返回 has_more=0；
 *   ② 页面所有出现过的列表都返回过 has_more=0（含内嵌第一页 hasMore=false 且没有出现其他列表）；
 *   ③ 可见评论列表里出现“暂时没有更多评论”，且本轮滚动没有新的评论响应。
 * 第一页缺失：最早收到的不带 insert_ids 的页 cursor>0、又没读到内嵌第一页，且没有从 cursor=0 开始的可见列表 → 记 partial。
 * 未完成：连续 3 轮无新评论且无结束标记 → interrupted；达到轮数上限 → partial。
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
    replyCount: comment.reply_comment_total ?? null, isAuthor: [1, '1'].includes(comment.label_type) || (!!user.sec_uid && user.sec_uid === work.authorUid),
    user: { uid: String(user.uid || ''), secUid: user.sec_uid || '', nickname: user.nickname || '' }
  };
}

// 只认“可见的”评论列表里的结束文字；隐藏的相关推荐页签下也挂着一份评论列表与结束文字。
function visibleEndMarker() {
  const lists = Array.from(document.querySelectorAll('[data-e2e="comment-list"]')).filter(list => list.getClientRects().length > 0);
  return lists.some(list => Array.from(list.querySelectorAll('div,span,p')).some(element => element.childElementCount === 0
    && /^暂时没有更多评论$/.test((element.textContent || '').trim()) && element.getClientRects().length > 0));
}
function visibleCommentList() {
  return Array.from(document.querySelectorAll('[data-e2e="comment-list"]')).some(list => list.getClientRects().length > 0 && list.clientHeight > 50);
}

async function collectWork(session, work, { maxRounds = 40, roundWaitMs = 8000 } = {}) {
  const { page, trace } = session;
  const comments = new Map();
  const sources = new Map(); // 'main' | 'insert' → { hasMore, minCursor, pages }
  let lastSource = null, apiPages = 0, embeddedRead = false;
  const sourceOf = name => { if (!sources.has(name)) sources.set(name, { hasMore: null, minCursor: null, pages: 0 }); return sources.get(name); };
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
    const name = event.insertIds ? 'insert' : 'main', source = sourceOf(name);
    apiPages++; source.pages++; lastSource = name;
    if ([0, 1, '0', '1'].includes(body.has_more)) source.hasMore = Number(body.has_more);
    source.minCursor = source.minCursor === null ? event.requestCursor : Math.min(source.minCursor, event.requestCursor);
    const added = add(Array.isArray(body.comments) ? body.comments : [], 'api:' + name);
    trace.step('collect.page', { list: name, requestCursor: event.requestCursor, added, has_more: body.has_more, total: body.total });
  });
  const allEnded = () => sources.size > 0 && [...sources.values()].every(source => source.hasMore === 0);
  const url = `https://www.douyin.com/${work.workType === 'note' ? 'note' : 'video'}/${work.awemeId}`;
  let state = 'partial', reason = '';
  const readEmbedded = async () => {
    let result = { ok: false, reason: 'not_read' };
    for (let attempt = 0; attempt < 6; attempt++) {
      result = await page.evaluate(readPageComments, work.awemeId).catch(error => ({ ok: false, reason: error.message }));
      if (result.ok || result.reason !== 'no_embedded_comments' || work.workType !== 'note') break;
      await page.waitForTimeout(1000);
    }
    return result;
  };
  try {
    trace.step('collect.open', { awemeId: work.awemeId, type: work.workType, url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pause(page, 1200, 2000);
    if (await session.verificationShown()) {
      if (!await session.waitForHumanVerification()) return { work, state: 'interrupted', reason: '安全验证未完成', comments: [...comments.values()] };
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    const embedded = await readEmbedded();
    if (embedded.ok) {
      embeddedRead = true;
      const main = sourceOf('main');
      main.hasMore = main.hasMore === null ? embedded.payload.has_more : main.hasMore;
      main.minCursor = 0;
      trace.step('collect.embedded', { added: add(embedded.payload.comments, 'embedded'), has_more: embedded.payload.has_more, total: embedded.payload.total });
    } else trace.step('collect.embedded_missing', { reason: embedded.reason });

    const done = () => allEnded() || (lastSource && sources.get(lastSource).hasMore === 0 && sources.get(lastSource).pages > 0 && lastSource === 'insert');
    if (!(embeddedRead && sources.get('main').hasMore === 0 && sources.size === 1)) {
      // 打开评论区：页签几秒后才渲染，最多等 10 秒
      let panel = { state: 'missing' };
      for (let attempt = 0; attempt < 10; attempt++) {
        panel = await page.evaluate(openComments).catch(error => ({ state: 'error', error: error.message }));
        if (['opened', 'ready'].includes(panel.state) && (panel.state === 'ready' || await page.waitForTimeout(1500).then(() => page.evaluate(visibleCommentList)))) break;
        await page.waitForTimeout(1000);
      }
      trace.step('collect.open_comments', { ...panel, visibleList: await page.evaluate(visibleCommentList).catch(() => false) });
      await pause(page, 1200, 2000);
      let idle = 0;
      for (let round = 1; round <= maxRounds; round++) {
        if (done()) break;
        const before = comments.size, pagesBefore = apiPages;
        const scrolled = await page.evaluate(scrollComments).catch(error => ({ state: 'error', error: error.message }));
        const until = Date.now() + roundWaitMs;
        while (Date.now() < until && apiPages === pagesBefore) await page.waitForTimeout(250);
        const ended = await page.evaluate(visibleEndMarker).catch(() => false);
        idle = comments.size === before && apiPages === pagesBefore ? idle + 1 : 0;
        trace.step('collect.round', { round, scroll: scrolled.state, newComments: comments.size - before, apiPages, lastList: lastSource,
          lists: Object.fromEntries([...sources].map(([name, source]) => [name, source.hasMore])), endMarker: ended });
        if (done()) break;
        if (ended && apiPages === pagesBefore) { state = 'complete'; reason = '可见评论列表显示“暂时没有更多评论”'; break; }
        if (idle >= 3) { state = 'interrupted'; reason = '连续 3 轮无新评论且无结束标记'; break; }
        await pause(page, 1800, 3500);
      }
    }
    const main = sources.get('main'), insert = sources.get('insert');
    const firstPageMissing = !embeddedRead && main && main.minCursor > 0 && !(insert && insert.minCursor === 0);
    if (done()) { state = firstPageMissing ? 'partial' : 'complete'; reason = firstPageMissing ? `第一页缺失（最早收到的评论页游标为 ${main.minCursor}）` : allEnded() ? '所有评论列表都返回 has_more=0' : '可见评论列表返回 has_more=0'; }
    else if (state !== 'complete' && !reason) reason = `达到 ${maxRounds} 轮上限`;
  } catch (error) {
    state = 'interrupted'; reason = error.message;
  } finally { off(); }
  const list = [...comments.values()];
  trace.step('collect.done', { awemeId: work.awemeId, state, reason, comments: list.length, apiPages,
    lists: Object.fromEntries([...sources].map(([name, source]) => [name, { hasMore: source.hasMore, pages: source.pages, minCursor: source.minCursor }])) });
  return { work, state, reason, comments: list };
}

module.exports = { collectWork };
