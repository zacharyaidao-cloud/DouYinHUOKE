'use strict';

// Fixed local smoke checks. This module does not create an account, obtain an
// authorization session, launch a platform page or bypass a product guard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function checkWorkbench() {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const api = window.desktop?.browser;
  const methods = ['list', 'show', 'hide', 'setBounds', 'back', 'forward', 'reload', 'onState'];
  check(api && methods.every(key => typeof api[key] === 'function'), '内嵌浏览器预载 API 缺失');
  check(Object.keys(api).sort().join(',') === methods.slice().sort().join(','), '预载 API 暴露了预期外的能力');
  check(typeof require === 'undefined' && typeof process === 'undefined' && typeof window.ipcRenderer === 'undefined', 'renderer 存在 Node/IPC 泄露');
  const empty = value => value && Array.isArray(value.accounts) && value.accounts.length === 0 && value.activeAccountId === null && value.showRequested === false;
  check(empty(await api.list()), '隔离首次启动不应有账号浏览器');
  check(empty(await api.hide()), '空账号隐藏返回值异常');
  check(empty(await api.setBounds({ x: 220, y: 180, width: 900, height: 580 })), '合法显示区域未经过 IPC');
  check(empty(await api.setBounds({ x: 0, y: 0, width: 0, height: 0 })), '零尺寸区域未经过 IPC');
  async function rejected(operation, pattern, label) {
    try { await operation(); } catch (error) {
      check(pattern.test(String(error?.message || error)), label + '错误类型不正确');
      return true;
    }
    throw new Error(label + '未拒绝');
  }
  let invalidBoundsRejected = 0;
  for (const rect of [null, {}, { x: NaN, y: 10, width: 100, height: 100 }, { x: 0, y: 0, width: -1, height: 100 }]) {
    await rejected(() => api.setBounds(rect), /区域.*(?:无效|不合法)/, '无效浏览器区域');
    invalidBoundsRejected++;
  }
  await rejected(() => api.show('smoke-nonexistent-account'), /账号浏览器已经关闭/, '不存在的账号');
  let navigationAuthorizationRejected = 0;
  for (const method of ['back', 'forward', 'reload']) {
    await rejected(() => api[method](), /请先登录客户端/, '未登录导航 ' + method);
    navigationAuthorizationRejected++;
  }
  const events = [];
  let invalidCallbackRejected = false;
  try { api.onState(null); } catch (error) { invalidCallbackRejected = /状态回调无效/.test(error.message); }
  check(invalidCallbackRejected, '非法状态回调未拒绝');
  const unsubscribe = api.onState(value => events.push(value));
  check(typeof unsubscribe === 'function', '状态订阅没有退订句柄');
  try {
    await api.hide();
    for (let i = 0; !events.length && i < 50; i++) await pause(10);
    check(events.length > 0 && events.every(empty), '状态事件不符合空账号契约');
    unsubscribe();
    await pause(30);
    const count = events.length;
    await api.hide();
    await pause(50);
    check(events.length === count, '退订后仍收到状态事件');
  } finally { unsubscribe(); }

  const nav = document.querySelector('#nav [data-page="browser"]');
  const requiredIds = ['page-browser', 'browser-tabs', 'browser-view-slot', 'browser-empty', 'btn-browser-workspace', 'btn-browser-back', 'btn-browser-forward', 'btn-browser-reload'];
  check(nav && requiredIds.every(id => document.getElementById(id)), '账号浏览器页面入口或控件缺失');
  const buildLabel = document.getElementById('client-build');
  check(buildLabel?.textContent === '客户端 ' + window.desktop.version + ' · 双浏览器模式', '侧栏客户端版本与实际预载版本不一致');
  check(buildLabel.getClientRects().length > 0 && getComputedStyle(buildLabel).fontSize === '15px', '侧栏版本不可见或字号不一致');
  check(document.getElementById('browser-url')?.readOnly === true, '账号网址必须只读');
  check(document.getElementById('browser-empty-detail').textContent.includes('账号管理'), '空账号缺少入口指引');
  check(document.getElementById('browser-upgrade-note').textContent.includes('重新扫码'), '缺少首次内嵌资料提示');
  nav.click();
  await pause(30);
  check(!document.getElementById('page-browser').classList.contains('hidden'), '账号浏览器导航未接线');
  check(['btn-browser-back', 'btn-browser-forward', 'btn-browser-reload'].every(id => document.getElementById(id).disabled), '空账号导航按钮应禁用');
  check(getComputedStyle(document.getElementById('login-layer')).display !== 'none', '页面导航不得绕过软件登录');
  check(!sessionStorage.getItem('dy_token'), '冒烟不能创建授权令牌');
  document.getElementById('btn-browser-workspace').click();
  await pause(30);
  check(document.getElementById('page-browser').classList.contains('hidden'), '返回工作台未接线');
  const stop = document.getElementById('btn-global-stop');
  check(stop && !stop.disabled && /停止所有任务/.test(stop.textContent), '全局停止控件缺失或禁用');
  check(empty(await api.list()), '测试操作不应创建或显示账号');
  const externalResources = performance.getEntriesByType('resource').filter(entry => {
    try { return new URL(entry.name).origin !== location.origin; } catch { return true; }
  }).map(entry => entry.name);
  check(externalResources.length === 0, '工作台访问了外部资源');
  return { title: document.title, version: window.desktop.version, nodeAvailable: typeof require !== 'undefined', isolated: !!window.desktop,
    browserApiCount: methods.length, browserUiPresent: true, readOnlyAddress: true, emptyAccountList: true,
    hideWorks: true, boundsWorks: true, invalidBoundsRejected, navigationAuthorizationRejected,
    unknownAccountRejected: true, stateEventsWork: true, stateUnsubscribeWorks: true, loginStillRequired: true,
    globalStopPresent: true, visibleClientVersion: true, noExternalRequests: true };
}

