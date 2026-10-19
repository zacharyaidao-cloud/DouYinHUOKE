'use strict';
// A fake preload bridge and a local HTTP fixture only. No real account,
// platform page, login profile, CDP connection or outgoing message is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { publicLeadFields } = require('../lib/lead-fields');
function dependencies() {
  const modulePath = [path.join(__dirname, '..', 'node_modules', 'playwright-core'), path.join(__dirname, '..', '..', 'dy-lead-app-release', 'node_modules', 'playwright-core')].find(fs.existsSync);
  const executablePath = [modulePath && path.join(modulePath, '.local-browsers', 'chromium-1243', 'chrome-win64', 'chrome.exe'), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => p && fs.existsSync(p));
  return modulePath && executablePath ? { playwright: require(modulePath), executablePath } : null;
}
function settings() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');
  const literal = source.match(/const DEFAULT_SETTINGS = ([\s\S]*?);\r?\n\r?\nfunction getAccounts/)[1];
  const prompt = source.match(/const DEFAULT_INDUSTRY_PROMPT = ([\s\S]*?);\r?\nconst DEFAULT_SETTINGS/);
  const context = { ...require('../lib/ai-policy'), ...require('../lib/keyword-screen') };
  if (prompt) context.DEFAULT_INDUSTRY_PROMPT = require('node:vm').runInNewContext('(' + prompt[1] + ')', context);
  return JSON.parse(JSON.stringify(require('node:vm').runInNewContext('(' + literal + ')', context)));
}
function fakeBridge() {
  sessionStorage.setItem('dy_token', 'fixture-session');
  const calls = [], state = { accounts: [], activeAccountId: null }, listeners = new Set();
  let bounds = null;
  const emit = extra => { for (const callback of listeners) callback({ ...state, accounts: state.accounts.map(account => ({ ...account })), showRequested: false, ...extra }); };
  const paint = () => {
    let view = document.getElementById('fixture-native-view');
    if (!view) { view = document.createElement('div'); view.id = 'fixture-native-view'; document.body.appendChild(view); }
    const selected = state.accounts.find(account => account.visible);
    view.style.cssText = 'position:fixed;z-index:10000;background:#f1f5fb;color:#24334c;display:' + (selected && bounds ? 'flex' : 'none') + ';align-items:center;justify-content:center;border:1px solid #b8c9df;font:24px Microsoft YaHei;';
    if (bounds) Object.assign(view.style, { left: bounds.x + 'px', top: bounds.y + 'px', width: bounds.width + 'px', height: bounds.height + 'px' });
    view.textContent = selected ? selected.name + ' · 隔离模拟网页' : '';
  };
  window.__browserFixture = { calls, state, emit, push: (accounts, extra = {}) => { state.accounts = accounts; if (Object.hasOwn(extra, 'activeAccountId')) state.activeAccountId = extra.activeAccountId; emit(extra); }, rejectShow: false };
  window.desktop = { version: '9.8.7', browser: {
    list: async () => { calls.push({ method: 'list' }); return { ...state, accounts: state.accounts.map(account => ({ ...account })), showRequested: false }; },
    show: async id => { calls.push({ method: 'show', id }); if (window.__browserFixture.rejectShow) throw new Error('模拟显示失败'); state.activeAccountId = id; state.accounts.forEach(account => { account.visible = account.id === id; }); paint(); emit(); },
    hide: async () => { calls.push({ method: 'hide' }); state.accounts.forEach(account => { account.visible = false; }); paint(); emit(); },
    setBounds: async value => { calls.push({ method: 'setBounds', value }); bounds = value; paint(); },
    back: async () => { calls.push({ method: 'back' }); }, forward: async () => { calls.push({ method: 'forward' }); }, reload: async () => { calls.push({ method: 'reload' }); },
    onState: callback => { listeners.add(callback); return () => listeners.delete(callback); }
  } };
}

