'use strict';

// Playwright serializes these functions into the page. Keep every dependency
// inside each function or in its explicit argument; this lib is copied intact
// to the client so Node-side obfuscation cannot inject inaccessible helpers.
function readPageHealth() {
  const visible = e => !!(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'
    && getComputedStyle(e).display !== 'none');
  const attribute = (e, name) => typeof e.getAttribute === 'function' ? e.getAttribute(name) || '' : '';
  const ordinaryContent = e => {
    for (let current = e; current; current = current.parentElement) {
      const tag = String(current.tagName || '').toUpperCase();
      if (/^(?:INPUT|TEXTAREA|BLOCKQUOTE)$/.test(tag) || attribute(current, 'contenteditable') === 'true'
        || ['textbox', 'log'].includes(attribute(current, 'role'))) return true;
      const identity = ['id', 'class', 'data-e2e'].map(name => attribute(current, name)).join(' ');
      if (/comment|video[-_ ]?(?:caption|desc)|(?:message|chat)[-_ ]?(?:item|bubble|content|history|list|record)|quoted[-_ ]?(?:message|text)/i.test(identity)) return true;
    }
    return false;
  };
  const all = selector => Array.from(document.querySelectorAll(selector)).filter(e => visible(e) && !ordinaryContent(e));
  const contentContainer = e => typeof e.querySelectorAll === 'function'
    && Array.from(e.querySelectorAll('*')).some(child => visible(child) && ordinaryContent(child));
  const captcha = all('[id*="captcha"],[class*="captcha"],[data-e2e="verify-popup"]').length > 0;
  const texts = all('button,span,a,[role="alert"],[role="dialog"]').filter(e => !contentContainer(e)).map(e => (e.textContent || '').trim());
  if (captcha || texts.some(t => /^(请完成验证|安全验证|拖动滑块完成验证|请先通过验证)$/.test(t))) return 'verification';
  // 只把系统提示当作平台反馈，普通评论、昵称或聊天内容不构成账户限制。
  const feedback = all('[role="alert"],[role="dialog"],[aria-live="assertive"],[aria-live="polite"],[class*="toast" i],[data-e2e="toast"],[data-e2e="global-toast"]')
    // A conversation dialog/live region may contain quoted or user-authored
    // messages. Its concatenated text is not a platform receipt.
    .filter(e => !contentContainer(e))
    .map(e => (e.textContent || '').trim());
  const recipientScoped = t => /对方|该用户|此用户|这位用户|陌生人|单(?:个|次)?会话|本会话|当前会话|(?:向|给|与)(?:这|此|该)/.test(t);
  if (feedback.some(text => {
    if (recipientScoped(text)) return false;
    const t = text.replace(/^(?:系统提示|温馨提示|提示|发送失败|关注失败|操作失败)[：:\s]*/, '')
      .replace(/^(?:(?:您|你)(?:的)?(?:账号)?|当前账号|本账号)(?:的)?/, '');
    return /^(?:(?:操作|访问|关注|私信(?:发送|操作)?|发送(?:私信|消息)?)(?:太频繁|过于频繁|频繁|频率过高|太快(?:了)?|过快)|账号存在风险|功能暂不可用|请稍后再试)([，,！!。\s]|$)/.test(t);
  })) return 'restricted';
  const dailyLimit = feedback.some(text => {
    const t = text.replace(/\s+/g, '').replace(/^(?:系统提示|温馨提示|提示|发送失败|关注失败|操作失败)[：:]?/, '')
      .replace(/^(?:(?:您|你)(?:的)?(?:账号)?|当前账号|本账号)(?:的)?/, '');
    // “今日陌生人私信”是账号当日额度；给单个用户的限制仍只影响该用户。
    const dailyPrefix = '(?:今日|今天|当日|每日|本日)(?:可|已|的)?';
    const dailyAction = '(?:(?:向|给)?陌生人(?:发送)?(?:私信|消息)|发送|私信|关注)';
    const ownDailyAction = new RegExp('^' + dailyPrefix + dailyAction).test(t)
      || new RegExp('^(?:已(?:经)?达(?:到)?|已(?:经)?超过)' + dailyPrefix + dailyAction).test(t);
    if (recipientScoped(t) && !new RegExp('^' + dailyPrefix + '(?:向|给)?陌生人(?:发送)?(?:私信|消息)').test(t)) return false;
    const reached = /(?:已(?:经)?达(?:到)?|已(?:经)?(?:超过|超出)|达(?:到)?)[^。！？!?；;]{0,30}(?:上限|限制|额度)(?=[，,。.!！?？:：；;（(]|$)/.test(t)
      || /(?:次数|人数|数量|额度)(?:已|已经)(?:用完|耗尽)(?=[，,。.!！?？:：；;]|$)/.test(t);
    return ownDailyAction && reached;
  });
  if (dailyLimit) return 'daily_limit';
  // Login words in a video caption, comment, or normal message say nothing
  // about the current account. Only the site's account entry or the current
  // conversation's login-required send control can invalidate the task.
  const headerControls = all('header button,header a,header [role="button"],[role="banner"] button,[role="banner"] a,[role="banner"] [role="button"],[data-e2e="top-header"] button,[data-e2e="top-header"] a,[data-e2e="top-header"] [role="button"]');
  const headerLogin = headerControls.some(e => /^(?:登录|扫码登录|立即登录|登录\s*\/\s*注册)$/.test((e.textContent || '').trim()));
  const conversation = e => {
    for (let current = e.parentElement; current; current = current.parentElement) {
      const tag = String(current.tagName || '').toUpperCase();
      if (/^(?:BODY|HTML|MAIN|ARTICLE)$/.test(tag)) return false;
      const identity = ['id', 'class', 'data-e2e'].map(name => attribute(current, name)).join(' ');
      if (/^(?:message-panel|im-chat|im-container|chat-window|conversation|private-message)$/.test(attribute(current, 'data-e2e'))
        || /(?:message|chat)[-_]?(?:panel|window|container)|private[-_]?message/i.test(identity)) return true;
    }
    return false;
  };
  const messageLogin = all('button,a,[role="button"],[data-e2e="message-login"],[data-e2e="chat-login"],[data-e2e="im-login"],[data-e2e="message-login-button"]')
    .some(e => /^登录后(?:发送消息|发送私信|发送)$/.test((e.textContent || '').trim())
      && (conversation(e) || /^(?:message-login|chat-login|im-login|message-login-button)$/.test(attribute(e, 'data-e2e'))));
  if (headerLogin || messageLogin) return 'login';
  if (!document.body || !(document.body.textContent || '').trim()) return 'empty';
  return 'ok';
}

function clickFollow() {
  const buttons = Array.from(document.querySelectorAll('button')).filter(e => e.getClientRects().length);
  if (buttons.some(e => /^(已关注|关注中|互相关注)$/.test((e.textContent || '').trim()))) return 'already';
  const btn = buttons.find(e => (e.textContent || '').trim() === '关注');
  if (!btn) return 'missing';
  btn.click(); return 'clicked';
}

function isFollowConfirmed() {
  return Array.from(document.querySelectorAll('button')).some(e => e.getClientRects().length && /^(已关注|关注中|互相关注)$/.test((e.textContent || '').trim()));
}

function openDirectMessage() {
  const els = Array.from(document.querySelectorAll('button,a,[role="button"],span,div'));
  const btn = els.find(e => e.getClientRects().length && /^(私信|发私信|发消息)$/.test((e.textContent || '').trim()));
  if (!btn) return false; btn.click(); return true;
}

function fillDirectMessage(msg) {
  const editors = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(e => e.getClientRects().length);
  if (editors.length !== 1) return false;
  const editor = editors[0]; editor.focus(); editor.textContent = msg;
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: msg })); return true;
}

function sendDirectMessage(msg) {
  const editors = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(e => e.getClientRects().length);
  if (editors.length !== 1 || (editors[0].textContent || '').trim() !== msg) return false;
  const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter(e => e.getClientRects().length && !e.disabled);
  const send = buttons.find(e => (e.textContent || '').trim() === '发送' || e.getAttribute('aria-label') === '发送');
  if (!send) return false;
  send.click(); return true;
}

module.exports = { readPageHealth, clickFollow, isFollowConfirmed, openDirectMessage, fillDirectMessage, sendDirectMessage };
