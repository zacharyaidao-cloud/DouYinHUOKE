'use strict';

// Exercise the actual shipping engine with throwaway account profiles. Browser
// requests are manufactured by local routes; a rejecting loopback proxy is a
// second transport boundary. No installed account, platform or paid API is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const sourceMode = process.argv.includes('--source');
const APP = path.join(ROOT, sourceMode ? 'dy-lead-app' : 'dy-lead-app-release');
const REPORT = path.join(__dirname, sourceMode ? 'startup-login-source-verification.json' : 'startup-login-build-verification.json');
const fixture = fs.mkdtempSync(path.join(__dirname, 'qa-startup-login-build-'));
process.env.DY_LEAD_DATA_DIR = path.join(fixture, 'data');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(APP, 'node_modules', 'playwright-core', '.local-browsers');
const scenarios = [
  { id: 'startup-login-qa-success', state: 'authenticated' },
  { id: 'startup-login-qa-logout', state: 'logged_out' },
  { id: 'startup-login-qa-verification', state: 'verification_required' },
  { id: 'startup-login-qa-unknown', state: 'unknown' }
];

function pageHtml(scenario) {
  const content = scenario.state === 'authenticated'
    ? '<h1>本地隔离本人页</h1><script>setTimeout(()=>fetch("/aweme/v1/web/user/profile/self/").then(response=>response.json()),100)</script>'
    : scenario.state === 'logged_out' ? '<header><button>登录</button></header><h1>本地隔离未登录页面</h1>'
    : scenario.state === 'verification_required' ? '<div data-e2e="captcha">请完成安全验证</div>'
    : '<h1>本地隔离页面，没有本人登录证据</h1>';
  return '<!doctype html><html><head><meta charset="utf-8"></head><body>' + content + '</body></html>';
}

