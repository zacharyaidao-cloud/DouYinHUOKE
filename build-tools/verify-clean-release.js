'use strict';
// 校验实际交付代码在空数据目录的首次启动，避免将开发机历史带给客户。
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const release = path.join(root, 'dy-lead-app-release');
const fixture = fs.mkdtempSync(path.join(__dirname, 'qa-clean-release-'));
const previousData = process.env.DY_LEAD_DATA_DIR;
try {
  assert(!fs.existsSync(path.join(release, 'data')), '发布目录不应有个人 data');
  const privateNames = /^(?:accounts|leads|videos|cooldowns|daily|plans|settings|license-cache|task-checkpoint|admin|users|keys)\.json$|^audit(?:\.previous)?\.jsonl$|^(?:网页管理登录信息|网页登录账户|本人测试账户|本机管理员密码|服务器密钥)\.txt$|\.env$/i;
  const privateDirs = /^(?:data|chrome-profiles|electron-profiles|logs|admin-data|license-admin-web|license-server)$/i;
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), '发布包不应包含链接：' + entry.name);
      if (entry.isDirectory()) {
        assert(!privateDirs.test(entry.name), '发布包含个人或管理目录：' + entry.name);
        if (directory === release) assert(!/^(?:tests|tools)$/i.test(entry.name), '发布包含开发目录：' + entry.name);
        inspect(filename);
      } else assert(!privateNames.test(entry.name), '发布包含历史或私有文件：' + entry.name);
    }
  }
  inspect(release);
  const releaseVersion = JSON.parse(fs.readFileSync(path.join(release, 'resources', 'app', 'package.json'), 'utf8')).version;
  assert.equal(releaseVersion, JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8')).version);
  assert.equal(JSON.parse(fs.readFileSync(path.join(release, 'node_modules', 'ws', 'package.json'), 'utf8')).version, '8.22.0');
  for (const file of ['resources/app/account-browser-host.js', 'lib/embedded-browser-client.js']) assert(fs.existsSync(path.join(release, file)), '发布缺少内嵌浏览器模块：' + file);
  const config = JSON.parse(fs.readFileSync(path.join(release, 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), ['dataDir', 'license']);
  assert.equal(config.dataDir, '');
  assert.deepEqual(Object.keys(config.license).sort(), ['allowedHosts', 'enabled', 'publicKey', 'serverUrl']);
  const trusted = JSON.parse(fs.readFileSync(path.join(release, 'trusted-license.json'), 'utf8'));
  assert.deepEqual(config.license, trusted);
  assert.equal(trusted.enabled, true);
  assert.equal(trusted.serverUrl.replace(/\/+$/, ''), 'https://huamao.xyz/dy-license');
  assert.deepEqual(trusted.allowedHosts, ['huamao.xyz']);
  const sourceTrusted = JSON.parse(fs.readFileSync(path.join(root, 'dy-lead-app', 'trusted-license.json'), 'utf8'));
  const publicKey = value => crypto.createPublicKey(value).export({ type: 'spki', format: 'der' });
  assert.deepEqual(publicKey(trusted.publicKey), publicKey(sourceTrusted.publicKey), '发布公钥须匹配正式签名公钥');
  process.env.DY_LEAD_DATA_DIR = path.join(fixture, 'data');
  const store = require(path.join(release, 'store.js'));
  assert.deepEqual(store.getAccounts(), []);
  assert.deepEqual(store.getLeads(), []);
  assert.deepEqual(store.getVideos(), {});
  assert.deepEqual(store.getDaily(), {});
  assert.deepEqual(store.getCooldowns(), {});
  assert.deepEqual(store.getPlans(), []);
  assert.equal(store.getTaskCheckpoint(), null);
  const settings = store.getSettings();
  assert.equal(settings.ai.apiKey, '');
  assert.equal(settings.ai.baseUrl, 'https://api.deepseek.com');
  assert.equal(settings.ai.model, 'deepseek-flash');
  assert.equal(settings.ai.batchMode, 'auto');
  assert.equal(settings.ai.batchMaxChars, 24000);
  assert.equal(settings.ai.batchMaxCount, 20);
  assert.equal(settings.collect.dailyVideoLimit, 240);
  assert.equal(settings.collect.maxScrolls, 120);
  assert.equal(settings.follow.dailyLimit, 150);
  assert.equal(settings.dm.dailyLimit, 150);
  assert.deepEqual(settings.dm.sessionPause, { count: 5, pauseMinSec: 60, pauseMaxSec: 300 });
  assert.deepEqual(settings.search, { enabled: true, intervalSec: 60, intervalJitter: .2, maxPages: 20, dailySearchLimit: 30, minCommentCount: 0 });
  assert.equal(settings.ai.promptPresets.length, 3);
  assert.equal(settings.ai.activePromptId, 'prompt-1');
  assert(settings.ai.promptPresets[0].prompt.includes('亚马逊'));
  assert(settings.ai.promptPresets[0].prompt.includes('是/否'));
  assert(settings.ai.promptPresets[0].prompt.includes('不超过30字符') && settings.ai.promptPresets[0].prompt.includes('不输出评分或待确认'), '新判断的默认提示词须为二值短理由协议');
  assert.equal(settings.ai.promptPresets[1].prompt, '');
  assert.equal(settings.ai.promptPresets[2].prompt, '');
  for (const field of ['businessDesc', 'targetCustomers', 'clearNeeds', 'misjudgments']) assert(settings.ai[field].trim());
  for (const marker of ['【用户评论】{需求内容}', '【评论时间】{评论时间}', '【用户UID】{UID}', '【用户名称】{昵称}', '【所在视频描述】{视频描述}']) assert(settings.ai.promptPresets[0].prompt.includes(marker), '缺少固定字段：' + marker);
  assert.deepEqual(settings.action, { userIntervalSec: 30, userIntervalJitter: .4, pacingVersion: 1 });
  assert.equal(settings.collect.autoAiAfterCollect, true);
  assert.equal(settings.collect.linkIntervalSec, 10);
  assert.equal(settings.collect.scrollIntervalSec, 3);
  assert.equal(settings.collect.scrollJitter, .4);
  assert.equal(settings.collect.linkIntervalJitter, .2);
  assert.equal(Object.hasOwn(settings.human, 'breakEvery'), false);
  assert.equal(Object.hasOwn(settings.human, 'workPeriods'), false);
  assert.equal(settings.dm.repeat.enabled, false);
  assert(!fs.existsSync(path.join(release, 'data')), '测试不能在发布目录生成个人数据');
  assert.deepEqual(fs.readdirSync(store.PROFILE_DIR), []);
  assert.deepEqual(fs.readdirSync(store.LOG_DIR), []);
  for (const file of Object.values(store.F)) assert(!fs.existsSync(file), '首次读取默认设置不应携带历史：' + path.basename(file));
  fs.writeFileSync(path.join(__dirname, 'clean-release-verification.json'), JSON.stringify({
    ok: true, version: releaseVersion, verifiedAt: new Date().toISOString(), emptyAccounts: true,
    emptyHistory: true, emptyApiKey: true, defaultIndustry: '亚马逊卖家账号问题服务',
    defaultPromptSlots: 3, activePromptId: settings.ai.activePromptId,
    model: settings.ai.model,
    aiBatchMode: settings.ai.batchMode, aiResultContract: '是/否＋不超过30字理由',
    defaultLimits: { videosPerDay: settings.collect.dailyVideoLimit, scrollRounds: settings.collect.maxScrolls, followPerDay: settings.follow.dailyLimit, dmPerDay: settings.dm.dailyLimit },
    privateDataAbsent: true, releaseDataUntouched: true, productionAuthorizationVerified: true
  }, null, 2), 'utf8');
  console.log('PASS: 实际发布代码首次启动为全新客户：无账号/线索/操作历史/API Key，默认行业规则与统一节奏正确');
} finally {
  if (previousData === undefined) delete process.env.DY_LEAD_DATA_DIR;
  else process.env.DY_LEAD_DATA_DIR = previousData;
  if (path.dirname(fixture) !== __dirname || !path.basename(fixture).startsWith('qa-clean-release-')) throw new Error('测试清理路径超出范围');
  fs.rmSync(fixture, { recursive: true, force: true });
}