test('embedded account browser preserves workbench controls and only switches existing isolated views', async t => {
  const deps = dependencies(); if (!deps) { t.skip('No browser runtime available'); return; }
  const config = settings(), requests = [], errors = [];
  const modes = {};
  const snapshot = () => ({ ok: true, role: 'user', settings: config, leadFields: publicLeadFields(), accounts: [1, 2].map(id => ({ id, name: '测试账号' + id, browserMode: modes[id], loginState: '未登录', daily: { follow: 0, dm: 0, videos: 0 } })),
    stats: { total: 0, intent: 0, followed: 0, dmSent: 0, newCount: 0, aiJudged: 0 }, task: { running: false, status: '空闲' }, license: {}, loginUser: 'fixture' });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html;charset=utf-8' : name.endsWith('.js') ? 'application/javascript;charset=utf-8' : 'text/css;charset=utf-8');
      res.end(fs.readFileSync(path.join(__dirname, '..', 'web', name))); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: url.pathname, method: req.method, body });
    if(req.method === 'PUT' && /^\/api\/accounts\/\d+$/.test(url.pathname)) modes[url.pathname.split('/').pop()] = JSON.parse(body).browserMode;
    const result = url.pathname === '/api/state' ? snapshot() : url.pathname === '/api/videos' ? { ok: true, videos: [] } : url.pathname === '/api/leads' ? { ok: true, leads: [], total: 0, counts: {} } : { ok: true };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await deps.playwright.chromium.launch({ executablePath: deps.executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  await page.addInitScript(fakeBridge);
  const base = 'http://127.0.0.1:' + server.address().port;
  const push = (rows, extra = {}) => page.evaluate(({ rows, extra }) => window.__browserFixture.push(rows, extra), { rows, extra });
  const rows = [{ id: '1', name: '测试账号一', url: 'https://www.douyin.com/user/self', title: '抖音账号页面', loading: false, visible: false }, { id: '2', name: '测试账号二', url: 'https://www.douyin.com/', title: '等待扫码', loading: true, visible: false }];
  const visible = async id => page.waitForFunction(id => window.__browserFixture.state.accounts.some(account => account.id === id && account.visible), id);
  try {
    await page.goto(base); await page.waitForFunction(() => document.getElementById('login-layer').style.display === 'none');
    await t.test('sidebar version uses the real preload value and plain web mode claims no client version', async () => {
      assert.equal(await page.locator('#client-build').textContent(), '客户端 9.8.7 · 双浏览器模式');
      assert.equal(await page.locator('#client-build').isVisible(), true);
      assert.equal(await page.locator('#client-build').evaluate(element => getComputedStyle(element).fontSize), '15px');
      const sourcePage = await browser.newPage();
      try {
        await sourcePage.addInitScript(() => sessionStorage.setItem('dy_token', 'fixture-session'));
        await sourcePage.goto(base);
        await sourcePage.waitForFunction(() => document.getElementById('login-layer').style.display === 'none');
        assert.equal(await sourcePage.locator('#client-build').textContent(), '网页调试模式 · 无客户端版本');
        assert.equal(await sourcePage.locator('#client-build').isVisible(), true);
      } finally { await sourcePage.close(); }
    });
    await t.test('empty browser explains account opening and one-time login migration without launching anything', async () => {
      await page.locator('#nav [data-page="browser"]').click();
      assert.match(await page.locator('#browser-empty-title').textContent(), /先打开/);
      assert.match(await page.locator('#browser-upgrade-note').textContent(), /首次请重新扫码/);
      assert.equal(await page.locator('#browser-url').getAttribute('readonly'), '');
      assert.equal(await page.locator('#btn-browser-back').isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__browserFixture.calls.filter(call => call.method === 'show').length), 0);
      await page.locator('#btn-browser-note-dismiss').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('hm-embedded-browser-intro-v230')), '1');
    });
    await t.test('default external login stays on workbench; account mode switch is saved independently', async () => {
      await page.locator('#nav [data-page="accounts"]').click();
      assert.equal(await page.locator('[data-account-mode="1"]').inputValue(), 'external');
      await page.locator('[data-account-id="1"][data-account-action="open"]').click();
      await page.waitForFunction(() => document.getElementById('account-login-status').textContent.includes('已开始打开'));
      assert.equal(await page.locator('#page-accounts').isVisible(), true);
      assert.equal(await page.evaluate(() => window.__browserFixture.calls.filter(c => c.method === 'show').length), 0);
      await page.locator('[data-account-mode="1"]').selectOption('embedded');
      await page.waitForFunction(() => document.getElementById('account-login-status').textContent.includes('已切换到内嵌'));
      assert(requests.some(r => r.method === 'PUT' && r.url === '/api/accounts/1' && JSON.parse(r.body).browserMode === 'embedded'));
      assert.equal(await page.locator('[data-account-mode="2"]').inputValue(), 'external');
    });
    await t.test('open login retains the existing authenticated API and waits for an opened account before show', async () => {
      await page.locator('[data-account-id="1"][data-account-action="open"]').click();
      await page.waitForSelector('#page-browser:not(.hidden)');
      assert(requests.some(row => row.url === '/api/accounts/1/open' && row.method === 'POST'));
      assert.equal(await page.evaluate(() => window.__browserFixture.calls.filter(call => call.method === 'show').length), 0);
      await push(rows, { activeAccountId: '1', showRequested: true }); await visible('1');
      assert.equal(await page.locator('#browser-url').inputValue(), rows[0].url);
    });
    await t.test('bounds avoid the top bar, sidebar and global stop and adapt to resize', async () => {
      const report = await page.evaluate(() => {
        const value = window.__browserFixture.calls.filter(call => call.method === 'setBounds').at(-1).value;
        const slot = document.getElementById('browser-view-slot').getBoundingClientRect(), stop = document.getElementById('btn-global-stop').getBoundingClientRect();
        return { value, slot: { x: slot.x, y: slot.y, right: slot.right, bottom: slot.bottom }, overlap: value.x < stop.right && value.x + value.width > stop.left && value.y < stop.bottom && value.y + value.height > stop.top };
      });
      assert(report.value.x >= 220); assert(report.value.y >= report.slot.y); assert(report.value.x + report.value.width <= report.slot.right);
      assert.equal(report.overlap, false); assert(Object.values(report.value).every(Number.isInteger));
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForFunction(width => window.__browserFixture.calls.filter(call => call.method === 'setBounds').at(-1).value.width < width, report.value.width);
      await page.locator('#btn-global-stop').click();
      assert(requests.some(row => row.url === '/api/tasks/stop' && row.method === 'POST'));
    });
    await t.test('tabs, keyboard selection and navigation use the preload only, not login endpoints', async () => {
      const opens = requests.filter(row => row.url.endsWith('/open')).length;
      await page.locator('[data-browser-account="2"]').click(); await visible('2');
      assert.equal(await page.locator('[data-browser-account="2"]').getAttribute('aria-selected'), 'true');
      await page.locator('#btn-browser-back').click(); await page.locator('#btn-browser-forward').click(); await page.locator('#btn-browser-reload').click();
      assert.deepEqual(await page.evaluate(() => window.__browserFixture.calls.filter(call => ['back', 'forward', 'reload'].includes(call.method)).map(call => call.method)), ['back', 'forward', 'reload']);
      await page.locator('[data-browser-account="2"]').press('Home'); await visible('1');
      assert.equal(requests.filter(row => row.url.endsWith('/open')).length, opens);
    });
    await t.test('background state does not navigate, explicit task focus does, and return hides without closing', async () => {
      await page.locator('#btn-browser-workspace').click();
      await page.waitForFunction(() => !window.__browserFixture.state.accounts.some(account => account.visible));
      assert.equal(await page.locator('#page-accounts').isVisible(), true);
      await push(rows, { activeAccountId: '2', showRequested: false });
      assert.equal(await page.locator('#page-accounts').isVisible(), true);
      await push(rows, { activeAccountId: '2', showRequested: true }); await visible('2');
      assert.equal(await page.locator('#page-browser').isVisible(), true);
      assert.equal(requests.some(row => row.url.endsWith('/close')), false);
    });
    await t.test('dialogs and the authorization screen hide the native view, so controls cannot be covered', async () => {
      await page.evaluate(() => openModal('field-detail-modal', 'field-detail-close'));
      await page.waitForFunction(() => !window.__browserFixture.state.accounts.some(account => account.visible));
      await page.locator('#field-detail-close').click(); await visible('2');
      await page.evaluate(() => showLogin());
      await page.waitForFunction(() => !window.__browserFixture.state.accounts.some(account => account.visible));
      await push(rows, { activeAccountId: '1', showRequested: true });
      assert.equal(await page.evaluate(() => window.__browserFixture.state.accounts.some(account => account.visible)), false);
      await page.locator('#btn-global-stop').click();
      await page.evaluate(() => hideLogin()); await visible('1');
    });
    await t.test('display errors are in-page, state text is escaped, and one-time notice stays dismissed', async () => {
      await page.evaluate(() => { window.__browserFixture.rejectShow = true; });
      await page.locator('[data-browser-account="2"]').click();
      await page.waitForSelector('#browser-error:not(.hidden)');
      assert.match(await page.locator('#browser-error').textContent(), /模拟显示失败/);
      await page.evaluate(() => { window.__browserFixture.rejectShow = false; });
      await page.locator('#btn-browser-show').click(); await visible('2');
      await push([{ ...rows[0], name: '<img src=x onerror="window.injected=1">', title: '<svg onload=alert(1)>' }], { activeAccountId: '1', showRequested: true }); await visible('1');
      assert.equal(await page.locator('#browser-tabs img, #browser-page-status svg').count(), 0);
      assert.equal(await page.locator('#browser-upgrade-note').isVisible(), false);
      await push(rows, { activeAccountId: '1', showRequested: true }); await visible('1');
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.waitForFunction(() => window.__browserFixture.calls.filter(call => call.method === 'setBounds').at(-1).value.width > 1100);
      const dir = path.resolve(__dirname, '../../build-tools/ui-review-v230'); fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'embedded-browser-1440.png'), fullPage: true });
      assert.deepEqual(errors, []);
    });
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
