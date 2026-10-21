'use strict';
// 私信消息页：本地模拟接口，不访问平台。列表渲染（文字按文本显示）、筛选、标为已读、检查私信的请求内容。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('私信消息页：汇总多账号会话，未读在前，筛选线索 / 未读，标为已读，检查私信只提交勾选的账号', async t => {
  const app = path.resolve(__dirname, '..');
  const web = process.env.DY_LEAD_QA_WEB_DIR || path.join(app, 'web');
  const playwright = require(path.join(app, 'node_modules/playwright-core'));
  const browserPath = path.join(app, 'node_modules/playwright-core/.local-browsers/chromium-1243/chrome-win64/chrome.exe');
  const source = fs.readFileSync(path.join(app, 'store.js'), 'utf8');
  const context = { ...require('../lib/ai-policy'), ...require('../lib/keyword-screen') };
  context.DEFAULT_INDUSTRY_PROMPT = vm.runInNewContext('(' + source.match(/const DEFAULT_INDUSTRY_PROMPT = ([\s\S]*?);\r?\nconst DEFAULT_SETTINGS/)[1] + ')', context);
  const settings = JSON.parse(JSON.stringify(vm.runInNewContext('(' + source.match(/const DEFAULT_SETTINGS = ([\s\S]*?);\r?\n\r?\nfunction getAccounts/)[1] + ')', context)));
  const accounts = [{ id: '1', name: '测试号', loginStatus: 'authenticated', daily: {} }, { id: '2', name: '崔广安', loginStatus: 'authenticated', daily: {} }];
  const snapshot = { ok: true, accounts, settings, stats: {}, task: { running: false }, videos: {}, license: {}, loginUser: 'qa' };
  const at = Date.parse('2026-10-21T10:00:00+08:00');
  let rows = [
    { accountId: '2', accountName: '崔广安', peerUid: '72551404516', peerSecUid: 'SEC-A', nickname: '', inbox: 'stranger', unread: 2, lastPeerAt: at + 3600000,
      messages: [{ from: 'me', kind: 'text', text: '你好，我们是专门处理亚马逊账户问题的', at }, { from: 'me', kind: 'system', text: '对方回复或关注你之前，只能发送一条文字消息', at: at + 1 }, { from: 'peer', kind: 'text', text: '<img src=x onerror="window.injected=1">怎么收费', at: at + 3600000 }],
      lead: { id: 88, nickname: '奇闻怪事', replied: true } },
    { accountId: '1', accountName: '测试号', peerUid: '61892108631', peerSecUid: 'SEC-B', nickname: '老客户', inbox: 'stranger', unread: 0, lastPeerAt: at - 86400000,
      messages: [{ from: 'peer', kind: 'image', text: '[图片]', at: at - 86400000 }], lead: null }
  ];
  const posted = [];
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
    if (pathname === '/api/inbox') response = { ok: true, rows, scanned: { 1: { scannedAt: at, baselineAt: at, count: 88 } } };
    if (pathname === '/api/inbox/read') { posted.push(['read', req.postDataJSON()]); rows = rows.map(r => r.peerUid === req.postDataJSON().peerUid ? { ...r, unread: 0 } : r); }
    if (pathname === '/api/inbox/scan') posted.push(['scan', req.postDataJSON()]);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('dy_token', 'local-qa'));
  await page.goto('https://inbox.test/');
  await page.waitForFunction(() => document.getElementById('login-layer').style.display === 'none' && !refreshBusy);
  await page.locator('#nav [data-page="inbox"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#inbox-list tr').length === 2);

  const first = await page.locator('#inbox-list tr').first().innerText();
  for (const text of ['崔广安', '陌生人消息', '奇闻怪事', '2 条新', '怎么收费', '线索 #88', '已回复']) assert.ok(first.includes(text), text);
  assert.ok(first.includes('<img src=x'), '对方消息按文本显示');
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator('#inbox-list tr').first().locator('a[href*="SEC-A"]').count(), 1, '可打开对方主页');
  assert.match(await page.locator('#inbox-count').innerText(), /2 个会话，1 个有未读/);
  assert.match(await page.locator('#inbox-scanned').innerText(), /测试号/);
  if (process.env.DY_QA_SHOT) await page.locator('#page-inbox').screenshot({ path: process.env.DY_QA_SHOT });

  await page.locator('#inbox-filter').selectOption('lead');
  assert.equal(await page.locator('#inbox-list tr').count(), 1);
  await page.locator('#inbox-filter').selectOption('unread');
  assert.equal(await page.locator('#inbox-list tr').count(), 1);
  await page.locator('[data-inbox-read]').click();
  await page.waitForFunction(() => document.querySelector('#inbox-list').innerText.includes('当前筛选下没有会话'));
  assert.deepEqual(posted[0], ['read', { accountId: '2', peerUid: '72551404516' }]);

  // 默认勾选全部账号；取消一个后只提交勾选的
  assert.equal(await page.locator('#inbox-accounts [data-inbox-account]:checked').count(), 2);
  await page.locator('#inbox-accounts [data-inbox-account="1"]').uncheck();
  await page.locator('#btn-inbox-scan').click();
  await page.waitForFunction(() => document.getElementById('inbox-feedback').textContent.includes('只读'));
  assert.deepEqual(posted.find(p => p[0] === 'scan')[1], { accountIds: ['2'] });
  assert.deepEqual(errors, []);
});
