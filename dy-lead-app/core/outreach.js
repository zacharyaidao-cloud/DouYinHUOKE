'use strict';
/**
 * 核心流程 · ④ 关注 + 私信（单账号，逐个用户）
 *
 * 每个用户：
 *   a. 打开主页 https://www.douyin.com/user/<sec_uid>，等 GET /aweme/v1/web/user/profile/other/ 响应，
 *      取 user.follow_status（0 未关注 / 1 已关注 / 2 互关）。
 *   b. 关注（需要时）：点主页资料区唯一的“关注”按钮；成功只认本次 POST /aweme/v1/web/commit/follow/user/
 *      返回 status_code=0 且 follow_status=1/2（lib/action-receipts）。按钮变化不算成功。
 *   c. 私信：点主页资料区“私信” → 等聊天层 → 核对接收人（协议会话标识优先，昵称后备）→ 填写 → 发送；
 *      成功只认本次发送请求匹配的协议回执（lib/action-receipts + lib/dm-protocol）；
 *      没有可靠回执 = pending（待核验，禁止自动重发）。
 *   d. 每个动作之后检查平台反馈：验证码 / 操作频繁 / 今日上限 → 立即停止整个任务（账号级事件）。
 * 节奏：用户之间 25–40 秒；每成功私信 5 人休息 90–180 秒。
 * 页面定位与回执解析全部复用已验证的 lib 模块，本文件只负责编排与记录。
 */
const crypto = require('node:crypto');
const adapter = require('../lib/outreach-browser');
const { createFollowReceiptObserver, createDmReceiptObserver } = require('../lib/action-receipts');
const { readPageHealth } = require('../lib/browser-actions');
const { follow: followUser } = require('./follow');
const { DEFAULT_PACING, between } = require('./pacing');

const pause = (page, min, max) => page.waitForTimeout(min + Math.round(Math.random() * (max - min)));
const ACCOUNT_STOP = { verification: '平台要求安全验证', restricted: '平台提示操作频繁或功能受限', daily_limit: '平台提示今日次数已达上限', login: '登录已失效' };

async function platformState(page) {
  const health = await page.evaluate(readPageHealth).catch(() => 'unknown');
  return ACCOUNT_STOP[health] ? { stop: true, code: health, reason: ACCOUNT_STOP[health] } : { stop: false, code: health };
}

