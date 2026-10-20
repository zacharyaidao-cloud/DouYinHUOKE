'use strict';
/**
 * 核心流程 · 关注（2026-10-21 实测后重写）
 *
 * 实测事实：
 *   - 点击主页“关注”按钮 → POST /aweme/v1/web/commit/follow/user/，表单字段 type=1、user_id=<数字UID>；
 *     响应 status_code=0、follow_status=1（互关为 2）即关注成功。
 *   - 旧适配器先把按钮记成一长串 nth-child 路径，再在 500 毫秒内重新定位；主页在此期间会重绘，
 *     导致“定位出错”；点中时其回执匹配规则又与当前请求格式对不上，成功也被记成“待核验”。
 * 新做法：
 *   1. 点击前现找：主页资料区 data-e2e="user-info-follow-btn"，可见且文字恰为“关注/回关”的唯一一个；
 *      文字为“已关注/互相关注”→ 已关注，不点。
 *   2. 只点一次（Playwright 原生点击，自动等待可点击）。
 *   3. 成功只认点击后 10 秒内、本页发出的 commit/follow/user 请求（type=1 且 user_id 等于目标数字 UID，
 *      目标 UID 未知时只要求 type=1）的响应：status_code=0 且 follow_status∈{1,2}。
 *      收到 status_code≠0 → 失败并带回平台文案；没收到 → pending（待核验，禁止自动重试）。
 */
const { OUTREACH } = require('../lib/selectors');

const FOLLOW_PATH = '/aweme/v1/web/commit/follow/user/';
const followLabel = new RegExp(OUTREACH.profile.followLabel.join('|'));
const followedLabel = new RegExp(OUTREACH.profile.followedLabel.join('|'));

async function follow(page, target, trace, { timeoutMs = 10000 } = {}) {
  const buttons = page.locator(OUTREACH.profile.followMarker.join(','));
  const visible = [];
  for (let index = 0; index < await buttons.count(); index++) {
    const button = buttons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    visible.push({ button, text: ((await button.innerText().catch(() => '')) || '').replace(/\s+/g, '') });
  }
  trace.step('follow.locate', { candidates: visible.map(item => item.text) });
  if (visible.some(item => followedLabel.test(item.text))) return { state: 'already', reason: '主页按钮显示已关注' };
  const clickable = visible.filter(item => followLabel.test(item.text));
  if (clickable.length !== 1) return { state: 'not_clicked', reason: clickable.length ? '主页有多个关注按钮，无法唯一确定' : '主页没有可点击的关注按钮' };

  let settle;
  const outcome = new Promise(resolve => { settle = resolve; });
  const pending = new Set();
  const onRequest = request => {
    try {
      const url = new URL(request.url());
      if (url.pathname !== FOLLOW_PATH || request.method() !== 'POST') return;
      const body = new URLSearchParams(request.postData() || '');
      if (body.get('type') !== '1') return;
      if (target.uid && body.get('user_id') && body.get('user_id') !== String(target.uid)) {
        trace.step('follow.request_other_user', {}); return;
      }
      pending.add(request);
    } catch (_) { /* 非目标请求 */ }
  };
  const onResponse = async response => {
    if (!pending.has(response.request())) return;
    const json = await response.json().catch(() => null);
    // 记录响应体字段名与身份字段是否指向目标（不记取值），用来核对旧回执匹配规则为何对不上
    if (json && typeof json === 'object') trace.step('follow.response_shape', { keys: Object.keys(json).slice(0, 20),
      userIdIsTarget: json.user_id === undefined ? 'absent' : String(json.user_id) === String(target.uid),
      secUserIdIsTarget: json.sec_user_id === undefined ? 'absent' : json.sec_user_id === target.secUid });
    if (json && json.status_code === 0 && [1, 2].includes(json.follow_status)) settle({ state: 'confirmed_success', evidence: `commit/follow/user status_code=0 follow_status=${json.follow_status}` });
    // follow_status=4：对方为私密账号，已发出关注请求（实测）
    else if (json && json.status_code === 0 && json.follow_status === 4) settle({ state: 'requested', reason: '对方为私密账号，已发出关注请求', evidence: 'commit/follow/user status_code=0 follow_status=4' });
    else settle({ state: 'confirmed_failure', reason: (json && (json.status_msg || `status_code=${json.status_code} follow_status=${json.follow_status}`)) || `HTTP ${response.status()}`, statusCode: json?.status_code, followStatus: json?.follow_status });
  };
  page.on('request', onRequest); page.on('response', onResponse);
  const timer = setTimeout(() => settle({ state: 'pending_verification', reason: '点击后未收到关注接口回执，需人工核验，禁止自动重试' }), timeoutMs);
  try {
    await clickable[0].button.click({ timeout: 5000 });
  } catch (error) {
    clearTimeout(timer); page.off('request', onRequest); page.off('response', onResponse);
    return { state: 'not_clicked', reason: '关注按钮无法点击：' + String(error.message).split(String.fromCharCode(10))[0] };
  }
  const result = await outcome;
  clearTimeout(timer); page.off('request', onRequest); page.off('response', onResponse);
  return result;
}

module.exports = { follow, FOLLOW_PATH };
