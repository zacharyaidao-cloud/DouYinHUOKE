'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebContentsView, session } = require('electron');

// This allowlist deliberately excludes file upload, global browser control,
// arbitrary target attachment and browser-wide storage/permission commands.
const PAGE_METHODS = new Set([
  'Page.enable', 'Page.disable', 'Page.getFrameTree', 'Page.createIsolatedWorld',
  'Page.setLifecycleEventsEnabled', 'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument', 'Page.navigate', 'Page.reload', 'Page.stopLoading',
  'Page.getNavigationHistory', 'Page.navigateToHistoryEntry', 'Page.getLayoutMetrics',
  'Page.captureScreenshot', 'Page.handleJavaScriptDialog', 'Page.setInterceptFileChooserDialog',
  'Runtime.enable', 'Runtime.disable', 'Runtime.evaluate', 'Runtime.callFunctionOn',
  'Runtime.getProperties', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
  'Runtime.runIfWaitingForDebugger', 'Runtime.addBinding', 'Runtime.removeBinding',
  'DOM.enable', 'DOM.disable', 'DOM.describeNode', 'DOM.resolveNode', 'DOM.getDocument',
  'DOM.getContentQuads', 'DOM.getBoxModel', 'DOM.getFrameOwner', 'DOM.scrollIntoViewIfNeeded',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Input.dispatchTouchEvent', 'Input.dispatchDragEvent',
  'Network.enable', 'Network.disable', 'Network.getResponseBody', 'Network.getRequestPostData',
  'Network.setCacheDisabled', 'Network.setExtraHTTPHeaders', 'Network.setBypassServiceWorker',
  'Fetch.enable', 'Fetch.disable', 'Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest',
  'Log.enable', 'Log.disable', 'Emulation.setFocusEmulationEnabled',
  'Emulation.setEmulatedMedia', 'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride', 'Emulation.setUserAgentOverride',
  'Emulation.setTouchEmulationEnabled', 'Emulation.setDefaultBackgroundColorOverride',
  'Accessibility.enable', 'Accessibility.disable', 'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree', 'Debugger.enable', 'Debugger.disable',
  'Debugger.resume', 'Debugger.setSkipAllPauses', 'Target.setAutoAttach'
]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const RESERVED_ID = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const CLOSED = 'Host.closed';

function failure(message) {
  const error = new Error(message);
  error.code = -32000;
  return error;
}
function defaultNavigation(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      (!parsed.port || parsed.port === '443') &&
      (parsed.hostname === 'douyin.com' || parsed.hostname.endsWith('.douyin.com') ||
        parsed.hostname === 'iesdouyin.com' || parsed.hostname === 'www.iesdouyin.com');
  } catch { return false; }
}
function validGeneration(generation) {
  return (typeof generation === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(generation)) ||
    (Number.isSafeInteger(generation) && generation > 0);
}
function normalizeProxy(proxy) {
  if (!proxy) return null;
  let parsed;
  try { parsed = new URL(typeof proxy === 'string' ? proxy : proxy.server); }
  catch { throw failure('账号代理格式不正确'); }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol) ||
      !parsed.hostname || parsed.pathname !== '/' && parsed.pathname !== '' || parsed.search || parsed.hash)
    throw failure('账号代理格式不正确');
  const username = typeof proxy === 'object' ? proxy.username : decodeURIComponent(parsed.username);
  const password = typeof proxy === 'object' ? proxy.password : decodeURIComponent(parsed.password);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '1080');
  return { server: `${parsed.protocol}//${parsed.hostname}:${port}`, host: parsed.hostname,
    port: Number(port), username: String(username || ''), password: String(password || '') };
}

