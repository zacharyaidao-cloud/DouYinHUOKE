'use strict';
const { TaskStopError } = require('../scheduler');

/**
 * 触达错误分级（修复指南 6.3）：统一决定一个错误让谁停下。
 *   task    — 停止整个任务（授权失效、计划/规则变化、目标身份冲突）
 *   account — 当前账号不可继续（登录、平台验证/频繁/上限、窗口关闭或离开抖音）
 *   item    — 只记本用户失败，继续下一位；连续多位用户级失败由 runTask 的 CONSECUTIVE_ERRORS 升级
 *
 * 与指南码表的差异：TARGET_* 与 SESSION_* 仍为非用户级。适配器在点击前发现页面已离开目标
 * 主页/会话时抛这些码，继续下一位会在错误的页面上操作，现有测试也要求它们暂停。
 * DM_RECIPIENT_MISMATCH（聊天对象明确是别人）属于身份冲突，保持立即暂停。
 */
const TASK_CODES = /^(?:TASK_STOPPED$|AUTH_|PLAN_CHANGED$|PLAN_IDENTITY_CHANGED$|RULE_CHANGED$|ACTION_ATTEMPT_CHANGED$|TARGET_|DM_RECIPIENT_MISMATCH$)/;
const ACCOUNT_CODES = /^(?:LOGIN_|PLATFORM_|PAGE_CLOSED$|PAGE_REDIRECT$|SESSION_|PROFILE_QUOTA$)/;

/**
 * @param {Error|{code?:string}|string} error 错误对象或错误码
 * @returns {'task'|'account'|'item'}
 */
function levelOf(error) {
  const code = typeof error === 'string' ? error : String(error && error.code || '');
  if (TASK_CODES.test(code)) return 'task';
  if (ACCOUNT_CODES.test(code)) return 'account';
  // 代码里显式抛出的停止（如 CONSECUTIVE_ERRORS）按任务级处理；其余未知码都是用户级
  if (error instanceof TaskStopError) return 'task';
  return 'item';
}

module.exports = { levelOf, TASK_CODES, ACCOUNT_CODES };