async function runDesktopSmoke({ window, backendOrigin }) {
  const { app, BrowserWindow, session } = require('electron');
  const dataDir = path.resolve(process.env.DY_LEAD_DATA_DIR || '');
  const resultFile = path.resolve(process.env.DY_LEAD_DESKTOP_SMOKE_RESULT || '');
  const fixtureDir = path.dirname(dataDir);
  assert.equal(process.env.DY_LEAD_DESKTOP_SMOKE, '1', '仅允许显式桌面冒烟模式');
  assert.match(path.basename(fixtureDir), /^qa-desktop-[a-f0-9]+$/i, '仅允许唯一 QA 数据目录');
  assert.equal(path.basename(dataDir), 'data');
  assert.equal(path.dirname(resultFile), fixtureDir);
  assert.equal(path.resolve(app.getPath('userData')), path.join(fixtureDir, 'desktop-userdata'));
  const parsed = new URL(backendOrigin);
  assert.equal(parsed.protocol, 'http:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(window.webContents.getURL(), backendOrigin + '/');
  const externalRequests = [];
  const observe = details => { try { if (new URL(details.url).origin !== backendOrigin) externalRequests.push(details.url); } catch { externalRequests.push('invalid'); } };
  // These observer slots are unused by the product. Do not replace its request
  // allowlist or nonce injection hooks.
  window.webContents.session.webRequest.onCompleted(observe);
  window.webContents.session.webRequest.onErrorOccurred(observe);
  let untrusted;
  try {
    const result = await window.webContents.executeJavaScript('(' + checkWorkbench.toString() + ')()');
    assert.equal(result.title, '抖音获客软件');
    const forbidden = await fetch(backendOrigin + '/api/state');
    assert.equal(forbidden.status, 403, '缺少桌面 nonce 的 API 请求必须拒绝');
    const testSession = session.fromPartition('huamao-smoke-untrusted-' + crypto.randomBytes(10).toString('hex'));
    testSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }));
    untrusted = new BrowserWindow({ show: false, webPreferences: { session: testSession, preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await untrusted.loadURL('data:text/html,<title>isolated untrusted sender</title>');
    const untrustedIpcRejected = await untrusted.webContents.executeJavaScript(`(async () => {
      if (typeof require !== 'undefined' || !window.desktop?.browser) throw new Error('隔离窗口预载异常');
      let rejected = 0;
      for (const action of [() => window.desktop.browser.list(), () => window.desktop.browser.hide(), () => window.desktop.browser.setBounds({x:0,y:0,width:100,height:100})]) {
        try { await action(); } catch (error) { if (/IPC sender 不合法/.test(error.message)) { rejected++; continue; } throw error; }
      }
      if (rejected !== 3) throw new Error('非工作台 renderer 可以调用管理 IPC');
      return rejected;
    })()`);
    assert.equal(externalRequests.length, 0, '冒烟工作台不得访问外部地址');
    const children = window.contentView.children;
    assert(children.every(view => !view.webContents || view.webContents === window.webContents), '冒烟不得创建账号网页视图');
    for (const name of ['accounts.json', 'leads.json', 'plans.json']) {
      const file = path.join(dataDir, name);
      if (fs.existsSync(file)) assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [], '冒烟不应产生业务数据：' + name);
    }
    for (const name of ['chrome-profiles', 'electron-profiles']) {
      const directory = path.join(dataDir, name);
      if (fs.existsSync(directory)) assert.deepEqual(fs.readdirSync(directory), [], '冒烟不应创建账号资料：' + name);
    }
    return { ...result, apiProtected: true, untrustedIpcRejected, nativeViewsAbsent: true,
      isolatedDataConfirmed: true, livePlatform: false, productionDataRead: false };
  } finally {
    if (untrusted && !untrusted.isDestroyed()) untrusted.destroy();
    window.webContents.session.webRequest.onCompleted(null);
    window.webContents.session.webRequest.onErrorOccurred(null);
  }
}

module.exports = { runDesktopSmoke };