function createAccountBrowserHost({ window, appRoot, profileRoot, sendEvent = () => {},
  onState = () => {}, allowNavigation = defaultNavigation }) {
  if (!window || window.isDestroyed() || !path.isAbsolute(appRoot || ''))
    throw failure('账号浏览器宿主参数不完整');
  const rootDir = path.resolve(profileRoot || path.join(appRoot, 'data', 'electron-profiles'));
  if (profileRoot && !path.isAbsolute(profileRoot)) throw failure('账号目录必须为绝对路径');
  const accounts = new Map();
  const locks = new Map();
  let activeAccountId = null;
  let bounds = null;
  let disposed = false;
  let disposePromise;

  function emit(account, event) {
    try { sendEvent({ accountId: account.id, generation: account.generation, event }); }
    catch { /* The owner handles backend disconnect and disposes the host. */ }
  }
  function list() {
    return { accounts: [...accounts.values()].filter(account => !account.closing).map(account => ({
      id: account.id, name: account.name,
      url: account.view.webContents.isDestroyed() ? '' : account.view.webContents.getURL(),
      title: account.view.webContents.isDestroyed() ? '' : account.view.webContents.getTitle(),
      loading: !account.view.webContents.isDestroyed() && account.view.webContents.isLoading(),
      visible: account.visible
    })), activeAccountId, showRequested: false };
  }
  function publish(showRequested = false) {
    const state = { ...list(), showRequested: showRequested === true };
    try { onState(state); } catch { /* UI state cannot interrupt browser teardown. */ }
    return state;
  }
  function locked(accountId, operation) {
    const previous = locks.get(accountId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(accountId, current);
    void current.finally(() => { if (locks.get(accountId) === current) locks.delete(accountId); }).catch(() => {});
    return current;
  }
  function validatePath(accountId, profileDir) {
    if (typeof accountId !== 'string' || !SAFE_ID.test(accountId) || RESERVED_ID.test(accountId))
      throw failure('账号标识不合法');
    const expected = path.join(rootDir, accountId);
    if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir) ||
        path.resolve(profileDir).toLowerCase() !== expected.toLowerCase())
      throw failure('账号目录越界');
    // Reject existing junctions/symlinks anywhere along the trusted storage path.
    // Check before mkdir, so an account path cannot redirect writes outside it.
    let cursor = expected;
    while (cursor !== path.dirname(cursor)) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        throw failure('账号目录不能经过链接或连接点');
      cursor = path.dirname(cursor);
    }
    fs.mkdirSync(expected, { recursive: true });
    if (fs.realpathSync(expected).toLowerCase() !== expected.toLowerCase())
      throw failure('账号目录实际路径不一致');
    return expected;
  }
  function matches(accountId, generation) {
    if (disposed) throw failure('账号浏览器宿主已经关闭');
    const account = accounts.get(accountId);
    if (!account || account.closing || account.view.webContents.isDestroyed())
      throw failure('账号浏览器已经关闭');
    if (account.generation !== generation) throw failure('账号浏览器连接已失效');
    return account;
  }
  function mayNavigate(url) {
    if (url === 'about:blank') return true;
    try { return allowNavigation(url) === true; } catch { return false; }
  }
  function clampBounds() {
    if (!bounds || window.isDestroyed()) return null;
    const [width, height] = window.getContentSize();
    const x = Math.max(0, Math.min(Math.floor(bounds.x), width));
    const y = Math.max(66, Math.min(Math.floor(bounds.y), height));
    const right = Math.max(x, Math.min(Math.floor(bounds.x + bounds.width), width));
    const bottom = Math.max(y, Math.min(Math.floor(bounds.y + bounds.height), height));
    if (right - x < 1 || bottom - y < 1) return null;
    return { x, y, width: right - x, height: bottom - y };
  }
  function layout() {
    const rect = clampBounds();
    for (const account of accounts.values()) {
      const visible = !!rect && account.id === activeAccountId && !account.closing;
      account.visible = visible;
      if (visible) account.view.setBounds(rect);
      if (account.view.getVisible() !== visible) account.view.setVisible(visible);
      // Applying the preference before the native view is attached is not
      // sufficient: hiding a WebContentsView can suspend its compositor's rAF.
      // Reapply after visibility changes so Electron uses hidden-but-painting.
      if (!account.closing && !account.view.webContents.isDestroyed())
        account.view.webContents.setBackgroundThrottling(false);
    }
  }
  function show(id, { requestUI = true, generation } = {}) {
    if (disposed) throw failure('账号浏览器宿主已经关闭');
    const account = accounts.get(id);
    if (!account || account.closing) throw failure('账号浏览器已经关闭');
    if (generation !== undefined && account.generation !== generation) throw failure('账号浏览器连接已失效');
    activeAccountId = id;
    layout();
    if (account.visible) account.view.webContents.focus();
    return publish(requestUI);
  }
  function hide() {
    activeAccountId = null;
    layout();
    return publish();
  }
  function setBounds(rect) {
    if (rect === null || rect === undefined) bounds = null;
    else {
      if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.width < 0 || rect.height < 0)
        throw failure('账号浏览器显示区域不合法');
      bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    layout();
    return publish();
  }
  function targetInfo(account) {
    return { targetId: account.targetId, type: 'page', title: account.view.webContents.getTitle(),
      url: account.view.webContents.getURL(), attached: true, canAccessOpener: false,
      browserContextId: account.contextId };
  }
  function descriptor(account) {
    return { accountId: account.id, generation: account.generation, targetId: account.targetId,
      contextId: account.contextId, pageSession: account.pageSession };
  }
  function closedEvent(account, reason) {
    if (account.closedEventSent) return;
    account.closedEventSent = true;
    if (account.announced) emit(account, { method: 'Target.detachedFromTarget', params: {
      sessionId: account.pageSession, targetId: account.targetId } });
    emit(account, { method: CLOSED, params: { reason } });
  }
  function retainCommandRendering(account) {
    const wc = account.view.webContents;
    if (account.renderCommandCount === 0) {
      // A focused editor in a hidden native view can fall to 1 fps even with
      // backgroundThrottling:false. Hold Chromium's native capturer only while
      // a CDP operation needs rendering (not between operations). No frame is
      // saved, logged or forwarded; the original page/rAF and input stay intact.
      wc.beginFrameSubscription(true, () => {});
      account.renderSubscribed = true;
    }
    account.renderCommandCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      account.renderCommandCount = Math.max(0, account.renderCommandCount - 1);
      if (account.renderCommandCount === 0 && account.renderSubscribed) {
        account.renderSubscribed = false;
        if (!wc.isDestroyed()) wc.endFrameSubscription();
      }
    };
  }
  async function closeAccount(account, reason = 'closed') {
    if (account.closePromise) return account.closePromise;
    account.closing = true;
    if (activeAccountId === account.id) activeAccountId = null;
    layout();
    account.closePromise = (async () => {
      try {
        account.ses.flushStorageData();
        await account.ses.cookies.flushStore();
      } finally {
        account.renderCommandCount = 0;
        if (account.renderSubscribed) {
          account.renderSubscribed = false;
          if (!account.view.webContents.isDestroyed()) account.view.webContents.endFrameSubscription();
        }
        if (!window.isDestroyed()) window.contentView.removeChildView(account.view);
        if (!account.view.webContents.isDestroyed()) account.view.webContents.close({ waitForBeforeUnload: false });
        account.ses.removeListener('will-download', account.downloadHandler);
        account.ses.webRequest.onBeforeRequest(null);
        account.children.clear();
        account.manualSessions.clear();
        account.browserSessions.clear();
        if (accounts.get(account.id) === account) accounts.delete(account.id);
        closedEvent(account, reason);
        publish();
      }
    })();
    return account.closePromise;
  }
  async function open(options) {
    if (disposed || window.isDestroyed()) throw failure('账号浏览器宿主已经关闭');
    const { accountId, name, profileDir, proxy, visible = false, generation } = options || {};
    if (!validGeneration(generation)) throw failure('账号浏览器连接代次不合法');
    const storagePath = validatePath(accountId, profileDir);
    const proxyConfig = normalizeProxy(proxy);
    return locked(accountId, async () => {
      if (disposed || window.isDestroyed()) throw failure('账号浏览器宿主已经关闭');
      const previous = accounts.get(accountId);
      if (previous && !previous.closing && previous.generation === generation) {
        if (previous.proxyKey !== JSON.stringify(proxyConfig)) throw failure('代理变更后需重新打开账号浏览器');
        previous.name = String(name || previous.name).slice(0, 100);
        if (visible) show(accountId, { requestUI: false });
        return descriptor(previous);
      }
      if (previous) await closeAccount(previous, 'replaced');
      const ses = session.fromPath(storagePath);
      await ses.setProxy(proxyConfig ? { mode: 'fixed_servers', proxyRules: proxyConfig.server,
        proxyBypassRules: '<-loopback>' } : { mode: 'direct' });
      await ses.closeAllConnections();
      if (disposed || window.isDestroyed()) throw failure('账号浏览器宿主已经关闭');
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      const downloadHandler = event => event.preventDefault();
      ses.on('will-download', downloadHandler);
      ses.webRequest.onBeforeRequest((details, callback) => {
        let allowed = false;
        try {
          const url = new URL(details.url);
          allowed = details.resourceType === 'mainFrame' ? mayNavigate(details.url) :
            ['https:', 'wss:', 'data:', 'blob:', 'about:'].includes(url.protocol) ||
              (url.protocol === 'http:' && allowNavigation !== defaultNavigation && mayNavigate(details.url));
        } catch { /* Malformed or unsupported URLs are blocked. */ }
        callback({ cancel: !allowed });
      });
      const view = new WebContentsView({ webPreferences: { session: ses, nodeIntegration: false,
        nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
        backgroundThrottling: false, devTools: false } });
      const [contentWidth, contentHeight] = window.getContentSize();
      view.setBounds({ x: 0, y: 66, width: Math.max(1, contentWidth), height: Math.max(1, contentHeight - 66) });
      view.setVisible(false);
      window.contentView.addChildView(view);
      const account = { id: accountId, name: String(name || accountId).slice(0, 100), generation,
        ses, view, children: new Map(), manualSessions: new Map(), browserSessions: new Set(), renderCommandCount: 0, renderSubscribed: false, visible: false, closing: false,
        pageSession: `page-${crypto.randomUUID()}`, contextId: `account-${crypto.randomUUID()}`,
        proxyKey: JSON.stringify(proxyConfig), downloadHandler, announced: false };
      accounts.set(accountId, account);
      const wc = view.webContents;
      const stopNavigation = (event, url) => { if (!mayNavigate(url)) event.preventDefault(); };
      wc.on('will-navigate', stopNavigation);
      wc.on('will-redirect', (event, url, _inPlace, isMainFrame) => { if (isMainFrame) stopNavigation(event, url); });
      wc.on('will-attach-webview', event => event.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('login', (event, _details, authInfo, callback) => {
        event.preventDefault();
        if (authInfo.isProxy && proxyConfig && authInfo.host === proxyConfig.host && authInfo.port === proxyConfig.port)
          callback(proxyConfig.username, proxyConfig.password);
        else callback();
      });
      for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'])
        wc.on(event, () => publish());
      wc.on('render-process-gone', () => { void closeAccount(account, 'crashed').catch(() => {}); });
      wc.on('destroyed', () => {
        if (!account.closing) void closeAccount(account, 'destroyed').catch(() => {});
      });
      wc.debugger.on('detach', () => {
        if (!account.closing) void closeAccount(account, 'debugger_detached').catch(() => {});
      });
      wc.debugger.on('message', (_event, method, params, sessionId) => {
        if (account.closing || (sessionId && !account.children.has(sessionId) && !account.manualSessions.has(sessionId))) return;
        // A page's explicit second CDP attachment is not a new page or OOPIF.
        // Playwright creates that CDPSession from the command response, so do
        // not announce it through the automatic page-target event stream.
        if (method === 'Target.attachedToTarget' && !sessionId && params.targetInfo?.targetId === account.targetId) return;
        if (method === 'Target.detachedFromTarget' && account.manualSessions.has(params.sessionId)) {
          const manual = account.manualSessions.get(params.sessionId);
          account.manualSessions.delete(params.sessionId);
          if (account.announced) emit(account, { method, params, sessionId: manual.parent });
          return;
        }
        if (method === 'Target.attachedToTarget' && params.sessionId) {
          account.children.set(params.sessionId, { parent: sessionId || account.pageSession,
            targetId: params.targetInfo?.targetId });
          params = { ...params, targetInfo: { ...params.targetInfo, browserContextId: account.contextId } };
        } else if (method === 'Target.detachedFromTarget' && params.sessionId) {
          const remove = id => {
            for (const [childId, child] of account.children) if (child.parent === id) remove(childId);
            account.children.delete(id);
          };
          remove(params.sessionId);
        }
        if (account.announced) emit(account, { method, params, sessionId: sessionId || account.pageSession });
      });
      try {
        await wc.loadURL('about:blank');
        if (disposed || account.closing || window.isDestroyed()) throw failure('账号浏览器正在关闭');
        wc.setBackgroundThrottling(false);
        wc.debugger.attach('1.3');
        const actual = await wc.debugger.sendCommand('Target.getTargetInfo');
        if (disposed || account.closing || window.isDestroyed()) throw failure('账号浏览器正在关闭');
        account.targetId = actual.targetInfo.targetId;
        if (visible) show(accountId, { requestUI: false });
        else publish();
        return descriptor(account);
      } catch (error) {
        await closeAccount(account, 'open_failed');
        throw error;
      }
    });
  }
  async function close({ accountId, generation } = {}) {
    return locked(accountId, async () => {
      const account = accounts.get(accountId);
      if (!account) return { closed: true };
      if (account.generation !== generation) throw failure('账号浏览器连接已失效');
      await closeAccount(account);
      return { closed: true };
    });
  }
  function checkTarget(account, targetId, optional = false) {
    if ((!targetId && optional) || targetId === account.targetId) return;
    throw failure('禁止操作其他页面目标');
  }
  function cookieToCdp(cookie) {
    return { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: cookie.expirationDate ?? -1, size: Buffer.byteLength(cookie.name + cookie.value),
      httpOnly: cookie.httpOnly, secure: cookie.secure, session: cookie.session,
      sameSite: { no_restriction: 'None', lax: 'Lax', strict: 'Strict' }[cookie.sameSite] };
  }
  async function setCookies(account, cookies) {
    if (!Array.isArray(cookies) || cookies.length > 1000) throw failure('Cookie 参数不合法');
    const converted = cookies.map(cookie => {
      if (!cookie || cookie.partitionKey) throw failure('不支持写入分区 Cookie');
      const hostname = String(cookie.domain || '').replace(/^\./, '');
      const url = cookie.url || `${cookie.secure ? 'https' : 'http'}://${hostname}${cookie.path || '/'}`;
      let parsed;
      try { parsed = new URL(url); } catch { throw failure('Cookie 地址不合法'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw failure('Cookie 地址不合法');
      const result = { url, name: cookie.name, value: cookie.value, path: cookie.path || '/',
        secure: !!cookie.secure, httpOnly: !!cookie.httpOnly };
      if (cookie.domain?.startsWith('.')) result.domain = cookie.domain;
      if (cookie.expires !== undefined && cookie.expires !== -1) {
        if (!Number.isFinite(cookie.expires) || cookie.expires < 0) throw failure('Cookie 过期时间不合法');
        result.expirationDate = cookie.expires;
      }
      if (cookie.sameSite) {
        result.sameSite = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' }[cookie.sameSite];
        if (!result.sameSite) throw failure('Cookie SameSite 不合法');
      }
      return result;
    });
    for (const cookie of converted) await account.ses.cookies.set(cookie);
    return {};
  }
  async function command({ accountId, generation, command: input } = {}) {
    const account = matches(accountId, generation);
    if (!input || typeof input.method !== 'string') throw failure('CDP 请求不合法');
    const { method, sessionId } = input;
    const params = input.params || {};
    if (typeof params !== 'object' || Array.isArray(params)) throw failure('CDP 参数不合法');
    if (params.browserContextId && params.browserContextId !== account.contextId)
      throw failure('禁止操作其他账号上下文');
    if (account.browserSessions.has(sessionId)) {
      if (method === 'Target.attachToTarget') {
        checkTarget(account, params.targetId);
        if (params.flatten !== true) throw failure('仅支持扁平独立会话');
        if (account.manualSessions.size >= 16) throw failure('账号独立会话数量已达上限');
        const result = await account.view.webContents.debugger.sendCommand('Target.attachToTarget', {
          targetId: account.targetId, flatten: true });
        if (disposed || account.closing || !account.browserSessions.has(sessionId)) {
          await account.view.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId: result.sessionId }).catch(() => {});
          throw failure('账号浏览器连接已失效');
        }
        account.manualSessions.set(result.sessionId, { parent: sessionId, targetId: account.targetId });
        return result;
      }
      if (method === 'Target.detachFromTarget') {
        const manual = account.manualSessions.get(params.sessionId);
        if (!manual || manual.parent !== sessionId) throw failure('禁止分离其他页面会话');
        await account.view.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId: params.sessionId });
        // Chromium normally emits detached before the reply. If it does not,
        // close the same scoped session here without touching the primary page.
        if (account.manualSessions.has(params.sessionId)) {
          account.manualSessions.delete(params.sessionId);
          emit(account, { method: 'Target.detachedFromTarget', sessionId, params: {
            sessionId: params.sessionId, targetId: account.targetId } });
        }
        return {};
      }
      throw failure(`不支持的账号浏览器会话命令：${method}`);
    }
    if (sessionId) {
      if (sessionId !== account.pageSession && !account.children.has(sessionId) && !account.manualSessions.has(sessionId))
        throw failure('禁止操作其他页面会话');
      if (method === 'Page.bringToFront') { show(accountId, { requestUI: false }); return {}; }
      if (method === 'Page.close') {
        if (sessionId !== account.pageSession) throw failure('禁止通过子会话关闭页面');
        await close({ accountId, generation }); return {};
      }
      if (!PAGE_METHODS.has(method)) throw failure(`不支持的页面命令：${method}`);
      if (method === 'Page.navigate' && !mayNavigate(params.url)) throw failure('禁止导航到非平台页面');
      if (method === 'Fetch.continueRequest' && params.url !== undefined && !mayNavigate(params.url))
        throw failure('禁止重写导航到非平台页面');
      if (method === 'Target.setAutoAttach' && params.flatten !== true)
        throw failure('仅支持扁平子会话');
      const releaseRendering = method === 'Runtime.callFunctionOn' ||
        method === 'DOM.scrollIntoViewIfNeeded' || method.startsWith('Input.') ? retainCommandRendering(account) : null;
      try {
        return await account.view.webContents.debugger.sendCommand(method, params,
          sessionId === account.pageSession ? undefined : sessionId);
      } finally { releaseRendering?.(); }
    }
    switch (method) {
      case 'Browser.getVersion': return { protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`,
        revision: 'electron-account-browser', userAgent: account.view.webContents.getUserAgent(), jsVersion: process.versions.v8 };
      case 'Target.setAutoAttach':
        if (params.flatten !== true) throw failure('仅支持扁平页面会话');
        if (params.autoAttach) {
          account.announced = true;
          emit(account, { method: 'Target.attachedToTarget', params: { sessionId: account.pageSession,
            targetInfo: targetInfo(account), waitingForDebugger: false } });
        } else account.announced = false;
        return {};
      case 'Target.getTargetInfo': checkTarget(account, params.targetId, true); return { targetInfo: targetInfo(account) };
      case 'Target.getTargets': return { targetInfos: [targetInfo(account)] };
      case 'Target.attachToBrowserTarget': {
        // This is a capability-scoped virtual browser session, never Chromium's
        // global browser target. It can only attach this account's page above.
        if (account.browserSessions.size >= 16) throw failure('账号浏览器会话数量已达上限');
        const virtualSession = `browser-${crypto.randomUUID()}`;
        account.browserSessions.add(virtualSession);
        return { sessionId: virtualSession };
      }
      case 'Target.detachFromTarget': {
        if (!account.browserSessions.has(params.sessionId)) throw failure('禁止分离其他浏览器会话');
        for (const [manualId, manual] of account.manualSessions) {
          if (manual.parent !== params.sessionId) continue;
          await account.view.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId: manualId });
          account.manualSessions.delete(manualId);
        }
        account.browserSessions.delete(params.sessionId);
        emit(account, { method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId } });
        return {};
      }
      case 'Target.activateTarget': checkTarget(account, params.targetId); show(accountId, { requestUI: false }); return {};
      case 'Target.closeTarget': checkTarget(account, params.targetId); await close({ accountId, generation }); return { success: true };
      case 'Browser.setDownloadBehavior': return {}; // Electron always denies the download itself.
      case 'Storage.getCookies': return { cookies: (await account.ses.cookies.get({})).map(cookieToCdp) };
      case 'Storage.setCookies': return setCookies(account, params.cookies);
      case 'Storage.clearCookies': await account.ses.clearStorageData({ storages: ['cookies'] }); return {};
      default: throw failure(`不支持的浏览器命令：${method}`);
    }
  }
  function controlTarget() {
    const account = accounts.get(activeAccountId);
    return account && !account.closing && !disposed ? { accountId: account.id, generation: account.generation } : null;
  }
  function navigateHistory(kind, expected) {
    if (disposed) throw failure('账号浏览器宿主已经关闭');
    if (expected !== undefined && (!expected || expected.accountId !== activeAccountId))
      throw failure('账号浏览器已切换，请重新操作');
    const account = accounts.get(activeAccountId);
    if (expected && (!account || account.generation !== expected.generation))
      throw failure('账号浏览器已重新打开，请重新操作');
    if (!account || account.closing) return list();
    const wc = account.view.webContents;
    if (kind === 'reload') wc.reload();
    else if (kind === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (kind === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    return publish();
  }
  const onResize = () => { layout(); publish(); };
  window.on('resize', onResize);
  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    window.removeListener('resize', onResize);
    disposePromise = (async () => {
      await Promise.allSettled([...locks.values()]);
      const results = await Promise.allSettled([...accounts.values()].map(account => closeAccount(account, 'disposed')));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return disposePromise;
  }
  return { open, close, command, show, hide, setBounds, list, dispose, controlTarget,
    back: target => navigateHistory('back', target), forward: target => navigateHistory('forward', target),
    reload: target => navigateHistory('reload', target) };
}

module.exports = { createAccountBrowserHost };
