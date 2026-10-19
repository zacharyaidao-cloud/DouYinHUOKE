'use strict';
// 升级前后仅核对配置、业务 JSON 和登录资料的指纹，不输出内容或修改安装目录。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const installation = 'D:\\华贸自媒体获客';
const manifestPath = path.join(__dirname, 'installed-upgrade-fingerprints.json');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function snapshot() {
  const configPath = path.join(installation, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const dataDirectory = path.resolve(installation, String(config.dataDir || 'data'));
  const files = [configPath];
  if (fs.existsSync(dataDirectory)) {
    for (const name of fs.readdirSync(dataDirectory)) {
      const file = path.join(dataDirectory, name);
      if (/\.json(?:\.bak)?$/i.test(name) && fs.statSync(file).isFile()) files.push(file);
    }
  }
  const profiles = path.join(dataDirectory, 'chrome-profiles');
  function profileFiles(directory, depth = 0) {
    if (!fs.existsSync(directory) || depth > 3) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory() && !/cache|code cache|gpu/i.test(item.name)) profileFiles(file, depth + 1);
      else if (item.isFile() && /^(?:Local State|Preferences|Cookies|Login Data|Web Data)$/i.test(item.name)) files.push(file);
    }
  }
  profileFiles(profiles);
  return { installation, dataDirectory, files: Object.fromEntries(files.sort().map(file => [file, digest(file)])) };
}
if (process.argv[2] === 'before') {
  assert(!fs.existsSync(manifestPath), '已有升级指纹，避免覆盖基线');
  const result = snapshot();
  fs.writeFileSync(manifestPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, phase: 'before', checkedFiles: Object.keys(result.files).length, dataDirectory: result.dataDirectory }));
} else if (process.argv[2] === 'after') {
  const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const current = snapshot();
  // 授权服务器时间缓存会在同步时刷新，独立报告，不把它算作业务数据或登录资料。
  const timeCache = path.join(previous.dataDirectory, 'servertime.json');
  const timeCacheChanged = previous.files[timeCache] !== current.files[timeCache];
  delete previous.files[timeCache];
  delete current.files[timeCache];
  assert.deepEqual(current, previous, '升级后的配置、业务数据或登录资料发生变化');
  const report = { ok: true, phase: 'after', checkedFiles: Object.keys(current.files).length, dataPreserved: true, timeCacheChanged };
  fs.writeFileSync(path.join(__dirname, 'installed-upgrade-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} else {
  throw new Error('参数必须为 before 或 after');
}
