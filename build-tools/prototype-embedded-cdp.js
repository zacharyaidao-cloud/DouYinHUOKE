'use strict';

// Isolated feasibility probe only. Run with the bundled Electron executable.
// This is intentionally not imported by the application or its build pipeline.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const playwrightRoot = path.join(root, 'dy-lead-app', 'node_modules', 'playwright-core');
const bundle = require(path.join(playwrightRoot, 'lib', 'utilsBundle.js'));

if (process.argv.includes('--client')) client().catch(error => {
  process.send?.({ type: 'result', result: { ok: false, error: error.stack } });
  process.exitCode = 1;
});
else main().catch(error => {
  console.error(error.stack);
  require('electron').app.exit(1);
});

async function main() {
  const { app, BrowserWindow, WebContentsView, session } = require('electron');
  const { spawn } = require('child_process');
  const runDir = fs.mkdtempSync(path.join(__dirname, 'qa-embedded-cdp-'));
  app.setPath('userData', path.join(runDir, 'electron-user-data'));
  app.enableSandbox();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL('data:text/html,<title>isolated workbench</title>');
  const accounts = new Map();
  const methods = new Set();
  let child;
  for (const id of ['a', 'b']) {
    const ses = session.fromPath(path.join(runDir, 'accounts', id));
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', event => event.preventDefault());
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: !(['about:', 'data:'].includes(url.protocol) ||
        (url.protocol === 'http:' && url.hostname === '127.0.0.1')) });
    });
    const view = new WebContentsView({ webPreferences: { session: ses,
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, backgroundThrottling: false } });
    window.contentView.addChildView(view);
    view.setBounds({ x: id === 'a' ? 0 : 550, y: 0, width: 550, height: 760 });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await view.webContents.loadURL('about:blank');
    view.webContents.debugger.attach('1.3');
    const actualTarget = await view.webContents.debugger.sendCommand('Target.getTargetInfo');
    const account = { id, ses, view, pageSession: `page-${id}`,
      contextId: `context-${id}`, targetId: actualTarget.targetInfo.targetId, children: new Set() };
    accounts.set(id, account);
    view.webContents.debugger.on('message', (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget' && params.sessionId)
        account.children.add(params.sessionId);
      if (method === 'Target.detachedFromTarget' && params.sessionId)
        account.children.delete(params.sessionId);
      child?.send({ type: 'cdp-event', accountId: id, event: {
        method, params, sessionId: sessionId || account.pageSession } });
    });
  }
  child = spawn(path.join(root, 'dy-lead-app', 'node.exe'), [__filename, '--client'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const timeout = setTimeout(() => finish({ ok: false, error: 'Probe timed out' }), 65000);
  let finished = false;
  async function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    result.electron = process.versions.electron;
    result.chromium = process.versions.chrome;
    result.methods = [...methods].sort();
    result.livePlatform = false;
    result.productionDataRead = false;
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, resultPath: path.join(runDir, 'result.json') }));
    child.kill();
    for (const account of accounts.values()) account.view.webContents.close();
    window.destroy();
    app.exit(result.ok ? 0 : 1);
  }
  const targetInfo = account => ({ targetId: account.targetId, type: 'page',
    title: 'isolated account fixture', url: account.view.webContents.getURL(),
    attached: true, canAccessOpener: false, browserContextId: account.contextId });
  child.on('message', async message => {
    if (message.type === 'result') return finish(message.result);
    if (message.type !== 'cdp-command') return;
    const { accountId, requestId, command } = message;
    const account = accounts.get(accountId);
    const reply = payload => child.send({ type: 'cdp-reply', accountId, requestId, ...payload });
    try {
      if (!account) throw new Error('Unknown account capability');
      const { method, params = {}, sessionId } = command;
      methods.add(`${sessionId ? 'page' : 'browser'}:${method}`);
      let result;
      if (sessionId) {
        if (sessionId !== account.pageSession && !account.children.has(sessionId))
          throw new Error('Foreign session rejected');
        const allowedDomains = new Set(['Page', 'Runtime', 'DOM', 'CSS', 'Input', 'Network',
          'Log', 'Emulation', 'Accessibility', 'Debugger', 'Performance', 'Security']);
        if (!allowedDomains.has(method.split('.')[0]) && method !== 'Target.setAutoAttach')
          throw new Error(`Page method denied: ${method}`);
        result = await account.view.webContents.debugger.sendCommand(method, params,
          sessionId === account.pageSession ? undefined : sessionId);
      } else {
        if (params.browserContextId && params.browserContextId !== account.contextId)
          throw new Error('Foreign browser context rejected');
        switch (method) {
          case 'Browser.getVersion':
            result = { protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`,
              revision: 'embedded-prototype', userAgent: account.view.webContents.getUserAgent(),
              jsVersion: process.versions.v8 };
            break;
          case 'Target.setAutoAttach':
            if (params.autoAttach) child.send({ type: 'cdp-event', accountId, event: {
              method: 'Target.attachedToTarget', params: { sessionId: account.pageSession,
                targetInfo: targetInfo(account), waitingForDebugger: false } } });
            result = {};
            break;
          case 'Target.getTargetInfo':
            if (params.targetId && params.targetId !== account.targetId)
              throw new Error('Foreign target rejected');
            result = { targetInfo: targetInfo(account) };
            break;
          case 'Browser.setDownloadBehavior':
            // The owning Electron session always denies downloads in this probe.
            result = {};
            break;
          case 'Storage.getCookies':
            result = { cookies: (await account.ses.cookies.get({})).map(cookie => ({
              name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
              expires: cookie.expirationDate ?? -1, size: cookie.name.length + cookie.value.length,
              httpOnly: cookie.httpOnly, secure: cookie.secure, session: cookie.session,
              sameSite: { no_restriction: 'None', lax: 'Lax', strict: 'Strict' }[cookie.sameSite]
            })) };
            break;
          default: throw new Error(`Browser method denied: ${method}`);
        }
      }
      reply({ result });
    } catch (error) { reply({ error: { code: -32000, message: error.message } }); }
  });
  child.on('exit', code => {
    if (!finished) void finish({ ok: false, error: `Client exited ${code} without result` });
  });
}

async function client() {
  const { chromium } = require(playwrightRoot);
  const { ws: WebSocket, wsServer: WebSocketServer } = bundle;
  const secrets = new Map(['a', 'b'].map(id => [id, crypto.randomBytes(32).toString('hex')]));
  const clients = new Map();
  const pending = new Map();
  let requestId = 0;
  let clicks = 0;
  const body = Buffer.from([0, 255, 1, 128, 10, 13, 254]);
  const fixture = http.createServer((req, res) => {
    if (req.url === '/binary') { clicks++; res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(body); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>local only</title><input id="draft"><button id="send" onclick="fetch(\'/binary\').then(r=>r.arrayBuffer()).then(b=>document.body.dataset.received=b.byteLength)">Local fixture request</button>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const id = /^\/account\/([ab])$/.exec(req.url)?.[1];
    if (!id || req.headers.origin || req.headers.authorization !== `Bearer ${secrets.get(id)}` ||
      req.headers.host !== `127.0.0.1:${server.address().port}` || clients.has(id)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      clients.set(id, ws);
      ws.on('close', () => { if (clients.get(id) === ws) clients.delete(id); });
      ws.on('message', data => {
        const command = JSON.parse(data.toString());
        const reqId = ++requestId;
        pending.set(reqId, { ws, id: command.id, sessionId: command.sessionId });
        process.send({ type: 'cdp-command', accountId: id, requestId: reqId, command });
      });
    });
  });
  process.on('message', message => {
    if (message.type === 'cdp-event') {
      const ws = clients.get(message.accountId);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message.event));
    }
    if (message.type === 'cdp-reply') {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify({ id: entry.id,
        sessionId: entry.sessionId, ...(message.error ? { error: message.error } : { result: message.result }) }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = id => `ws://127.0.0.1:${server.address().port}/account/${id}`;
  const rejected = headers => new Promise(resolve => {
    const ws = new WebSocket(endpoint('a'), { headers });
    ws.on('unexpected-response', (_req, res) => { const status = res.statusCode; res.resume(); ws.terminate(); resolve(status); });
    ws.on('error', () => {});
    ws.on('open', () => { ws.close(); resolve(101); });
  });
  assert.equal(await rejected({}), 403);
  assert.equal(await rejected({ Authorization: `Bearer ${secrets.get('a')}`, Origin: origin }), 403);
  const browsers = [];
  const checks = [];
  for (const id of ['a', 'b']) {
    const browser = await chromium.connectOverCDP(endpoint(id), {
      headers: { Authorization: `Bearer ${secrets.get(id)}` }, timeout: 15000 });
    browsers.push(browser);
    assert.equal(browser.contexts().length, 1);
    const context = browser.contexts()[0];
    assert.equal(context.pages().length, 1);
    const page = context.pages()[0];
    await page.goto(origin);
    assert.equal(await page.title(), 'local only');
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    await page.locator('#draft').fill(`fixture-${id}`);
    assert.equal(await page.locator('#draft').inputValue(), `fixture-${id}`);
    await page.evaluate(value => { document.cookie = `probe=${value};path=/`; localStorage.setItem('probe', value); }, id);
    const [response] = await Promise.all([page.waitForResponse(`${origin}/binary`), page.locator('#send').click()]);
    assert.deepEqual(await response.body(), body);
    assert.equal(response.request().frame(), page.mainFrame());
    const cookies = await context.cookies([origin]);
    assert.equal(cookies.find(cookie => cookie.name === 'probe')?.value, id);
    checks.push(`${id}: goto/evaluate/fill/native-click/response.body/request.frame/cookies`);
  }
  assert.equal(await browsers[0].contexts()[0].pages()[0].evaluate(() => localStorage.getItem('probe')), 'a');
  assert.equal((await browsers[0].contexts()[0].cookies([origin])).find(cookie => cookie.name === 'probe')?.value, 'a');
  assert.equal(clicks, 2);
  for (const browser of browsers) await browser.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const ws = new WebSocket(endpoint('a'), { headers: { Authorization: `Bearer ${secrets.get('a')}` } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  async function raw(command) {
    const response = new Promise(resolve => ws.once('message', data => resolve(JSON.parse(data.toString()))));
    ws.send(JSON.stringify({ id: 1, ...command }));
    return response;
  }
  assert.match((await raw({ method: 'Browser.close' })).error.message, /denied/);
  assert.match((await raw({ method: 'Target.getTargetInfo', params: { targetId: 'target-b' } })).error.message, /Foreign target/);
  assert.match((await raw({ method: 'Storage.getCookies', params: { browserContextId: 'context-b' } })).error.message, /Foreign browser context/);
  assert.match((await raw({ sessionId: 'page-b', method: 'Runtime.evaluate', params: { expression: '1' } })).error.message, /Foreign session/);
  ws.close();
  checks.push('auth/origin/foreign-target/foreign-session/foreign-context/browser-close denied');
  checks.push('two accounts: cookie and localStorage isolation; one click per account');
  process.send({ type: 'result', result: { ok: true, checks, clicks,
    playwright: require(path.join(playwrightRoot, 'package.json')).version } });
}
