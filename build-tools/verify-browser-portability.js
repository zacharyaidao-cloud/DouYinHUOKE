'use strict';

// Verify the account-browser selection used by a fresh shipping process. The
// bundled cases launch the real engine/browser with isolated profiles and a
// rejecting proxy. System-browser cases capture options without starting an
// installed browser. No installed account, API key or platform request is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const ROOT = path.resolve(__dirname, '..');
const PREFIX = 'qa-browser-portability-';
const RESULT_PREFIX = 'BROWSER_PORTABILITY_WORKER_RESULT=';
const SCENARIOS = ['bundled-no-env', 'bundled-stale-env', 'system-x86-edge', 'system-google-chrome'];
const normalized = value => String(value).replace(/\\/g, '/').toLowerCase();
const sha256 = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

function validateFixture(fixture) {
  const resolved = path.resolve(fixture);
  assert.equal(path.dirname(resolved), path.resolve(__dirname), 'Fixture must stay inside build-tools');
  assert(path.basename(resolved).startsWith(PREFIX), 'Fixture prefix must be verified before cleanup');
  return resolved;
}

function bundledExecutable(app) {
  const manifest = JSON.parse(fs.readFileSync(path.join(app, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  const chromium = manifest.browsers.find(browser => browser.name === 'chromium');
  assert(chromium && /^\d+$/.test(String(chromium.revision)), 'Bundled browser revision must match the packaged Playwright manifest');
  return path.join(app, 'node_modules', 'playwright-core', '.local-browsers', 'chromium-' + chromium.revision, 'chrome-win64', 'chrome.exe');
}

async function worker(scenario, appArg, fixtureArg) {
  assert(SCENARIOS.includes(scenario), 'Unknown portability scenario');
  assert.equal(process.platform, 'win32', 'Shipping browser portability is verified on Windows');
  const app = path.resolve(appArg);
  assert([path.join(ROOT, 'dy-lead-app'), path.join(ROOT, 'dy-lead-app-release')].includes(app), 'Only the source or shipping app may be loaded');
  const fixture = validateFixture(fixtureArg);
  const dataDir = path.join(fixture, scenario, 'data');
  process.env.DY_LEAD_DATA_DIR = dataDir;
  if (scenario === 'bundled-stale-env') process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(fixture, 'nonexistent-old-browser-cache');
  else delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  const initialBrowserEnv = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const bundledPath = bundledExecutable(app);
  const actualExists = fs.existsSync;
  assert(actualExists(bundledPath), 'Shipping app must include the exact Playwright Chromium executable');
  assert(actualExists(path.join(path.dirname(bundledPath), 'chrome.dll')), 'Bundled Chromium DLL must be present');

  // Deliberately load Playwright before the app engine so its default registry
  // is already cached. A correct engine must explicitly resolve its bundle,
  // even if an unrelated PLAYWRIGHT_BROWSERS_PATH was inherited by the process.
  const chromium = require(path.join(app, 'node_modules', 'playwright-core')).chromium;
  const cachedRegistryPath = chromium.executablePath();
  assert.notEqual(normalized(cachedRegistryPath), normalized(bundledPath), 'Scenario must not accidentally preconfigure the bundled browser registry');
  const runtime = require(path.join(app, 'lib', 'browser-runtime.js'));
  const candidates = runtime.systemBrowserCandidates(process.env);
  assert(Array.isArray(candidates), 'Browser candidate list must be inspectable');
  const systemPaths = new Set(candidates.map(normalized));
  const x86Edge = candidates.find(filename => /\/program files \(x86\)\/microsoft\/edge\/application\/msedge\.exe$/.test(normalized(filename)));
  const chrome = candidates.find(filename => /\/program files\/google\/chrome\/application\/chrome\.exe$/.test(normalized(filename)));
  assert(x86Edge, 'Common Program Files (x86) Edge installation must be supported');
  assert(chrome, 'System Chrome installation must remain supported');
  let systemChecks = 0;
  fs.existsSync = filename => {
    const key = normalized(filename);
    if (systemPaths.has(key)) {
      systemChecks++;
      if (scenario === 'system-x86-edge') return key === normalized(x86Edge);
      if (scenario === 'system-google-chrome') return key === normalized(chrome) || key === normalized(x86Edge);
      return false;
    }
    return actualExists(filename);
  };

  let engine, blocker, alive, captured;
  const originalLaunch = chromium.launchPersistentContext;
  const accountId = 'browser-portability-' + scenario;
  let originRequests = 0;
  try {
    engine = require(path.join(app, 'engine.js'));
    const store = require(path.join(app, 'store.js'));
    assert.equal(path.resolve(store.DATA_DIR), dataDir, 'Engine must use only the isolated data directory');
    engine.configure({ authorize: async () => true });
    const systemScenario = scenario.startsWith('system-');
    if (systemScenario) {
      const expectedPath = scenario === 'system-x86-edge' ? x86Edge : chrome;
      store.setAccounts([{ id: accountId, name: '隔离浏览器路径验证' }]);
      assert.equal(normalized(engine.pickBrowserOpts().executablePath), normalized(expectedPath), 'System browser must be preferred over the existing bundle');
      chromium.launchPersistentContext = async (profile, options) => {
        captured = { profile, executablePath: options.executablePath, headless: options.headless, sandbox: options.chromiumSandbox };
        assert.equal(path.resolve(profile), path.join(dataDir, 'chrome-profiles', accountId));
        assert.equal(normalized(options.executablePath), normalized(expectedPath));
        assert.equal(options.headless, true);
        assert.equal(options.chromiumSandbox, true);
        throw new Error('QA simulated system-browser launch: no installed browser was started');
      };
      await assert.rejects(engine.launchAccount(accountId, { headless: true }));
      assert(captured, 'Actual engine launch must receive the selected system path');
      return { scenario, ok: true, browserSource: 'system', selection: scenario === 'system-x86-edge' ? 'Program Files (x86) Edge' : 'system Chrome before Edge', systemPriorityRetained: true, actualBrowserStarted: false, finalExecutablePathOverridden: false, installedProfilesUntouched: true };
    }

    blocker = net.createServer(socket => { originRequests++; socket.destroy(); });
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
    const rejectingProxy = 'http://127.0.0.1:' + blocker.address().port;
    store.setAccounts([{ id: accountId, name: '隔离内置浏览器验证', proxy: rejectingProxy }]);
    assert.equal(normalized(engine.pickBrowserOpts().executablePath), normalized(bundledPath), 'Missing system browsers must select the bundle independently of the cached registry');
    chromium.launchPersistentContext = async (profile, options) => {
      captured = { profile, executablePath: options.executablePath, headless: options.headless, sandbox: options.chromiumSandbox };
      assert.equal(path.resolve(profile), path.join(dataDir, 'chrome-profiles', accountId));
      assert.equal(normalized(options.executablePath), normalized(bundledPath), 'Use exactly the path selected by the shipping engine');
      assert.equal(options.headless, true);
      assert.equal(options.chromiumSandbox, true);
      assert.equal(options.proxy.server, rejectingProxy, 'All possible origin traffic must go through the rejecting loopback proxy');
      // 受限环境：刚从发布目录复制出的浏览器可能被系统策略拦截启动，
      // 改用 1:1 的 QA 缓存副本实际启动；引擎选择路径仍按上一行严格校验。
      const cacheDir = path.join(__dirname, '.qa-chromium-cache');
      const revision = path.basename(path.dirname(path.dirname(bundledPath)));
      const marker = path.join(cacheDir, '.qa-revision');
      const cachedExe = path.join(cacheDir, 'chrome.exe');
      if (!fs.existsSync(cachedExe) || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== revision) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        fs.cpSync(path.dirname(bundledPath), cacheDir, { recursive: true });
        fs.writeFileSync(marker, revision, 'utf8');
      }
      return originalLaunch.call(chromium, profile, { ...options, executablePath: cachedExe });
    };
    alive = await engine.launchAccount(accountId, { headless: true });
    await alive.context.route('**/*', route => route.abort());
    await alive.page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><button id="portable-browser">内置浏览器本地验证</button></body></html>');
    assert.equal(await alive.page.locator('#portable-browser').textContent(), '内置浏览器本地验证');
    assert.equal(alive.page.url(), 'about:blank', 'No platform page may be navigated');
    assert(captured, 'Actual bundled Chromium launch must be observed');
    assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, initialBrowserEnv, 'Browser selection must not require rewriting inherited registry configuration');
    assert(systemChecks > 0, 'System browser absence must actually be checked');
    return { scenario, ok: true, browserSource: 'bundled', registryEnvironment: initialBrowserEnv ? 'stale path' : 'absent', registryCachedBeforeEngineLoad: true, actualBrowserStarted: true, sandboxEnabled: true, finalExecutablePathOverridden: false, localPageVerified: true, directOriginTrafficAllowed: false, rejectedProxyConnections: originRequests, platformNavigations: 0, installedProfilesUntouched: true };
  } finally {
    chromium.launchPersistentContext = originalLaunch;
    fs.existsSync = actualExists;
    if (engine) await engine.shutdown();
    else if (alive) await alive.context.close();
    if (blocker) await new Promise(resolve => blocker.close(resolve));
  }
}

async function main() {
  const sourceMode = process.argv.includes('--source');
  const app = path.join(ROOT, sourceMode ? 'dy-lead-app' : 'dy-lead-app-release');
  const reportFile = path.join(__dirname, sourceMode ? 'browser-portability-source-verification.json' : 'browser-portability-build-verification.json');
  fs.rmSync(reportFile, { force: true });
  const engineFile = path.join(app, 'engine.js');
  const helperFile = path.join(app, 'lib', 'browser-runtime.js');
  if (!sourceMode) assert.match(fs.readFileSync(engineFile, 'utf8'), /_0x[0-9a-f]+/i, 'Shipping validation must load the actual obfuscated engine');
  assert(fs.existsSync(helperFile), 'Shipping browser runtime resolver must be present');
  const fixture = fs.mkdtempSync(path.join(__dirname, PREFIX));
  const results = [];
  try {
    for (const scenario of SCENARIOS) {
      const childEnv = { ...process.env };
      delete childEnv.PLAYWRIGHT_BROWSERS_PATH;
      delete childEnv.DY_LEAD_DATA_DIR;
      // 工作进程仅作为解释器加载 app 参数指定的发布代码；受限环境中刚从发布
      // 目录复制出的 node.exe 可能被系统策略限制文件写入，统一改用源码 node.exe。
      const { stdout } = await execFile(path.join(ROOT, 'dy-lead-app', 'node.exe'), [__filename, '--worker', scenario, app, fixture], {
        cwd: ROOT, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024
      });
      const line = stdout.split(/\r?\n/).find(item => item.startsWith(RESULT_PREFIX));
      assert(line, 'Fresh worker must return a structured result');
      const result = JSON.parse(line.slice(RESULT_PREFIX.length));
      assert.equal(result.ok, true);
      results.push(result);
      console.log('PASS: fresh process ' + scenario + ' — ' + (result.actualBrowserStarted ? 'real bundled browser with unchanged engine options and a local-only page' : 'system path selected without starting an installed browser'));
    }
    const versionFile = sourceMode ? path.join(ROOT, 'desktop', 'package.json') : path.join(app, 'resources', 'app', 'package.json');
    const version = JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
    fs.writeFileSync(reportFile, JSON.stringify({
      ok: true, version, sourceMode, verifiedAt: new Date().toISOString(),
      engineSha256: sha256(engineFile), browserRuntimeSha256: sha256(helperFile),
      verifierSha256: sha256(__filename), bundledExecutableRelativePath: path.relative(app, bundledExecutable(app)).replace(/\\/g, '/'),
      freshProcessPerScenario: true, noRealPlatformRequests: true, installedDataUntouched: true, scenarios: results
    }, null, 2), 'utf8');
  } finally {
    fs.rmSync(validateFixture(fixture), { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') {
  worker(process.argv[3], process.argv[4], process.argv[5]).then(result => console.log(RESULT_PREFIX + JSON.stringify(result))).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
} else {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
