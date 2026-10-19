'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveBrowserRuntime, systemBrowserCandidates, browserLaunchError, BROWSER_ERROR_MESSAGES } = require('../lib/browser-runtime');

const appDir = path.resolve(__dirname, '..');
const packagedDir = path.join(appDir, 'node_modules', 'playwright-core', '.local-browsers', 'chromium-1243', 'chrome-win64');
const coreFiles = ['chrome.exe', 'chrome.dll', 'icudtl.dat', 'resources.pak'].map(name => path.join(packagedDir, name));
function resolve(files, extra = {}) {
  return resolveBrowserRuntime({ appDir, platform: 'win32', env: {}, exists: file => files.includes(file),
    readJson: () => ({ browsers: [{ name: 'chromium', revision: '1243' }] }), ...extra });
}

test('没有系统浏览器时显式定位随包Chromium，不受未设置或过期Playwright缓存影响', () => {
  for (const env of [{}, { PLAYWRIGHT_BROWSERS_PATH: 'Z:\\another-app-cache' }, { PLAYWRIGHT_BROWSERS_PATH: '0' }]) {
    assert.equal(resolve(coreFiles, { env }).executablePath, path.join(packagedDir, 'chrome.exe'));
    assert.equal(resolve(coreFiles, { env }).source, '内置 Chromium');
  }
});

test('保留Chrome优先，并识别32位Edge及Windows环境变量指定安装盘', () => {
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(resolve([edge, ...coreFiles]).executablePath, edge);
  assert.equal(resolve([edge, chrome, ...coreFiles]).executablePath, chrome);
  const otherDrive = 'E:\\Apps\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(resolve([otherDrive], { env: { ProgramFiles: 'E:\\Apps' } }).executablePath, otherDrive);
  assert(systemBrowserCandidates({ LOCALAPPDATA: 'E:\\Local' }).includes('E:\\Local\\Google\\Chrome\\Application\\chrome.exe'));
});

test('内置可执行文件或核心资源缺失、清单无效均返回明确安全错误', () => {
  for (const removed of coreFiles) assert.throws(() => resolve(coreFiles.filter(file => file !== removed)), error => error.code === 'BROWSER_RUNTIME_MISSING');
  for (const revision of ['../../external', '', '999999999999']) {
    assert.throws(() => resolve(coreFiles, { readJson: () => ({ browsers: [{ name: 'chromium', revision }] }) }), error => error.code === 'BROWSER_RUNTIME_MISSING');
  }
});

test('浏览器启动错误保留可操作类别与退出码，不暴露原始启动参数', () => {
  const cases = [
    ['Failed to create a ProcessSingleton; profile in use', 'BROWSER_PROFILE_IN_USE'],
    ['EPERM access denied', 'BROWSER_PROFILE_ACCESS_DENIED'],
    ["Executable doesn't exist", 'BROWSER_RUNTIME_MISSING'],
    ['unsupported Windows operating system', 'BROWSER_UNSUPPORTED_SYSTEM'],
    ['Target page, context or browser has been closed', 'BROWSER_LAUNCH_FAILED']
  ];
  for (const [text, code] of cases) {
    const result = browserLaunchError(new Error(text + ' sessionid=private --proxy-server=http://user:password@invalid exitCode=21'));
    assert.equal(result.code, code); assert.equal(result.message, BROWSER_ERROR_MESSAGES[code]); assert.equal(result.browserExitCode, 21);
    assert.doesNotMatch(result.message, /sessionid|password|private/);
  }
});

