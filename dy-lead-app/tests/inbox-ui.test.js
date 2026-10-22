'use strict';
// 私信消息（IM 聊天界面）：本地模拟接口，不访问平台。账号标签与在线状态、会话列表、气泡聊天、发送与离线禁用。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('私信聊天界面：账号标签显示在线与未读，会话列表可搜索筛选，气泡聊天，Enter 发送 / Shift+Enter 换行，离线不能发', async t => {
  const app = path.resolve(__dirname, '..');
  const web = process.env.DY_LEAD_QA_WEB_DIR || path.join(app, 'web');
  const playwright = require(path.join(app, 'node_modules/playwright-core'));
  const browserPath = path.join(app, 'node_modules/playwright-core/.local-browsers/chromium-1243/chrome-win64/chrome.exe');
  const source = fs.readFileSync(path.join(app, 'store.js'), 'utf8');
  const context = { ...require('../lib/ai-policy'), ...require('../lib/keyword-screen') };
  context.DEFAULT_INDUSTRY_PROMPT = vm.runInNewContext('(' + source.match(/const DEFAULT_INDUSTRY_PROMPT = ([\s\S]*?);\r?\nconst DEFAULT_SETTINGS/)[1] + ')', context);
  const settings = JSON.parse(JSON.stringify(vm.runInNewContext('(' + source.match(/const DEFAULT_SETTINGS = ([\s\S]*?);\r?\n\r?\nfunction getAccounts/)[1] + ')', context)));
  const accounts = [{ id: 'A', name: '测试号', loginStatus: 'authenticated', daily: {} }, { id: 'B', name: '崔广安', note: '客服A', loginStatus: 'authenticated', daily: {} }, { id: 'C', name: '账号3', loginStatus: 'authenticated', daily: {} }];
  const snapshot = { ok: true, accounts, settings, stats: {}, task: { running: false }, videos: {}, license: {}, loginUser: 'qa' };
  const now = Date.now();
  let version = 1;
  const runtimes = { A: { state: 'offline' }, B: { state: 'online', live: true }, C: { state: 'error', reason: '账号未登录' } };
  const conversations = [
    { accountId: 'B', accountName: '崔广安', peerUid: '111', peerSecUid: 'SEC-111', nickname: '奇闻怪事', inbox: 'stranger', unread: 2, lastAt: now - 60000, hasPeer: true,
      last: { from: 'peer', kind: 'text', text: '<img src=x onerror="window.injected=1">怎么收费' }, lead: { id: 88, nickname: '奇闻怪事', replied: true } },
    { accountId: 'A', accountName: '测试号', peerUid: '222', peerSecUid: 'SEC-222', nickname: '老客户', inbox: 'normal', unread: 0, lastAt: now - 3600000, hasPeer: false,
      last: { from: 'me', kind: 'text', text: '你好' }, lead: null }
  ];
  const messages = {
    'B|111': [{ id: '1', from: 'me', kind: 'text', text: '你好，我们是专门处理亚马逊账户问题的', at: now - 7200000 },
      { id: '2', from: 'me', kind: 'system', text: '对方回复或关注你之前，只能发送一条文字消息', at: now - 7199000 },
      { id: '3', from: 'peer', kind: 'text', text: '<b>怎么收费</b>', at: now - 60000 },
      { id: '4', from: 'peer', kind: 'text', text: '好的[捂脸]', at: now - 50000 },
      { id: '5', from: 'peer', kind: 'sticker', text: '[表情]', media: { url: 'https://p3-sign.douyinpic.com/sticker.webp' }, at: now - 40000 }],
    'A|222': [{ id: '9', from: 'me', kind: 'text', text: '你好', at: now - 3600000 }]
  };
  const sent = [], opened = [], posted = [];
  const browser = await playwright.chromium.launch({ headless: true, executablePath: browserPath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url()), pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(filename)) { await route.fulfill({ status: 404 }); return; }
      await route.fulfill({ contentType: filename.endsWith('.html') ? 'text/html;charset=utf-8' : filename.endsWith('.js') ? 'application/javascript;charset=utf-8' : 'text/css;charset=utf-8', body: fs.readFileSync(path.join(web, filename)) });
      return;
    }
    let response = { ok: true };
    if (pathname === '/api/state') response = snapshot;
    if (pathname === '/api/chat/state') response = { ok: true, version, runtimes, conversations };
    if (pathname === '/api/chat/messages') {
      const key = url.searchParams.get('accountId') + '|' + url.searchParams.get('peerUid');
      const conv = conversations.find(c => c.accountId + '|' + c.peerUid === key);
      response = { ok: true, conversation: { ...conv, lead: conv.lead && { ...conv.lead, demand: '账号被停用了' } }, messages: messages[key] || [] };
    }
    if (pathname === '/api/chat/open') opened.push(req.postDataJSON());
    if (['/api/chat/connect', '/api/chat/browser', '/api/settings'].includes(pathname) || pathname.startsWith('/api/accounts/')) posted.push([req.method(), pathname, req.postDataJSON()]);
    if (pathname === '/api/chat/browser') response = { ok: true };
    if (pathname === '/api/chat/send') {
      const body = req.postDataJSON(); sent.push(body);
      messages[body.accountId + '|' + body.peerUid].push({ id: 'local-1', from: 'me', kind: 'text', text: body.text, at: Date.now(), status: 'sent' });
      version++;
      response = { ok: true, state: 'sent' };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('dy_token', 'local-qa'));
  await page.goto('https://chat.test/');
  await page.waitForFunction(() => document.getElementById('login-layer').style.display === 'none' && !refreshBusy);
  await page.locator('#nav [data-page="inbox"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#chat-list .chat-item').length === 2);

  // 顶部与账号标签
  assert.match(await page.locator('#chat-sync').innerText(), /实时同步中 1\/3 个账号/);
  // 连接状态条：每个账号状态、失败原因与操作；主按钮只连未连接的
  assert.equal(await page.locator('#chat-conn .chat-chip').count(), 3);
  const chipC = await page.locator('#chat-conn .chat-chip.error').innerText();
  for (const text of ['账号3', '连接失败', '账号未登录', '去处理', '重试']) assert.ok(chipC.includes(text), text);
  assert.match(await page.locator('#chat-conn .chat-chip.online').innerText(), /崔广安（客服A）.*在线.*断开/s);
  assert.equal(await page.locator('#btn-chat-connect-all').innerText(), '连接未连接的 2 个账号');
  await page.locator('#chat-conn [data-chat-conn="A"][data-act="connect"]').click();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(200);
  assert.deepEqual(posted.find(x => x[1] === '/api/chat/connect'), ['POST', '/api/chat/connect', { accountIds: ['A'] }]);
  assert.equal(await page.locator('#chat-auto-connect').isChecked(), true);
  await page.locator('#chat-auto-connect').uncheck();
  await page.waitForTimeout(200);
  assert.deepEqual(posted.find(x => x[1] === '/api/settings'), ['PUT', '/api/settings', { chat: { autoConnect: false } }]);
  const tabs = await page.locator('#chat-tabs').innerText();
  for (const text of ['全部', '测试号', '崔广安（客服A）']) assert.ok(tabs.includes(text), text);
  assert.equal(await page.locator('[data-chat-tab="B"] .chat-dot.online').count(), 1);
  assert.equal(await page.locator('[data-chat-tab="A"] .chat-dot.offline').count(), 1);
  assert.equal(await page.locator('[data-chat-tab="B"] .chat-count').innerText(), '1');

  // 会话列表：按文本显示、标签、搜索、只看有回复
  const first = await page.locator('#chat-list .chat-item').first().innerText();
  for (const text of ['奇闻怪事', '怎么收费', '陌生人', '已回复', '崔广安']) assert.ok(first.includes(text), text);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.locator('#chat-search').fill('老客户');
  assert.equal(await page.locator('#chat-list .chat-item').count(), 1);
  await page.locator('#chat-search').fill('');
  await page.locator('#chat-only-peer').check();
  assert.equal(await page.locator('#chat-list .chat-item').count(), 1);
  await page.locator('#chat-only-peer').uncheck();
  await page.locator('[data-chat-tab="A"]').click();
  assert.equal(await page.locator('#chat-list .chat-item').count(), 1);
  await page.locator('[data-chat-tab="all"]').click();

  // 打开会话：气泡、系统提示、头部信息；在线账号会请求后台打开会话
  await page.locator('#chat-list .chat-item').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#chat-messages .chat-row').length === 4);
  assert.equal(await page.locator('#chat-messages img.chat-media.sticker').getAttribute('src'), 'https://p3-sign.douyinpic.com/sticker.webp');
  assert.equal(await page.locator('#chat-messages img.chat-media').getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(await page.locator('#chat-messages .chat-row.peer').nth(1).innerText(), /好的🤦/);
  assert.equal(await page.locator('#chat-messages .chat-row.me').count(), 1);
  assert.equal(await page.locator('#chat-messages .chat-row.peer .chat-bubble').first().innerText(), '<b>怎么收费</b>');
  assert.match(await page.locator('#chat-messages .chat-system').innerText(), /只能发送一条/);
  assert.match(await page.locator('#chat-head-sub').innerText(), /崔广安（客服A） · 陌生人消息 · 线索 #88（已回复）/);
  await page.locator('#btn-chat-profile').click();
  await page.waitForFunction(() => document.getElementById('chat-compose-hint').textContent.includes('已在该账号的浏览器窗口打开'));
  assert.deepEqual(posted.find(x => x[1] === '/api/chat/browser'), ['POST', '/api/chat/browser', { accountId: 'B', peerUid: '111', target: 'profile' }]);
  assert.deepEqual(opened[0], { accountId: 'B', peerUid: '111' });
  if (process.env.DY_QA_SHOT) await page.locator('.chat-shell').screenshot({ path: process.env.DY_QA_SHOT });

  // Shift+Enter 换行，Enter 发送
  await page.locator('#chat-input').click();
  await page.keyboard.type('你好');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('第二行');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#chat-messages .chat-row.me').length === 2);
  assert.deepEqual(sent[0], { accountId: 'B', peerUid: '111', text: '你好\n第二行' });
  assert.equal(await page.locator('#chat-input').inputValue(), '');

  // 离线账号的会话不能发送
  await page.locator('#chat-list .chat-item').nth(1).click();
  await page.waitForFunction(() => document.getElementById('chat-head-name').textContent === '老客户');
  assert.equal(await page.locator('#btn-chat-send').isDisabled(), true);
  assert.match(await page.locator('#chat-compose-hint').innerText(), /账号未连接/);
  assert.equal(opened.length, 1, '离线账号不请求后台打开会话');

  // 账号管理：备注行内编辑，Enter 保存
  await page.locator('#nav [data-page="accounts"]').click();
  await page.locator('[data-account-action="note"][data-account-id="A"]').click();
  await page.locator('[data-account-note-input="A"]').fill('主号');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert.deepEqual(posted.find(x => x[1] === '/api/accounts/A'), ['PUT', '/api/accounts/A', { note: '主号' }]);
  assert.deepEqual(errors, []);
});
