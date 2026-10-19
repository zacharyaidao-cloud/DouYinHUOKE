'use strict';
const { inspectLoginState } = require('./login-state');
const { persistLoginResult } = require('./account-login');
const { TaskStopError } = require('../scheduler');

const codes = {
  logged_out: 'LOGIN_REQUIRED', unknown: 'LOGIN_UNCONFIRMED', pending: 'LOGIN_PENDING',
  verification_required: 'PLATFORM_VERIFICATION', browser_closed: 'PAGE_CLOSED'
};

// All task checks publish the same public state as the account page. Neither a
// saved "已登录" flag nor uncertain page evidence grants permission to act.
async function assertTaskLogin(page, accountId, { store, inspect = inspectLoginState, checkStopped = () => {}, health = async () => {},
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), settleTimeoutMs = 3000 }) {
  checkStopped();
  let state = await inspect(page);
  const deadline = now() + Math.max(0, Math.min(3000, Number(settleTimeoutMs) || 0));
  // Only retry an explicitly reported in-flight login read. Never reuse a
  // saved success, navigate, refresh, or retry a real logged-out/verify result.
  while (state.state === 'unknown' && state.updating === true && now() < deadline) {
    checkStopped();
    await wait(Math.min(80, deadline - now()));
    checkStopped();
    state = await inspect(page);
  }
  checkStopped();
  if (state.state === 'unknown' && state.updating === true) state = {
    ...state, message: '抖音登录状态更新未完成，已等待复核；请检查账号窗口后重新预检查'
  };
  persistLoginResult(store, accountId, state);
  if (!state.loggedIn || state.state !== 'authenticated') {
    const error = new TaskStopError(state.message || '抖音登录状态待确认，请在账号窗口检查', codes[state.state] || 'LOGIN_UNCONFIRMED');
    if (state.state === 'unknown' && state.pageTransition === true) error.pageTransition = true;
    throw error;
  }
  try {
    await health();
  } catch (error) {
    checkStopped();
    const failedState = { LOGIN_REQUIRED: 'logged_out', PLATFORM_VERIFICATION: 'verification_required', PAGE_CLOSED: 'browser_closed' }[error.code];
    if (failedState) persistLoginResult(store, accountId, { state: failedState, loggedIn: false, message: error.message });
    throw error;
  }
  checkStopped();
  return state;
}

module.exports = { assertTaskLogin };