async function outreachOneUnsafe(session, target, { follow, dm, message }) {
  const { page, trace } = session;
  const lead = { uid: target.secUid, UID: target.uid, nickname: target.nickname };
  const options = { checkStopped() {}, async beforeUiAction() {} };
  const result = { nickname: target.nickname, secUid: target.secUid, follow: null, dm: null, stop: null };

  // a. 主页
  let profile = null;
  const off = session.on(event => { if (event.type === 'profileOther' && event.body?.user?.sec_uid === target.secUid) profile = event.body.user; });
  try {
    trace.step('outreach.open_profile', { nickname: target.nickname });
    await page.goto(`https://www.douyin.com/user/${encodeURIComponent(target.secUid)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const until = Date.now() + 10000;
    while (!profile && Date.now() < until) await page.waitForTimeout(250);
  } finally { off(); }
  trace.step('outreach.profile', { received: !!profile, follow_status: profile?.follow_status, follower_status: profile?.follower_status });
  let platform = await platformState(page);
  if (platform.stop) { result.stop = platform; return result; }
  if (!profile) { result.follow = result.dm = { state: 'skipped', reason: '未收到目标主页资料响应' }; return result; }

  // b. 关注（本次运行中已关注过的人不再重复点关注：实测频繁期间关注会被静默撤销，反复关注同一人只会加重风控）
  if (follow && !target.skipFollow) {
    if ([1, 2].includes(profile.follow_status)) result.follow = { state: 'already', reason: '主页响应显示已关注' };
    else result.follow = await followUser(page, target, trace);
    trace.step('outreach.follow', result.follow);
    platform = await platformState(page);
    if (platform.stop) { result.stop = platform; return result; }
  }

  // c. 私信
  if (dm) {
    const openConversation = async () => {
      const opened = await adapter.openDirectMessage(page, lead, options).catch(error => { trace.step('outreach.dm_error', { stage: 'open', message: error.message }); return false; });
      if (!opened) return { stage: 'entry', diagnostic: adapter.getDiagnostic(page) };
      const ready = await adapter.ensureDirectMessageConversation(page, lead, options).catch(error => { trace.step('outreach.dm_error', { stage: 'conversation', message: error.message }); return false; });
      return ready ? null : { stage: 'conversation', diagnostic: adapter.getDiagnostic(page) };
    };
    let failed = await openConversation();
    // 首次联系“只出会话列表”（2026-10-21 实测）：conversation/create 已成功但聊天层没打开；会话建好后再打开就和老会话一样正常。
    // 重新加载主页、稍候再点一次私信（只重试一次；不涉及发送，不会重复发消息）。
    if (failed && failed.stage === 'conversation' && ['DM_MESSAGE_LIST_ONLY', 'DM_TARGET_CHAT_NOT_READY'].includes(failed.diagnostic?.code)) {
      trace.step('outreach.dm_reopen', { code: failed.diagnostic.code });
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(3000 + Math.round(Math.random() * 2000));
      await page.goto(`https://www.douyin.com/user/${encodeURIComponent(target.secUid)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(4000);
      platform = await platformState(page);
      if (platform.stop) { result.stop = platform; return result; }
      failed = await openConversation();
      if (!failed) trace.step('outreach.dm_reopen_ok', {});
    }
    if (failed) { result.dm = { state: 'not_sent', ...failed }; trace.step('outreach.dm', result.dm); return result; }
    trace.step('outreach.dm_conversation', { recipient: adapter.getDiagnostic(page).recipientEvidence || '' });
    const history = await adapter.readDirectMessageHistory(page, lead, options).catch(() => null);
    if (history?.restriction) {
      result.dm = { state: 'refused', reason: history.restriction.reason, code: history.restriction.code, scope: history.restriction.failureScope };
      if (history.restriction.failureScope === 'account') result.stop = { stop: true, code: history.restriction.code, reason: history.restriction.reason };
      trace.step('outreach.dm', result.dm); return result;
    }
    if (history?.history?.state === 'already_sent') { result.dm = { state: 'skipped', reason: '聊天里已有本账号发出的消息' }; trace.step('outreach.dm', result.dm); return result; }
    const filled = await adapter.fillDirectMessage(page, lead, message, options).catch(() => false);
    if (!filled) { result.dm = { state: 'not_sent', stage: 'fill', diagnostic: adapter.getDiagnostic(page) }; trace.step('outreach.dm', result.dm); return result; }
    const prepared = await adapter.prepareSend(page, lead, message, options).catch(error => ({ state: 'error', reason: error.message.split(String.fromCharCode(10))[0] }));
    if (prepared.state !== 'ready') { result.dm = { state: 'not_sent', stage: 'send', reason: prepared.reason, code: prepared.code }; trace.step('outreach.dm', result.dm); return result; }
    const receipt = createDmReceiptObserver({ page, targetUid: target.secUid, targetSecUid: target.secUid, targetNumericUid: target.uid });
    receipt.arm({ message, attemptId: crypto.randomUUID() });
    try {
      await prepared.click();
      await receipt.waitForReceipt({ timeoutMs: 30000 });
      result.dm = { ...receipt.getOutcome(), protocol: receipt.getReceiptSummary() };
      // 回执本身就是账号级拒绝（频繁 / 今日上限）→ 立即停止整个任务。
      // 2026-10-21 实测：第 12 条起回执 send=3、check=2（私信操作频繁），旧逻辑漏判继续发了 4 次。
      if (result.dm.failureScope === 'account') result.stop = { stop: true, code: result.dm.failureCode || 'DM_ACCOUNT_LIMIT', reason: result.dm.reason };
      const feedback = await prepared.readFeedback().catch(() => null);
      if (feedback?.restriction) {
        result.dm.restriction = feedback.restriction;
        if (feedback.restriction.failureScope === 'account') result.stop = { stop: true, code: feedback.restriction.code, reason: feedback.restriction.reason };
      }
    } catch (error) { result.dm = { state: 'pending_verification', reason: '点击发送后出现异常，需人工核验：' + error.message }; }
    finally { receipt.dispose(); }
    trace.step('outreach.dm', { state: result.dm.state, reason: result.dm.reason, failureScope: result.dm.failureScope, restriction: result.dm.restriction?.code });
    if (!result.stop) { platform = await platformState(page); if (platform.stop) result.stop = platform; }
  }
  return result;
}

async function outreachOne(session, target, options) {
  try { return await outreachOneUnsafe(session, target, options); }
  catch (error) {
    session.trace.step('outreach.user_error', { nickname: target.nickname, message: error.message.split(String.fromCharCode(10))[0] });
    return { nickname: target.nickname, secUid: target.secUid, follow: null, dm: { state: 'not_sent', stage: 'error', reason: error.message.split(String.fromCharCode(10))[0] }, stop: null };
  }
}

async function outreachList(session, targets, { follow = true, dm = true, message, pacing = DEFAULT_PACING.outreach, onResult = () => {} } = {}) {
  const { page, trace } = session;
  const results = [];
  const acting = state => ['confirmed_success', 'confirmed_failure', 'pending_verification'].includes(state);
  let sent = 0;
  for (let index = 0; index < targets.length; index++) {
    // 只有上一位真的做了动作（点了关注或尝试发送）才等用户间隔；全部跳过的用户不占间隔
    const previous = results[results.length - 1];
    if (previous && (acting(previous.follow?.state) || acting(previous.dm?.state))) await between(page, pacing.betweenUsers);
    if (sent && pacing.restEvery && sent % pacing.restEvery === 0 && previous?.dm?.state === 'confirmed_success') {
      trace.step('outreach.rest', { afterSent: sent }); await between(page, pacing.rest);
    }
    const result = await outreachOne(session, targets[index], { follow, dm, message });
    if (result.dm?.state === 'confirmed_success') sent++;
    result.index = index + 1; results.push(result); onResult(result, results);
    trace.step('outreach.user_done', { index: index + 1, nickname: result.nickname, follow: result.follow?.state, dm: result.dm?.state, stop: result.stop?.code || '' , sentSoFar: sent });
    if (result.stop) { trace.step('outreach.stop', { atUser: index + 1, sentSoFar: sent, ...result.stop }); break; }
  }
  return results;
}

module.exports = { outreachList, outreachOne };
