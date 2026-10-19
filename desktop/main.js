const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertNoLegacyService } = require('./legacy-preflight');
const { createAccountBrowserHost } = require('./account-browser-host');
let mainWindow, backend, backendOrigin, browserHost, bootFailed = false, quitting = false, shutdownComplete = false;
const controlChecks = new Map();
const appRoot = app.isPackaged ? path.resolve(process.resourcesPath, '..') : path.resolve(__dirname, '..', 'dy-lead-app');
const desktopToken = crypto.randomBytes(32).toString('hex');
app.setName('抖音获客软件');
// 安装版和绿色版共用 single-instance 锁，防止同时写同一份数据。
app.setPath('userData', process.env.DY_LEAD_DESKTOP_SMOKE === '1' && process.env.DY_LEAD_DESKTOP_SMOKE_RESULT ?
  path.join(path.dirname(process.env.DY_LEAD_DESKTOP_SMOKE_RESULT), 'desktop-userdata') :
  path.join(app.getPath('appData'), 'Huamao', 'DouyinLeadDesktop'));
app.enableSandbox();
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  app.whenReady().then(start).catch(fail);
}
function writeLog(text) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'startup.log'), new Date().toISOString() + ' ' + text + '\n', 'utf8');
  } catch { /* 启动仍继续，错误以窗口展示 */ }
}
function fail(error) {
  if (bootFailed || quitting) return;
  bootFailed = true; writeLog(error.message || String(error));
  if (process.env.DY_LEAD_DESKTOP_SMOKE === '1' && process.env.DY_LEAD_DESKTOP_SMOKE_RESULT) {
    fs.writeFileSync(process.env.DY_LEAD_DESKTOP_SMOKE_RESULT, JSON.stringify({ ok: false, error: error.message || String(error) }), 'utf8');
  } else dialog.showErrorBox('抖音获客软件启动失败', (error.message || String(error)) + '\n启动日志位于软件用户数据目录的 logs/startup.log。');
  app.quit();
}
function sendBackend(message) {
  if (!backend?.connected) return false;
  try { backend.send(message, () => {}); return true; } catch { return false; }
}
function checkBrowserControl() {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controlChecks.delete(id); sendBackend({ type: 'embedded:control-release', id });
      reject(new Error('操作检查超时，请稍后重试'));
    }, 8000);
    controlChecks.set(id, { timer, resolve, reject });
    if (!sendBackend({ type: 'embedded:control-check', id })) {
      clearTimeout(timer); controlChecks.delete(id); reject(new Error('后台服务尚未就绪'));
    }
  });
}
async function handleBrowserRequest(message) {
  if (!browserHost || typeof message.id !== 'string' || message.id.length > 128) return;
  const { id, op, accountId, generation, payload } = message;
  try {
    let result;
    switch (op) {
      case 'open': result = await browserHost.open({ ...payload, accountId, generation }); break;
      case 'close': result = await browserHost.close({ accountId, generation }); break;
      case 'show': result = await browserHost.show(accountId, { generation }); break;
      case 'command': result = await browserHost.command({ accountId, generation, command: payload }); break;
      default: throw new Error('不支持的账号浏览器操作');
    }
    sendBackend({ type: 'embedded:reply', id, result });
  } catch (error) {
    // Protocol errors are returned only to the trusted backend, never to a page.
    sendBackend({ type: 'embedded:reply', id, error: { code: error.code || 'EMBEDDED_BROWSER_ERROR', message: String(error.message || '账号浏览器操作失败').slice(0, 500) } });
  }
}
async function start() {
  const executable = path.join(appRoot, 'node.exe'), script = path.join(appRoot, 'server.js');
  if (!fs.existsSync(executable) || !fs.existsSync(script)) throw new Error('程序文件不完整，请重新安装完整安装包。');
  const smokeDataDir = process.env.DY_LEAD_DATA_DIR && path.resolve(process.env.DY_LEAD_DATA_DIR);
  // 自动 smoke 仅在显式临时 QA 目录隔离业务数据时，允许与旧服务同时验证界面。
  const isolatedSmoke = process.env.DY_LEAD_DESKTOP_SMOKE === '1' && smokeDataDir &&
    /^qa-desktop-[a-f0-9]+$/i.test(path.basename(path.dirname(smokeDataDir))) &&
    path.basename(smokeDataDir) === 'data' && smokeDataDir !== path.join(appRoot, 'data');
  if (!isolatedSmoke) await assertNoLegacyService({ oldPort: process.env.DY_LEAD_PORT });
  const runtimeSession = session.fromPartition('huamao-ui-' + crypto.randomBytes(8).toString('hex'));
  runtimeSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  runtimeSession.setPermissionCheckHandler(() => false);
  mainWindow = new BrowserWindow({ width: 1360, height: 880, minWidth: 1050, minHeight: 700,
    title: '抖音获客软件', icon: path.join(appRoot, 'icon.ico'), show: false,
    webPreferences: { session: runtimeSession, preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false } });
  mainWindow.removeMenu();
  mainWindow.on('close', event => {
    if (!shutdownComplete) { event.preventDefault(); app.quit(); }
  });
  // nonce 仅在主进程中；浏览器与其他进程不能直接调用客户软件 API。
  runtimeSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = backendOrigin && new URL(details.url).origin === backendOrigin;
    callback({ cancel: !allowed });
  });
  runtimeSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (backendOrigin && new URL(details.url).origin === backendOrigin) headers['x-desktop-token'] = desktopToken;
    callback({ requestHeaders: headers });
  });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!backendOrigin || new URL(url).origin !== backendOrigin) event.preventDefault(); });
  mainWindow.webContents.on('will-redirect', (event, url) => { if (!backendOrigin || new URL(url).origin !== backendOrigin) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('render-process-gone', (_event, details) => fail(new Error('桌面界面进程退出：' + details.reason)));
  const checkSender = event => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== backendOrigin) throw new Error('IPC sender 不合法');
  };
  ipcMain.handle('desktop:minimize', event => { checkSender(event); mainWindow.minimize(); });
  ipcMain.handle('desktop:close', event => { checkSender(event); mainWindow.close(); });
  ipcMain.handle('desktop:browser:list', event => { checkSender(event); return browserHost?.list() || { accounts: [], activeAccountId: null, showRequested: false }; });
  ipcMain.handle('desktop:browser:show', (event, id) => { checkSender(event); return browserHost?.show(String(id)); });
  ipcMain.handle('desktop:browser:hide', event => { checkSender(event); return browserHost?.hide(); });
  ipcMain.handle('desktop:browser:bounds', (event, rect) => {
    checkSender(event);
    if (!rect || !['x', 'y', 'width', 'height'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key]))) throw new Error('浏览器区域无效');
    const zoom = mainWindow.webContents.getZoomFactor();
    return browserHost?.setBounds(Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(rect[key] * zoom)])));
  });
  for (const command of ['back', 'forward', 'reload']) ipcMain.handle('desktop:browser:' + command, async event => {
    checkSender(event);
    const target = browserHost?.controlTarget();
    const leaseId = await checkBrowserControl();
    try { checkSender(event); return browserHost?.[command](target); }
    finally { sendBackend({ type: 'embedded:control-release', id: leaseId }); }
  });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('后台服务未在 30 秒内就绪，请查看启动日志。')), 30000);
    let buffer = '';
    backend = spawn(executable, [script], { cwd: appRoot, windowsHide: true,
      env: { ...process.env, DY_LEAD_PORT: '0', DY_LEAD_NO_OPEN: '1', DY_LEAD_DESKTOP_TOKEN: desktopToken, DY_LEAD_EMBEDDED_BROWSER: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const acceptReady = (port, dataDir) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535 || backendOrigin) return;
      if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) return;
      browserHost = createAccountBrowserHost({ window: mainWindow, appRoot, profileRoot: path.join(dataDir, 'electron-profiles'),
        sendEvent: message => sendBackend({ type: 'embedded:event', ...message }),
        onState: state => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:browser-state', state); } });
      backendOrigin = 'http://127.0.0.1:' + port; clearTimeout(timeout); resolve();
    };
    backend.on('message', message => {
      if (message?.type === 'ready') acceptReady(message.port, message.dataDir);
      else if (message?.type === 'embedded:request') void handleBrowserRequest(message);
      else if (message?.type === 'embedded:control-result') {
        const entry = controlChecks.get(message.id);
        if (!entry) { if (message.ok) sendBackend({ type: 'embedded:control-release', id: message.id }); return; }
        clearTimeout(entry.timer); controlChecks.delete(message.id);
        if (message.ok) entry.resolve(message.id); else entry.reject(new Error(message.error || '当前不能操作账号浏览器'));
      }
    });
    backend.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        writeLog(line);
        // Ready travels over the inherited private IPC pipe, including DATA_DIR.
      }
    });
    backend.stderr.on('data', chunk => writeLog(chunk.toString('utf8')));
    backend.once('error', error => { clearTimeout(timeout); reject(error); });
    backend.once('exit', code => {
      clearTimeout(timeout);
      if (!backendOrigin) reject(new Error('后台服务提前退出，退出码 ' + code));
      else if (!quitting) fail(new Error('后台服务意外退出，退出码 ' + code));
    });
  });
  await ready;
  await mainWindow.loadURL(backendOrigin + '/');
  mainWindow.show();
  // 仅供本地包验证；不会登录、启动任务或访问平台。
  if (process.env.DY_LEAD_DESKTOP_SMOKE === '1') {
    const result = await require('./smoke-checks').runDesktopSmoke({ window: mainWindow, backendOrigin });
    fs.writeFileSync(process.env.DY_LEAD_DESKTOP_SMOKE_RESULT || path.join(appRoot, 'desktop-smoke.json'), JSON.stringify({ ok: true, ...result }), 'utf8');
    app.quit();
  }
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  for (const pending of controlChecks.values()) { clearTimeout(pending.timer); pending.reject(new Error('程序正在退出')); }
  controlChecks.clear();
  void (async () => {
    // 主窗口保持存活，等后台停止任务及账号会话落盘后再销毁网页。
    if (backend && backend.exitCode === null && backend.signalCode === null) await new Promise(resolve => {
      const finished = () => { clearTimeout(timer); backend.removeListener('exit', finished); resolve(); };
      const timer = setTimeout(() => { backend.kill(); finished(); }, 8000);
      backend.once('exit', finished);
      sendBackend({ type: 'shutdown' });
    });
    await browserHost?.dispose();
  })().catch(error => writeLog('关闭账号浏览器：' + String(error.message || error)))
    .finally(() => { shutdownComplete = true; app.quit(); });
});
