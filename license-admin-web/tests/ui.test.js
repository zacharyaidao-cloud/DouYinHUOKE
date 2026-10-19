'use strict';
// Runs against an isolated fake management server. Does not touch customer data,
// live administrator credentials, real licensing APIs, AI or the Douyin platform.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

function dependencies() {
  const root = path.join(__dirname, '..', '..');
  const candidates = [path.join(root, 'dy-lead-app', 'node_modules', 'playwright-core'), path.join(root, 'dy-lead-app-release', 'node_modules', 'playwright-core')];
  const modulePath = candidates.find(candidate => fs.existsSync(candidate));
  const executablePath = [modulePath && path.join(modulePath, '.local-browsers', 'chromium-1243', 'chrome-win64', 'chrome.exe'), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(candidate => candidate && fs.existsSync(candidate));
  if (!modulePath || !executablePath) return null;
  return { playwright: require(modulePath), executablePath };
}
function currentDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function addDays(date, count) { return new Date(Date.parse(date + 'T12:00:00+08:00') + count * 86400000).toISOString().slice(0, 10); }

test('standalone administrator interface safely manages customer accounts', async t => {
  const deps = dependencies(); if (!deps) { t.skip('Browser dependency unavailable'); return; }
  const prefix = '/dy-license/manage/';
  const reviewDir = path.join(__dirname, '..', '..', 'build-tools', 'admin-ui-review-v22'); fs.mkdirSync(reviewDir, { recursive: true });
  const viewports = [[1440, 1000], [1100, 900], [760, 1000], [390, 844]];
  const users = [
    { username: 'demo-team-01', enabled: true, expired: false, expiresAt: addDays(currentDate(), 30), note: '示例客户 A · 亚马逊账户服务', mac: 'AA:BB:CC:DD:EE:FF', createdAt: '2026-10-08T00:00:00+08:00' },
    { username: '装修客户', enabled: true, expired: false, expiresAt: addDays(currentDate(), 3), note: '家装行业 · 待续期', mac: '', createdAt: '2026-10-07T00:00:00+08:00' },
    { username: '暂时停用', enabled: false, expired: false, expiresAt: addDays(currentDate(), 90), note: '示例客户 C · 暂停合作', mac: '' },
    { username: '旧客户', enabled: true, expired: true, expiresAt: addDays(currentDate(), -4), note: '已结束合作', mac: '' }
  ];
  const events = [{ timestamp: '2026-10-08T10:30:00+08:00', actor: 'admin', action: 'create', target: '<img src=x onerror="window.__injected=1">', result: 'success' }, { timestamp: '2026-10-08T10:00:00+08:00', actor: 'anonymous', action: 'login', target: 'admin', result: 'rate_limited' }];
  const requests = []; let authenticated = false; let expired = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); const local = url.pathname.slice(prefix.length);
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    if (!local.startsWith('api/')) { const file = local || 'index.html'; if (!['index.html', 'app.js', 'styles.css'].includes(file)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html;charset=utf-8' : file.endsWith('.js') ? 'application/javascript;charset=utf-8' : 'text/css;charset=utf-8'); res.end(fs.readFileSync(path.join(__dirname, '..', 'web', file))); return; }
    let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : undefined;
    const endpoint = local.slice(4); requests.push({ endpoint, method: req.method, body, csrf: req.headers['x-csrf-token'], cookie: req.headers.cookie });
    let result = { ok: true }; let status = 200;
    if (endpoint === 'login') { if (body.username !== 'admin' || body.password !== 'fake-admin-password') { status = 401; result = { ok: false, error: '管理账户或密码错误' }; } else { authenticated = true; expired = false; res.setHeader('Set-Cookie', 'test-session=fake; HttpOnly; SameSite=Strict; Path=' + prefix); result = { ok: true, username: 'admin', csrfToken: 'fake-csrf' }; } }
    else if (endpoint === 'me') result = authenticated && !expired ? { ok: true, authenticated: true, username: 'admin', csrfToken: 'fake-csrf' } : { ok: true, authenticated: false };
    else if (!authenticated || expired) { status = 401; result = { ok: false, error: '登录已过期' }; }
    else if (req.method !== 'GET' && req.headers['x-csrf-token'] !== 'fake-csrf') { status = 403; result = { ok: false, error: 'CSRF 验证失败' }; }
    else if (endpoint === 'logout') { authenticated = false; res.setHeader('Set-Cookie', 'test-session=; Max-Age=0; HttpOnly; Path=' + prefix); }
    else if (endpoint === 'users' && req.method === 'GET') result.users = structuredClone(users);
    else if (endpoint === 'audit') result.events = structuredClone(events);
    else if (endpoint === 'users' && req.method === 'POST') { users.push({ username: body.username, enabled: true, expired: false, expiresAt: body.expiresAt, note: body.note, mac: '', createdAt: new Date().toISOString() }); events.unshift({ timestamp: new Date().toISOString(), actor: 'admin', action: 'create', target: body.username, result: 'success' }); }
    else { const [, encoded, action] = endpoint.split('/'); const username = decodeURIComponent(encoded); const user = users.find(item => item.username === username); assert.ok(user, 'Fake user exists');
      if (action === 'update') { if (body.expiresAt) { user.expiresAt = body.expiresAt; user.expired = false; } if (body.note !== undefined) user.note = body.note; if (body.enabled !== undefined) user.enabled = body.enabled; }
      else if (action === 'unbind') user.mac = '';
      else if (action === 'reset-password') assert.ok(body.newPassword.length >= 8);
      else if (action === 'delete') { assert.equal(body.confirmation, username); users.splice(users.indexOf(user), 1); }
      else assert.fail('Unexpected fake operation: ' + endpoint);
      events.unshift({ timestamp: new Date().toISOString(), actor: 'admin', action, target: username, result: 'success' });
    }
    res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await deps.playwright.chromium.launch({ headless: true, executablePath: deps.executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = 'http://127.0.0.1:' + server.address().port + prefix;
  const row = username => page.locator('tr[data-username]').filter({ has: page.locator('.account-name strong', { hasText: username }) });
  const login = async () => { await page.locator('#login-password').fill('fake-admin-password'); await page.locator('#login-submit').click(); await page.waitForSelector('#app-view:not([hidden])'); await page.waitForFunction(() => document.querySelectorAll('#account-table-body tr').length > 0); };
  const submit = async () => { await page.locator('#dialog-submit').click(); await page.waitForFunction(() => !document.getElementById('account-dialog').open); await page.waitForFunction(() => !document.getElementById('refresh-button').disabled); };
  const openMore = async (username, action) => { await row(username).locator('.more-button').click(); await page.locator('.more-menu [data-account-action="' + action + '"]').click(); await page.waitForFunction(() => document.getElementById('account-dialog').open); };
  try {
    await page.goto(base);
    for (const [width, height] of viewports) { await page.setViewportSize({ width, height }); await page.screenshot({ path: path.join(reviewDir, 'login-' + width + '.png'), fullPage: true }); const overflow = await page.evaluate(() => ({ width: window.innerWidth, total: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => element.className).slice(0, 8) })); assert.equal(overflow.total <= overflow.width, true, JSON.stringify(overflow)); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await t.test('login is distinct from customer access, errors clear passwords and credentials stay out of browser storage', async () => {
      assert.equal(await page.locator('#login-username').inputValue(), 'admin'); assert.match(await page.locator('.login-help').textContent(), /客户账户.*独立客户端/);
      await page.locator('#login-password').fill('wrong-password'); await page.locator('#login-submit').click(); await page.waitForSelector('#login-error:not([hidden])'); assert.equal(await page.locator('#login-password').inputValue(), '');
      await login(); assert.equal(await page.locator('#admin-name').textContent(), 'admin'); assert.equal(await page.locator('#login-password').inputValue(), '');
      const storage = await page.evaluate(() => [localStorage.length, sessionStorage.length]); assert.deepEqual(storage, [0, 0]);
      assert.equal(await page.locator('[onclick],[onchange],[oninput],script:not([src])').count(), 0);
    });
    await t.test('summary, search and status filtering reflect the actual customer list', async () => {
      assert.equal(await page.locator('#stat-total').textContent(), '4'); assert.equal(await page.locator('#stat-active').textContent(), '2'); assert.equal(await page.locator('#stat-expiring').textContent(), '1'); assert.equal(await page.locator('#stat-unavailable').textContent(), '2');
      await page.locator('#account-filter').selectOption('active'); assert.equal(await page.locator('#account-table-body tr').count(), 2);
      await page.locator('#account-filter').selectOption('expired'); assert.equal(await page.locator('#account-table-body tr').count(), 1); assert.match(await page.locator('#account-table-body').textContent(), /旧客户/);
      await page.locator('#account-filter').selectOption('all'); await page.locator('#account-search').fill('家装行业'); assert.equal(await page.locator('#account-table-body tr').count(), 1); assert.match(await page.locator('#account-table-body').textContent(), /装修客户/);
      await page.locator('#account-search').fill('no-such-customer'); assert.equal(await page.locator('#accounts-empty').isVisible(), true); await page.locator('#account-search').fill('');
      assert.equal(await row('demo-team-01').locator('.mac-address').textContent(), 'AA:BB:CC:DD:EE:FF'); assert.doesNotMatch(await row('demo-team-01').locator('.computer-cell').textContent(), /••/);
      await page.locator('#account-search').fill('aa:bb:cc:dd:ee:ff'); assert.equal(await page.locator('#account-table-body tr').count(), 1); await page.locator('#account-search').fill('');
      users[2].note = '<img src=x onerror="window.__injected=1">'; await page.locator('#refresh-button').click(); await page.waitForFunction(() => !document.getElementById('refresh-button').disabled);
      assert.equal(await page.locator('#account-table-body img').count(), 0); assert.match(await row('暂时停用').locator('.note-cell').textContent(), /<img/); assert.equal(await page.evaluate(() => window.__injected), undefined);
      users[2].note = '示例客户 C · 暂停合作'; await page.locator('#refresh-button').click(); await page.waitForFunction(() => !document.getElementById('refresh-button').disabled);
    });
    await t.test('full MAC, readable account cards and all dialogs remain visible at four screen widths', async () => {
      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        const mac = row('demo-team-01').locator('.mac-address'); assert.equal(await mac.textContent(), 'AA:BB:CC:DD:EE:FF'); assert.equal(await mac.isVisible(), true);
        const metrics = await mac.evaluate(element => ({ font: parseFloat(getComputedStyle(element).fontSize), clipped: element.scrollWidth > element.clientWidth, overflow: getComputedStyle(element).textOverflow })); assert.ok(metrics.font >= 16); assert.equal(metrics.clipped, false); assert.notEqual(metrics.overflow, 'ellipsis');
        assert.ok(await row('demo-team-01').locator('.account-name strong').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 16);
        assert.ok(await page.locator('.panel-heading p').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 14);
        const contrast = await page.evaluate(() => {
          const rgb = value => (value.match(/[\d.]+/g) || []).map(Number); const luminance = color => color.slice(0, 3).map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
          return ['.summary-label', '.summary-card > span', '.panel-heading p', '.mac-address', '.account-name strong', '.badge.active', '.badge.expiring', '.badge.disabled', '.badge.expired', '.nav-item.selected', '#create-button', '.sidebar-note p'].map(selector => {
            const element = document.querySelector(selector); let ancestor = element; let background; while (ancestor) { background = rgb(getComputedStyle(ancestor).backgroundColor); if (background.length === 3 || background[3] > .99) break; ancestor = ancestor.parentElement; } const text = luminance(rgb(getComputedStyle(element).color)); const paper = luminance(background); return { selector, ratio: (Math.max(text, paper) + .05) / (Math.min(text, paper) + .05) };
          });
        });
        for (const value of contrast) assert.ok(value.ratio >= 4.5, value.selector + ' contrast ' + value.ratio);
        await page.screenshot({ path: path.join(reviewDir, 'accounts-' + width + '.png'), fullPage: true });
        const before = requests.filter(request => request.method !== 'GET').length; await row('demo-team-01').locator('[data-account-action="details"]').click();
        assert.equal(await page.locator('#field-mac').inputValue(), 'AA:BB:CC:DD:EE:FF'); assert.equal(await page.locator('#field-mac').getAttribute('readonly'), ''); assert.equal(await page.locator('#field-detail-note').inputValue(), '示例客户 A · 亚马逊账户服务'); assert.equal(await page.locator('#dialog-submit').isVisible(), false);
        assert.equal(await page.locator('#account-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), true); await page.screenshot({ path: path.join(reviewDir, 'details-' + width + '.png'), fullPage: true });
        await page.locator('#field-mac').press('Enter'); assert.equal(requests.filter(request => request.method !== 'GET').length, before); await page.locator('#dialog-cancel').click();
        await page.locator('#create-button').click(); await page.screenshot({ path: path.join(reviewDir, 'create-' + width + '.png'), fullPage: true }); await page.locator('#dialog-cancel').click();
      }
      await page.setViewportSize({ width: 1440, height: 1000 }); await openMore('demo-team-01', 'unbind'); assert.equal(await page.locator('.binding-review .mac-address').textContent(), 'AA:BB:CC:DD:EE:FF'); await page.screenshot({ path: path.join(reviewDir, 'unbind-1440.png'), fullPage: true }); await page.locator('#dialog-cancel').click();
    });
    await t.test('copy MAC writes only the complete device identifier and permission refusal offers selectable read-only text', async () => {
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__fakeClipboard = value; } } }); });
      await row('demo-team-01').getByRole('button', { name: '复制 demo-team-01 的 MAC 地址', exact: true }).click(); assert.equal(await page.evaluate(() => window.__fakeClipboard), 'AA:BB:CC:DD:EE:FF');
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Test permission refusal'); } } }); });
      await row('demo-team-01').locator('.copy-mac').click(); await page.waitForFunction(() => document.getElementById('account-dialog').open); assert.equal(await page.locator('#field-mac').evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd)), 'AA:BB:CC:DD:EE:FF'); assert.match(await page.locator('#toast').textContent(), /手动复制/); await page.locator('#dialog-cancel').click();
      await row('装修客户').locator('[data-account-action="details"]').click(); assert.equal(await page.locator('#field-mac').inputValue(), '未绑定电脑'); assert.equal(await page.locator('#dialog-fields .copy-mac').count(), 0); await page.locator('#dialog-cancel').click();
    });
    await t.test('create account defaults to Shanghai date plus thirty days and sends explicit CSRF-protected fields', async () => {
      await page.locator('#create-button').click(); assert.equal(await page.locator('#field-expiry').inputValue(), addDays(currentDate(), 30));
      await page.locator('#field-username').fill('新客户'); await page.getByRole('button', { name: '生成密码', exact: true }).click(); const password = await page.locator('#field-password').inputValue(); assert.equal(password.length, 16); assert.equal(await page.locator('#field-password').getAttribute('type'), 'text');
      await page.locator('#field-note').fill('<svg onload="window.__injected=1">客户备注'); await submit();
      const request = requests.filter(item => item.endpoint === 'users' && item.method === 'POST').at(-1); assert.equal(request.csrf, 'fake-csrf'); assert.match(request.cookie, /test-session=fake/); assert.deepEqual(Object.keys(request.body).sort(), ['expiresAt', 'note', 'password', 'username']); assert.equal(request.body.username, '新客户'); assert.equal(request.body.password, password);
      assert.equal(await page.locator('#dialog-fields input[type=password]').count(), 0); assert.equal(await page.locator('#account-table-body svg').count(), 0); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      assert.match(await page.locator('#operation-result-text').textContent(), /新客户.*已开通/); assert.doesNotMatch(await page.locator('#operation-result-text').textContent(), new RegExp(password));
    });
    await t.test('expiry editing preserves account identity and computes renewal from current valid expiry', async () => {
      await row('demo-team-01').locator('[data-account-action="edit"]').click(); await page.getByRole('button', { name: '+90 天', exact: true }).click(); const expected = addDays(users.find(user => user.username === 'demo-team-01').expiresAt, 90); assert.equal(await page.locator('#field-expiry').inputValue(), expected); await page.locator('#field-note').fill('示例客户 A · 已续期'); await submit();
      const request = requests.filter(item => item.endpoint === 'users/demo-team-01/update').at(-1); assert.deepEqual(request.body, { expiresAt: expected, note: '示例客户 A · 已续期' });
    });
    await t.test('enable and disable require a reviewable confirmation and describe delayed authorization rechecks', async () => {
      await row('demo-team-01').locator('[data-account-action="disable"]').click(); assert.match(await page.locator('.dialog-caution').textContent(), /下一次授权校验.*1 分钟.*离线/); await submit(); assert.deepEqual(requests.filter(item => item.endpoint === 'users/demo-team-01/update').at(-1).body, { enabled: false });
      await row('demo-team-01').locator('[data-account-action="enable"]').click(); await submit(); assert.deepEqual(requests.filter(item => item.endpoint === 'users/demo-team-01/update').at(-1).body, { enabled: true });
    });
    await t.test('computer unbind and customer password reset use separate scoped operations', async () => {
      await openMore('demo-team-01', 'unbind'); await submit(); assert.deepEqual(requests.filter(item => item.endpoint === 'users/demo-team-01/unbind').at(-1).body, {}); assert.match(await row('demo-team-01').locator('.computer-cell').textContent(), /等待首次登录/);
      await openMore('新客户', 'reset-password'); assert.match(await page.locator('.password-feedback').textContent(), /不会修改管理员登录密码/); await page.locator('#field-password').fill('new-fake-customer-password'); await submit(); const request = requests.filter(item => item.endpoint === 'users/' + encodeURIComponent('新客户') + '/reset-password').at(-1); assert.deepEqual(request.body, { newPassword: 'new-fake-customer-password' }); assert.equal(await page.locator('#field-password').count(), 0);
    });
    await t.test('permanent deletion requires the exact typed account name and cancellation never mutates', async () => {
      await openMore('新客户', 'delete'); const before = requests.filter(item => item.endpoint.endsWith('/delete')).length; await page.locator('#field-confirmation').fill('新'); await page.locator('#dialog-submit').click(); await page.waitForSelector('#dialog-error:not([hidden])'); assert.equal(requests.filter(item => item.endpoint.endsWith('/delete')).length, before);
      await page.locator('#dialog-cancel').click(); assert.ok(users.some(user => user.username === '新客户')); await openMore('新客户', 'delete'); await page.locator('#field-confirmation').fill('新客户'); await submit(); assert.equal(users.some(user => user.username === '新客户'), false); assert.equal(requests.filter(item => item.endpoint.endsWith('/delete')).at(-1).body.confirmation, '新客户');
      await page.locator('#dismiss-result').click(); assert.equal(await page.locator('#operation-result').isVisible(), false); assert.equal(await page.locator('#operation-result-text').textContent(), '');
    });
    await t.test('activity audit safely renders untrusted names and the narrow layout remains usable', async () => {
      await page.locator('#nav-audit').click(); await page.waitForSelector('#audit-list li'); assert.match(await page.locator('#audit-list').textContent(), /开通账户/); assert.equal(await page.locator('#audit-list img').count(), 0); assert.match(await page.locator('#audit-list').textContent(), /<img/); assert.match(await page.locator('#audit-list').textContent(), /未登录访问者.*请求过于频繁/);
      await page.locator('#nav-accounts').click(); await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true); await page.screenshot({ path: path.join(__dirname, 'admin-ui-mobile.png'), fullPage: true });
      await page.locator('#create-button').click(); assert.equal(await page.locator('#account-dialog').isVisible(), true); assert.equal(await page.locator('#field-username').evaluate(element => document.activeElement === element), true); await page.keyboard.press('Escape'); assert.equal(await page.locator('#account-dialog').evaluate(element => element.open), false); await page.setViewportSize({ width: 1440, height: 1000 });
    });
    await t.test('expired administrator sessions remove private account data and force a fresh login', async () => {
      expired = true; await page.locator('#refresh-button').click(); await page.waitForSelector('#login-view:not([hidden])'); assert.match(await page.locator('#login-error').textContent(), /登录已过期/); assert.equal(await page.locator('#account-table-body tr').count(), 0); assert.equal(await page.locator('#login-password').inputValue(), ''); await login();
      await page.locator('#logout-button').click(); await page.waitForSelector('#login-view:not([hidden])'); assert.equal(authenticated, false); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      await page.screenshot({ path: path.join(__dirname, 'admin-login-review.png'), fullPage: true });
    });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

