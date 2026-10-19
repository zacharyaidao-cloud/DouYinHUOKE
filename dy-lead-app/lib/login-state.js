'use strict';

// Read only the page/session that the user already opened. This module never
// navigates, clicks, makes requests, or exposes account identifiers/Cookie values.
const registered = new WeakMap();
const SELF_PATH = '/aweme/v1/web/user/profile/self/';
const RESPONSE_MAX_AGE_MS = 15000;

const messages = {
  authenticated: '已确认抖音账号登录',
  logged_out: '抖音账号尚未登录，请在账号窗口扫码并在手机上确认',
  pending: '正在等待扫码或手机确认，请保持账号窗口打开',
  verification_required: '抖音要求安全验证，请在账号窗口人工完成验证',
  browser_closed: '账号浏览器窗口已关闭，请重新打开登录',
  unknown: '尚未取得可靠登录证据，请在账号窗口打开本人主页后重新检查'
};

function result(state, evidence = [], message = messages[state]) {
  return { state, loggedIn: state === 'authenticated', message, evidence };
}

function trustedUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && ['www.douyin.com', 'douyin.com'].includes(url.hostname)
      && !url.username && !url.password && (!url.port || url.port === '443') ? url : null;
  } catch (_) { return null; }
}

function validSessionCookie(cookie, url, nowSeconds) {
  if (!cookie || !['sessionid', 'sessionid_ss'].includes(cookie.name)
    || typeof cookie.value !== 'string' || !cookie.value.length) return false;
  const domain = String(cookie.domain || '').toLowerCase();
  if (!['douyin.com', '.douyin.com', 'www.douyin.com', '.www.douyin.com'].includes(domain)) return false;
  if (!domain.startsWith('.') && domain !== url.hostname) return false;
  const cookiePath = String(cookie.path || '/');
  if (!url.pathname.startsWith(cookiePath) || (cookiePath !== '/' && url.pathname.length > cookiePath.length
    && !cookiePath.endsWith('/') && url.pathname[cookiePath.length] !== '/')) return false;
  const expiry = Number(cookie.expires);
  return Number.isFinite(expiry) && (expiry === -1 || expiry > nowSeconds);
}

// Exact credential identity is private, short-lived process memory. Never add it
// to a result, account record, task, diagnostic, log, or file.
function sessionIdentity(cookies, url) {
  if (!Array.isArray(cookies)) return '';
  const valid = cookies.filter(cookie => validSessionCookie(cookie, url, Date.now() / 1000));
  if (!valid.length) return '';
  return JSON.stringify(valid.map(cookie => [cookie.name, String(cookie.domain).toLowerCase(), cookie.path || '/', cookie.value])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

function invalidateProof(proof) {
  if (proof) { proof.identity = ''; proof.origin = ''; proof.revision++; }
}

function readWithDeadline(operation, timeoutMs = 8000, pendingReads) {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const pending = { cancel: () => finish(false, Object.assign(new Error('登录检查已结束'), { code: 'LOGIN_READ_CANCELLED' })) };
    function finish(ok, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingReads) pendingReads.delete(pending);
      if (ok) resolve(value); else reject(value);
    }
    timer = setTimeout(() => finish(false, Object.assign(new Error('登录回复读取超时'), { code: 'LOGIN_READ_TIMEOUT' })), timeoutMs);
    if (pendingReads) pendingReads.add(pending);
    Promise.resolve().then(() => settled ? undefined : operation()).then(value => finish(true, value), error => finish(false, error));
  });
}

