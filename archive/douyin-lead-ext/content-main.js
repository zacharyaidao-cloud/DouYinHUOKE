/**
 * 抖音获客采集助手 - 网络监听脚本（注入页面 MAIN world）v0.4
 * 职责：钩住页面的 XHR/fetch，拦截三个关键接口的响应，转发给内容脚本解析：
 *   1) /aweme/v1/web/comment/list/      评论列表（评论者昵称/抖音号/uid/评论/时间/属地）
 *   2) /aweme/v1/web/user/profile/other/ 用户主页（粉丝数/关注数/获赞/作品/性别/省市/认证/签名）
 *   3) /aweme/v1/web/aweme/detail/       视频详情（点赞/评论/分享/收藏、作者与粉丝数、描述）
 * 原理：页面自己带 msToken / a_bogus 签名请求接口，我们"蹭读"响应，无需破解签名。
 * 本脚本运行在页面主世界，无法使用 chrome.* API，用 postMessage 桥接。
 */
(() => {
  'use strict';
  if (window.__DY_NET_HOOK__) return;
  window.__DY_NET_HOOK__ = true;

  const HOOKS = [
    { mark: '/aweme/v1/web/comment/list/', type: 'comment-response', field: 'comments' },
    { mark: '/aweme/v1/web/user/profile/other/', type: 'profile-response', field: 'user' },
    { mark: '/aweme/v1/web/aweme/detail/', type: 'detail-response', field: 'aweme_detail' }
  ];

  function matchHook(url) {
    for (const h of HOOKS) {
      if (url.indexOf(h.mark) >= 0) return h;
    }
    return null;
  }

  function tryParse(text, url) {
    if (typeof text !== 'string' || !text) return null;
    const hook = matchHook(url);
    if (!hook) return null;
    try {
      const obj = JSON.parse(text);
      if (obj && obj[hook.field]) return { hookType: hook.type, data: obj };
    } catch (e) { /* ignore */ }
    return null;
  }

  function emit(hookType, data) {
    try {
      window.postMessage({ __dyLead: true, type: hookType, payload: data }, '*');
    } catch (e) { /* ignore */ }
  }

  function handleBody(text, url) {
    const parsed = tryParse(text, url);
    if (parsed) emit(parsed.hookType, { url, data: parsed.data });
  }

  /* ---------- 钩住 XMLHttpRequest（抖音网页端走 axios/XHR） ---------- */
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__dyUrl = typeof url === 'string' ? url : (url && (url.href || url.toString())) || '';
    } catch (e) { this.__dyUrl = ''; }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    try {
      xhr.addEventListener('load', () => {
        handleBody(xhr.responseText, xhr.__dyUrl || '');
      });
    } catch (e) { /* ignore */ }
    return origSend.apply(this, arguments);
  };

  /* ---------- 钩住 fetch（备用通道） ---------- */
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
      } catch (e) { url = ''; }
      const p = origFetch.apply(this, arguments);
      if (matchHook(url)) {
        p.then(resp => {
          try {
            if (resp && typeof resp.clone === 'function') {
              resp.clone().text().then(t => handleBody(t, url)).catch(() => {});
            }
          } catch (e) { /* ignore */ }
        }).catch(() => {});
      }
      return p;
    };
    try { window.fetch.toString = origFetch.toString.bind(origFetch); } catch (e) { /* ignore */ }
  }
})();
