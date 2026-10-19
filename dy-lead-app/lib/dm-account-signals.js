'use strict';

/**
 * 私信账号级信号分类：把任务停止/发送拒绝归类为 频繁 / 今日上限 / 账号异常，
 * 无法归类的按接收人级回退（不换号、不动账号状态）。
 * 文案样本来自真实平台提示；正则仅用于本机分类，不含任何签名或敏感参数。
 */

const ACCOUNT_FREQUENT_PATTERNS = [
  /操作频繁/, /操作过于频繁/, /私信频繁/, /发消息频繁/, /发送太频繁/, /频率过快/, /频繁操作/, /稍后再试/
];

const ACCOUNT_DAILY_LIMIT_PATTERNS = [
  /今日私信.*已达上限/, /今日.*发送.*上限/, /私信.*次数已达/, /今日次数已达上限/, /今日发送已达/, /已达今日.*上限/, /达到今日.*上限/
];

// 发送回执中的账号级限制文案（如"消息检查未通过（检查码：N）"）
const ACCOUNT_RECEIPT_PATTERNS = [
  /检查码/, /消息检查未通过/, /账号.*限制/, /功能受限/, /私信功能暂不可用/, /需要验证/
];

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
  if (ACCOUNT_DAILY_LIMIT_PATTERNS.some(pattern => pattern.test(text))) return 'daily_limit';
  if (ACCOUNT_FREQUENT_PATTERNS.some(pattern => pattern.test(text))) return 'frequent';
  if (ACCOUNT_RECEIPT_PATTERNS.some(pattern => pattern.test(text))) return 'frequent';
  if (RECIPIENT_PATTERNS.some(pattern => pattern.test(text))) return 'recipient';
  return null;
}

/** 账号冷却时长：首次 baseSec，之后逐次翻倍，封顶 2 小时 */
function cooldownFor(baseSec, frequentCountToday) {
  const base = Math.max(300, Number(baseSec) || 1800);
  const multiplier = Math.min(4, Math.max(1, Math.pow(2, Math.max(0, Number(frequentCountToday) || 0))));
  return Math.min(7200, base * multiplier);
}

module.exports = { classifyAccountSignal, cooldownFor, ACCOUNT_FREQUENT_PATTERNS, ACCOUNT_DAILY_LIMIT_PATTERNS };
