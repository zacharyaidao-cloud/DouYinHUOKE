'use strict';
/**
 * 发布门禁（release-verify）
 *
 * 设计目标：把“能不能发”拆成可独立运行的层，任何一层失败都给出精确原因，
 * 而不是等安装包做完了才发现配置里带密钥、或新代码没进产物。
 *
 *   static    版本一致性、语法、授权配置只含公钥
 *   unit      全部单元/集成测试（node --test）
 *   artifact  发布目录清单、混淆、隐私隔离、配置字段、SHA256 清单
 *   smoke     真实启动发布版后端：健康检查、页面、未授权拒绝、路径穿越
 *   installer 安装包/绿色包存在、大小、校验值
 *   deep      端到端脚本（真实浏览器/桌面/内嵌浏览器），按需开启
 *
 * 用法：
 *   node build-tools/release-verify.js                       # static,unit,artifact,smoke
 *   node build-tools/release-verify.js --gates=static,artifact,smoke
 *   node build-tools/release-verify.js --gates=deep          # 端到端
 *   node build-tools/release-verify.js --gates=installer
 *   node build-tools/release-verify.js --json=report.json
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const TOOL_DIR = __dirname;
const ROOT = path.resolve(TOOL_DIR, '..');
const SRC = path.join(ROOT, 'dy-lead-app');
const OUT = path.join(ROOT, 'dy-lead-app-release');
const REPORT_DIR = path.join(TOOL_DIR, 'reports');
const NODE = process.execPath;

const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(item);
  return match ? [match[1], match[2] === undefined ? true : match[2]] : [item, true];
}));
const requested = String(args.gates || 'static,unit,artifact,smoke').split(',').map(x => x.trim()).filter(Boolean);
const jsonPath = args.json ? path.resolve(String(args.json)) : path.join(REPORT_DIR, 'release-verify.json');

const report = { tool: 'release-verify', generatedAt: new Date().toISOString(), root: ROOT, version: '', ok: true, gates: [] };
function releaseFingerprint() {
  try { return sha256(path.join(OUT, 'server.js')); } catch { return ''; }
}
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  return !!ok;
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function versionOf() {
  const pkg = readJson(path.join(ROOT, 'desktop/package.json'));
  return String(pkg.version || '');
}

/* ------------------------------------------------------------------ static */
function runStatic() {
  const version = versionOf();
  report.version = version;
  check('version-format', /^\d+\.\d+\.\d+$/.test(version), version || 'missing');

  const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const serverVersions = [...server.matchAll(/version:\s*'(\d+\.\d+\.\d+)'/g)].map(m => m[1]);
  check('server-version', serverVersions.length >= 2 && serverVersions.every(v => v === version), serverVersions.join(','));

  const preload = fs.readFileSync(path.join(ROOT, 'desktop/preload.js'), 'utf8');
  const preloadVersion = (/version:\s*'(\d+\.\d+\.\d+)'/.exec(preload) || [])[1] || '';
  check('preload-version', preloadVersion === version, preloadVersion || 'missing');

  const serverTest = fs.readFileSync(path.join(SRC, 'tests/server.test.js'), 'utf8');
  const tested = (/body\.version\s*,\s*'(\d+\.\d+\.\d+)'/.exec(serverTest) || [])[1] || '';
  check('test-version', tested === version, tested || 'missing');

  const iss = fs.readFileSync(path.join(TOOL_DIR, 'setup.iss'), 'utf8');
  const issVersion = (/#define\s+MyAppVersion\s+"([^"]+)"/.exec(iss) || [])[1] || '';
  check('installer-version', issVersion === version, issVersion || 'missing');

  const guide = path.join(ROOT, '使用文档', `华贸获客-字段与采集流程说明-${version}.html`);
  check('field-guide', fs.existsSync(guide) && fs.readFileSync(guide, 'utf8').includes(`字段与采集流程说明 ${version}</title>`), path.basename(guide));

  const sourceFiles = [
    ...fs.readdirSync(SRC).filter(name => name.endsWith('.js')).map(name => path.join(SRC, name)),
    ...fs.readdirSync(path.join(SRC, 'lib')).filter(name => name.endsWith('.js')).map(name => path.join(SRC, 'lib', name)),
    ...fs.readdirSync(path.join(SRC, 'core')).filter(name => name.endsWith('.js')).map(name => path.join(SRC, 'core', name))
  ];
  let syntaxOk = 0;
  for (const file of sourceFiles) {
    const result = spawnSync(NODE, ['--check', file], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) check('syntax:' + path.relative(ROOT, file), false, (result.stderr || '').split('\n')[0]);
    else syntaxOk++;
  }
  check('syntax-all', syntaxOk === sourceFiles.length, `${syntaxOk}/${sourceFiles.length}`);

  const trusted = readJson(path.join(SRC, 'trusted-license.json'));
  const url = (() => { try { return new URL(String(trusted.serverUrl || '')); } catch { return null; } })();
  check('license-https', !!url && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, trusted.serverUrl || '');
  check('license-public-only', /^-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(String(trusted.publicKey || ''))
    && !/PRIVATE KEY/.test(String(trusted.publicKey || '')), '只允许 RSA 公钥');
  check('license-hosts', Array.isArray(trusted.allowedHosts) && url && trusted.allowedHosts.includes(url.host), (trusted.allowedHosts || []).join(','));

  for (const name of ['main.js', 'preload.js', 'account-browser-host.js', 'legacy-preflight.js']) {
    check('desktop:' + name, fs.existsSync(path.join(ROOT, 'desktop', name)));
  }
}

/* -------------------------------------------------------------------- unit */
// 浏览器 E2E 与普通单测分开跑：UI 用例对时序敏感，和 40 多个文件并行时会因 CPU
// 争用产生假失败。浏览器批次串行执行，并允许一次重试（仍失败即判失败）。
// account-login-scan 含真实 Chromium 用例，并行时同样因 CPU 争用超时，归入串行浏览器批次
const BROWSER_TESTS = new Set(['ui.test.js', 'collection-entry-ui.test.js', 'embedded-browser-ui.test.js', 'account-login-scan.test.js', 'keyword-stats-ui.test.js', 'inbox-ui.test.js']);
function parseTap(output) {
  return {
    tests: Number((/# tests (\d+)/.exec(output) || [])[1] || 0),
    passes: Number((/# pass (\d+)/.exec(output) || [])[1] || 0),
    failures: Number((/# fail (\d+)/.exec(output) || [])[1] || 0),
    failedNames: output.split('\n').filter(line => /^\s*not ok /.test(line)).slice(0, 20)
  };
}
function runUnitBatch(files, concurrency) {
  // 显式 TAP：Node 23+ 非终端默认不再输出 TAP，否则统计为 0 个测试
  const result = spawnSync(NODE, ['--test', '--test-reporter=tap', `--test-concurrency=${concurrency}`, ...files.map(name => path.join('tests', name))], {
    cwd: SRC, encoding: 'utf8', timeout: Number(args['timeout-unit'] || 15 * 60 * 1000), maxBuffer: 64 * 1024 * 1024
  });
  const output = String(result.stdout || '') + String(result.stderr || '');
  return { status: result.status, output, ...parseTap(output) };
}
function runUnit() {
  const testsDir = path.join(SRC, 'tests');
  const files = fs.readdirSync(testsDir).filter(name => name.endsWith('.test.js')).sort();
  check('test-files', files.length > 0, `${files.length} files`);
  const fast = files.filter(name => !BROWSER_TESTS.has(name));
  const browser = files.filter(name => BROWSER_TESTS.has(name));
  const started = Date.now();
  const totals = { tests: 0, passes: 0, failures: 0 };
  const failedNames = [];

  const fastRun = runUnitBatch(fast, 4);
  totals.tests += fastRun.tests; totals.passes += fastRun.passes; totals.failures += fastRun.failures;
  failedNames.push(...fastRun.failedNames);
  check('unit-core', fastRun.status === 0 && fastRun.failures === 0, `tests=${fastRun.tests} pass=${fastRun.passes} fail=${fastRun.failures}`);

  let browserRun = runUnitBatch(browser, 1);
  let retried = false;
  if (browserRun.status !== 0) {
    retried = true;
    check('unit-browser-retry', true, '首次失败，串行重试一次');
    browserRun = runUnitBatch(browser, 1);
  }
  totals.tests += browserRun.tests; totals.passes += browserRun.passes; totals.failures += browserRun.failures;
  failedNames.push(...browserRun.failedNames);
  check('unit-browser', browserRun.status === 0 && browserRun.failures === 0, `tests=${browserRun.tests} pass=${browserRun.passes} fail=${browserRun.failures} retried=${retried}`);

  if (failedNames.length) {
    check('unit-failures', false, failedNames.join(' | '));
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'unit-failure.log'), fastRun.output + '\n' + browserRun.output, 'utf8');
  }
  report.unit = { ...totals, retried, durationMs: Date.now() - started };
}

/* ---------------------------------------------------------------- artifact */
const REQUIRED = [
  'server.js', 'engine.js', 'engine-actions.js', 'engine-ai-tasks.js', 'engine-collection-tasks.js',
  'engine-dm-distribution.js', 'engine-search-tasks.js', 'ai.js', 'scheduler.js', 'store.js',
  'workflow.js', 'lead-query.js', 'license.js', 'config.json', 'trusted-license.json',
  'node.exe', '抖音获客软件.exe', 'web/index.html', 'web/app.js', 'web/style.css',
  'lib/lead-fields.js', 'lib/outreach-browser.js', 'lib/dm-protocol.js', 'lib/browser-runtime.js',
  'engine-core-collect.js', 'core/session.js', 'core/search.js', 'core/collect.js', 'core/follow.js', 'core/pacing.js', 'lib/page-comments.js', 'lib/competitor-screen.js', 'lib/work-record.js', 'lib/lead-dedupe.js', 'lib/keyword-stats.js', 'lib/im-inbox.js', 'lib/inbox-store.js', 'core/inbox.js', 'engine-inbox-tasks.js',
  'node_modules/playwright-core/package.json', 'node_modules/ws/package.json',
  'resources/app/main.js', 'resources/app/preload.js', 'resources/app/account-browser-host.js',
  '使用说明.txt'
];
const FORBIDDEN_DIRS = ['tools', 'data', 'license-server', 'license-admin-web', 'tests', 'build-tools', 'chrome-profiles', 'electron-profiles'];
const FORBIDDEN_FILES = ['settings.json', 'leads.json', 'accounts.json', 'videos.json', 'daily.json', 'license-cache.json',
  'servertime.json', 'dm-account-state.json', 'contact-allocation.json', '管理端配置.env', '本人测试账户.txt', '服务器密钥.txt'];

function walk(dir, base = '') {
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rows.push(...walk(full, rel));
    else if (entry.isFile()) rows.push({ rel, full, size: fs.statSync(full).size });
  }
  return rows;
}

function runArtifact() {
  if (!fs.existsSync(OUT)) throw new Error('发布目录不存在：' + OUT);
  const version = versionOf();
  for (const rel of REQUIRED) check('required:' + rel, fs.existsSync(path.join(OUT, rel)));
  const guide = `使用文档/华贸获客-字段与采集流程说明-${version}.html`;
  check('required:' + guide, fs.existsSync(path.join(OUT, guide)));

  const pkg = readJson(path.join(OUT, 'resources/app/package.json'));
  check('release-version', pkg.version === version, pkg.version || 'missing');

  // 源码改动后忘记重新构建，是发布里最危险的低级错误：报告看起来全绿，
  // 装出来的却是旧代码。用 mtime 做一次强制一致性检查。
  const watched = [
    ...fs.readdirSync(SRC).filter(name => name.endsWith('.js')).map(name => path.join(SRC, name)),
    ...fs.readdirSync(path.join(SRC, 'lib')).filter(name => name.endsWith('.js')).map(name => path.join(SRC, 'lib', name)),
    ...fs.readdirSync(path.join(SRC, 'core')).filter(name => name.endsWith('.js')).map(name => path.join(SRC, 'core', name)),
    path.join(SRC, 'web', 'app.js'), path.join(SRC, 'web', 'index.html'),
    path.join(ROOT, 'desktop', 'main.js')
  ];
  const newestSource = Math.max(...watched.map(file => fs.statSync(file).mtimeMs));
  const releaseTime = fs.statSync(path.join(OUT, 'server.js')).mtimeMs;
  check('release-current', releaseTime >= newestSource,
    `源码 ${new Date(newestSource).toISOString()} / 发布 ${new Date(releaseTime).toISOString()}，需重新构建`);

  const files = walk(OUT);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  check('file-count', files.length > 20, String(files.length));
  check('total-size', totalBytes > 200 * 1024 * 1024 && totalBytes < 1500 * 1024 * 1024, (totalBytes / 1024 / 1024).toFixed(1) + ' MB');

  const badPaths = files.map(file => file.rel).filter(rel =>
    FORBIDDEN_DIRS.some(dir => rel === dir || rel.startsWith(dir + '/')) ||
    FORBIDDEN_FILES.includes(path.basename(rel)) ||
    /(^|\/)(chrome-profiles|electron-profiles)(\/|$)/.test(rel));
  check('privacy-paths', badPaths.length === 0, badPaths.slice(0, 8).join(', '));

  // 空目录同样不能交付：data/ 一旦被创建（例如用默认数据目录启动过一次），
  // 压缩工具会把空目录一起打进去，客户包里就出现了用户数据路径。
  const dirs = [];
  (function walkDirs(dir, base) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = base ? base + '/' + entry.name : entry.name;
      dirs.push(rel);
      walkDirs(path.join(dir, entry.name), rel);
    }
  })(OUT, '');
  const badDirs = dirs.filter(rel => FORBIDDEN_DIRS.some(name => rel === name || rel.startsWith(name + '/')));
  check('privacy-dirs', badDirs.length === 0, badDirs.slice(0, 8).join(', '));

  const badExt = files.map(file => file.rel).filter(rel =>
    !rel.startsWith('node_modules/playwright-core/.local-browsers/') &&
    (/\.(map|log|bak|tmp)$/.test(rel) || /(^|\/)tests\//.test(rel)));
  check('no-build-residue', badExt.length === 0, badExt.slice(0, 8).join(', '));

  const config = readJson(path.join(OUT, 'config.json'));
  check('config-dataDir', config.dataDir === '', JSON.stringify(config.dataDir));
  check('config-no-admin', !Object.hasOwn(config, 'adminPassword') && !Object.hasOwn(config, 'adminKey'), Object.keys(config).join(','));
  check('config-license', config.license && config.license.enabled === true && String(config.license.serverUrl).startsWith('https://'), String(config.license && config.license.serverUrl));

  const trusted = readJson(path.join(OUT, 'trusted-license.json'));
  check('trusted-public-only', /^-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(String(trusted.publicKey || '')) && !/PRIVATE KEY/.test(String(trusted.publicKey || '')), '');

  const nodeModules = fs.readdirSync(path.join(OUT, 'node_modules')).filter(name => !name.startsWith('.'));
  check('runtime-deps', nodeModules.length === 2 && nodeModules.includes('playwright-core') && nodeModules.includes('ws'), nodeModules.join(','));

  // 顶层脚本必须经过混淆；lib 与 desktop 必须与源码逐字节一致。
  const topLevel = fs.readdirSync(SRC).filter(name => name.endsWith('.js'));
  let obfuscated = 0;
  for (const name of topLevel) {
    const sourceHash = sha256(path.join(SRC, name));
    const releaseFile = path.join(OUT, name);
    if (!fs.existsSync(releaseFile)) { check('obf:' + name, false, 'missing'); continue; }
    if (sha256(releaseFile) !== sourceHash) obfuscated++;
    else check('obf:' + name, false, '发布文件与源码完全相同，未混淆');
  }
  check('obfuscation', obfuscated === topLevel.length, `${obfuscated}/${topLevel.length}`);

  const identical = [
    ['lib/outreach-browser.js', 'lib/outreach-browser.js'],
    ['lib/dm-protocol.js', 'lib/dm-protocol.js'],
    ['web/app.js', 'web/app.js'],
    ['web/index.html', 'web/index.html'],
    ['lib/lead-fields.js', 'lib/lead-fields.js'],
    ['core/collect.js', 'core/collect.js'],
    ['core/search.js', 'core/search.js'],
    ['core/follow.js', 'core/follow.js']
  ];
  for (const [rel, source] of identical) {
    check('sync:' + rel, sha256(path.join(OUT, rel)) === sha256(path.join(SRC, source)), '发行文件与源码不一致（未重新构建）');
  }
  check('desktop-sync', sha256(path.join(OUT, 'resources/app/main.js')) === sha256(path.join(ROOT, 'desktop/main.js')), '');

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    totalBytes,
    files: files.map(file => ({ path: file.rel, size: file.size, sha256: sha256(file.full) }))
  };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, `release-manifest-${version}.json`), JSON.stringify(manifest, null, 2), 'utf8');
  check('manifest', fs.existsSync(path.join(REPORT_DIR, `release-manifest-${version}.json`)), `${files.length} files`);
  report.artifact = { files: files.length, totalBytes, manifest: `reports/release-manifest-${version}.json` };
}

/* ------------------------------------------------------------------- smoke */
function request(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: pathname.startsWith('/api/') ? 'POST' : 'GET',
      headers: { ...(token ? { 'x-desktop-token': token } : {}), 'Content-Type': 'application/json' }, timeout: 5000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(pathname.startsWith('/api/') ? '{}' : undefined);
  });
}

