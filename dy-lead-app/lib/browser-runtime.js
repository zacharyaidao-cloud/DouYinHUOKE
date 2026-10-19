'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BROWSER_ERROR_MESSAGES = {
  BROWSER_EMBEDDED_UNAVAILABLE: '内嵌账号浏览器连接不可用，请重启客户端后再试，账号资料已保留',
  BROWSER_RUNTIME_MISSING: '浏览器程序文件缺失或不完整，请重新安装完整安装包',
  BROWSER_PROFILE_IN_USE: '该账号浏览器资料正在被其他窗口使用，请关闭对应浏览器后重试',
  BROWSER_LAUNCH_TIMEOUT: '账号浏览器启动超时：该账号窗口可能仍在运行，请先关闭对应浏览器窗口，再重新打开登录',
  BROWSER_PROFILE_ACCESS_DENIED: '无法读写账号浏览器资料，请检查安装目录权限后重试',
  BROWSER_LAUNCH_FAILED: '账号浏览器启动失败，请重新打开登录；如仍失败，请联系管理员检查浏览器运行环境',
  BROWSER_UNSUPPORTED_SYSTEM: '当前 Windows 系统不支持内置浏览器，请升级系统后重试'
};

function systemBrowserCandidates(env = process.env) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)', env.LOCALAPPDATA].filter(Boolean);
  const candidates = [];
  // Keep the existing Chrome preference, including users' current profiles.
  for (const name of ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe']) {
    for (const root of roots) candidates.push(path.win32.join(root, name));
  }
  return [...new Set(candidates)];
}

function browserError(code) {
  return Object.assign(new Error(BROWSER_ERROR_MESSAGES[code]), { code });
}

function resolveBrowserRuntime({ appDir, env = process.env, platform = process.platform,
  exists = filename => fs.existsSync(filename), readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8')) } = {}) {
  if (platform !== 'win32') throw browserError('BROWSER_UNSUPPORTED_SYSTEM');
  for (const filename of systemBrowserCandidates(env)) {
    if (exists(filename)) return { executablePath: filename, source: '系统 Chrome / Edge' };
  }
  // Playwright caches its registry at require-time. Resolve the shipped revision
  // directly so another app's cache or PLAYWRIGHT_BROWSERS_PATH cannot redirect it.
  try {
    const coreDir = path.join(path.resolve(appDir), 'node_modules', 'playwright-core');
    const manifest = readJson(path.join(coreDir, 'browsers.json'));
    const chromium = manifest?.browsers?.find(browser => browser.name === 'chromium');
    if (!chromium || !/^\d{1,8}$/.test(String(chromium.revision))) throw browserError('BROWSER_RUNTIME_MISSING');
    const directory = path.join(coreDir, '.local-browsers', 'chromium-' + chromium.revision, 'chrome-win64');
    const executablePath = path.join(directory, 'chrome.exe');
    if (['chrome.exe', 'chrome.dll', 'icudtl.dat', 'resources.pak'].some(name => !exists(path.join(directory, name)))) {
      throw browserError('BROWSER_RUNTIME_MISSING');
    }
    return { executablePath, source: '内置 Chromium' };
  } catch (_) { throw browserError('BROWSER_RUNTIME_MISSING'); }
}

function browserLaunchError(error) {
  if (Object.hasOwn(BROWSER_ERROR_MESSAGES, error?.code)) return browserError(error.code);
  const text = String(error?.message || '');
  let code = 'BROWSER_LAUNCH_FAILED';
  if (/^EMBEDDED_/.test(String(error?.code || ''))) code = 'BROWSER_EMBEDDED_UNAVAILABLE';
  else if (/user data directory is already in use|ProcessSingleton|SingletonLock|profile.*(?:in use|locked)|配置.*(?:占用|锁)/i.test(text)) code = 'BROWSER_PROFILE_IN_USE';
  else if (/Timeout \d+ms exceeded|timed out|启动超时/i.test(text)) code = 'BROWSER_LAUNCH_TIMEOUT';
  else if (/EACCES|EPERM|access (?:is )?denied|permission denied|拒绝访问/i.test(text)) code = 'BROWSER_PROFILE_ACCESS_DENIED';
  else if (/executable (?:doesn.t|does not) exist|ENOENT.*(?:chrome|msedge|chromium)|cannot find.*(?:chrome|msedge|chromium)/i.test(text)) code = 'BROWSER_RUNTIME_MISSING';
  else if (/unsupported.*(?:operating system|Windows)|Windows.*(?:not supported|unsupported)/i.test(text)) code = 'BROWSER_UNSUPPORTED_SYSTEM';
  const result = browserError(code);
  const exitCode = text.match(/exitCode=(-?\d{1,10})\b/);
  if (exitCode) result.browserExitCode = Number(exitCode[1]);
  return result;
}

module.exports = { resolveBrowserRuntime, systemBrowserCandidates, browserLaunchError, BROWSER_ERROR_MESSAGES };