async function pageSignals(page, url) {
  return page.evaluate(({ selfPage }) => {
    const visible = element => !!(element && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    const text = element => String(element.textContent || '').trim();
    const all = selector => Array.from(document.querySelectorAll(selector)).filter(visible);
    const authoredArea = element => element.matches('blockquote,[role="log"]')
      || /comment|video[-_ ]?(?:caption|desc)|(?:message|chat)[-_ ]?(?:item|bubble|content|history|list|record)|quoted[-_ ]?(?:message|text)|评论|消息内容/i
        .test(['class', 'id', 'data-e2e'].map(name => element.getAttribute(name) || '').join(' '));
    const contentArea = element => element.matches('textarea,input,[contenteditable="true"],[role="textbox"]') || authoredArea(element);
    const outsideContent = element => {
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) if (contentArea(ancestor)) return false;
      return true;
    };
    // Conversation dialogs may aggregate quoted user messages. Native login
    // form inputs are allowed; authored messages/captions inside a container
    // cannot turn that container's combined text into account-system feedback.
    const hasAuthoredContent = element => Array.from(element.querySelectorAll('*')).some(child => visible(child) && authoredArea(child));
    const accountLoginControl = element => {
      if (!outsideContent(element)) return false;
      for (let ancestor = element; ancestor && !/^(?:BODY|HTML|MAIN|ARTICLE)$/.test(ancestor.tagName); ancestor = ancestor.parentElement) {
        if (ancestor.matches('[role="dialog"]') && hasAuthoredContent(ancestor)) return false;
        if (ancestor.matches('header,nav,[role="banner"],[role="dialog"],[data-e2e="top-header"],[data-e2e="navigation"],[data-e2e="login-button"],[data-e2e="login-modal"],[data-e2e="login-dialog"]')) return true;
      }
      return false;
    };
    const controls = all('button,a,[role="button"],[role="menuitem"],[tabindex]');
    const labels = all('button,a,span,div,[role="button"],[role="menuitem"]');
    const captcha = all('[id*="captcha"],[class*="captcha"],[data-e2e="verify-popup"],[data-e2e="captcha"]');
    const verification = captcha.filter(outsideContent).length > 0 || labels.filter(outsideContent).filter(element => !hasAuthoredContent(element))
      .some(element => /^(?:请完成验证|安全验证|请完成安全验证|拖动滑块完成验证|请先通过验证)$/.test(text(element)));
    const dialogs = all('[role="dialog"],[data-e2e="login-modal"],[data-e2e="login-dialog"],[class*="login-modal"],[class*="loginModal"]')
      .filter(outsideContent).filter(element => !hasAuthoredContent(element));
    const loginDialog = dialogs.some(element => /扫码登录|二维码登录|请使用抖音扫码|扫描二维码|请打开抖音|手机确认|确认登录/.test(text(element)));
    const pendingConfirmation = dialogs.some(element => /扫码成功|扫描成功|请在手机(?:上|端)?确认|等待确认|请在抖音(?:APP)?上确认|确认登录/.test(text(element)));
    const headerLogin = all('header button,header a,header [role="button"],[role="banner"] button,[role="banner"] a,[data-e2e="top-header"] button,[data-e2e="top-header"] a').filter(outsideContent)
      .some(element => /^(?:登录|扫码登录|立即登录|登录\s*\/\s*注册)$/.test(text(element)));
    const logout = controls.filter(outsideContent).some(element => /^(?:退出登录|退出登陆)$/.test(text(element)))
      || all('[role="menu"] span,[role="menu"] div,[data-e2e="user-menu"] span,[data-e2e="user-menu"] div,[data-e2e="user-dropdown"] span,[data-e2e="user-dropdown"] div')
        .filter(outsideContent).some(element => /^(?:退出登录|退出登陆)$/.test(text(element)));
    const privateLabels = new Set(['我的喜欢', '我的收藏', '观看历史', '稍后再看', '我的作品']);
    const privateLabel = value => String(value || '').trim().replace(/\s+/g, '')
      .replace(/[（(]?(?:\d+(?:\.\d+)?(?:万|亿|w|k)?|--)[）)]?$/i, '');
    // Current headers also use an icon-only link to /user/self, without the
    // previous navigation classes or a textual "我的" label. Its own image and
    // top navigation placement are required; links inside comments do not count.
    const topSelfLink = all('a').some(link => {
      if (!/^(?:https:\/\/(?:www\.)?douyin\.com)?\/user\/self\/?(?:[?#].*)?$/.test(link.getAttribute('href') || '')
        || !outsideContent(link) || !Array.from(link.querySelectorAll('img')).some(visible)) return false;
      for (let ancestor = link; ancestor && !/^(?:BODY|HTML|MAIN|ARTICLE)$/.test(ancestor.tagName); ancestor = ancestor.parentElement) {
        if (ancestor.matches('header,nav,[role="banner"],[data-e2e="top-header"],[data-e2e="navigation"]')) return true;
      }
      const rect = typeof link.getBoundingClientRect === 'function' ? link.getBoundingClientRect() : null;
      return !!(rect && rect.top >= 0 && rect.top <= 160 && rect.width > 0 && rect.height > 0
        && rect.width <= 140 && rect.height <= 140);
    });
    // Some current account menus use plain div/span labels, without button/role
    // attributes. Only accept their local private-menu combination on /user/self;
    // ordinary comments or labels spread across the whole page do not qualify.
    const selfMenu = selfPage && labels.filter(element => /^(?:退出登录|退出登陆)$/.test(text(element))).some(exit => {
      for (let ancestor = exit; ancestor; ancestor = ancestor.parentElement) {
        if (contentArea(ancestor)) return false;
      }
      let container = exit.parentElement;
      for (let depth = 0; container && depth < 6; depth++, container = container.parentElement) {
        if (contentArea(container) || /^(?:BODY|HTML|MAIN|ARTICLE)$/.test(container.tagName)) return false;
        if (text(container).length > 400) continue;
        const nearby = Array.from(container.querySelectorAll('button,a,span,div,[role="button"],[role="menuitem"]')).filter(visible);
        if (nearby.length > 60) continue;
        const found = new Set(nearby.map(element => privateLabel(text(element))).filter(label => privateLabels.has(label)));
        if (found.size >= 2) return true;
      }
      return false;
    });
    // The same private menu is present on works and other profiles. Require a
    // local account panel with its image, three distinct private features and
    // the trusted top self link (or an explicit account-menu marker).
    const accountMenu = labels.filter(element => /^(?:退出登录|退出登陆)$/.test(text(element))).some(exit => {
      if (!outsideContent(exit)) return false;
      let container = exit.parentElement;
      for (let depth = 0; container && depth < 6; depth++, container = container.parentElement) {
        if (contentArea(container) || /^(?:BODY|HTML|MAIN|ARTICLE)$/.test(container.tagName)) return false;
        if (text(container).length > 600) continue;
        const nearby = Array.from(container.querySelectorAll('button,a,span,div,[role="button"],[role="menuitem"]')).filter(visible);
        if (nearby.length > 80) continue;
        const found = new Set(nearby.map(element => privateLabel(text(element))).filter(label => privateLabels.has(label)));
        const marked = container.matches('[role="menu"],[data-e2e="user-menu"],[data-e2e="user-dropdown"]');
        if (found.size >= 3 && Array.from(container.querySelectorAll('img')).some(visible) && (topSelfLink || marked)) return true;
      }
      return false;
    });
    // /user/self is the already-opened本人主页. Editing controls plus its
    // personal tabs are meaningful; another user's profile/avatar is not.
    const profileLabels = new Set(labels.filter(outsideContent).map(text));
    const selfEditor = selfPage && ['编辑个人简介', '编辑资料', '编辑主页'].some(label => profileLabels.has(label))
      && ['作品', '喜欢', '收藏'].filter(label => profileLabels.has(label)).length >= 2;
    const avatar = all('header [data-e2e="user-avatar"],[role="banner"] [data-e2e="user-avatar"],[data-e2e="top-header"] [data-e2e="user-avatar"],[data-e2e="navigation-avatar"],[data-e2e="header-user-avatar"]').filter(outsideContent).length > 0;
    const ownHome = all('header a,[role="banner"] a,[data-e2e="top-header"] a,[data-e2e="navigation"] a')
      .filter(outsideContent).some(element => /^(?:个人主页|我的主页|我的)$/.test(text(element))
        && /^(?:https:\/\/(?:www\.)?douyin\.com)?\/user\/self\/?(?:[?#].*)?$/.test(element.getAttribute('href') || ''));
    // A generic/default avatar alone is not reliable account evidence.
    const ownAvatar = avatar && ownHome || topSelfLink;
    const loginControl = controls.filter(accountLoginControl).some(element => /^(?:登录|扫码登录|立即登录|登录\s*\/\s*注册)$/.test(text(element)));
    const bodyReady = !!(document.body && String(document.body.innerText || document.body.textContent || '').trim());
    return { verification, loginDialog, pendingConfirmation, headerLogin, loginControl,
      logout, selfMenu, accountMenu, selfEditor, ownAvatar, bodyReady, loading: document.readyState === 'loading' };
  }, { selfPage: url.pathname === '/user/self' || url.pathname === '/user/self/' });
}

async function inspectPage(page, context, recentResponse, proof) {
  try {
    const revision = proof && proof.revision;
    if (!page || page.isClosed()) return result('browser_closed');
    const url = trustedUrl(page.url());
    if (!url) return result('unknown', [], '账号页面尚未进入可信的抖音 HTTPS 页面，请返回抖音本人主页');
    const signals = await pageSignals(page, url);
    if (signals.verification) { invalidateProof(proof); return result('verification_required', ['visible_platform_verification']); }
    if (!signals.bodyReady) return result(signals.loading ? 'pending' : 'unknown', [], '账号页面尚未加载完成，请检查网络并保持窗口打开');
    if (signals.loginDialog || signals.pendingConfirmation) {
      invalidateProof(proof); if (recentResponse) recentResponse.authenticated = false;
      return result('pending', ['visible_login_confirmation']);
    }
    if (signals.headerLogin || signals.loginControl) {
      invalidateProof(proof);
      if (recentResponse) recentResponse.authenticated = false;
      return result('logged_out', [signals.headerLogin ? 'visible_header_login' : 'visible_login_control']);
    }
    let identity = '';
    try {
      const read = () => context.cookies([url.href]);
      const cookies = await (proof ? proof.read(read) : readWithDeadline(read));
      identity = sessionIdentity(cookies, url);
    } catch (_) { /* No session evidence: never turn a Cookie-read failure into success. */ }
    const session = !!identity;
    if (proof && (proof.revision !== revision || proof.responsePending)) return {
      ...result('unknown', [], '抖音登录状态正在更新，请稍候重新检查'), updating: true
    };
    if (proof && proof.identity && proof.identity !== identity) invalidateProof(proof);
    if (!session && recentResponse) recentResponse.authenticated = false;
    if (!session) invalidateProof(proof);
    // A failed self-profile reply invalidates even a cached panel for this
    // credential. A new successful reply or new credential can establish proof.
    if (session && proof && proof.rejectedIdentity === identity) return result('unknown', ['failed_self_profile_response'], '抖音本人登录接口未确认当前会话，请在账号窗口检查登录状态');
    // Prefer an actual successful self-profile reply over page appearance.
    // Its live-session-bound memory proof survives normal works navigation;
    // it is never an account flag persisted on disk.
    const responseAge = recentResponse && Date.now() - recentResponse.at;
    if (session && recentResponse && recentResponse.authenticated
      && recentResponse.identity === identity && responseAge >= 0 && responseAge < RESPONSE_MAX_AGE_MS) {
      if (proof) { proof.identity = identity; proof.origin = 'self_response'; }
      return result('authenticated', ['valid_session_cookie', 'successful_self_profile_response']);
    }
    if (session && proof && proof.identity === identity && proof.origin === 'self_response') {
      return result('authenticated', ['valid_session_cookie', 'verified_self_response_session']);
    }
    const ui = signals.logout ? 'own_logout_control' : signals.selfMenu ? 'self_private_menu' : signals.accountMenu ? 'account_private_menu' : signals.selfEditor ? 'self_profile_editor'
      : signals.ownAvatar ? 'own_header_avatar' : '';
    if (session && ui) {
      if (proof) { proof.identity = identity; proof.origin = 'own_ui'; proof.rejectedIdentity = ''; }
      return result('authenticated', ['valid_session_cookie', ui]);
    }
    if (signals.loading) return result('pending', [], '抖音页面仍在加载，请稍候');
    if (session && proof && proof.identity === identity) return result('authenticated', ['valid_session_cookie', 'verified_context_session']);
    return result('unknown');
  } catch (error) {
    if (page && typeof page.isClosed === 'function' && page.isClosed()) return result('browser_closed');
    // A video URL can switch to the same work's note renderer after DOM ready.
    // Preserve this narrow transient cause without treating it as a login proof.
    if (/Execution context was destroyed|Cannot find context with specified id/.test(String(error && error.message || ''))) return {
      ...result('unknown', ['page_navigation_read_interrupted'], '页面正在切换，登录状态尚待重新确认'), pageTransition: true
    };
    return result('unknown', [], '暂时无法读取账号页面，请保持窗口打开后重新检查');
  }
}

function removeListener(emitter, name, handler) {
  if (typeof emitter.off === 'function') emitter.off(name, handler);
  else if (typeof emitter.removeListener === 'function') emitter.removeListener(name, handler);
}

function createLoginMonitor(context, primaryPage, options = {}) {
  if (!context || typeof context.cookies !== 'function' || typeof context.pages !== 'function') throw new TypeError('需要有效的浏览器上下文');
  const old = registered.get(context);
  if (old) old.dispose();
  let disposed = false, closed = false, responseEvidence = null, responseSequence = 0;
  const requestedTimeout = Number(options && options.responseTimeoutMs);
  const responseTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, 30000) : 8000;
  const pendingReads = new Set();
  const read = operation => readWithDeadline(operation, responseTimeoutMs, pendingReads);
  const cancelReads = () => { for (const pending of pendingReads) pending.cancel(); };
  const proof = { identity: '', origin: '', rejectedIdentity: '', revision: 0, responsePending: 0, read };
  const trackedPages = new Map();

  const onPage = page => {
    if (!page || trackedPages.has(page) || typeof page.on !== 'function') return;
    const onClose = () => {
      invalidateProof(proof);
      proof.responsePending = 0; responseSequence++; cancelReads();
      trackedPages.delete(page);
      removeListener(page, 'close', onClose);
      if (responseEvidence && responseEvidence.page === page) responseEvidence = null;
    };
    trackedPages.set(page, onClose);
    page.on('close', onClose);
  };
  const onClose = () => { closed = true; responseEvidence = null; dispose(); };
  const onResponse = async response => {
    let url;
    try { url = trustedUrl(response.url()); } catch (_) { return; }
    if (disposed || closed || !url || url.pathname !== SELF_PATH) return;
    try {
      if (!context.pages().some(page => !page.isClosed())) return;
      const frame = typeof response.frame === 'function' ? response.frame() : null;
      const sourcePage = frame && typeof frame.page === 'function' ? frame.page() : null;
      if (sourcePage && typeof sourcePage.isClosed === 'function' && sourcePage.isClosed()) return;
    } catch (_) { return; }
    const sequence = ++responseSequence, responseAt = Date.now();
    // Invalidate an earlier successful response before processing the newest
    // reply. An auth error/failed parse cannot preserve stale success evidence.
    responseEvidence = null;
    invalidateProof(proof);
    proof.responsePending = sequence;
    const responseRevision = proof.revision;
    let authenticated = false, responsePage = null, identity = '', readIdentity = '', decodingActive = true;
    const currentDecode = () => decodingActive && !disposed && !closed && sequence === responseSequence && responseRevision === proof.revision;
    try {
      // One deadline covers both Cookie reads and the whole JSON decode. A
      // response that never completes cannot lock every later task in pending.
      const decoded = await read(async () => {
        const currentIdentity = sessionIdentity(await context.cookies([url.href]), url);
        readIdentity = currentIdentity;
        const failed = { authenticated: false, identity: currentIdentity, page: null };
        if (!currentDecode()) return failed;
        if (response.status() !== 200) return failed;
        const headers = typeof response.headers === 'function' ? response.headers() : {};
        if (Number(headers['content-length'] || 0) > 262144) return failed;
        const body = await response.json();
        if (!currentDecode()) return failed;
        const user = body && body.user;
        const valid = !!(body && body.status_code === 0 && body.is_login !== false && user
          && typeof user === 'object' && !Array.isArray(user)
          && ((typeof user.uid === 'string' || typeof user.uid === 'number') && /^[1-9]\d{0,31}$/.test(String(user.uid))
            || typeof user.sec_uid === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(user.sec_uid)));
        let page = null;
        if (typeof response.frame === 'function') {
          const frame = response.frame();
          page = frame && typeof frame.page === 'function' ? frame.page() : null;
        }
        // Re-read before committing: an old reply cannot confirm a replacement
        // token changed while response.json() was pending.
        const matched = !!(valid && currentIdentity && !(page && typeof page.isClosed === 'function' && page.isClosed())
          && sessionIdentity(await context.cookies([url.href]), url) === currentIdentity);
        return { authenticated: matched, identity: currentIdentity, page };
      });
      authenticated = decoded.authenticated; identity = decoded.identity; responsePage = decoded.page;
    } catch (_) { authenticated = false; identity = readIdentity; }
    finally {
      decodingActive = false;
      if (proof.responsePending === sequence) proof.responsePending = 0;
      if (!disposed && !closed && sequence === responseSequence && responseRevision === proof.revision) {
        proof.rejectedIdentity = authenticated ? '' : identity;
        responseEvidence = { authenticated, at: responseAt, page: responsePage, identity };
        if (authenticated) { proof.identity = identity; proof.origin = 'self_response'; }
      }
    }
  };

  async function inspectOne(page) {
    if (disposed || closed) return result('browser_closed');
    return inspectPage(page, context, responseEvidence, proof);
  }
  async function inspect() {
    if (disposed || closed) return result('browser_closed');
    let pages;
    try { pages = context.pages().filter(page => !page.isClosed()); }
    catch (_) { return result('browser_closed'); }
    if (primaryPage && !primaryPage.isClosed() && !pages.includes(primaryPage)) pages.unshift(primaryPage);
    pages = [primaryPage, ...pages.slice().reverse()].filter((page, index, all) => page && !page.isClosed() && all.indexOf(page) === index);
    if (!pages.length) return result('browser_closed');
    const candidates = [];
    for (const page of pages) {
      const current = await inspectOne(page);
      // Verification on the primary account window always remains explicit.
      if (page === primaryPage && current.state === 'verification_required') return current;
      candidates.push(current);
    }
    const negative = candidates.find(item => item.state === 'verification_required')
      || candidates.find(item => item.state === 'pending')
      || candidates.find(item => item.state === 'logged_out');
    if (negative) { invalidateProof(proof); if (responseEvidence) responseEvidence.authenticated = false; return negative; }
    return candidates.find(item => item.loggedIn) || candidates[0];
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    responseSequence++;
    responseEvidence = null;
    invalidateProof(proof); proof.rejectedIdentity = ''; proof.responsePending = 0;
    cancelReads();
    removeListener(context, 'response', onResponse);
    removeListener(context, 'page', onPage);
    removeListener(context, 'close', onClose);
    for (const [page, handler] of trackedPages) removeListener(page, 'close', handler);
    trackedPages.clear();
    if (registered.get(context) === internal) registered.delete(context);
  }
  const internal = { inspectOne, inspect, dispose };
  registered.set(context, internal);
  for (const page of context.pages()) onPage(page);
  if (typeof context.on === 'function') {
    context.on('response', onResponse);
    context.on('page', onPage);
    context.on('close', onClose);
  }
  return { inspect, dispose };
}

async function inspectLoginState(page) {
  if (!page || page.isClosed()) return result('browser_closed');
  let context;
  try { context = page.context(); } catch (_) { return result('unknown'); }
  const monitor = registered.get(context);
  return monitor ? monitor.inspectOne(page) : inspectPage(page, context, null);
}

module.exports = { createLoginMonitor, inspectLoginState };