function runSmoke() {
  const serverFile = path.join(OUT, 'server.js');
  const nodeFile = path.join(OUT, 'node.exe');
  check('smoke-server', fs.existsSync(serverFile));
  check('smoke-node', fs.existsSync(nodeFile));
  // 不写系统 TEMP：部分机器的受控文件夹/杀软会拦截新二进制的首次写入。
  // 只有“根本没起来”才换目录重试；已起来但断言失败属于真实缺陷，不重试。
  return attemptSmoke().then(first => {
    if (first.started) return first.ok;
    return attemptSmoke(true).then(second => {
      check('smoke-ready', second.started, second.detail || first.detail);
      return second.ok;
    });
  });
}

function attemptSmoke(isRetry = false) {
  const nodeFile = path.join(OUT, 'node.exe');
  const serverFile = path.join(OUT, 'server.js');
  // 默认必须运行发布目录里的 node.exe。仅当宿主限制该路径执行时，允许用
  // --smoke-node 指定一个“逐字节相同”的副本，并在报告里记录。
  const smokeNode = args['smoke-node'] ? path.resolve(String(args['smoke-node'])) : nodeFile;
  if (smokeNode !== nodeFile) {
    let identical = false;
    try { identical = fs.existsSync(smokeNode) && sha256(smokeNode) === sha256(nodeFile); } catch { identical = false; }
    check('smoke-node-identical', identical, identical ? path.basename(smokeNode) : '与发布 node.exe 不一致');
    if (!identical) return Promise.resolve({ started: false, ok: false, detail: 'smoke-node 与发布版不一致' });
  }
  const token = crypto.randomBytes(16).toString('hex');
  const dataDir = fs.mkdtempSync(path.join(TOOL_DIR, 'qa-smoke-'));
  // 有些机器会用受控文件夹/杀软拦截“新编译二进制”的 mkdir。
  // 目录由门禁预先建好，发布版启动时只读不建，冒烟验证的是启动与接口而非建目录。
  for (const sub of ['logs', 'chrome-profiles']) {
    try { fs.mkdirSync(path.join(dataDir, sub), { recursive: true }); } catch { /* 权限问题留给子进程报错 */ }
  }
  const child = spawn(smokeNode, [serverFile], {
    cwd: OUT, windowsHide: true,
    env: { ...process.env, DY_LEAD_PORT: '0', DY_LEAD_DATA_DIR: dataDir, DY_LEAD_DESKTOP_TOKEN: token, DY_LEAD_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

  return new Promise(resolve => {
    const startedAt = Date.now();
    const before = results.length;
    let settled = false;
    const cleanup = () => {
      try { child.kill(); } catch { /* already gone */ }
      setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp */ } }, 300);
    };
    const startupFailure = reason => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      cleanup();
      const detail = (stderr || stdout).split('\n').map(line => line.trim())
        .filter(line => /Error|code:|errno|EPERM|EACCES|EEXIST|ENOENT|ready/.test(line)).slice(0, 3).join(' | ');
      resolve({ started: false, ok: false, detail: detail || reason });
    };
    const timer = setInterval(async () => {
      const match = /\{"event":"ready","port":(\d+)/.exec(stdout);
      if (!match) {
        if (Date.now() - startedAt > 20000 || child.exitCode !== null) startupFailure(`exited=${child.exitCode} after ${Date.now() - startedAt}ms`);
        return;
      }
      if (settled) return;
      settled = true;
      clearInterval(timer);
      const port = Number(match[1]);
      try {
        const health = await request(port, '/health');
        check('smoke-health', health.status === 200 && JSON.parse(health.body).version === versionOf(), `${health.status} ${health.body.slice(0, 80)}`);
        const home = await request(port, '/');
        check('smoke-index', home.status === 200 && /抖音获客软件/.test(home.body), String(home.status));
        check('smoke-csp', /default-src 'self'/.test(String(home.headers['content-security-policy'] || '')), String(home.headers['content-security-policy'] || ''));
        const bare = await request(port, '/api/state');
        check('smoke-token-required', bare.status === 403, String(bare.status));
        const noSession = await request(port, '/api/state', token);
        check('smoke-session-required', noSession.status === 401, String(noSession.status));
        const traversal = await request(port, '/..%2F..%2Fpackage.json');
        check('smoke-traversal', traversal.status === 404, String(traversal.status));
        const missingApi = await request(port, '/api/not-exist', token);
        check('smoke-api-404', missingApi.status === 401 || missingApi.status === 404, String(missingApi.status));
        check('smoke-fresh-data', !fs.existsSync(path.join(dataDir, 'leads.json')) && !fs.existsSync(path.join(dataDir, 'settings.json')), dataDir);
      } catch (error) {
        check('smoke-http', false, error.message);
      } finally {
        const ok = results.slice(before).every(item => item.ok);
        cleanup();
        resolve({ started: true, ok, detail: '' });
      }
    }, 200);
  });
}

