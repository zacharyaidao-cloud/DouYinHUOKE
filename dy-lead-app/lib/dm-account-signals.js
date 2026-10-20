'use strict';
const { classifyCheckMessage } = require('./dm-rejection');

/**
 * 私信账号级信号分类：把任务停止/发送拒绝归类为 频繁 / 今日上限 / 账号异常，
 * 无法归类的按接收人级回退（不换号、不动账号状态）。
 * 文案样本来自真实平台提示；正则仅用于本机分类，不含任何签名或敏感参数。
 */

const ACCOUNT_FREQUENT_PATTERNS = [
  // 不收“稍后再试”这类泛化文案：网络/接收人提示也常带它，会把账号误判为频繁冷却
  /操作频繁/, /操作过于频繁/, /私信频繁/, /发消息频繁/, /发送太频繁/, /频率过快/, /频繁操作/, /过于频繁/, /太频繁/
];

const ACCOUNT_DAILY_LIMIT_PATTERNS = [
  /今日私信.*已达上限/, /今日.*发送.*上限/, /私信.*次数已达/, /今日次数已达上限/, /今日发送已达/, /已达今日.*上限/, /达到今日.*上限/
];

// 账号级限制文案。“消息检查未通过（检查码：N）”不在此列：检查码本身不说明是账号级，
// 只有 dm-rejection 能精确识别出的账号级回执（DM_ACCOUNT_*）才算频繁/上限。
const ACCOUNT_RECEIPT_PATTERNS = [
  /账号.*限制/, /功能受限/, /私信功能暂不可用/, /需要验证/
];

// engine-actions 记录精确回执时写成“[DM_ACCOUNT_FREQUENT] 原因”
const REJECTION_TAG = /\[(DM_[A-Z_]+)\]/;
function fromRejection(code, failureScope) {
  if (code === 'DM_ACCOUNT_DAILY_LIMIT') return 'daily_limit';
  if (code === 'DM_ACCOUNT_FREQUENT') return 'frequent';
  if (failureScope === 'recipient' || /^DM_RECIPIENT_/.test(code)) return 'recipient';
  return null;
}

const RECIPIENT_PATTERNS = [
  /仅自己可见/, /对方.*设置/, /对方.*拒绝/, /互相关注/, /关注后.*私信/, /对方未关注/, /对方.*关闭.*私信/, /无法私信该用户/, /会话上限/
];

/**
 * @param {string} code 任务停止错误码（PLATFORM_RESTRICTED / PLATFORM_DAILY_LIMIT 等）
 * @param {string} message 停止原因或发送拒绝文案
 * @returns {'frequent'|'daily_limit'|'recipient'|null}
 */
function classifyAccountSignal(code, message) {
  const text = String(message || '');
  if (code === 'PLATFORM_DAILY_LIMIT') return 'daily_limit';
  if (code === 'PLATFORM_RESTRICTED') return 'frequent';
  if (!text) return null;
  const tagged = text.match(REJECTION_TAG);
  if (tagged) return fromRejection(tagged[1]);
  const exact = classifyCheckMessage(text);
  if (exact) return fromRejection(exact.code, exact.failureScope);
  if (ACCOUNT_DAILY_LIMIT_PATTERNS.some(pattern => pattern.test(text))) return 'daily_limit';
  // 接收人级先于频繁判断：针对单个用户的拒绝不能让整个账号进入冷却
  if (RECIPIENT_PATTERNS.some(pattern => pattern.test(text))) return 'recipient';
  if (ACCOUNT_FREQUENT_PATTERNS.some(pattern => pattern.test(text))) return 'frequent';
  if (ACCOUNT_RECEIPT_PATTERNS.some(pattern => pattern.test(text))) return 'frequent';
  return null;
}

/** 账号冷却时长：首次 baseSec，之后逐次翻倍，封顶 2 小时 */
function cooldownFor(baseSec, frequentCountToday) {
  const base = Math.max(300, Number(baseSec) || 1800);
  const multiplier = Math.min(4, Math.max(1, Math.pow(2, Math.max(0, Number(frequentCountToday) || 0))));
  return Math.min(7200, base * multiplier);
}

module.exports = { classifyAccountSignal, cooldownFor, ACCOUNT_FREQUENT_PATTERNS, ACCOUNT_DAILY_LIMIT_PATTERNS };