function engineFixture({ rejectClose = false, failLaunch = false, embedded = false, embeddedAvailable = true,
  failEmbedded = false, afterEmbeddedOpen, afterShow, desktop = embedded, browserMode = embedded ? 'embedded' : undefined } = {}) {
  const source = fs.readFileSync(path.join(appDir, 'engine.js'), 'utf8');
  const start = source.indexOf('const contexts = new Map()'), end = source.indexOf('/* ===================== 登录检测', start);
  assert(start > 0 && end > start);
  const calls = [], browsers = [], embeddedRequests = [], profiles = [], logs = [], runtimeRequests = [], clients = [];
  const dataDir = path.join(appDir, 'synthetic-browser-runtime-data');
  const accounts = [{ id: 'qa-account', name: 'synthetic first', proxy: 'synthetic proxy setting', browserMode }, { id: 'qa-other', name: 'synthetic second', browserMode }];
  function makeContext(accountId) {
    let closed = false;
    const closeListeners = [], responseListeners = [];
    const page = { isClosed: () => closed, on: (event, fn) => { if (event === 'response') responseListeners.push(fn); } };
    const browser = { pages: () => [page], on: (event, fn) => { if (event === 'close') closeListeners.push(fn); },
      close: async () => {
        if (closed) return;
        calls.push('close'); if (rejectClose) throw new Error('profile in use');
        closed = true; for (const listener of closeListeners) listener();
      }, accountId, responseListeners };
    browsers.push(browser); return { context: browser, page };
  }
  const context = {
    __dirname: appDir, path, process: { env: desktop ? { DY_LEAD_EMBEDDED_BROWSER: '1' } : {} }, embeddedBrowserClient: undefined,
    parseProxy: value => value ? { server: 'http://127.0.0.1:9876' } : null,
    authorize: async () => { calls.push('authorize'); },
    store: { DATA_DIR: dataDir, getAccounts: () => accounts,
      profileDir: id => { profiles.push(id); return path.join(dataDir, 'chrome-profiles', id); }, log: (accountId, text) => logs.push({ accountId, text }) },
    resolveBrowserRuntime: options => { runtimeRequests.push(options); return { executablePath: 'isolated-runtime', source: '内置 Chromium' }; },
    browserLaunchError, logBrowserFailure: () => {}, passiveProfileResponse: async () => {},
    createLoginMonitor: () => ({ dispose: () => calls.push('dispose') }),
    chromium: { launchPersistentContext: async (profile, options) => {
      calls.push('launch:' + options.headless);
      if (failLaunch) throw new Error('Target page, context or browser has been closed exitCode=22 proxy=private');
      return makeContext(path.basename(profile)).context;
    } },
    createEmbeddedBrowserClient: options => {
      clients.push(options);
      return { isAvailable: () => embeddedAvailable, open: async options => {
        embeddedRequests.push(options);
        if (failEmbedded) throw Object.assign(new Error('private-token=synthetic-secret payload=private'), { code: 'EMBEDDED_CONNECT_FAILED' });
        const resource = { ...makeContext(options.accountId), embedded: true, show: async () => {
          calls.push('show:' + options.accountId); if (afterShow) afterShow(resource);
        } };
        resource.close = () => resource.context.close();
        if (afterEmbeddedOpen) afterEmbeddedOpen(resource);
        return resource;
      } };
    }
  };
  const engine = vm.runInNewContext('(function(){' + source.slice(start, end) + ';return {launchAccount,closeAccount,getAlive};})()', context);
  return { engine, calls, browsers, embeddedRequests, profiles, logs, runtimeRequests, clients, dataDir, accounts };
}

test('桌面支持内嵌仍默认外部，显式外部也使用原chrome-profiles', async () => {
  for (const browserMode of [undefined, 'external']) {
    const f = engineFixture({ desktop: true, browserMode });
    const alive = await f.engine.launchAccount('qa-account');
    assert.equal(alive.embedded, false);
    assert.equal(f.runtimeRequests.length, 1); assert.equal(f.clients.length, 0);
    assert.match(f.logs[0].text, /chrome-profiles/);
  }
});

test('模式改变不复用另一内核，返回外部模式仍使用原资料路径', async () => {
  const f = engineFixture({ desktop: true });
  const original = await f.engine.launchAccount('qa-account');
  f.accounts[0].browserMode = 'embedded';
  const internal = await f.engine.launchAccount('qa-account');
  assert.equal(original.page.isClosed(), true); assert.equal(internal.embedded, true);
  f.accounts[0].browserMode = 'external';
  const external = await f.engine.launchAccount('qa-account');
  assert.equal(internal.page.isClosed(), true); assert.equal(external.embedded, false);
  assert.equal(f.embeddedRequests.length, 1); assert.equal(f.runtimeRequests.length, 2);
  assert.match(f.logs.at(-1).text, /chrome-profiles/);
});

test('严格关闭失败保留原上下文；非桌面不能悄悄把内嵌选择改成外部', async () => {
  const f = engineFixture({ rejectClose: true });
  const alive = await f.engine.launchAccount('qa-account');
  await assert.rejects(f.engine.closeAccount('qa-account', { strict: true }), /原模式和资料已保留/);
  assert.equal(f.engine.getAlive('qa-account'), alive);
  const unsupported = engineFixture({ browserMode: 'embedded' });
  await assert.rejects(unsupported.engine.launchAccount('qa-account'), e => e.code === 'BROWSER_EMBEDDED_UNAVAILABLE');
  assert.equal(unsupported.browsers.length, 0);
});

