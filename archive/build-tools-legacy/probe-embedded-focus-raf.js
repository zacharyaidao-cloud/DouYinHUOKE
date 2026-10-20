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
  const runDir = fs.mkdtempSync(path.join(__dirname, 'qa-probe-focus-raf-'));
  app.setPath('userData', path.join(runDir, 'electron-user-data'));
  app.enableSandbox();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL('data:text/html,<title>isolated workbench</title>');
  const accounts = new Map();
  const methods = new Set();
  const nativeEvents=[];
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
    for(const event of ['focus','blur'])view.webContents.on(event,()=>nativeEvents.push({accountId:id,event,time:Date.now()}));
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.setVisible(false);
    await view.webContents.loadURL('about:blank');
    view.webContents.setBackgroundThrottling(false);
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
      child?.connected && child.send({ type: 'cdp-event', accountId: id, event: {
        method, params, sessionId: sessionId || account.pageSession } });
    });
  }
  child = spawn(path.join(root, 'dy-lead-app', 'node.exe'), [__filename, '--client'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const timeout = setTimeout(() => finish({ ok: false, error: 'Probe timed out' }), 85000);
  let finished = false;
  async function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    result.electron = process.versions.electron;
    result.chromium = process.versions.chrome;
    result.methods = [...methods].sort();
    result.nativeEvents = nativeEvents;
    result.livePlatform = false;
    result.productionDataRead = false;
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, resultPath: path.join(runDir, 'result.json') }));
    child.kill();
    app.exit(result.ok ? 0 : 1);
    for (const account of accounts.values()) account.view.webContents.close();
    window.destroy();
    app.exit(result.ok ? 0 : 1);
  }
  const targetInfo = account => ({ targetId: account.targetId, type: 'page',
    title: 'isolated account fixture', url: account.view.webContents.getURL(),
    attached: true, canAccessOpener: false, browserContextId: account.contextId });
  child.on('message', async message => {
    if (message.type === 'result') return finish(message.result);
    if (message.type === 'probe-hook') {
      const a = accounts.get('a'), wc = a.view.webContents;
      try {
        switch(message.action) {
          case 'focus-false': await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:false}); break;
          case 'focus-true': await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true}); break;
          case 'wc-focus': wc.focus(); break;
          case 'native-blur': if(typeof wc.blur!=='function')throw new Error('wc.blur unavailable');wc.blur(); break;
          case 'parent-focus': window.webContents.focus(); break;
          case 'capture-pulse': wc.beginFrameSubscription(()=>{});await new Promise(resolve=>setTimeout(resolve,100));wc.endFrameSubscription();break;
          case 'invalidate': wc.invalidate(); break;
          case 'reset-bounds': a.view.setBounds(a.view.getBounds()); break;
          case 'blur-input': await wc.debugger.sendCommand('Runtime.evaluate',{expression:'document.activeElement.blur()'}); break;
          case 'parent-throttle-off': window.webContents.setBackgroundThrottling(false); break;
          case 'frame-subscribe': wc.beginFrameSubscription(()=>{}); break;
          case 'frame-unsubscribe': wc.endFrameSubscription(); break;
          case 'throttle-off': wc.setBackgroundThrottling(false); break;
          case 'throttle-toggle': wc.setBackgroundThrottling(true); wc.setBackgroundThrottling(false); break;
          case 'hidden-again': a.view.setVisible(false); break;
          case 'visible-hidden-window': a.view.setVisible(true); break;
          case 'hide-after-visible': a.view.setVisible(false); break;
        }
        child.send({type:'probe-hook-result', requestId:message.requestId, ok:true, action:message.action,
          state:{windowVisible:window.isVisible(),viewVisible:a.view.getVisible(),wcFocused:wc.isFocused(),throttling:wc.getBackgroundThrottling()}});
      } catch(error) { child.send({type:'probe-hook-result',requestId:message.requestId,error:error.message}); }
      return;
    }
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
  const hooks = new Map();
  process.on('message', message => { if(message.type === 'probe-hook-result') { hooks.get(message.requestId)?.(message); hooks.delete(message.requestId); } });
  const hook = action => new Promise(resolve => { const id=++requestId;hooks.set(id,resolve);process.send({type:'probe-hook',requestId:id,action}); });
  const browser = await chromium.connectOverCDP(endpoint('a'), {headers:{Authorization:'Bearer '+secrets.get('a')},timeout:15000});
  const page = browser.contexts()[0].pages()[0];
  const rows=[];
  const sample = async stage => {
    const measured=await page.evaluate(()=>new Promise(resolve=>{
      const start=performance.now(), stamps=[];let raf;
      const done=()=>{cancelAnimationFrame(raf);clearTimeout(timer);resolve({elapsed:performance.now()-start,stamps,visibility:document.visibilityState,focus:document.hasFocus(),active:document.activeElement?.id});};
      const step=t=>{stamps.push(t-start);if(stamps.length===3)done();else raf=requestAnimationFrame(step);};
      const timer=setTimeout(done,2600);raf=requestAnimationFrame(step);
    }));
    const row={stage,...measured};rows.push(row);console.log(JSON.stringify(row));
    await new Promise(resolve=>setTimeout(resolve,1200));
  };
  await page.goto(origin);
  await sample('initial');
  if(process.env.PROBE_IDLE_ONLY==='1') {
    const variant=process.env.PROBE_VARIANT||'idle';
    if(variant==='focus') await page.locator('#draft').focus();
    if(variant==='fill') await page.locator('#draft').fill('fixture text');
    if(variant==='inputValue') await page.locator('#draft').inputValue();
    if(variant==='domvalue') await page.evaluate(()=>document.querySelector('#draft').value='fixture text');
    await new Promise(resolve=>setTimeout(resolve,5000));
    await sample(variant+'-after-5s');
    for(const action of (process.env.PROBE_RECOVERY==='2'?['native-blur','parent-focus','capture-pulse']:process.env.PROBE_RECOVERY==='1'?['invalidate','reset-bounds','blur-input','parent-throttle-off','frame-subscribe','frame-unsubscribe']:[])){console.log(JSON.stringify(await hook(action)));await sample(action);}
    if(process.env.PROBE_RECOVERY==='2'){
      await new Promise(resolve=>setTimeout(resolve,5000));await sample('pulse-ended-idle-5s');
      await page.locator('#draft').fill('second fixture text');await new Promise(resolve=>setTimeout(resolve,5000));await sample('pulse-ended-refill-5s');
    }
    const began=Date.now();let clickError=null;try{await page.locator('#send').click({timeout:5000})}catch(error){clickError=error.message}
    process.send({type:'result',result:{ok:true,rows,clickMs:Date.now()-began,clickError,idleOnly:true,variant}},()=>process.exit(0));return;
  }
  await page.locator('#draft').fill('local fixture');
  await sample('after-fill');
  await page.locator('#draft').inputValue();
  await sample('after-inputValue');
  for(const action of ['focus-false','focus-true','wc-focus','throttle-off','throttle-toggle','hidden-again','visible-hidden-window','hide-after-visible','throttle-off']) {
    const result=await hook(action);console.log(JSON.stringify(result));await sample(action);
  }
  const clickStarted=Date.now();let clickError=null;
  try {await page.locator('#send').click({timeout:5000});} catch(error){clickError=error.message;}
  console.log(JSON.stringify({clickMs:Date.now()-clickStarted,clickError}));
  process.send({type:'result',result:{ok:true,rows,clickMs:Date.now()-clickStarted,clickError,playwright:require(path.join(playwrightRoot,'package.json')).version}});
}
