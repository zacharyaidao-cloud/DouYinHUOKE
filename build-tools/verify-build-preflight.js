'use strict';
// 错误公开配置必须在清理发布目录之前阻止构建。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const publicConfig = JSON.parse(fs.readFileSync(path.join(root, 'dy-lead-app', 'trusted-license.json'), 'utf8'));
const fixture = fs.mkdtempSync(path.join(__dirname, 'qa-build-preflight-'));
const releaseMarker = path.join(root, 'dy-lead-app-release', 'web', 'index.html');
const fingerprint = () => fs.existsSync(releaseMarker) ? crypto.createHash('sha256').update(fs.readFileSync(releaseMarker)).digest('hex') : null;
const previousFingerprint = fingerprint();
try {
  const cases = [
    { name: '缺少配置', value: null },
    { name: 'HTTP 配置', value: { ...publicConfig, serverUrl: 'http://huamao.xyz/dy-license' } },
    { name: '域名不匹配', value: { ...publicConfig, allowedHosts: ['invalid.example'] } },
    { name: '端口不匹配', value: { ...publicConfig, serverUrl: 'https://huamao.xyz:8443/dy-license' } },
    { name: '非公钥材料', value: { ...publicConfig, publicKey: '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----' } }
  ];
  for (let index = 0; index < cases.length; index++) {
    const example = cases[index];
    const configFile = path.join(fixture, index + '.json');
    if (example.value) fs.writeFileSync(configFile, JSON.stringify(example.value), 'utf8');
    const result = spawnSync(path.join(root, 'dy-lead-app', 'node.exe'), [path.join(__dirname, 'build.js')], {
      env: { ...process.env, DY_LEAD_LICENSE_CONFIG: configFile }, encoding: 'utf8', windowsHide: true, timeout: 10000
    });
    assert.equal(result.error, undefined, example.name + '预检进程未正常结束');
    assert.notEqual(result.status, 0, example.name + '必须拒绝构建');
    assert(!result.stdout.includes('清空输出目录'), example.name + '不应进入删除步骤');
    assert.equal(fingerprint(), previousFingerprint, example.name + '不得修改既有发布目录');
  }
  console.log('PASS: 5 项打包配置预检，错误授权配置在清理发布目录前拒绝');
} finally {
  if (path.dirname(fixture) !== __dirname || !path.basename(fixture).startsWith('qa-build-preflight-')) throw new Error('预检清理路径超出范围');
  fs.rmSync(fixture, { recursive: true, force: true });
}