/* --------------------------------------------------------------- installer */
function zipEntries(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const tailSize = Math.min(size, 4 * 1024 * 1024);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('ZIP 缺少中央目录结束标记');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const rows = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏，条目 ' + i);
      const flags = cd.readUInt16LE(p + 8);
      const crc = cd.readUInt32LE(p + 16);
      const usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      const name = cd.slice(p + 46, p + 46 + nlen).toString('utf8').replace(/\\/g, '/');
      rows.push({ name, flags, crc, usize, dir: name.endsWith('/') });
      p += 46 + nlen + elen + clen;
    }
    return rows;
  } finally { fs.closeSync(fd); }
}
function runInstaller() {
  const version = versionOf();
  const exe = path.join(ROOT, `华贸获客-安装包-${version}.exe`);
  // 完整打包脚本生成“程序包”，绿色版打包脚本生成“绿色版”：两者都是同一发布目录的完整压缩
  const zip = [`华贸获客-程序包-${version}.zip`, `华贸获客-绿色版-${version}.zip`].map(name => path.join(ROOT, name)).find(file => fs.existsSync(file)) || path.join(ROOT, `华贸获客-程序包-${version}.zip`);
  check('installer-exists', fs.existsSync(exe), path.basename(exe));
  check('archive-exists', fs.existsSync(zip), path.basename(zip));
  if (fs.existsSync(exe)) {
    const stat = fs.statSync(exe);
    check('installer-size', stat.size > 100 * 1024 * 1024, (stat.size / 1024 / 1024).toFixed(1) + ' MB');
    check('installer-fresh', stat.mtimeMs > Date.now() - 24 * 3600 * 1000, stat.mtime.toISOString());
  }
  if (fs.existsSync(zip)) {
    const stat = fs.statSync(zip);
    check('archive-size', stat.size > 100 * 1024 * 1024, (stat.size / 1024 / 1024).toFixed(1) + ' MB');
    try {
      const entries = zipEntries(zip);
      const files = entries.filter(entry => !entry.dir);
      const expected = walk(OUT);
      const actual = new Map(files.map(entry => [entry.name, entry.usize]));
      const missing = expected.filter(file => !actual.has(file.rel)).map(file => file.rel);
      const extra = files.filter(entry => !expected.some(file => file.rel === entry.name)).map(entry => entry.name);
      const sizeMismatch = expected.filter(file => actual.get(file.rel) !== file.size).map(file => file.rel);
      check('zip-manifest', !missing.length && !extra.length && !sizeMismatch.length,
        `files=${files.length}/${expected.length}` + (missing.length ? ' missing=' + missing.slice(0, 3).join(',') : '')
        + (extra.length ? ' extra=' + extra.slice(0, 3).join(',') : '')
        + (sizeMismatch.length ? ' size=' + sizeMismatch.slice(0, 3).join(',') : ''));
      const allNames = entries.map(entry => entry.name);
      const badNames = allNames.filter(name => FORBIDDEN_DIRS.some(dir => name === dir + '/' || name.startsWith(dir + '/'))
        || FORBIDDEN_FILES.includes(path.basename(name)));
      check('zip-privacy', badNames.length === 0, badNames.slice(0, 5).join(', '));
      const utf8 = files.filter(entry => /[^\x00-\x7F]/.test(entry.name));
      check('zip-utf8-names', utf8.every(entry => (entry.flags & 0x800) === 0x800), `${utf8.length} 个非 ASCII 文件名`);
      report.archive = { files: files.length, bytes: stat.size };
    } catch (error) {
      check('zip-readable', false, error.message);
    }
  }
  if (fs.existsSync(exe) && fs.existsSync(zip)) {
    const manifest = {
      version, generatedAt: new Date().toISOString(),
      artifacts: [exe, zip].map(file => ({ file: path.basename(file), size: fs.statSync(file).size, sha256: sha256(file) }))
    };
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, `artifacts-${version}.json`), JSON.stringify(manifest, null, 2), 'utf8');
    for (const item of manifest.artifacts) console.log(`      ${item.sha256}  ${item.file}  (${item.size} bytes)`);
    report.artifacts = manifest.artifacts;
  }
}