test('用户打开登录不复用后台窗口，先释放同一账号资料再启动可见浏览器', async () => {
  const f = engineFixture();
  const background = await f.engine.launchAccount('qa-account', { headless: true });
  const visible = await f.engine.launchAccount('qa-account');
  assert.notEqual(background.context, visible.context); assert.equal(visible.headless, false);
  assert.deepEqual(f.calls.filter(call => call !== 'authorize'), ['launch:true', 'close', 'dispose', 'launch:false']);
  assert.equal(await f.engine.launchAccount('qa-account'), visible);
  assert.equal(f.browsers.length, 2);
});

test('后台资料无法释放则不启动第二个同账号窗口，停止后也不会启动新进程', async () => {
  const f = engineFixture({ rejectClose: true });await f.engine.launchAccount('qa-account', { headless: true });
  await assert.rejects(f.engine.launchAccount('qa-account'), error => error.code === 'BROWSER_PROFILE_IN_USE');
  assert.equal(f.browsers.length, 1);
  await assert.rejects(f.engine.launchAccount('qa-account', { checkStopped: () => { throw new Error('stopped'); } }), /stopped/);
  assert.equal(f.browsers.length, 1);
});

test('进程未成功启动不伪报已启动，不把关闭的进程错误当作用户关闭窗口', async () => {
  const f = engineFixture({ failLaunch: true });
  await assert.rejects(f.engine.launchAccount('qa-account'), error => error.code === 'BROWSER_LAUNCH_FAILED' && error.browserExitCode === 22);
  assert.equal(f.engine.getAlive('qa-account'), null);
});

test('内嵌启动只走内嵌提供者，每账号使用独立Electron资料且不复用Chrome资料', async () => {
  const f = engineFixture({ embedded: true });
  const first = await f.engine.launchAccount('qa-account', { headless: true });
  const second = await f.engine.launchAccount('qa-other');
  assert.equal(first.embedded, true); assert.equal(second.embedded, true);
  assert.notEqual(first.context, second.context); assert.notEqual(first.page, second.page);
  assert.equal(f.clients.length, 1, '所有账号共享传输客户端，每个账号仍有独立上下文');
  assert.equal(f.runtimeRequests.length, 0, '内嵌模式不查找或启动外部Chrome');
  assert.equal(f.calls.some(call => call.startsWith('launch:')), false);
  assert.deepEqual(f.profiles, ['qa-account', 'qa-other'], '仍先走store账号profile标识校验');
  assert.deepEqual(f.embeddedRequests.map(item => [item.accountId, item.profileDir, item.visible]), [
    ['qa-account', path.join(f.dataDir, 'electron-profiles', 'qa-account'), false],
    ['qa-other', path.join(f.dataDir, 'electron-profiles', 'qa-other'), true]
  ]);
  for (const request of f.embeddedRequests) assert(!request.profileDir.includes('chrome-profiles'));
  assert.equal(f.embeddedRequests[0].name, 'synthetic first');
  assert.equal(f.embeddedRequests[0].proxy.server, 'http://127.0.0.1:9876');
  assert.equal(f.embeddedRequests[1].proxy, null);
  assert.equal(first.context.responseListeners.length, 1); assert.equal(second.context.responseListeners.length, 1);
  await f.engine.closeAccount('qa-account');
  assert.equal(f.engine.getAlive('qa-account'), null); assert.equal(second.page.isClosed(), false);
  assert.equal(f.engine.getAlive('qa-other'), second, '关闭一个账号不影响另一个账号缓存');
});

test('隐藏内嵌账号转显示只调用show，复用页面和登录观察器，不再建第二个窗口', async () => {
  const f = engineFixture({ embedded: true });
  const background = await f.engine.launchAccount('qa-account', { headless: true });
  const visible = await f.engine.launchAccount('qa-account');
  assert.equal(visible, background); assert.equal(visible.headless, false);
  assert.equal(f.embeddedRequests.length, 1); assert.equal(f.browsers.length, 1);
  assert.deepEqual(f.calls.filter(call => call !== 'authorize'), ['show:qa-account']);
  assert.equal(await f.engine.launchAccount('qa-account'), visible);
  assert.equal(await f.engine.launchAccount('qa-account', { headless: true }), visible);
  assert.equal(f.calls.filter(call => call === 'show:qa-account').length, 1);
  assert.equal(visible.context.responseListeners.length, 1, '复用不重复注册响应观察器');
  assert.equal(f.calls.includes('dispose'), false);
});