(async () => {
  let engine, blocker, chromium, originalLaunch;
  const opened = [], closed = [], requests = [], progress = [], authorizationKinds = new Set();
  try {
    fs.rmSync(REPORT, { force: true });
    const engineFile = path.join(APP, 'engine.js');
    const engineCode = fs.readFileSync(engineFile, 'utf8');
    if (!sourceMode) assert.match(engineCode, /_0x[0-9a-f]+/i, 'Verification must load the actual obfuscated release engine');
    chromium = require(path.join(APP, 'node_modules', 'playwright-core')).chromium;
    let bundledBrowser = chromium.executablePath();
    assert(fs.existsSync(bundledBrowser), 'Verification requires the bundled release Chromium');
    // 受限环境：从刚生成的大目录启动浏览器可能被拦截，先复制到 QA 缓存目录再启动（文件 1:1 一致）
    if (!sourceMode) {
      const cacheDir = path.join(__dirname, '.qa-chromium-cache');
      const revision = chromium.executablePath().split(path.sep).find(part => /^chromium-\d+$/.test(part)) || 'chromium';
      const marker = path.join(cacheDir, '.qa-revision');
      const cachedExe = path.join(cacheDir, 'chrome.exe');
      if (!fs.existsSync(cachedExe) || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== revision) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        fs.cpSync(path.dirname(bundledBrowser), cacheDir, { recursive: true });
        fs.writeFileSync(marker, revision, 'utf8');
      }
      bundledBrowser = cachedExe;
    }
    originalLaunch = chromium.launchPersistentContext;
    blocker = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
    const rejectingProxy = 'http://127.0.0.1:' + blocker.address().port;
    // The engine still creates its own persistent context and monitor. Install
    // the route before returning that context, so no navigation can race it.
    chromium.launchPersistentContext = async (profile, options) => {
      const accountId = path.basename(profile);
      const scenario = scenarios.find(item => item.id === accountId);
      assert(scenario, 'Only isolated QA account profiles may be opened');
      assert.equal(path.dirname(path.resolve(profile)), path.join(fixture, 'data', 'chrome-profiles'));
      assert.equal(options.headless, true, 'Startup scans must use a background browser');
      assert.equal(options.chromiumSandbox, true, 'Startup scans must retain the browser sandbox');
      assert.equal(options.proxy.server, rejectingProxy, 'No origin may bypass the rejecting proxy');
      assert.equal(opened.length, closed.length, 'Each background context must close before the next account opens');
      const context = await originalLaunch.call(chromium, profile, { ...options, executablePath: bundledBrowser });
      opened.push({ id: accountId, context });
      context.on('close', () => closed.push(accountId));
      try {
        await context.route('**/*', async route => {
          const address = new URL(route.request().url());
          requests.push({ accountId, path: address.pathname });
          if (address.protocol !== 'https:' || address.hostname !== 'www.douyin.com') return route.abort();
          if (address.pathname === '/user/self') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml(scenario) });
          if (address.pathname === '/aweme/v1/web/user/profile/self/' && scenario.state === 'authenticated') {
            return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8',
              body: '{"status_code":0,"is_login":true,"user":{"uid":"7000000000000000999"}}' });
          }
          return route.abort();
        });
        if (scenario.state === 'authenticated') await context.addCookies([{ name: 'sessionid', value: 'synthetic-private-startup-session-only',
          domain: '.douyin.com', path: '/', expires: -1, secure: true, httpOnly: true }]);
        return context;
      } catch (error) { await context.close(); throw error; }
    };
    engine = require(engineFile);
    const store = require(path.join(APP, 'store.js'));
    assert.equal(path.resolve(store.DATA_DIR), path.join(fixture, 'data'));
    assert.equal(typeof engine.scanAccountLogins, 'function', 'Shipping engine must expose the startup scan');
    // Intentionally stale saved success cannot confirm an unknown browser.
    store.setAccounts(scenarios.map(item => ({ id: item.id, name: '隔离发行登录测试', proxy: rejectingProxy,
      loginState: '已登录', loginStatus: 'authenticated', loginAt: '2026-10-07 12:00:00' })));
    engine.configure({ authorize: async metadata => { authorizationKinds.add(metadata.kind); return true; } });
    const result = await engine.scanAccountLogins({ onProgress: item => progress.push(item) });
    assert.equal(result.ok, true); assert.equal(result.total, scenarios.length); assert.equal(result.done, scenarios.length);
    assert.deepEqual(scenarios.map(item => result.accountStates[item.id].state), scenarios.map(item => item.state));
    assert.equal(Object.values(result.accountStates).every(item => item.checked === true), true);
    assert.deepEqual(opened.map(item => item.id), scenarios.map(item => item.id));
    assert.deepEqual(closed, scenarios.map(item => item.id));
    assert.equal(engine.taskState.kind, 'login_scan'); assert.equal(engine.taskState.running, false);
    assert.equal(engine.taskState.done, scenarios.length);
    assert(progress.some(item => Object.values(item.accountStates).some(state => state.state === 'checking')));
    assert.equal(progress[0].done, 0); assert.equal(progress.at(-1).done, scenarios.length);
    for (const kind of ['login_scan_browser', 'browser', 'login_scan_navigate', 'login_scan_check']) assert(authorizationKinds.has(kind));
    const accounts = store.getAccounts();
    assert.deepEqual(accounts.map(item => item.loginStatus), scenarios.map(item => item.state));
    assert.equal(accounts.at(-1).loginState, '登录待确认', 'Missing browser proof must not become saved success or false logout');
    assert(requests.some(item => item.path === '/aweme/v1/web/user/profile/self/'), 'The browser itself must return the observed self-profile reply');
    assert(requests.every(item => ['/user/self', '/aweme/v1/web/user/profile/self/'].includes(item.path)), 'No outreach or additional data endpoint is allowed');
    for (const item of opened) {
      assert.equal(item.context.pages().length, 0, 'Each owned background context must actually be closed');
      assert.equal(item.context.listeners('response').length, 0, 'Login-monitor listeners must be disposed');
    }
    const publicState = JSON.stringify({ result, progress, accounts, taskState: engine.taskState });
    for (const privateValue of ['synthetic-private-startup-session-only', '7000000000000000999']) assert.equal(publicState.includes(privateValue), false);
    const packageFile = sourceMode ? path.join(ROOT, 'desktop', 'package.json') : path.join(APP, 'resources', 'app', 'package.json');
    const report = { ok: true, version: JSON.parse(fs.readFileSync(packageFile, 'utf8')).version,
      actualObfuscatedReleaseEngine: !sourceMode,
      releaseEngineSha256: crypto.createHash('sha256').update(engineCode).digest('hex'),
      realBundledHeadlessChromium: true, isolatedDataAndProfile: true, allPageRequestsIntercepted: true,
      rejectingLoopbackProxyEnabled: true, noInstalledClientDataAccess: true, noLivePlatformOrPaidApiRequests: true,
      successfulOwnProfileBrowserResponseConfirmed: true, explicitLogoutDetected: true, visibleVerificationDetected: true,
      staleSavedLoginIgnoredWithoutEvidence: true, orderedAccountsCompleted: scenarios.length,
      authorizationBeforeLaunchNavigateInspect: true, checkingProgressReported: true,
      allOwnedBackgroundContextsClosed: true, responseMonitorListenersDisposed: true, publicStateContainsNoPrivateEvidence: true };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log('PASS: ' + (sourceMode ? 'source' : 'actual obfuscated release') + ' startup scan uses bundled Chromium self responses, classifies all accounts sequentially and closes owned background contexts; all responses local');
  } finally {
    if (engine) await engine.shutdown();
    if (chromium && originalLaunch) chromium.launchPersistentContext = originalLaunch;
    await Promise.allSettled(opened.map(item => item.context.close()));
    if (blocker) await new Promise(resolve => blocker.close(resolve));
    if (path.dirname(fixture) !== __dirname || !path.basename(fixture).startsWith('qa-startup-login-build-')) throw new Error('Unsafe startup-login fixture cleanup');
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