/* -------------------------------------------------------------------- deep */
const DEEP_SCRIPTS = [
  ['verify.js', []], ['verify-collection.js', []], ['verify-outreach-browser.js', []],
  ['verify-outreach-flow.js', []], ['verify-startup-login.js', []], ['verify-ai.js', []],
  ['verify-ui.js', []], ['verify-browser-sandbox.js', []], ['verify-browser-portability.js', []],
  ['verify-embedded-browser.js', ['--app-dir', OUT]], ['verify-embedded-outreach.js', ['--app-dir', OUT]],
  ['verify-license.js', []], ['verify-legacy-preflight.js', []]
];
function runDeep() {
  for (const [script, extra] of DEEP_SCRIPTS) {
    const file = path.join(TOOL_DIR, script);
    if (!fs.existsSync(file)) { check('deep:' + script, false, 'missing'); continue; }
    const started = Date.now();
    const result = spawnSync(NODE, [file, ...extra], { cwd: ROOT, encoding: 'utf8', timeout: Number(args['timeout-deep'] || 20 * 60 * 1000), maxBuffer: 64 * 1024 * 1024 });
    const tail = String(result.stdout || '').trim().split('\n').slice(-2).join(' ');
    check('deep:' + script, result.status === 0, `${Date.now() - started}ms ${tail}`.slice(0, 300));
  }
  const desktop = path.join(TOOL_DIR, 'verify-desktop.ps1');
  if (fs.existsSync(desktop)) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', desktop], { cwd: ROOT, encoding: 'utf8', timeout: 20 * 60 * 1000 });
    check('deep:verify-desktop.ps1', result.status === 0, String(result.stdout || result.stderr || '').trim().split('\n').slice(-1)[0]);
  }
}

