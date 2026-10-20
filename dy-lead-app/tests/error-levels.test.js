'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { levelOf } = require('../lib/error-levels');
const { TaskStopError } = require('../scheduler');

const err = code => Object.assign(new Error(code), { code });

test('错误分级：任务级', () => {
  for (const code of ['TASK_STOPPED', 'AUTH_REQUIRED', 'PLAN_CHANGED', 'PLAN_IDENTITY_CHANGED', 'TARGET_MISMATCH', 'DM_RECIPIENT_MISMATCH']) {
    assert.equal(levelOf(err(code)), 'task', code);
  }
});

test('错误分级：账号级', () => {
  for (const code of ['LOGIN_REQUIRED', 'LOGIN_UNCONFIRMED', 'PLATFORM_VERIFICATION', 'PLATFORM_RESTRICTED', 'PLATFORM_DAILY_LIMIT', 'PAGE_CLOSED', 'PAGE_REDIRECT', 'SESSION_CHANGED']) {
    assert.equal(levelOf(err(code)), 'account', code);
  }
});

test('错误分级：用户级（含降级的接收人未确认、会话/输入框变化、入口点击被挡）', () => {
  for (const code of ['DM_RECIPIENT_UNCONFIRMED', 'DM_COMPOSER_CHANGED', 'DM_PREVIOUS_CONVERSATION_UNCONFIRMED', 'DM_ENTRY_CLICK_BLOCKED',
    'DM_ENTRY_NOT_FOUND', 'DM_TARGET_CHAT_NOT_READY', 'DM_EDITOR_NOT_FOUND', 'DM_SEND_DISABLED', 'FOLLOW_CONTROL_CHANGED', 'PAGE_NOT_READY', '']) {
    assert.equal(levelOf(err(code)), 'item', code || '无错误码');
  }
  assert.equal(levelOf(new Error('Timeout 2000ms exceeded')), 'item');
  assert.equal(levelOf(null), 'item');
});

test('错误分级：显式停止的未知码按任务级；也接受字符串码', () => {
  assert.equal(levelOf(new TaskStopError('连续异常', 'CONSECUTIVE_ERRORS')), 'task');
  assert.equal(levelOf(new TaskStopError()), 'task');
  assert.equal(levelOf('LOGIN_REQUIRED'), 'account');
  assert.equal(levelOf('DM_RECIPIENT_UNCONFIRMED'), 'item');
});
