'use strict';
// 本地模拟接口：关键词草稿恢复 / 自动保存，关键词统计表渲染与“再搜”。不访问平台、不读客户数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('搜索关键词重启后恢复、输入自动保存；关键词统计表显示每个词的数据并可一键再搜', async t => {
  const app = path.resolve(__dirname, '..');
  const web = process.env.DY_LEAD_QA_WEB_DIR || path.join(app, 'web');
  const playwright = require(path.join(app, 'node_modules/playwright-core'));
  const browserPath = path.join(app, 'node_modules/playwright-core/.local-browsers/chromium-1243/chrome-win64/chrome.exe');
  const source = fs.readFileSync(path.join(app, 'store.js'), 'utf8');
  const context = { ...require('../lib/ai-policy'), ...require('../lib/keyword-screen') };
  context.DEFAULT_INDUSTRY_PROMPT = vm.runInNewContext('(' + source.match(/const DEFAULT_INDUSTRY_PROMPT = ([\s\S]*?);\r?\nconst DEFAULT_SETTINGS/)[1] + ')', context);
  const settings = JSON.parse(JSON.stringify(vm.runInNewContext('(' + source.match(/const DEFAULT_SETTINGS = ([\s\S]*?);\r?\n\r?\nfunction getAccounts/)[1] + ')', context)));
  const snapshot = { ok: true, accounts: [{ id: '1', name: '模拟账号', loginStatus: 'authenticated', daily: {} }], settings, stats: {}, task: { running: false }, videos: {}, license: {}, loginUser: 'qa' };
  const drafts = [];
  const stored = { keywords: '亚马逊扫号\n亚马逊申诉服务商', workType: 'note', minComments: '20', publishedWithinDays: '7', maxPages: '50' };
  const rows = [
    { keyword: '亚马逊扫号', searchCount: 2, lastSearchAt: '2026-10-21 10:00:00', lastTotal: 120, lastWithinWeek: 18, lastKept: 25, lastAdded: 9, lastPages: 50,
      lastPublishedWithinDays: 30, worksFound: 140, worksCollected: 22, comments: 610, aiDemand: 47, aiDemandUsers: 41, keywordDemand: 63, contacted: 12 },
    { keyword: '<b>注入</b>', searchCount: 1, lastSearchAt: '2026-10-20 18:00:00', lastTotal: 3, lastWithinWeek: 0, lastKept: 0, worksFound: 3 }
  ];
  const browser = await playwright.chromium.launch({ headless: true, executablePath: browserPath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('**/*', async route => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    if (!pathname.startsWith('/api/')) {
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(filename)) { await route.fulfill({ status: 404 }); return; }
      await route.fulfill({ contentType: filename.endsWith('.html') ? 'text/html;charset=utf-8' : filename.endsWith('.js') ? 'application/javascript;charset=utf-8' : 'text/css;charset=utf-8', body: fs.readFileSync(path.join(web, filename)) });
      return;
    }
    let response = { ok: true };
    if (pathname === '/api/state') response = snapshot;
    if (pathname === '/api/search/results') response.results = [];
    if (pathname === '/api/videos') response.videos = [];
    if (pathname === '/api/search/draft' && req.method() === 'GET') response.draft = stored;
    if (pathname === '/api/search/draft' && req.method() === 'POST') drafts.push(req.postDataJSON());
    if (pathname === '/api/search/keyword-stats') response.rows = rows;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('dy_token', 'local-qa'));
  await page.goto('https://keyword-stats.test/');
  await page.waitForFunction(() => document.getElementById('login-layer').style.display === 'none' && !refreshBusy);
  await page.locator('#nav [data-page="collect"]').click();
  await page.locator('#search-options summary').click();

  // 1. 打开搜索面板即恢复上次输入
  await page.waitForFunction(() => document.getElementById('s-kws').value.includes('亚马逊扫号'));
  assert.equal(await page.locator('#s-kws').inputValue(), stored.keywords);
  assert.equal(await page.locator('#s-type').inputValue(), 'note');
  assert.equal(await page.locator('#s-minc').inputValue(), '20');
  assert.equal(await page.locator('#s-days').inputValue(), '7');
  assert.equal(await page.locator('#s-maxp').inputValue(), '50');

  // 2. 统计表：每个词的上次查询、作品数、近一周、需求评论等；关键词按文本显示（不执行 HTML）
  await page.waitForFunction(() => document.querySelectorAll('#kw-stats-list tr').length === 2);
  const first = await page.locator('#kw-stats-list tr').first().innerText();
  for (const text of ['亚马逊扫号', '搜过 2 次', '2026-10-21 10:00:00', '翻 50 页', '120', '18', '25', '新增 9', '140', '22', '610', '47', '41 人', '63', '12']) assert.ok(first.includes(text), text);
  assert.equal(await page.locator('#kw-stats-list b').nth(1).innerText(), '<b>注入</b>');
  assert.match(await page.locator('#kw-stats-count').innerText(), /共 2 个关键词/);

  if (process.env.DY_QA_SHOT) await page.locator('#search-options').screenshot({ path: process.env.DY_QA_SHOT });
  // 3. 输入后自动保存草稿（防抖）
  await page.locator('#s-kws').fill('亚马逊扫号\n亚马逊账户被停用');
  await page.waitForTimeout(900);
  assert.equal(drafts.at(-1).keywords, '亚马逊扫号\n亚马逊账户被停用');
  assert.equal(drafts.at(-1).publishedWithinDays, '7');

  // 4. “再搜”把词加到输入框（已有的不重复）并保存
  await page.locator('#kw-stats-list .kw-reuse').nth(1).click();
  assert.equal(await page.locator('#s-kws').inputValue(), '亚马逊扫号\n亚马逊账户被停用\n<b>注入</b>');
  await page.locator('#kw-stats-list .kw-reuse').first().click();
  assert.equal(await page.locator('#s-kws').inputValue(), '亚马逊扫号\n亚马逊账户被停用\n<b>注入</b>');
  await page.waitForTimeout(900);
  assert.equal(drafts.at(-1).keywords, '亚马逊扫号\n亚马逊账户被停用\n<b>注入</b>');

  // 5. 已在输入的内容不被轮询恢复覆盖
  await page.evaluate(() => refresh());
  await page.waitForFunction(() => !refreshBusy);
  assert.equal(await page.locator('#s-kws').inputValue(), '亚马逊扫号\n亚马逊账户被停用\n<b>注入</b>');
  assert.deepEqual(errors, []);
});