test('要求内嵌但IPC不可用或内嵌连接失败时明确失败，绝不回退外部浏览器', async () => {
  for (const options of [{ embeddedAvailable: false }, { failEmbedded: true }]) {
    const f = engineFixture({ embedded: true, ...options });
    await assert.rejects(f.engine.launchAccount('qa-account'), failure => failure.code === 'BROWSER_EMBEDDED_UNAVAILABLE'
      && !/token|payload|private|synthetic-secret/.test(failure.message));
    assert.equal(f.engine.getAlive('qa-account'), null);
    assert.equal(f.runtimeRequests.length, 0); assert.equal(f.browsers.length, 0);
    assert.equal(f.calls.some(call => call.startsWith('launch:')), false);
    assert.equal(f.logs.some(item => item.text.includes('浏览器已启动')), false);
    assert.equal(f.embeddedRequests.length, options.embeddedAvailable === false ? 0 : 1);
  }
});

test('停止在内嵌创建前不会打开页面，创建后停止会关闭新上下文并清理缓存', async () => {
  const stop = Object.assign(new Error('synthetic stopped'), { code: 'TASK_STOPPED' });
  const before = engineFixture({ embedded: true });
  await assert.rejects(before.engine.launchAccount('qa-account', { checkStopped: () => { throw stop; } }), failure => failure === stop);
  assert.equal(before.embeddedRequests.length, 0); assert.equal(before.browsers.length, 0);
  let stopped = false;
  const after = engineFixture({ embedded: true, afterEmbeddedOpen: () => { stopped = true; } });
  await assert.rejects(after.engine.launchAccount('qa-account', { checkStopped: () => { if (stopped) throw stop; } }), failure => failure === stop);
  assert.equal(after.embeddedRequests.length, 1); assert.equal(after.browsers[0].pages()[0].isClosed(), true);
  assert.equal(after.engine.getAlive('qa-account'), null); assert.equal(after.calls.filter(call => call === 'close').length, 1);
  assert.equal(after.logs.some(item => item.text.includes('浏览器已启动')), false);
});

test('内嵌创建后回调失败会释放登录观察器，随后可重新打开同账号', async () => {
  const f = engineFixture({ embedded: true });
  await assert.rejects(f.engine.launchAccount('qa-account', { onCreated: () => { throw new Error('synthetic creation cancelled'); } }), /synthetic creation cancelled/);
  assert.equal(f.engine.getAlive('qa-account'), null);
  assert.deepEqual(f.calls.filter(call => call !== 'authorize'), ['close', 'dispose']);
  const reopened = await f.engine.launchAccount('qa-account');
  assert.equal(reopened.page.isClosed(), false); assert.equal(f.embeddedRequests.length, 2);
  assert.notEqual(reopened.context, f.browsers[0]);
});

test('显示复用期间收到停止信号会立即向上传递，不启动替代外部窗口', async () => {
  let stopped = false;
  const f = engineFixture({ embedded: true, afterShow: () => { stopped = true; } });
  const existing = await f.engine.launchAccount('qa-account', { headless: true });
  await assert.rejects(f.engine.launchAccount('qa-account', { checkStopped: () => { if (stopped) throw new Error('stop after show'); } }), /stop after show/);
  assert.equal(f.engine.getAlive('qa-account'), existing);
  assert.equal(f.embeddedRequests.length, 1); assert.equal(f.browsers.length, 1);
  assert.equal(f.calls.some(call => call.startsWith('launch:')), false);
});

test('启动超时映射为“账号窗口仍占用”的可操作提示', () => {
  const timeout = browserLaunchError(new Error('browserType.launchPersistentContext: Timeout 45000ms exceeded.'));
  assert.equal(timeout.code, 'BROWSER_LAUNCH_TIMEOUT');
  assert.match(timeout.message, /关闭对应浏览器窗口/);
  const other = browserLaunchError(new Error('unexpected launch failure'));
  assert.equal(other.code, 'BROWSER_LAUNCH_FAILED');
});
