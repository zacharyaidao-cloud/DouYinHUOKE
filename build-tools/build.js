/**
 * 构建脚本：把源码混淆后组装成可发布的程序目录（dy-lead-app-release）
 * 混淆目标：server.js / engine.js / store.js / license.js
 * 发布目录剔除：tools/（开发工具与含密钥脚本）、data/（用户数据）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const obfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'dy-lead-app');
const OUT = path.join(ROOT, 'dy-lead-app-release');

const OBF_FILES = fs.readdirSync(SRC).filter(name => name.endsWith('.js'));
const ELECTRON_RUNTIME = path.join(__dirname, 'electron-runtime-44.6.0');
if (!fs.existsSync(path.join(ELECTRON_RUNTIME, 'electron.exe'))) throw new Error('缺少已校验的 Electron 44.6.0 运行时，请先运行 prepare-electron.ps1');

const OPTIONS = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  rotateStringArray: true,
  shuffleStringArray: true,
  target: 'node',
  log: false
};

// 正式客户包使用已核验的公开配置，不依赖临时环境变量或开发机 config。
// 在清理旧产物前失败，避免生成能启动但不能登录的客户包。
const publicLicensePath = process.env.DY_LEAD_LICENSE_CONFIG || path.join(SRC, 'trusted-license.json');
if (!fs.existsSync(publicLicensePath)) throw new Error('缺少正式公开授权配置，拒绝打包');
const lic = JSON.parse(fs.readFileSync(publicLicensePath, 'utf8').replace(/^\uFEFF/, ''));
const licenseUrl = new URL(String(lic.serverUrl || ''));
if (lic.enabled !== true || licenseUrl.protocol !== 'https:' || licenseUrl.username || licenseUrl.password || licenseUrl.search || licenseUrl.hash ||
    !Array.isArray(lic.allowedHosts) || !lic.allowedHosts.length || !lic.allowedHosts.includes(licenseUrl.host)) {
  throw new Error('正式授权必须为 HTTPS 且匹配允许域名，拒绝打包');
}
if (!/^\s*-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(String(lic.publicKey || '')) || /PRIVATE KEY/.test(String(lic.publicKey))) {
  throw new Error('发行授权配置只能包含公钥，已拒绝将非公钥材料打入客户包');
}
if (crypto.createPublicKey(lic.publicKey).asymmetricKeyType !== 'rsa') throw new Error('客户授权配置需使用 RSA 公钥');
const trustedLicense = { enabled: true, serverUrl: lic.serverUrl, allowedHosts: lic.allowedHosts, publicKey: lic.publicKey };

// The desktop uses Electron WebContentsView. Retain the bundled Chromium only
// for isolated regression fixtures and source-mode compatibility in this release.
const { resolveBrowserRuntime, systemBrowserCandidates } = require(path.join(SRC, 'lib', 'browser-runtime'));
const systemBrowserPaths = new Set(systemBrowserCandidates().map(filename => filename.toLowerCase()));
const bundledRuntime = resolveBrowserRuntime({ appDir: SRC, exists: filename => !systemBrowserPaths.has(filename.toLowerCase()) && fs.existsSync(filename) });
if (bundledRuntime.source !== '内置 Chromium') throw new Error('缺少本版隔离验证所需的完整内置 Chromium，拒绝打包');
const wsDirectory = path.join(SRC, 'node_modules', 'ws');
const wsPackage = JSON.parse(fs.readFileSync(path.join(wsDirectory, 'package.json'), 'utf8'));
if (wsPackage.name !== 'ws' || wsPackage.version !== '8.22.0' || !fs.existsSync(path.join(wsDirectory, 'index.js')) || !fs.existsSync(path.join(wsDirectory, 'lib', 'websocket.js'))) {
  throw new Error('缺少已核验的 ws 8.22.0 内嵌浏览器桥接依赖，拒绝打包');
}
for (const filename of ['desktop/main.js', 'desktop/preload.js', 'desktop/account-browser-host.js', 'desktop/smoke-checks.js', 'dy-lead-app/lib/embedded-browser-client.js']) {
  if (!fs.existsSync(path.join(ROOT, filename))) throw new Error('缺少内嵌账号浏览器模块：' + filename);
}

const releaseVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).version;
const guideName = `华贸获客-字段与采集流程说明-${releaseVersion}.html`;
const guideSource = path.join(ROOT, '使用文档', guideName);
if (!fs.existsSync(guideSource) || !fs.readFileSync(guideSource, 'utf8').includes(`字段与采集流程说明 ${releaseVersion}</title>`)) throw new Error('缺少当前版本字段流程文档，请先生成文档再打包');
if (!fs.readFileSync(path.join(ROOT, 'desktop', '使用说明.txt'), 'utf8').startsWith(`华贸获客 ${releaseVersion} 独立客户端`)) throw new Error('随包使用说明版本过期，请更新后再打包');

function rmdir(p) {
  if (path.resolve(p) !== path.join(ROOT, 'dy-lead-app-release')) throw new Error('拒绝清理未确认的路径');
  if (fs.existsSync(path.join(p, 'data'))) throw new Error('发布目录存在用户数据，拒绝清理');
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst, exclude = []) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (exclude.includes(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d, []);
    else {
      // 杀毒软件可能瞬时锁定 DLL/EXE，纯 JS 阻塞等待后重试
      for (let attempt = 0; ; attempt++) {
        try { fs.copyFileSync(s, d); break; }
        catch (e) {
          if ((e.code === 'EPERM' || e.code === 'EBUSY') && attempt < 10) {
            try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); } catch { const end = Date.now() + 800; while (Date.now() < end) { /* busy */ } }
            continue;
          }
          throw e;
        }
      }
    }
  }
}