/* ------------------------------------------------------------------- 主流程 */
const GATES = { static: runStatic, unit: runUnit, artifact: runArtifact, smoke: runSmoke, installer: runInstaller, deep: runDeep };

async function gateAsync(name, fn) {
  const started = Date.now();
  results.length = 0;
  let crashed = '';
  try { await fn(); } catch (error) { crashed = error.message || String(error); check('gate-crashed', false, crashed); }
  const ok = results.every(item => item.ok);
  report.gates.push({ name, ok, durationMs: Date.now() - started, checks: [...results] });
  if (!ok) report.ok = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${Date.now() - started}ms)`);
  for (const item of results.filter(item => !item.ok)) console.log(`      x ${item.name}${item.detail ? ' — ' + item.detail : ''}`);
  return ok;
}

async function main() {
  const version = versionOf();
  report.version = version;
  report.releaseHash = releaseFingerprint();
  console.log(`release-verify  version=${version}  node=${process.version}`);
  let allOk = true;
  for (const name of requested) {
    const fn = GATES[name];
    if (!fn) { console.log(`FAIL  unknown-gate  ${name}`); allOk = false; continue; }
    allOk = (await gateAsync(name, fn)) && allOk;
  }
  // 构建分两次调用（产物层 + 安装包层）。同一份发布必须合并成一份报告，
  // 否则后一次会用只含 installer 的报告覆盖前面的 static/unit/artifact/smoke。
  try {
    const previous = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (previous && previous.version === version && previous.releaseHash && previous.releaseHash === report.releaseHash) {
      const byName = new Map((previous.gates || []).map(item => [item.name, item]));
      for (const item of report.gates) byName.set(item.name, item);
      report.gates = [...byName.values()];
      for (const key of ['unit', 'artifact', 'archive', 'artifacts']) {
        if (report[key] == null && previous[key] != null) report[key] = previous[key];
      }
      allOk = report.gates.every(item => item.ok);
    }
  } catch { /* 首次运行没有旧报告 */ }
  report.ok = allOk;
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n${allOk ? 'OK' : 'FAILED'}  gates=${requested.join(',')}  report=${path.relative(ROOT, jsonPath)}`);
  process.exit(allOk ? 0 : 1);
}

main().catch(error => {
  console.error('release-verify 异常：' + (error && error.stack || error));
  process.exit(1);
});
