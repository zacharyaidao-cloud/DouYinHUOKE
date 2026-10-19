'use strict';

// Product-host integration test: Electron main + isolated Node CDP client.
// No platform requests, existing user profiles or production data are used.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
// 受限环境：系统临时目录可能不可写（Playwright 工件目录创建被拒），重定向到构建目录。
const QA_TMP = path.join(__dirname, 'qa-tmp');
fs.mkdirSync(QA_TMP, { recursive: true });
process.env.TEMP = process.env.TMP = QA_TMP;
const argument = key => { const index = process.argv.indexOf(key); return index < 0 ? null : process.argv[index + 1]; };
const appDir = path.resolve(argument('--app-dir') || path.join(root, 'dy-lead-app'));
const hostModule = argument('--host') || (appDir === path.join(root, 'dy-lead-app') ?
  path.join(root, 'desktop', 'account-browser-host.js') : path.join(appDir, 'resources', 'app', 'account-browser-host.js'));
const playwrightRoot = path.join(appDir, 'node_modules', 'playwright-core');
const bundle = require(path.join(playwrightRoot, 'lib', 'utilsBundle.js'));

if (!process.versions.electron && !process.argv.includes('--client')) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(path.join(__dirname, 'electron-runtime-44.6.0', 'electron.exe'),
    [__filename, '--app-dir', appDir, '--host', hostModule], { windowsHide: true, env,
      cwd: root, encoding: 'utf8', timeout: 120000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error) console.error(result.error.message);
  if (result.status !== 0 && result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status === 0 && !result.error ? 0 : 1;
} else if (process.argv.includes('--client')) client().catch(error => {
  process.send?.({ type: 'result', result: { ok: false, error: error.stack } });
});
else main().catch(error => {
  console.error(error.stack);
  require('electron').app.exit(1);
});

async function main() {
  const { app, BrowserWindow } = require('electron');
  const { spawn } = require('child_process');
  const { createAccountBrowserHost } = require(hostModule);
  const runDir = fs.mkdtempSync(path.join(__dirname, 'qa-embedded-host-'));
  app.setPath('userData', path.join(runDir, 'electron-user-data'));
  app.commandLine.appendSwitch('site-per-process');
  app.enableSandbox();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadURL('data:text/html,<title>isolated workbench</title>');
  let fixturePort = 0;
  let child;
  const states = [];
  let childSessionEvents = 0;
  let closedEvents = 0;
  const renderingLeases = new Map();
  function instrumentRendering(accountId) {
    for (const view of window.contentView.children) {
      const wc = view.webContents;
      if (!wc || renderingLeases.has(wc.id)) continue;
      const state = { accountId, starts: 0, stops: 0, active: false };
      renderingLeases.set(wc.id, state);
      const begin = wc.beginFrameSubscription.bind(wc), end = wc.endFrameSubscription.bind(wc);
      wc.beginFrameSubscription = (onlyDirty, callback) => {
        assert.equal(onlyDirty, true); assert.equal(state.active, false, 'Concurrent commands must share one subscription');
        begin(onlyDirty, callback); state.starts++; state.active = true;
      };
      wc.endFrameSubscription = () => {
        assert.equal(state.active, true, 'Each rendering subscription must be released exactly once');
        end(); state.stops++; state.active = false;
      };
    }
  }
  const host = createAccountBrowserHost({ window, appRoot: runDir,
    allowNavigation: url => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) &&
          parsed.port === String(fixturePort) && parsed.pathname !== '/denied';
      } catch { return false; }
    },
    onState: state => states.push(state),
    sendEvent: packet => {
      if (packet.event.method === 'Host.closed') closedEvents++;
      if (packet.event.method === 'Target.attachedToTarget' && packet.event.sessionId) childSessionEvents++;
      child?.send({ type: 'embedded:event', ...packet });
    }
  });
  const trackedFiles = { host: hostModule, client: path.join(appDir, 'lib', 'embedded-browser-client.js'), verifier: __filename };
  const hashes = () => Object.fromEntries(Object.entries(trackedFiles).map(([key, file]) =>
    [key, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const initialHashes = hashes();
  // 受限环境：刚复制出的发布目录 node.exe 可能被系统策略限制文件操作，
  // 客户端工作进程改用源码 node.exe 作解释器，加载的仍是指定 appDir 的发布代码。
  child = spawn(path.join(root, 'dy-lead-app', 'node.exe'), [__filename, '--client', '--app-dir', appDir], {
    cwd: root, windowsHide: true, env: { ...process.env, DY_LEAD_EMBEDDED_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => void finish({ ok: false, error: 'Embedded host verification timed out' }), 90000);
  let finished = false;
  async function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    await host.dispose();
    if (result.ok) {
      try {
        assert.deepEqual(hashes(), initialHashes, 'Host/client/verifier changed during verification; rerun required');
        for (const state of renderingLeases.values()) { assert.equal(state.active, false); assert.equal(state.starts, state.stops); }
      } catch (error) { result = { ...result, ok: false, error: error.message }; }
    }
    result.sourceHashes = initialHashes;
    result.electron = process.versions.electron;
    result.chromium = process.versions.chrome;
    result.childSessionEvents = childSessionEvents;
    result.closedEvents = closedEvents;
    result.livePlatform = false;
    result.productionDataRead = false;
    result.appDirectory = appDir;
    result.renderingLeases = [...renderingLeases.values()];
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(__dirname, 'embedded-browser-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, resultPath: path.join(runDir, 'result.json') }));
    child.kill();
    window.destroy();
    app.exit(result.ok ? 0 : 1);
  }
  child.on('message', async message => {
    if (message.type === 'result') return finish(message.result);
    if (message.type === 'fixture-ready') { fixturePort = message.port; return; }
    if (message.type !== 'embedded:request') return;
    try {
      let result;
      if (message.op === 'open') {
        result = await host.open({ ...message.payload, accountId: message.accountId, generation: message.generation,
          profileDir: path.join(runDir, 'data', 'electron-profiles', message.accountId) });
        instrumentRendering(message.accountId);
      }
      else if (message.op === 'command') result = await host.command({ accountId: message.accountId,
        generation: message.generation, command: message.payload });
      else if (message.op === 'close') result = await host.close(message);
      else if (message.op === 'show') result = host.show(message.accountId);
      else if (message.op === 'test-rendering-state') result = [...renderingLeases.values()].map(state => ({ ...state }));
      else if (message.op === 'test-state') {
        host.hide(); host.setBounds(null); host.show('a', { requestUI: false });
        assert.equal(host.list().accounts.find(account => account.id === 'a').visible, false);
        host.setBounds({ x: -4, y: 0, width: 2000, height: 2000 });
        host.show('a');
        const rect = window.contentView.children[1].getBounds();
        const [width, height] = window.getContentSize();
        assert.ok(rect.y >= 66 && rect.x >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height);
        assert.equal(states.at(-1).showRequested, true);
        assert.throws(() => host.show('a', { generation: 'stale-generation' }), /已失效/);
        const target = host.controlTarget();
        host.show('b', { requestUI: false });
        assert.throws(() => host.reload(target), /已切换/);
        host.show('a', { requestUI: false });
        host.hide();
        assert.equal(host.list().accounts.some(account => account.visible), false);
        assert.equal(host.list().showRequested, false);
        await assert.rejects(host.open({ accountId: '../escape', generation: 'bad', profileDir: path.join(runDir, 'escape') }));
        await assert.rejects(host.open({ accountId: 'a', generation: 'bad', profileDir: path.join(runDir, 'outside', 'a') }));
        result = { ok: true };
      } else if (message.op === 'test-stale-navigation') {
        host.show('a', { requestUI: false });
        assert.throws(() => host.reload({ accountId: 'a', generation: message.payload.generation }), /重新打开/);
        host.hide();
        result = { ok: true };
      } else if (message.op === 'test-dispose-race') {
        const opening = host.open({ accountId: 'dispose-race', generation: 'race',
          profileDir: path.join(runDir, 'data', 'electron-profiles', 'dispose-race') });
        const disposing = host.dispose();
        assert.equal(host.dispose(), disposing);
        await assert.rejects(opening, /已经关闭/);
        await disposing;
        assert.equal(host.list().accounts.length, 0);
        await assert.rejects(host.open({ accountId: 'after-dispose', generation: 'rejected',
          profileDir: path.join(runDir, 'data', 'electron-profiles', 'after-dispose') }), /已经关闭/);
        assert.equal(fs.existsSync(path.join(runDir, 'data', 'electron-profiles', 'after-dispose')), false);
        result = { ok: true };
      } else throw new Error('Unknown test operation');
      child.send({ type: 'embedded:reply', id: message.id, result });
    } catch (error) {
      child.send({ type: 'embedded:reply', id: message.id, error: { code: error.code || -32000, message: error.message } });
    }
  });
  child.on('exit', code => { if (!finished) void finish({ ok: false, error: `Client exited ${code} without result` }); });
}

async function client() {
  const { chromium } = require(playwrightRoot);
  const { ws: WebSocket, wsServer: WebSocketServer } = bundle;
  const secrets = new Map(['a', 'b'].map(id => [id, crypto.randomBytes(32).toString('hex')]));
  const sockets = new Map();
  const descriptors = new Map();
  const pending = new Map();
  let nextId = 0;
  const calls = [];
  const body = Buffer.from([0, 255, 1, 128, 10, 13, 254]);
  const fixture = http.createServer((req, res) => {
    if (req.url.startsWith('/binary')) {
      calls.push(req.url); res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(body);
    }
    if (req.url === '/redirect-denied') { res.writeHead(302, { location: '/denied' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const frame = req.url === '/frame';
    res.end(`<!doctype html><title>${frame ? 'iframe' : 'local only'}</title><input id="draft"><button id="send" onclick="fetch('/binary?source=${frame ? 'frame' : 'page'}').then(r=>r.arrayBuffer()).then(b=>document.body.dataset.received=b.byteLength)">Local fixture request</button>${frame ? '' : `<iframe name="child" src="http://localhost:${fixture.address().port}/frame"></iframe>`}`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  process.send({ type: 'fixture-ready', port: fixture.address().port });
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  function rpc(op, accountId, generation, payload) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`IPC timed out: ${op}`)); }, 20000);
      pending.set(id, { resolve, reject, timeout });
      process.send({ type: 'embedded:request', id, op, accountId, generation, payload });
    });
  }
  process.on('message', message => {
    if (message.type === 'embedded:reply') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timeout);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else entry.resolve(message.result);
    }
    if (message.type === 'embedded:event') {
      const entry = sockets.get(message.accountId);
      if (!entry || entry.generation !== message.generation) return;
      if (message.event.method === 'Host.closed') entry.ws.close();
      else if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify(message.event));
    }
  });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const id = /^\/account\/([ab])$/.exec(req.url)?.[1];
    if (!id || req.headers.origin || req.headers.authorization !== `Bearer ${secrets.get(id)}` ||
        req.headers.host !== `127.0.0.1:${server.address().port}` || sockets.has(id)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const descriptor = descriptors.get(id);
      sockets.set(id, { ws, generation: descriptor.generation });
      ws.on('close', () => { if (sockets.get(id)?.ws === ws) sockets.delete(id); });
      ws.on('message', async data => {
        const command = JSON.parse(data.toString());
        try {
          const result = await rpc('command', id, descriptor.generation, command);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result }));
        } catch (error) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: command.id, sessionId: command.sessionId,
            error: { code: error.code || -32000, message: error.message } }));
        }
      });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = id => `ws://127.0.0.1:${server.address().port}/account/${id}`;
  const connect = id => chromium.connectOverCDP(endpoint(id), {
    headers: { Authorization: `Bearer ${secrets.get(id)}` }, timeout: 15000 });
  const rejected = headers => new Promise(resolve => {
    const ws = new WebSocket(endpoint('a'), { headers });
    ws.on('unexpected-response', (_req, res) => { const status = res.statusCode; res.resume(); ws.terminate(); resolve(status); });
    ws.on('error', () => {});
    ws.on('open', () => { ws.close(); resolve(101); });
  });
  assert.equal(await rejected({}), 403);
  assert.equal(await rejected({ Authorization: `Bearer ${secrets.get('a')}`, Origin: origin }), 403);
  const browsers = new Map();
  const checks = [];
  const backgroundFrames = [];
  async function verifyBackgroundFrames(page, phase) {
    const sample = await page.evaluate(() => new Promise(resolve => {
      let frames = 0, handle;
      const start = performance.now();
      const frame = () => { frames++; handle = requestAnimationFrame(frame); };
      handle = requestAnimationFrame(frame);
      setTimeout(() => { cancelAnimationFrame(handle); resolve({ frames,
        elapsedMs: Math.round(performance.now() - start), visibility: document.visibilityState }); }, 1000);
    }));
    assert(sample.frames >= 10, `Hidden account rendering stalled during ${phase}: ${JSON.stringify({ sample, previous: backgroundFrames })}`);
    backgroundFrames.push({ phase, ...sample });
  }
  for (const id of ['a', 'b']) {
    descriptors.set(id, await rpc('open', id, `generation-${id}`, { name: `Fixture ${id}`, visible: false }));
    const browser = await connect(id);
    browsers.set(id, browser);
    assert.equal(browser.contexts().length, 1);
    const context = browser.contexts()[0];
    assert.equal(context.pages().length, 1);
    const page = context.pages()[0];
    await page.goto(origin);
    assert.equal(await page.title(), 'local only');
    await verifyBackgroundFrames(page, `initial-hidden-${id}`);
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    await page.locator('#draft').fill(`fixture-${id}`);
    assert.equal(await page.locator('#draft').inputValue(), `fixture-${id}`);
    await verifyBackgroundFrames(page, `after-fill-${id}`);
    await context.addCookies([{ url: origin, name: 'probe', value: id, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await page.evaluate(value => localStorage.setItem('probe', value), id);
    if (id === 'a') {
      // No renderer calls or continuous rAF during this idle period. A native
      // click must recover after hidden input focus without a larger deadline.
      await new Promise(resolve => setTimeout(resolve, 5000));
      assert((await rpc('test-rendering-state')).every(state => state.active === false));
    }
    const [response] = await Promise.all([page.waitForResponse(`${origin}/binary?source=page`), page.locator('#send').click({ timeout: 2000 })]);
    assert.deepEqual(await response.body(), body);
    assert.equal(response.request().frame(), page.mainFrame());
    await verifyBackgroundFrames(page, `after-native-click-${id}`);
    const frame = page.frame({ name: 'child' });
    assert.ok(frame);
    await frame.locator('#draft').fill(`frame-${id}`);
    const [frameResponse] = await Promise.all([page.waitForResponse(response => response.url().includes('/binary?source=frame')),
      frame.locator('#send').click()]);
    assert.deepEqual(await frameResponse.body(), body);
    assert.equal(frameResponse.request().frame(), frame);
    assert.equal((await context.cookies([origin])).find(cookie => cookie.name === 'probe')?.value, id);
    checks.push(`${id}: goto/evaluate/fill/native-click/binary-response/cookies/cross-site-iframe`);
  }
  const a = descriptors.get('a');
  const b = descriptors.get('b');
  await verifyBackgroundFrames(browsers.get('a').contexts()[0].pages()[0], 'before-manual-CDP-attach');
  const command = (method, params, sessionId) => rpc('command', 'a', a.generation, { method, params, sessionId });
  const aPage = browsers.get('a').contexts()[0].pages()[0];
  const overlapping = [aPage.evaluate(() => new Promise(resolve => setTimeout(resolve, 200))),
    aPage.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)))];
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await rpc('test-rendering-state')).filter(state => state.active).length, 1);
  await Promise.all(overlapping);
  assert((await rpc('test-rendering-state')).every(state => state.active === false));
  await assert.rejects(command('Runtime.callFunctionOn', { functionDeclaration: 'function() {}', objectId: 'invalid-fixture-object' }, a.pageSession));
  assert((await rpc('test-rendering-state')).every(state => state.active === false));
  const virtualBrowser = await command('Target.attachToBrowserTarget');
  await assert.rejects(command('Target.attachToTarget', { targetId: b.targetId, flatten: true }, virtualBrowser.sessionId), /其他页面/);
  await assert.rejects(command('Browser.close', {}, virtualBrowser.sessionId), /不支持/);
  const manual = await command('Target.attachToTarget', { targetId: a.targetId, flatten: true }, virtualBrowser.sessionId);
  await verifyBackgroundFrames(browsers.get('a').contexts()[0].pages()[0], 'after-manual-CDP-attach');
  const frameTree = await command('Page.getFrameTree', {}, manual.sessionId);
  assert.equal(frameTree.frameTree.frame.url, `${origin}/`);
  await assert.rejects(rpc('command', 'b', b.generation, { method: 'Page.getFrameTree', sessionId: manual.sessionId }), /其他页面/);
  await assert.rejects(command('Fetch.continueRequest', { requestId: 'fixture', url: 'https://untrusted.invalid/' }, manual.sessionId), /非平台/);
  await command('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, manual.sessionId);
  await command('Fetch.disable', {}, manual.sessionId);
  await command('Page.stopLoading', {}, manual.sessionId);
  await command('Target.detachFromTarget', { sessionId: manual.sessionId }, virtualBrowser.sessionId);
  await assert.rejects(command('Page.getFrameTree', {}, manual.sessionId), /其他页面/);
  await command('Target.detachFromTarget', { sessionId: virtualBrowser.sessionId });
  assert.equal(browsers.get('a').contexts()[0].pages()[0].isClosed(), false);
  await assert.rejects(command('Browser.close'), /不支持/);
  await assert.rejects(command('Target.createTarget', { url: origin }), /不支持/);
  await assert.rejects(command('Target.getTargetInfo', { targetId: b.targetId }), /其他页面/);
  await assert.rejects(command('Storage.getCookies', { browserContextId: b.contextId }), /其他账号/);
  await assert.rejects(command('Runtime.evaluate', { expression: '1' }, b.pageSession), /其他页面/);
  await assert.rejects(command('DOM.setFileInputFiles', { files: [] }, a.pageSession), /不支持/);
  await assert.rejects(rpc('command', 'a', 'stale-generation', { method: 'Browser.getVersion' }), /已失效/);
  await assert.rejects(browsers.get('a').contexts()[0].pages()[0].goto(`${origin}/denied`), /非平台/);
  await verifyBackgroundFrames(browsers.get('a').contexts()[0].pages()[0], 'after-manual-CDP-detach');
  assert.deepEqual(await rpc('test-state'), { ok: true });
  await verifyBackgroundFrames(browsers.get('a').contexts()[0].pages()[0], 'hidden-after-show-and-switch');
  await command('Storage.clearCookies');
  assert.equal((await browsers.get('a').contexts()[0].cookies([origin])).length, 0);
  assert.equal((await browsers.get('b').contexts()[0].cookies([origin])).find(cookie => cookie.name === 'probe')?.value, 'b');
  await browsers.get('a').contexts()[0].addCookies([{ url: origin, name: 'probe', value: 'a', expires: Math.floor(Date.now() / 1000) + 3600 }]);
  const interruptedEvaluation = aPage.evaluate(() => new Promise(() => {}));
  interruptedEvaluation.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await rpc('test-rendering-state')).filter(state => state.active).length, 1);
  await Promise.all([new Promise(resolve => browsers.get('a').once('disconnected', resolve)),
    rpc('close', 'a', a.generation)]);
  await assert.rejects(interruptedEvaluation);
  assert((await rpc('test-rendering-state')).every(state => state.active === false));
  assert.equal(browsers.get('a').isConnected(), false);
  descriptors.set('a', await rpc('open', 'a', 'generation-a-reopened', { name: 'Fixture A reopened', visible: false }));
  browsers.set('a', await connect('a'));
  const reopened = browsers.get('a').contexts()[0];
  await reopened.pages()[0].goto(origin);
  assert.equal((await reopened.cookies([origin])).find(cookie => cookie.name === 'probe')?.value, 'a');
  assert.equal(await reopened.pages()[0].evaluate(() => localStorage.getItem('probe')), 'a');
  assert.equal(await browsers.get('b').contexts()[0].pages()[0].evaluate(() => localStorage.getItem('probe')), 'b');
  await assert.rejects(rpc('close', 'a', a.generation), /已失效/);
  await rpc('test-stale-navigation', undefined, undefined, { generation: a.generation });
  checks.push('auth/origin/foreign-target/foreign-context/foreign-session/stale-generation/file-upload/browser-close denied');
  checks.push('independent CDP attach/detach and Fetch; foreign target/session and navigation rewrite denied; primary page survives detach');
  checks.push('no bounds means hidden; toolbar reserved; explicit show signal only; invalid profile paths denied');
  checks.push('hidden parent and account views retain animation frames initially and after show/switch/hide');
  checks.push('focus then hidden idle 5 seconds; native click retains original 2-second deadline; concurrent/error/close rendering leases released');
  checks.push('cookies get/set/clear isolated; closed socket disconnected; reopened cookies/localStorage retained');
  assert.equal(calls.length, 4);
  for (const [id, browser] of browsers) { await browser.close(); await rpc('close', id, descriptors.get(id).generation); }

  // The second pass uses the shipped backend transport, not the test relay.
  const { createEmbeddedBrowserClient } = require(path.join(appDir, 'lib', 'embedded-browser-client'));
  const embedded = createEmbeddedBrowserClient({ channel: process, chromium });
  assert.equal(embedded.isAvailable(), true);
  const liveA = await embedded.open({ accountId: 'a', name: 'Production client A' });
  const liveB = await embedded.open({ accountId: 'b', name: 'Production client B' });
  assert.equal(liveA.embedded, true);
  await liveA.page.goto(origin);
  await liveB.page.goto(origin);
  await liveA.page.locator('#draft').fill('production transport');
  const [liveResponse] = await Promise.all([liveA.page.waitForResponse(`${origin}/binary?source=page`),
    liveA.page.locator('#send').click()]);
  assert.deepEqual(await liveResponse.body(), body);
  const liveFrame = liveA.page.frame({ name: 'child' });
  const [liveFrameResponse] = await Promise.all([liveA.page.waitForResponse(response => response.url().includes('/binary?source=frame')),
    liveFrame.locator('#send').click()]);
  assert.deepEqual(await liveFrameResponse.body(), body);
  assert.equal(liveFrameResponse.request().frame(), liveFrame);
  assert.equal((await liveA.context.cookies([origin])).find(cookie => cookie.name === 'probe')?.value, 'a');
  assert.equal((await liveB.context.cookies([origin])).find(cookie => cookie.name === 'probe')?.value, 'b');
  await liveA.show();
  await liveA.close();
  const liveReopened = await embedded.open({ accountId: 'a', name: 'Production client reopened' });
  await liveReopened.page.goto(origin);
  assert.equal(await liveReopened.page.evaluate(() => localStorage.getItem('probe')), 'a');
  await liveReopened.context.close();
  let stopChecks = 0;
  await assert.rejects(embedded.open({ accountId: 'cancelled', checkStopped() {
    if (++stopChecks === 3) throw new Error('fixture stop after host open');
  } }), /fixture stop/);
  await liveB.close();
  await embedded.dispose();
  await rpc('test-dispose-race');
  assert.equal(calls.length, 6);
  checks.push('production backend client: binary response and iframe, two sessions, show, context.close, reopen, stop after open');
  checks.push('stale show/navigation refused; dispose is idempotent and cannot revive queued open');
  process.send({ type: 'result', result: { ok: true, checks, fixtureRequests: calls.length, productionClient: true,
    backgroundFrames,
    playwright: require(path.join(playwrightRoot, 'package.json')).version } });
}