console.log('1) 清空输出目录');
rmdir(OUT);
fs.mkdirSync(OUT, { recursive: true });

console.log('2) 复制静态资源');
// Runtime dependencies are explicit; do not include development tools or data.
copyDir(path.join(SRC, 'web'), path.join(OUT, 'web'));
copyDir(path.join(SRC, 'lib'), path.join(OUT, 'lib'));
copyDir(path.join(SRC, 'node_modules', 'playwright-core'), path.join(OUT, 'node_modules', 'playwright-core'));
copyDir(wsDirectory, path.join(OUT, 'node_modules', 'ws'));
fs.copyFileSync(path.join(SRC, 'node.exe'), path.join(OUT, 'node.exe'));
fs.copyFileSync(path.join(ROOT, 'desktop', '使用说明.txt'), path.join(OUT, '使用说明.txt'));
fs.mkdirSync(path.join(OUT, '使用文档'), { recursive: true });
fs.copyFileSync(guideSource, path.join(OUT, '使用文档', guideName));
fs.copyFileSync(path.join(__dirname, 'app.ico'), path.join(OUT, 'icon.ico'));
// Windows 文件名不区分大小写；Electron 的 LICENSE 会抢先匹配 require('./license')。
copyDir(ELECTRON_RUNTIME, OUT, ['LICENSE']);
fs.copyFileSync(path.join(ELECTRON_RUNTIME, 'LICENSE'), path.join(OUT, 'Electron-LICENSE.txt'));
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, '抖音获客软件.exe'));
const desktopDir = path.join(OUT, 'resources', 'app');
copyDir(path.join(ROOT, 'desktop'), desktopDir);

console.log('3) 发布客户版配置（无本机管理员；授权配置与 dataDir 分离）');
const publicConfig = { dataDir: '', license: trustedLicense };
fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify(publicConfig, null, 2), 'utf-8');
fs.writeFileSync(path.join(OUT, 'trusted-license.json'), JSON.stringify(trustedLicense, null, 2), 'utf-8');

console.log('4) 混淆核心代码');
for (const f of OBF_FILES) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf-8');
  const result = obfuscator.obfuscate(code, OPTIONS);
  fs.writeFileSync(path.join(OUT, f), result.getObfuscatedCode(), 'utf-8');
  console.log('  混淆:', f, Math.round(code.length / 1024) + 'KB →', Math.round(result.getObfuscatedCode().length / 1024) + 'KB');
}

console.log('5) 完成 →', OUT);
