'use strict';
// Browser checks run against a fake local backend. No platform, AI provider,
// customer data, real account or real outgoing operation is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const AI = require('../ai');
const { filterLeads, aiCategory, contactCategory, aiFacetCounts } = require('../lead-query');
const { publicLeadFields, projectLead } = require('../lib/lead-fields');

function sourceDefaultSettings() {
  // Read only the literal defaults; requiring store.js would open a data directory.
  const source = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');
  const definition = source.match(/const DEFAULT_SETTINGS = ([\s\S]*?);\r?\n\r?\nfunction getAccounts/);
  assert.ok(definition, 'source defaults should be available without reading customer data');
  const prompt = source.match(/const DEFAULT_INDUSTRY_PROMPT = ([\s\S]*?);\r?\nconst DEFAULT_SETTINGS/);
  const context = {...require('../lib/ai-policy'),...require('../lib/keyword-screen')};
  if(prompt) context.DEFAULT_INDUSTRY_PROMPT=require('node:vm').runInNewContext('(' + prompt[1] + ')',context);
  return JSON.parse(JSON.stringify(require('node:vm').runInNewContext('(' + definition[1] + ')', context)));
}

function dependencies() {
  const candidates = [path.join(__dirname, '..', 'node_modules', 'playwright-core'), path.join(__dirname, '..', '..', 'dy-lead-app-release', 'node_modules', 'playwright-core')];
  const modulePath = candidates.find(p => fs.existsSync(p));
  const browserCandidates = [
    modulePath && path.join(modulePath, '.local-browsers', 'chromium-1243', 'chrome-win64', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const executablePath = browserCandidates.find(p => p && fs.existsSync(p));
  return modulePath && executablePath ? { playwright: require(modulePath), executablePath } : null;
}

async function readability(page, loginOnly = false) {
  return page.evaluate(login => {
    const rgb = color => (color.match(/[\d.]+/g) || []).map(Number);
    const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const candidates = [...document.querySelectorAll(login ? '#login-layer *, #btn-global-stop, #btn-global-stop *' : 'body *')];
    const text = [], controls = [];
    for (const element of candidates) {
      if (!element.getClientRects().length || element.closest('script,style,[aria-hidden="true"]') || element.disabled) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden') continue;
      if (element.matches('input:not([type="checkbox"]):not([type="radio"]),select,textarea')) controls.push({ id: element.id, fontSize: parseFloat(style.fontSize), minFontSize: element.closest('#page-leads,.work-history-panel') ? 15 : 16 });
      if (![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
      let backgroundElement = element, background = rgb(style.backgroundColor);
      while ((!background.length || background[3] === 0) && backgroundElement.parentElement) {
        backgroundElement = backgroundElement.parentElement;
        background = rgb(getComputedStyle(backgroundElement).backgroundColor);
      }
      if (!background.length || background[3] === 0) background = [255, 255, 255];
      const foreground = luminance(rgb(style.color)), backdrop = luminance(background);
      const ratio = (Math.max(foreground, backdrop) + .05) / (Math.min(foreground, backdrop) + .05);
      text.push({ selector: element.id ? '#' + element.id : element.tagName.toLowerCase() + '.' + element.className, text: element.textContent.trim().slice(0, 38), fontSize: parseFloat(style.fontSize), contrast: Math.round(ratio * 100) / 100 });
    }
    return { bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize), textCount: text.length, minTextFontSize: Math.min(...text.map(item => item.fontSize)), minContrast: Math.min(...text.map(item => item.contrast)), lowContrast: text.filter(item => item.contrast < 4.5), smallText: text.filter(item => item.fontSize < 14), smallControls: controls.filter(item => item.fontSize < item.minFontSize), controlsCount: controls.length };
  }, loginOnly);
}

function assertReadable(report, context) {
  assert.equal(report.bodyFontSize, 16, context + ' 正文默认 16px');
  assert.deepEqual(report.smallText, [], context + ' 所有可见文字至少 14px');
  assert.deepEqual(report.smallControls, [], context + ' 紧凑列表输入内容至少 15px，其他输入至少 16px');
  assert.deepEqual(report.lowContrast, [], context + ' 文字对比度至少 4.5:1');
}

test('customer interface uses unified actions, official models and three explicit prompt presets', async t => {
  const deps = dependencies();
  if (!deps) { t.skip('No bundled or installed browser available'); return; }
  const sourceDefaults = sourceDefaultSettings();
  const config = {
    collect: { scrollIntervalSec: 3, scrollJitter: .4, cooldownHours: 24, dailyVideoLimit: 3, maxScrolls: 80, linkIntervalSec: 10, linkIntervalJitter: .2, skipEmptyText: true, autoAiAfterCollect: true },
    follow: { enabled: true, intervalMinSec: 60, intervalMaxSec: 180, dailyLimit: 30 },
    dm: { enabled: true, intervalMinSec: 90, intervalMaxSec: 240, dailyLimit: 20, skipAuthor: true, repeat: { enabled: false, intervalDays: 7 }, template: '您好' },
    keywords: { intent: ['申诉'], exclude: [] },
    human: { preDwellMinSec: 5, preDwellMaxSec: 15, breakEvery: 10, breakMinSec: 60, breakMaxSec: 180, maxConsecutiveErrors: 3, workPeriods: [] },
    action: { userIntervalSec: 10, userIntervalJitter: .4, pacingVersion: 1 },
    ai: { enabled: true, apiKey: '', model: 'deepseek-flash', businessDesc: '亚马逊账户申诉、激活、解封与资金解冻', targetCustomers: '遇到账户受限的亚马逊卖家', clearNeeds: '自己的账户被停用，需要申诉', misjudgments: '围观、同行广告和转述', promptPresets: [{ id: 'prompt-1', name: '亚马逊账户服务', prompt: '判断真实需求' }, { id: 'prompt-2', name: '提示词 2', prompt: '' }, { id: 'prompt-3', name: '提示词 3', prompt: '' }], activePromptId: 'prompt-1', prompt: '判断真实需求', intervalSec: 5, intervalJitter: .2, batchMaxChars: sourceDefaults.ai.batchMaxChars, batchMaxCount: sourceDefaults.ai.batchMaxCount, requestTimeoutSec: 60 },
    license: { enabled: true }
  };
  const maliciousNickname = '\"><img src=x onerror="window.__injected=1">';
  const recentCommentTime = () => {
    const d = new Date(Date.now() - 2 * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const sampleLeads = [
    { id: 1, accountId: '1', nickname: maliciousNickname, uid: 'fake-1', UID: '100', demand: '申诉费用？', trigger: '申诉', aiDone: true, aiNeed: '是', aiReason: '询问申诉服务费用', aiPromptVersion: AI.getRuleSet(config).version, aiScore: 90, status: 'new', time: recentCommentTime() },
    { id: 2, accountId: '1', nickname: '待核验用户', uid: 'fake-2', demand: '申诉如何处理', aiDone: true, aiNeed: '是', aiPromptVersion: 'old', dmState: 'pending_verification', status: 'dm_pending', time: recentCommentTime() },
    { id: 3, accountId: '1', nickname: '未判断用户', uid: 'fake-3', demand: '需要申诉', status: 'new', time: recentCommentTime() }
  ];
  for (const lead of sampleLeads) lead.homepage = 'https://www.douyin.com/user/mock-ui-profile-' + lead.id;
  const requests = [];
  const collectionHistory = [
    { awemeId: '123', videoLink: 'https://www.douyin.com/video/123', desc: '完整样例', scanCount: 2, collectCount: 900, collectionState: 'complete', lastCollectAt: '2026-10-08 10:00:00', collectionReason: '平台返回 has_more=0' },
    { awemeId: '456', videoLink: 'https://www.douyin.com/note/456', desc: '图文部分样例', scanCount: 3, collectCount: 800, collectionState: 'partial', lastCollectAt: '2026-10-08 11:00:00', collectionReason: '达到翻页上限' }
  ];
  sampleLeads[0].aiInputHash = require('node:crypto').createHash('sha256').update(JSON.stringify(AI.leadInput(sampleLeads[0], {}))).digest('hex');
  let uiFieldSchema = publicLeadFields();
  const plans = new Map();
  let expired = false;
  let modelsError = false;
  let modelCandidates = [{ id: 'deepseek-flash', name: 'deepseek-flash' }, { id: 'deepseek-pro-test', name: '测试新模型' }];
  let draftGate = null;
  let aiStartGate = null;
  let aiStartError = '';
  let uiTask = { running: false, status: '测试空闲' };
  let outreachStartGate = null;
  let outreachStartError = '';
  let nextOutreachTask = null;
  let collectionStartGate = null;
  let settingsSaveError = '';
  let stateReadError = false;
  const mockAiLogLines = [
    { event: 'selection', selectedCount: 8, pendingCount: 4, force: false },
    { event: 'request_sent', kind: 'models', completionRequestCount: 0, modelRequestCount: 1 },
    { event: 'model_capacity', model: 'deepseek-new-test', contextWindow: 128000, maxOutputTokens: 16000, sourceKind: 'official_document_fallback' },
    { event: 'budget', batchNo: 1, batchCount: 1, inputTokensEstimate: 2800, outputTokensReserved: 800, targetTokens: 115200 },
    { event: 'plan', count: 4, batchCount: 1, ruleVersion: 'test-binary-rules' },
    { event: 'request', mode: 'batch', batchNo: 1, batchCount: 1, count: 4, workCount: 1, reason: '按模型容量的90%自动组批' },
    { event: 'request_sent', kind: 'completion', batchNo: 1, batchCount: 1, completionRequestCount: 1, modelRequestCount: 1 },
    { event: 'provider_retry', batchNo: 1, batchCount: 1, retryNo: 1, delayMs: 2000, reason: '服务暂不可用' },
    { event: 'result', mode: 'batch', batchNo: 1, batchCount: 1, leadId: 1, outcome: 'success', need: '是', reason: '询问账户申诉资料' },
    { event: 'response_invalid', batchNo: 1, batchCount: 1, message: '回执缺少一个编号' },
    { event: 'retry_split', batchNo: 1, batchCount: 1, count: 4, leftCount: 2, rightCount: 2, reason: '服务器拒绝超限批次' },
    { event: 'request', mode: 'retry_batch', batchNo: 1, batchCount: 1, count: 2, workCount: 1, reason: '拆分后按顺序重试' },
    { event: 'budget_rejected', leadId: 3, reason: '单条输入及预留返回超过模型容量预算' },
    { event: 'usage', batchNo: 1, batchCount: 1, usage: { prompt_tokens: 1234, completion_tokens: 456 } },
    { event: 'fallback', batchNo: 1, batchCount: 1, leadId: 2, reason: '本批回执未通过完整核验' },
    { event: 'result', mode: 'fallback_single', leadId: 2, outcome: 'failed', reason: '<img src=x onerror="window.__injected=1">' },
    { event: 'batch_completed', batchNo: 1, batchCount: 1, yes: 2, no: 1, failed: 1, skipped: 0, fallback: 1 },
    { event: 'completed', yes: 2, no: 1, failed: 1, skipped: 0, fallbackCount: 1 }
  ].map(item => '[2026-10-08 14:20:00] AI_AUDIT ' + JSON.stringify(item));
  let aiPromptWarning='';
  const snapshot = () => {
    // 与生产服务一致：明文 Key 不下发，只暴露是否已保存。
    const settings = structuredClone(config);
    settings.ai.apiKeySet = !!String(settings.ai.apiKey || '').trim();
    settings.ai.apiKey = '';
    return { ok: true, role: 'user', leadFields: uiFieldSchema, settings, aiRuleVersion: AI.getRuleSet(config).version,aiPromptWarning,aiIndustryDefaults:{businessInput:Object.fromEntries(['businessDesc','targetCustomers','clearNeeds','misjudgments'].map(key=>[key,sourceDefaults.ai[key]])),prompt:sourceDefaults.ai.promptPresets[0].prompt,keywords:sourceDefaults.keywords},
    accounts: [1, 2].map(id => ({ id, name: '测试账号' + id, loginState: '已登录', daily: { follow: 0, dm: 0, videos: 0 } })),
    task: structuredClone(uiTask), stats: { total: 3, intent: 1, followed: 0, dmSent: 0, newCount: 3, aiJudged: 2 }, loginUser: 'fake-user', license: { mac: '02:00:00:00:00:01', serverTime: '2026-10-08', cache: { username: 'fake-user', expiresAt: '2026-11-08' } }, dataDir: 'fake-data' };
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'");
      res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html;charset=utf-8' : name.endsWith('.js') ? 'application/javascript;charset=utf-8' : 'text/css;charset=utf-8');
      res.end(fs.readFileSync(path.join(__dirname, '..', 'web', name))); return;
    }
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : undefined;
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, token: req.headers['x-auth-token'] };
    requests.push(entry);
    let result = { ok: true };
    if (url.pathname === '/api/login') result.token = 'fake-known-session';
    else if (url.pathname === '/api/state') {
      if (expired) { res.statusCode = 401; result = { ok: false, error: '测试授权已到期' }; }
      else if (stateReadError) { res.statusCode = 503; result = { ok: false, error: '测试本机连接中断' }; }
      else result = snapshot();
    } else if (url.pathname === '/api/videos') result.videos = collectionHistory;
    else if (url.pathname === '/api/leads') {
      const videos = Object.fromEntries(collectionHistory.map(work => [work.awemeId, work]));
      const filters = Object.fromEntries(url.searchParams), options = { settings: config };
      const filtered = filterLeads(sampleLeads, videos, filters, options);
      result = { ok: true, leadFields: uiFieldSchema, total: sampleLeads.length, totalFiltered: filtered.length, facets: { ai: aiFacetCounts(sampleLeads, videos, filters, options) }, leads: filtered.map(lead => {
      const projected = { ...projectLead(lead, videos), aiResultCurrent: AI.isStoredResultCurrent(lead, AI.getRuleSet(config).version, videos), aiCategory: aiCategory(lead, videos, options), contactCategory: contactCategory(lead) };
      // Additional mock fields exercise schema evolution without a UI edit.
      for (const field of uiFieldSchema.fields) if (!Object.hasOwn(projected.fieldValues, field.key)) projected.fieldValues[field.key] = lead[field.key] || '';
      return projected;
      }) };
    }
    else if (url.pathname === '/api/export' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''mock-leads.xlsx");
      res.end(Buffer.from('isolated UI export fixture')); return;
    }
    else if (/^\/api\/(follow|dm|outreach)\/preview$/.test(url.pathname)) {
      const kind = url.pathname.split('/')[2];
      const scoped = filterLeads(sampleLeads.filter(lead => String(lead.accountId) === String(body.accountId)), {}, body.filters, { settings: config, ...(body.leadIds === undefined ? {} : { leadIds: body.leadIds }) });
      result = { ok: true, planId: 'fake-plan-' + plans.size, accountId: String(body.accountId), kind, dmTemplate: config.dm.template, actions: { follow: kind !== 'dm', dm: kind !== 'follow' }, remaining: { follow: 10, dm: 20, profile: 30 }, warnings: ['预检查不占用额度'], count: scoped.length, filteredCount: scoped.length, leads: scoped.map(lead => ({ ...lead, messagePreview: config.dm.template.replaceAll('{昵称}', lead.nickname), actions: { follow: kind !== 'dm', dm: kind !== 'follow' } })) };
      plans.set(result.planId, result);
    } else if (/^\/api\/(follow|dm|outreach)\/start$/.test(url.pathname)) {
      assert.ok(plans.has(body.planId)); // mock records only: performs no action
      if (outreachStartGate) await outreachStartGate;
      if (outreachStartError) { res.statusCode = 409; result = { ok: false, error: outreachStartError }; }
      else if (nextOutreachTask) uiTask = structuredClone(nextOutreachTask);
    } else if (url.pathname === '/api/collect/start') { if (collectionStartGate) await collectionStartGate; } else if (url.pathname === '/api/ai/models') {
      if (modelsError || !config.ai.apiKey) { res.statusCode = 400; result = { ok: false, error: modelsError ? '测试官方服务暂不可用' : '请先保存 DeepSeek API Key' }; }
      else result = { ok: true, models: modelCandidates, selectedModel: config.ai.model, fetchedAt: new Date().toISOString() };
    } else if (url.pathname === '/api/ai/start') {
      if (aiStartGate) await aiStartGate;
      if (aiStartError) { res.statusCode = 400; result = { ok: false, error: aiStartError }; }
    } else if (url.pathname === '/api/ai/prompt-draft') { if (draftGate) await draftGate; result.prompt = '只判断家装方案求助或服务咨询；给作者建议但无求助的判否，理由不超过30字，不生成评分。'; }
    else if (url.pathname === '/api/ai/prompt-test') result.results = body.samples.map((comment, index) => ({ i: index + 1, comment, need: index % 2 ? '否' : '是', reason: index % 2 ? '仅围观无业务需求' : '业务相关可考虑联系' }));
    else if (url.pathname.startsWith('/api/logs/')) result.lines = url.pathname === '/api/logs/system' ? mockAiLogLines : ['账号1操作日志'];
    else if (url.pathname === '/api/settings' && req.method === 'PUT') {
      if (settingsSaveError) { res.statusCode = 409; result = { ok: false, error: settingsSaveError }; } else {
      // 与生产服务一致：留空表示沿用已保存的 Key。
      if (body.ai && typeof body.ai.apiKey === 'string' && !body.ai.apiKey.trim()) body.ai.apiKey = config.ai.apiKey;
      if (body.ai) delete body.ai.apiKeySet;
      for (const key of Object.keys(body)) config[key] = { ...config[key], ...body[key] };
      config.ai.prompt = config.ai.promptPresets.find(item => item.id === config.ai.activePromptId).prompt;
      }
    }
    else if (/^\/api\/leads\/\d+\/resolve$/.test(url.pathname)) {
      const lead = sampleLeads.find(item => String(item.id) === url.pathname.split('/')[3]);
      lead[body.kind + 'State'] = body.outcome === 'success' ? 'confirmed_success' : 'confirmed_failure';
    } else if (/^\/api\/leads\/\d+\/status$/.test(url.pathname)) {
      const lead = sampleLeads.find(item => String(item.id) === url.pathname.split('/')[3]);
      if (body.status === 'manual_approved') lead.manualApproved = true;
      else { lead.status = body.status; lead[body.status === 'replied' ? 'replied' : 'doNotContact'] = true; }
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await deps.playwright.chromium.launch({ headless: true, executablePath: deps.executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], dialogs = [];
  const screenshotDir = path.resolve(__dirname, '../../build-tools/ui-review-v2216');
  fs.mkdirSync(screenshotDir, { recursive: true });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(dialog.type() === 'prompt' ? '已核对本次发送回执' : undefined); });
  async function openLeadDetail(id) {
    if (await page.locator('#field-detail-modal').isVisible()) await page.locator('#field-detail-close').click();
    await page.locator(`#lead-list [data-lead-detail="${id}"]`).first().click();
    await page.waitForSelector('#lead-detail-actions:not(.hidden)');
  }
  try {
    await page.goto(base);
    await page.screenshot({ path: path.join(screenshotDir, 'login-1440.png'), fullPage: true });
    await page.locator('#login-user').fill('fake-user'); await page.locator('#login-pass').fill('fake-password'); await page.locator('#btn-login').click();
    await page.waitForFunction(() => document.getElementById('login-layer').style.display === 'none' && document.getElementById('act-account').options.length === 2);
    await page.locator('#nav a[data-page="leads"]').click(); await page.waitForSelector('#lead-list .lead-select');

    await t.test('customer UI has no administrator capability and escapes collected text under strict CSP', async () => {
      assert.equal(await page.locator('[id*="admin"], #s-lic-enabled, #s-lic-adminkey').count(), 0);
      assert.equal(await page.locator('#s-lic-url, #s-ai-base').count(), 0);
      assert.equal(await page.locator('#lead-list img').count(), 0);
      assert.equal(await page.locator('#lead-list .col-nick .lead-name').first().textContent(), '未判断用户'); // newest-first sort
      assert.match(await page.locator('#lead-list .lead-work').first().textContent(), /描述待补充|描述未获取/);
      assert.doesNotMatch(await page.locator('#lead-list').textContent(), /查看作品/);
      assert.equal(await page.locator('[onclick], [onchange], [oninput]').count(), 0);
      assert.match(await page.locator('#ai-decision-policy').textContent(), /是.*否.*30.*不代表已确认需求/s);
    });

    await t.test('database field definitions control main column order and extra column preferences independently of task scope', async () => {
      const primary = uiFieldSchema.fields.filter(field => field.defaultVisible);
      const compactKeys = ['id', 'nickname', 'time', 'demand', 'videoDesc', 'aiNeed', 'contact'];
      assert.deepEqual(await page.locator('#lead-head th[data-field-key]').evaluateAll(elements => elements.map(element => element.dataset.fieldKey)), compactKeys);
      assert.deepEqual(primary.map(field => field.key), ['id', 'time', 'UID', 'nickname', 'aiNeed', 'aiScore', 'aiReason', 'trigger', 'demand', 'videoDesc', 'homepage']);
      await page.locator('#page-leads .lead-field-settings summary').click();
      assert.deepEqual(await page.locator('#lead-field-options legend').allTextContents(), uiFieldSchema.groups.map(group => group.label));
      const extra = uiFieldSchema.fields.find(field => !field.defaultVisible);
      const beforeScope = await page.evaluate(() => taskScope());
      await page.locator(`[data-lead-field="${extra.key}"]`).check();
      assert.equal(await page.locator(`#lead-head th[data-field-key="${extra.key}"]`).count(), 1);
      await page.evaluate(() => refresh());
      await page.waitForFunction(key => document.querySelector(`#lead-field-options [data-lead-field="${key}"]`).checked, extra.key);
      assert.deepEqual(await page.evaluate(() => taskScope()), beforeScope);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('hm-lead-view-fields-v1'))), [extra.key]);
      await page.locator('#lead-fields-reset').click();
      assert.equal(await page.locator(`#lead-head th[data-field-key="${extra.key}"]`).count(), 0);

      const previousSchema = uiFieldSchema;
      uiFieldSchema = { ...uiFieldSchema, version: uiFieldSchema.version + 1, fields: [...uiFieldSchema.fields, { key: 'futureCommentField', label: '新增评论字段', group: 'comment', type: 'text', defaultVisible: false, width: 170 }] };
      sampleLeads[0].futureCommentField = '来自下一版数据字段';
      try {
        await page.evaluate(() => loadLeads());
        await page.locator('[data-lead-field="futureCommentField"]').check();
        assert.equal(await page.locator('#lead-head th[data-field-key="futureCommentField"]').textContent(), '新增评论字段');
        assert.equal(await page.locator('#lead-list td[data-field-key="futureCommentField"]').last().textContent(), '来自下一版数据字段');
      } finally {
        uiFieldSchema = previousSchema; delete sampleLeads[0].futureCommentField;
        await page.locator('#lead-fields-reset').click(); await page.evaluate(() => loadLeads());
        await page.locator('#page-leads .lead-field-settings summary').click();
      }
    });

    await t.test('pending status filter sends the same range used by tasks and stays separate from AI categories', async () => {
      await page.locator('#chip-status [data-s="dm_pending"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#lead-list .lead-select').length === 1);
      assert.deepEqual(await page.locator('#lead-list .lead-select').evaluateAll(elements => elements.map(element => element.dataset.leadId)), ['2']);
      const scope = await page.evaluate(() => taskScope());
      assert.equal(scope.filters.f, 'all');
      assert.equal(scope.filters.s, 'dm_pending');
      await page.locator('#chip-status [data-s=""]').click();
      await page.waitForFunction(() => document.querySelectorAll('#lead-list .lead-select').length === 3);
    });

    await t.test('homepage copy stays in the list and falls back to selectable full text without opening a browser', async () => {
      const before = requests.filter(request => /\/api\/leads\/\d+\/open$/.test(request.path)).length;
      const copy = page.locator('[data-copy-lead="1"][data-copy-field="homepage"]');
      try {
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__testCopied = text; } } }));
        await copy.click();
        assert.equal(await page.evaluate(() => window.__testCopied), sampleLeads[0].homepage);
        assert.equal(await copy.textContent(), '已复制');
        assert.equal(await page.locator('#field-detail-modal').isVisible(), false);
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('isolated clipboard unavailable'); } } }));
        await copy.click();
        assert.equal(await page.locator('#field-detail-content').textContent(), sampleLeads[0].homepage);
        assert.equal(await page.locator('#lead-detail-actions').isVisible(), false, 'copy fallback does not expose unrelated lead actions');
        assert.equal(requests.filter(request => /\/api\/leads\/\d+\/open$/.test(request.path)).length, before);
      } finally {
        if (await page.locator('#field-detail-modal').isVisible()) await page.locator('#field-detail-close').click();
        await page.evaluate(() => { delete navigator.clipboard; delete window.__testCopied; });
      }
    });

    await t.test('AI tabs classify current, missing and stale results and expose accessible facet counts', async () => {
      const expected = { all: ['3', '2', '1'], ai_todo: ['3'], ai_yes: ['1'], ai_no: [], ai_stale: ['2'] };
      for (const [category, ids] of Object.entries(expected)) {
        await page.locator(`#chip-filters [data-f="${category}"]`).click();
        await page.waitForFunction(expectedIds => JSON.stringify([...document.querySelectorAll('#lead-list .lead-select')].map(input => input.dataset.leadId)) === JSON.stringify(expectedIds), ids);
        assert.equal(await page.locator(`#chip-filters [data-f="${category}"]`).getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator(`#chip-filters [data-ai-count="${category}"]`).textContent(), String(ids.length));
        assert.equal((await page.evaluate(() => taskScope())).filters.f, category);
        assert.equal((await page.evaluate(() => taskScope())).filters.contact, 'all');
      }
      await page.locator('#chip-filters [data-f="all"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#lead-list .lead-select').length === 3);
    });

    await t.test('contact column sorts actual contact categories in both directions and retains order after refresh', async () => {
      const originals = sampleLeads.map(lead => ({ ...lead }));
      const previousSort = await page.evaluate(() => ({ ...leadSort }));
      const rowIds = () => page.locator('#lead-list .lead-select').evaluateAll(inputs => inputs.map(input => input.dataset.leadId));
      try {
        sampleLeads[0].dmState = 'confirmed_success'; sampleLeads[0].status = 'dm_sent';
        sampleLeads[2].dmState = 'confirmed_failure'; sampleLeads[2].status = 'dm_failed';
        await page.evaluate(() => loadLeads());
        await page.locator('#lead-head [data-k="contact"]').click();
        assert.deepEqual(await rowIds(), ['1', '2', '3'], 'sent, pending and failed use their real category rather than an empty field');
        assert.equal(await page.locator('#lead-head [data-k="contact"]').getAttribute('aria-sort'), 'descending');
        await page.locator('#lead-head [data-k="contact"]').press('Enter');
        assert.deepEqual(await rowIds(), ['3', '2', '1']);
        assert.equal(await page.locator('#lead-head [data-k="contact"]').getAttribute('aria-sort'), 'ascending');
        await page.evaluate(() => loadLeads());
        assert.deepEqual(await rowIds(), ['3', '2', '1'], 'polling preserves the chosen contact sort');
      } finally {
        for (let index = 0; index < sampleLeads.length; index++) { Object.keys(sampleLeads[index]).forEach(key => delete sampleLeads[index][key]); Object.assign(sampleLeads[index], originals[index]); }
        await page.evaluate(sort => { leadSort = sort; return loadLeads(); }, previousSort);
      }
    });

    await t.test('lead detail retains complete follow and message failure reasons as safe text', async () => {
      const lead = sampleLeads[2], original = { ...lead };
      const followReason = '关注控件未出现，确认未点击。\n请核对该账号的浏览器页面。';
      const dmReason = '平台未接受本次消息。\n' + '保留完整诊断说明。'.repeat(60) + '\n<img src=x onerror="window.__injected=1">\n诊断末尾原文';
      try {
        Object.assign(lead, { followState: 'confirmed_failure', dmState: 'confirmed_failure', followFailedReason: followReason, dmFailedReason: dmReason, status: 'dm_failed' });
        await page.evaluate(() => loadLeads()); await openLeadDetail(3);
        const text = await page.locator('#field-detail-content').textContent();
        assert.ok(text.includes('关注失败原因：' + followReason));
        assert.ok(text.includes('私信失败原因：' + dmReason));
        assert.equal(await page.locator('#field-detail-content img').count(), 0);
        assert.equal(await page.evaluate(() => window.__injected), undefined);
        assertReadable(await readability(page), '完整失败原因详情');
        await page.screenshot({ path: path.join(screenshotDir, 'failure-reasons-detail-1440.png'), fullPage: true });
      } finally {
        if (await page.locator('#field-detail-modal').isVisible()) await page.locator('#field-detail-close').click();
        Object.keys(lead).forEach(key => delete lead[key]); Object.assign(lead, original);
        await page.evaluate(() => loadLeads());
      }
    });

    await t.test('comment age and status filters combine and preserve their exact range for task precheck', async () => {
      const original = sampleLeads.map(lead => ({ ...lead }));
      const nowSeconds = Math.floor(Date.now() / 1000);
      try {
        [0.5, 2, 6].forEach((days, index) => { sampleLeads[index].commentTimestamp = nowSeconds - days * 86400; });
        for (const [days, ids] of [['1', ['1']], ['3', ['2', '1']], ['7', ['3', '2', '1']]]) {
          await page.locator('#lead-comment-days').selectOption(days);
          await page.waitForFunction(expectedIds => JSON.stringify([...document.querySelectorAll('#lead-list .lead-select')].map(input => input.dataset.leadId)) === JSON.stringify(expectedIds), ids);
          assert.equal(requests.filter(request => request.path === '/api/leads').at(-1).query.commentDays, days);
        }
        await page.locator('#lead-comment-days').selectOption('3');
        await page.locator('#chip-status [data-s="new"]').click();
        await page.waitForFunction(() => [...document.querySelectorAll('#lead-list .lead-select')].map(input => input.dataset.leadId).join() === '1');
        const scope = await page.evaluate(() => taskScope());
        assert.equal(Number(scope.filters.commentDays), 3); assert.equal(scope.filters.s, 'new');
        await page.locator('#btn-outreach-start').click(); await page.waitForSelector('#precheck-modal:not(.hidden)');
        assert.equal(Number(requests.filter(request => request.path === '/api/outreach/preview').at(-1).body.filters.commentDays), 3);
        assert.equal(requests.filter(request => request.path === '/api/outreach/preview').at(-1).body.filters.s, 'new');
        await page.locator('#pc-cancel').click();
      } finally {
        for (let index = 0; index < sampleLeads.length; index++) { Object.keys(sampleLeads[index]).forEach(key => delete sampleLeads[index][key]); Object.assign(sampleLeads[index], original[index]); }
        await page.locator('#lead-comment-days').selectOption('0'); await page.locator('#chip-status [data-s=""]').click();
        await page.evaluate(() => loadLeads());
      }
    });

    await t.test('Excel exports use authenticated POST with explicit filtered, selected and all scopes', async () => {
      await page.locator('.lead-select[data-lead-id="2"]').check();
      await page.locator('#chip-status [data-s="new"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#lead-list .lead-select').length === 2);
      try {
        for (const scope of ['filters', 'selected', 'all']) {
          await page.locator('#lead-export-scope').selectOption(scope);
          const downloadPromise = page.waitForEvent('download');
          await page.locator('#btn-export').click();
          const download = await downloadPromise;
          const exported = requests.filter(request => request.path === '/api/export').at(-1);
          assert.equal(exported.method, 'POST'); assert.equal(exported.token, 'fake-known-session');
          assert.deepEqual(exported.query, {}, 'export range and auth must not leak into a GET URL');
          assert.equal(exported.body.scope, scope);
          if (scope === 'filters') { assert.equal(exported.body.filters.s, 'new'); assert.equal(exported.body.filters.f, 'all'); assert.equal(exported.body.leadIds, undefined); }
          if (scope === 'selected') assert.deepEqual(exported.body.leadIds, ['2'], 'selected export retains a checked record hidden by the current filter');
          if (scope === 'all') assert.equal(exported.body.leadIds, undefined, 'full export must not carry an implicit selected subset');
          await download.cancel();
        }
        await page.locator('#btn-clear-selection').click(); await page.locator('#lead-export-scope').selectOption('selected');
        const before = requests.filter(request => request.path === '/api/export').length;
        await page.locator('#btn-export').click(); await page.waitForTimeout(30);
        assert.equal(requests.filter(request => request.path === '/api/export').length, before, 'an empty selection never exports the full library');
      } finally {
        await page.locator('#lead-export-scope').selectOption('filters'); await page.locator('#chip-status [data-s=""]').click();
        await page.locator('#btn-clear-selection').click(); await page.evaluate(() => loadLeads());
      }
    });

    await t.test('checked IDs drive the execution scope and survive filter changes', async () => {
      await page.locator('.lead-select[data-lead-id="1"]').check();
      await page.locator('#chip-status [data-s="replied"]').click();
      await page.waitForFunction(() => document.getElementById('selection-count').textContent.includes('1'));
      await page.locator('#btn-ai-start').click();
      const request = requests.filter(r => r.path === '/api/ai/start').at(-1);
      assert.deepEqual(request.body, { filters: { f: 'all', s: '', q: '' }, leadIds: ['1'] });
      await page.locator('#chip-status [data-s=""]').click(); await page.waitForSelector('.lead-select[data-lead-id="1"]');
      await page.locator('#btn-clear-selection').click();
    });

    await t.test('AI submission gives immediate in-page feedback, prevents duplicate starts and exposes progress, errors and stop', async () => {
      let release;
      aiStartGate = new Promise(resolve => { release = resolve; });
      const before = requests.filter(r => r.path === '/api/ai/start').length;
      try {
        await page.locator('#ai-force-rejudge').check();
        assert.match(await page.locator('#ai-pending').textContent(), /重新判断当前筛选范围/);
        await page.locator('#btn-ai-start').click();
        await page.waitForFunction(() => document.getElementById('ai-task-status').textContent.includes('正在提交'));
        assert.equal(await page.locator('#btn-ai-start').isDisabled(), true);
        assert.equal(await page.locator('#ai-force-rejudge').isDisabled(), true);
        assert.equal(await page.locator('#btn-task-stop2').isEnabled(), true);
        await page.evaluate(() => document.getElementById('btn-ai-start').click());
        await page.waitForTimeout(30);
        assert.equal(requests.filter(r => r.path === '/api/ai/start').length, before + 1);
        assert.equal(requests.filter(r => r.path === '/api/ai/start').at(-1).body.force, true);
        release(); aiStartGate = null;
        await page.waitForFunction(() => !document.getElementById('btn-ai-start').disabled);
        assert.match(await page.locator('#ai-task-status').textContent(), /已提交/);
        assert.equal(await page.locator('#ai-force-rejudge').isChecked(), false);
        uiTask = { kind:'ai',running:true,status:'正在判断第1批',done:4,total:12,detail:'是 2｜否 2' };
        await page.evaluate(() => refresh());
        assert.match(await page.locator('#ai-task-status').textContent(), /正在判断第1批.*4\/12/s);
        assert.equal(await page.locator('#btn-ai-start').isDisabled(),true);
        uiTask = { ...uiTask,running:false,status:'AI 判断完成',done:12 };
        await page.evaluate(() => refresh());
        assert.equal(await page.locator('#btn-ai-start').isEnabled(),true);
        aiStartError = '测试余额不足，请检查API账户';
        await page.locator('#btn-ai-start').click();
        await page.waitForFunction(() => document.getElementById('ai-task-status').textContent.includes('余额不足'));
        assert.equal(requests.filter(r => r.path === '/api/ai/start').at(-1).body.force, undefined);
        assert.equal(await page.locator('#btn-task-stop2').isEnabled(),true);
      } finally {
        release(); aiStartGate=null; aiStartError=''; uiTask={running:false,status:'测试空闲'};
        await page.evaluate(() => refresh());
      }
    });

    await t.test('preview uses current filter but confirmation uses the captured account and plan only', async () => {
      await page.locator('#lead-q').fill('申诉');
      await page.locator('#btn-outreach-start').click(); await page.waitForSelector('#precheck-modal:not(.hidden)');
      assert.match(await page.locator('#pc-summary').textContent(), /今日剩余尝试额度：关注 10.*私信 20.*主页访问 30/);
      assert.match(await page.locator('#pc-summary').textContent(), /预检查不占用额度/);
      assert.match(await page.locator('#pc-list').textContent(), /本用户操作：关注、私信/);
      const preview = requests.filter(r => r.path === '/api/outreach/preview').at(-1);
      assert.equal(preview.body.filters.q, '申诉');
      const expectedPlan = [...plans.values()].at(-1);
      await page.evaluate(() => { document.getElementById('act-account').value = '2'; document.getElementById('lead-q').value = '改变筛选'; leadFilter.q = '改变筛选'; });
      await page.locator('#pc-confirm').click();
      const request = requests.filter(r => r.path === '/api/outreach/start').at(-1);
      assert.deepEqual(request.body, { accountId: expectedPlan.accountId, planId: expectedPlan.planId });
      assert.equal(request.body.accountId, '1');
      await page.locator('#nav a[data-page="leads"]').click();
      await page.locator('#lead-q').fill(''); await page.locator('#act-account').selectOption('1');
      await page.waitForSelector('.lead-select[data-lead-id="2"]');
    });

    await t.test('outreach submission gives immediate feedback, submits once and keeps global stop available', async () => {
      const original = structuredClone(uiTask);
      let releaseStart;
      outreachStartGate = new Promise(resolve => { releaseStart = resolve; });
      nextOutreachTask = { kind: 'outreach', running: true, status: '工作时间外，队列暂停等待下一工作时段', done: 0, total: 3 };
      await page.locator('#lead-q').fill(''); await page.locator('#act-account').selectOption('1');
      await page.locator('#btn-outreach-start').click(); await page.waitForSelector('#precheck-modal:not(.hidden)');
      const startsBefore = requests.filter(request => request.path === '/api/outreach/start').length;
      const stopBefore = requests.filter(request => request.path === '/api/tasks/stop').length;
      await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/outreach/start')), page.locator('#pc-confirm').click()]);
      try {
        await page.evaluate(() => {
          window.__qaOriginalScrollIntoView = Element.prototype.scrollIntoView;
          window.__qaProgressScrollCalls = 0;
          Element.prototype.scrollIntoView = function (...args) {
            if (this.id === 'act-status') window.__qaProgressScrollCalls++;
            return window.__qaOriginalScrollIntoView.apply(this, args);
          };
        });
        assert.match(await page.locator('#pc-feedback').textContent(), /正在提交固定名单并启动任务/);
        assert.equal(await page.locator('#pc-confirm').isDisabled(), true);
        assert.equal(await page.locator('#pc-cancel').isDisabled(), true);
        assert.equal(await page.locator('#btn-global-stop').isEnabled(), true);
        await page.evaluate(() => document.getElementById('pc-confirm').dispatchEvent(new MouseEvent('click', { bubbles: true })));
        assert.equal(requests.filter(request => request.path === '/api/outreach/start').length, startsBefore + 1);
        await page.locator('#btn-global-stop').click();
        await page.waitForFunction(() => !document.getElementById('btn-global-stop').disabled);
        assert.equal(requests.filter(request => request.path === '/api/tasks/stop').length, stopBefore + 1);
        releaseStart(); outreachStartGate = null;
        await page.waitForSelector('#precheck-modal.hidden', { state: 'attached' });
        await page.waitForFunction(() => !document.getElementById('page-leads').classList.contains('hidden') && document.getElementById('act-status').textContent.includes('工作时间外'));
        await page.waitForFunction(() => { const rect = document.getElementById('act-status').getBoundingClientRect(); return rect.top < innerHeight && rect.bottom > 0; });
        assert.equal(await page.locator('#action-feedback').isVisible(), false, 'real task progress replaces the submitted notice');
        uiTask = { ...uiTask, status: '操作间隔等待中，可随时停止（剩余 60 秒）' };
        await page.evaluate(() => refresh());
        assert.match(await page.locator('#act-status').textContent(), /剩余 60 秒/);
        assert.equal(await page.evaluate(() => window.__qaProgressScrollCalls), 1, 'confirmation must scroll the real progress into view once');
        // Cancel the previous smooth animation as an explicit user scroll.
        // Browser scroll anchoring may move a few pixels after DOM refresh;
        // verify the application does not request another progress scroll.
        await page.evaluate(() => new Promise(resolve => {
          let last = -1, stable = 0;
          const tick = () => {
            const y = window.scrollY;
            stable = y === last ? stable + 1 : 0;
            last = y;
            if (stable >= 5) resolve(); else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }));
        await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
        await page.waitForFunction(() => scrollY === 0, null, { timeout: 5000 });
        assert.equal(await page.evaluate(() => scrollY), 0, '显式回到顶部后不应被动画拉回');
        await page.evaluate(() => refresh());
        assert.equal(await page.evaluate(() => window.__qaProgressScrollCalls), 1, 'polling must not scroll the user back to progress');
      } finally {
        await page.evaluate(() => {
          if (window.__qaOriginalScrollIntoView) Element.prototype.scrollIntoView = window.__qaOriginalScrollIntoView;
          delete window.__qaOriginalScrollIntoView; delete window.__qaProgressScrollCalls;
        });
        releaseStart(); outreachStartGate = null; nextOutreachTask = null; uiTask = original;
        await page.evaluate(() => refresh()); await page.locator('#nav a[data-page="leads"]').click();
      }
    });

    await t.test('a rejected outreach start remains visible in the modal and permits a new precheck', async () => {
      outreachStartError = '已有任务在运行，请停止并等待结束';
      await page.locator('#btn-outreach-start').click(); await page.waitForSelector('#precheck-modal:not(.hidden)');
      const dialogsBefore = dialogs.length;
      try {
        await page.locator('#pc-confirm').click();
        await page.waitForFunction(() => document.getElementById('pc-feedback').textContent.includes('已有任务在运行'));
        assert.equal(await page.locator('#precheck-modal').isVisible(), true);
        assert.equal(await page.locator('#pc-confirm').isEnabled(), true);
        assert.equal(await page.locator('#pc-cancel').isEnabled(), true);
        assert.equal(await page.locator('#btn-global-stop').isEnabled(), true);
        assert.equal(dialogs.length, dialogsBefore, 'the error is shown in place, without duplicate alerts');
        assert.match(await page.locator('#pc-feedback').textContent(), /启动请求未完成.*重新预检查/);
        await page.locator('#pc-cancel').click();
      } finally { outreachStartError = ''; }
    });

    await t.test('outreach state read errors show uncertainty and recovery exposes the real asynchronous pause', async () => {
      const original = structuredClone(uiTask);
      await page.locator('#nav a[data-page="leads"]').click();
      await page.waitForFunction(() => !refreshBusy);
      uiTask = { kind: 'outreach', running: true, status: '处理 1/3：测试用户', done: 0, total: 3 };
      await page.evaluate(() => refresh());
      await page.waitForFunction(() => document.getElementById('act-status').textContent.includes('处理 1/3'));
      try {
        stateReadError = true;
        await page.evaluate(() => refresh());
        await page.waitForFunction(() => document.getElementById('act-status').textContent.includes('无法读取本机任务状态'));
        const text = await page.locator('#act-status').textContent();
        assert.match(text, /无法读取本机任务状态.*测试本机连接中断.*执行结果尚未确认.*自动重试/);
        assert.match(text, /最后已知状态：处理 1\/3/);
        assert.doesNotMatch(text, /任务已失败|发送失败|任务已停止/);
        assert.equal(await page.locator('#btn-global-stop').isEnabled(), true);
        stateReadError = false;
        uiTask = { ...uiTask, running: false, status: '任务已暂停：账号页面仍在加载，请检查网络' };
        await page.evaluate(() => refresh());
        await page.waitForFunction(() => document.getElementById('act-status').textContent.includes('任务已暂停'));
        assert.match(await page.locator('#act-status').textContent(), /任务已暂停：账号页面仍在加载/);
        assert.doesNotMatch(await page.locator('#act-status').textContent(), /无法读取|最后已知/);
      } finally {
        stateReadError = false; uiTask = original; await page.evaluate(() => refresh());
        await page.locator('#nav a[data-page="leads"]').click();
      }
    });

    await t.test('pending resolution, contact status, manual approval and profile visit use scoped endpoints', async () => {
      await openLeadDetail(2);
      assert.equal(await page.locator('#lead-detail-actions [data-lead-id="2"][data-lead-action="manual_approved"]').count(), 0);
      await page.locator('#lead-detail-actions [data-lead-id="2"][data-lead-action="dm-success"]').click();
      await page.locator('#verification-note').fill('已核对本次发送回执');
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/leads/2/resolve')), page.locator('#verification-confirm').click()]);
      assert.deepEqual(requests.filter(r => r.path === '/api/leads/2/resolve').at(-1).body, { kind: 'dm', outcome: 'success', note: '已核对本次发送回执' });
      await openLeadDetail(3);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/leads/3/status')), page.locator('[data-lead-id="3"][data-lead-action="manual_approved"]').click()]);
      assert.deepEqual(requests.filter(r => r.path === '/api/leads/3/status').at(-1).body, { status: 'manual_approved' });
      await openLeadDetail(1);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/leads/1/open')), page.locator('[data-lead-id="1"][data-lead-action="open"]').click()]);
      assert.deepEqual(requests.filter(r => r.path === '/api/leads/1/open').at(-1).body, { accountId: '1' });
      await openLeadDetail(1);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/leads/1/status')), page.locator('[data-lead-id="1"][data-lead-action="do_not_contact"]').click()]);
      assert.deepEqual(requests.filter(r => r.path === '/api/leads/1/status').at(-1).body, { status: 'do_not_contact' });
      if (await page.locator('#field-detail-modal').isVisible()) await page.locator('#field-detail-close').click();
    });

    await t.test('fresh AI defaults expose four business fields, three presets and one explicit active selection', async () => {
      await page.locator('#nav a[data-page="settings"]').click(); await page.waitForFunction(() => !pageDirty);
      assert.equal(await page.locator('#s-ai-key').inputValue(), '');
      assert.equal(await page.locator('#s-ai-model').inputValue(), 'deepseek-flash');
      assert.match(await page.locator('#s-ai-biz').inputValue(), /亚马逊/);
      assert.equal(await page.locator('#prompt-slots input[type="radio"]').count(), 3);
      assert.equal(await page.locator('#prompt-slots input:checked').inputValue(), 'prompt-1');
      await page.locator('[data-prompt-edit="prompt-2"]').click();
      assert.equal(await page.locator('#s-ai-prompt').inputValue(), '');
      await page.locator('[data-prompt-edit="prompt-3"]').click();
      assert.equal(await page.locator('#s-ai-prompt').inputValue(), '');
      await page.locator('[data-prompt-edit="prompt-1"]').click();
      assert.match(await page.locator('#page-settings').textContent(), /用户评论.*评论时间.*用户UID.*用户名称.*所在视频描述/s);
      assert.equal(await page.locator('#page-settings #s-hu-periods').count(), 0);
    });

    await t.test('a delayed generation stays with its original preset and preserves intervening edits', async () => {
      const activeBefore = config.ai.activePromptId;
      let releaseDraft;
      draftGate = new Promise(resolve => { releaseDraft = resolve; });
      await page.locator('[data-prompt-edit="prompt-2"]').click();
      await page.locator('#s-ai-prompt').fill('生成前规则');
      await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/ai/prompt-draft')), page.locator('#btn-ai-draft').click()]);
      await page.locator('[data-prompt-edit="prompt-3"]').click();
      await page.locator('#s-ai-prompt').fill('切换后的第三版编辑');
      releaseDraft(); draftGate = null;
      await page.waitForFunction(() => !document.getElementById('btn-ai-draft').disabled);
      assert.equal(await page.locator('#s-ai-prompt').inputValue(), '切换后的第三版编辑');
      await page.locator('[data-prompt-edit="prompt-2"]').click(); assert.match(await page.locator('#s-ai-prompt').inputValue(), /家装/);
      draftGate = new Promise(resolve => { releaseDraft = resolve; });
      await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/ai/prompt-draft')), page.locator('#btn-ai-draft').click()]);
      await page.locator('#s-ai-prompt').fill('生成期间手工修改，必须保留');
      releaseDraft(); draftGate = null;
      await page.waitForSelector('#ai-generated-draft-panel:not(.hidden)');
      assert.equal(await page.locator('#s-ai-prompt').inputValue(), '生成期间手工修改，必须保留');
      assert.equal(config.ai.activePromptId, activeBefore);
      await page.locator('#btn-ai-generated-apply').click(); assert.match(await page.locator('#s-ai-prompt').inputValue(), /家装/);
      assert.equal(config.ai.activePromptId, activeBefore);
    });

    await t.test('AI generation edits the chosen preset without enabling it; three drafts and active choice survive saves', async () => {
      const oldPrompt = config.ai.prompt;
      await page.locator('[data-prompt-edit="prompt-2"]').click();
      await page.locator('#s-ai-prompt-name').fill('装修客户');
      await page.locator('#s-ai-biz').fill('家装方案咨询'); await page.locator('#s-ai-target').fill('装修业主');
      await page.locator('#s-ai-needs').fill('咨询装修方案'); await page.locator('#s-ai-misjudgments').fill('围观和同行广告');
      await page.locator('#btn-ai-draft').click(); await page.waitForFunction(() => document.getElementById('s-ai-prompt').value.includes('家装'));
      assert.equal(config.ai.prompt, oldPrompt);
      assert.equal(await page.locator('#prompt-slots input:checked').inputValue(), 'prompt-1');
      assert.deepEqual(requests.filter(r => r.path === '/api/ai/prompt-draft').at(-1).body.businessInput, { businessDesc: '家装方案咨询', targetCustomers: '装修业主', clearNeeds: '咨询装修方案', misjudgments: '围观和同行广告' });
      await page.locator('.prompt-draft-panel summary').click();
      await page.locator('#s-ai-samples').fill('装修怎么规划\n只是看看'); await page.locator('#btn-ai-test').click(); await page.waitForSelector('.sample-result');
      assert.equal(config.ai.prompt, oldPrompt);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-settings').click()]);
      assert.equal(config.ai.prompt, oldPrompt); assert.match(config.ai.promptPresets[1].prompt, /家装/);
      await page.locator('[data-prompt-edit="prompt-3"]').click(); await page.locator('#s-ai-prompt').fill('第三版测试规则');
      await page.locator('#s-ai-prompt-name').fill('测试规则三');
      await page.locator('[data-prompt-edit="prompt-1"]').click(); assert.equal(await page.locator('#s-ai-prompt').inputValue(), oldPrompt);
      await page.locator('[data-prompt-edit="prompt-2"]').click(); assert.match(await page.locator('#s-ai-prompt').inputValue(), /家装/);
      await page.locator('input[name="active-prompt"][value="prompt-3"]').check();
      assert.equal(config.ai.activePromptId, 'prompt-1');
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-settings').click()]);
      assert.equal(config.ai.activePromptId, 'prompt-3'); assert.equal(config.ai.prompt, '第三版测试规则');
      const saved = requests.filter(r => r.path === '/api/settings').at(-1).body;
      assert.equal(Object.hasOwn(saved, 'license'), false);
      assert.equal(Object.hasOwn(saved, 'human'), false);
      assert.equal(Object.hasOwn(saved.ai, 'baseUrl'), false);
    });

    await t.test('model failures preserve selection; refreshed new candidates can be explicitly selected', async () => {
      modelsError = true;
      await page.locator('#s-ai-key').fill('sk-fake-ui-test');
      await page.locator('#btn-save-settings').click();
      await page.waitForFunction(() => document.getElementById('ai-model-msg').textContent.includes('刷新失败'));
      assert.equal(await page.locator('#s-ai-model').inputValue(), 'deepseek-flash');
      modelsError = false;
      await page.locator('#btn-ai-models').click(); await page.waitForFunction(() => document.getElementById('ai-model-msg').textContent.includes('已获取'));
      await page.locator('#s-ai-model').selectOption('deepseek-pro-test');
      await page.locator('#btn-ai-models').click(); await page.waitForFunction(() => document.getElementById('ai-model-msg').textContent.includes('已获取'));
      assert.equal(await page.locator('#s-ai-model').inputValue(), 'deepseek-pro-test');
      modelCandidates = [{ id: 'deepseek-new-test', name: '测试最新模型', contextWindow: 128000, maxOutputTokens: 16000 }];
      await page.locator('#btn-ai-models').click(); await page.waitForFunction(() => document.getElementById('ai-model-msg').textContent.includes('不在官方列表'));
      assert.equal(await page.locator('#s-ai-model').inputValue(), 'deepseek-pro-test');
      await page.locator('#s-ai-model').selectOption('deepseek-new-test');
      assert.doesNotMatch(await page.locator('#ai-model-msg').textContent(), /不在官方列表/);
      assert.equal(await page.locator('#ai-model-msg').evaluate(element => element.classList.contains('model-error')), false);
      assert.match(await page.locator('#ai-model-msg').textContent(), /上下文 128.?000 token.*最大输出 16.?000 token/);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-settings').click()]);
      assert.equal(config.ai.model, 'deepseek-new-test');
      await page.locator('#s-ai-model').selectOption('');
      const [emptyModelDialog] = await Promise.all([page.waitForEvent('dialog'), page.locator('#btn-save-settings').click()]);
      assert.match(emptyModelDialog.message(), /请选择 DeepSeek 模型/);
      assert.equal(config.ai.model, 'deepseek-new-test');
      await page.locator('#s-ai-model').selectOption('deepseek-new-test');
    });

    await t.test('automatic AI batching retains custom manual budgets, preserves the rest and requires an explicit save', async () => {
      config.ai.batchMode = 'manual'; config.ai.batchMaxChars = 3210; config.ai.batchMaxCount = 7;
      const details = page.locator('#s-ai-bchars').locator('xpath=ancestor::details');
      if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
      await page.locator('#s-ai-batch-mode').selectOption('manual');
      assert.equal(await page.locator('#s-ai-bchars').isEnabled(), true); assert.equal(await page.locator('#s-ai-bcount').isEnabled(), true);
      await page.locator('#s-ai-bchars').fill('60000');
      assert.equal(await page.locator('#s-ai-bchars').evaluate(element => element.checkValidity()), true);
      await page.locator('#s-ai-bchars').fill('60001');
      assert.equal(await page.locator('#s-ai-bchars').evaluate(element => element.checkValidity()), false);
      await page.locator('#s-ai-bchars').fill('3210'); await page.locator('#s-ai-bcount').fill('7');
      const preserved = await page.evaluate(() => ({ key: document.getElementById('s-ai-key').value, model: document.getElementById('s-ai-model').value,
        presets: JSON.stringify(promptPresets), active: activePromptId, editing: editingPromptId, prompt: document.getElementById('s-ai-prompt').value,
        business: businessInput(), timeout: document.getElementById('s-ai-timeout').value }));
      assert.ok(preserved.key, 'the mock key is nonempty so accidental clearing would be detected');
      const stored = structuredClone(config.ai), savesBefore = requests.filter(request => request.path === '/api/settings').length;
      await page.locator('#btn-ai-batch-recommended').click();
      assert.equal(await page.locator('#s-ai-batch-mode').inputValue(), 'auto');
      assert.equal(await page.locator('#s-ai-bchars').inputValue(), '3210'); assert.equal(await page.locator('#s-ai-bcount').inputValue(), '7');
      assert.equal(await page.locator('#s-ai-bchars').isDisabled(), true); assert.equal(await page.locator('#s-ai-bcount').isDisabled(), true);
      assert.match(await page.locator('#ai-batch-msg').textContent(), /75%/);
      assert.match(await page.locator('#ai-batch-msg').textContent(), /保存设置.*生效/);
      assert.deepEqual(config.ai, stored); assert.equal(requests.filter(request => request.path === '/api/settings').length, savesBefore);
      assert.deepEqual(await page.evaluate(() => ({ key: document.getElementById('s-ai-key').value, model: document.getElementById('s-ai-model').value,
        presets: JSON.stringify(promptPresets), active: activePromptId, editing: editingPromptId, prompt: document.getElementById('s-ai-prompt').value,
        business: businessInput(), timeout: document.getElementById('s-ai-timeout').value })), preserved);
      await page.evaluate(() => refresh());
      assert.equal(await page.locator('#s-ai-batch-mode').inputValue(), 'auto', 'polling must keep the unsaved mode selection');
      assert.equal(await page.locator('#s-ai-bchars').inputValue(), '3210', 'auto mode must retain the original manual budget');
      assert.equal(requests.filter(request => request.path === '/api/settings').length, savesBefore);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-settings').click()]);
      const saved = requests.filter(request => request.path === '/api/settings').at(-1).body.ai;
      assert.equal(saved.batchMode, 'auto'); assert.equal(saved.batchMaxChars, 3210); assert.equal(saved.batchMaxCount, 7);
      assert.equal(saved.apiKey, preserved.key); assert.equal(saved.model, preserved.model);
      assert.equal(saved.activePromptId, preserved.active); assert.deepEqual(saved.promptPresets, JSON.parse(preserved.presets));
      assert.deepEqual({ businessDesc: saved.businessDesc, targetCustomers: saved.targetCustomers, clearNeeds: saved.clearNeeds, misjudgments: saved.misjudgments }, preserved.business);
      assert.equal(config.ai.batchMode, 'auto'); assert.equal(config.ai.batchMaxChars, 3210); assert.equal(config.ai.batchMaxCount, 7);
      await page.setViewportSize({ width: 1360, height: 880 }); await page.evaluate(() => window.scrollTo(0, 0));
      assertReadable(await readability(page), '新版AI设置');
      await page.screenshot({ path: path.join(screenshotDir, 'ai-settings-auto-batch-1360.png'), fullPage: true });
    });

    await t.test('manual batch mode enables the retained budget controls without automatically saving', async () => {
      const savesBefore = requests.filter(request => request.path === '/api/settings').length;
      await page.locator('#s-ai-batch-mode').selectOption('manual');
      assert.equal(await page.locator('#s-ai-bchars').isEnabled(), true); assert.equal(await page.locator('#s-ai-bcount').isEnabled(), true);
      assert.equal(await page.locator('#s-ai-bchars').inputValue(), '3210'); assert.equal(await page.locator('#s-ai-bcount').inputValue(), '7');
      assert.equal(config.ai.batchMode, 'auto'); assert.equal(requests.filter(request => request.path === '/api/settings').length, savesBefore);
      await page.locator('#s-ai-batch-mode').selectOption('auto');
      assert.equal(await page.locator('#s-ai-bchars').isDisabled(), true); assert.equal(await page.locator('#s-ai-bcount').isDisabled(), true);
      assert.equal(requests.filter(request => request.path === '/api/settings').length, savesBefore);
    });

    await t.test('prompt samples display binary decisions and short reasons without scores or changing the active rules', async () => {
      const prompt = config.ai.prompt, active = config.ai.activePromptId;
      await page.locator('#s-ai-samples').fill('需要咨询装修方案\n只是看看');
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/ai/prompt-test')), page.locator('#btn-ai-test').click()]);
      assert.deepEqual(await page.locator('#ai-test-results .sample-result b').allTextContents(), ['1. 是', '2. 否']);
      const reasons = await page.locator('#ai-test-results .sample-result .note').allTextContents();
      assert.equal(reasons.every(reason => Array.from(reason).length <= 30), true);
      assert.doesNotMatch(await page.locator('#ai-test-results').textContent(), /评分|分数|待确认|\d+\s*分/);
      assert.equal(config.ai.prompt, prompt); assert.equal(config.ai.activePromptId, active);
    });

    await t.test('three explicit pacing boundaries replace per-action pauses and save decimal seconds plus percentage jitter', async () => {
      await page.locator('#nav a[data-page="settings"]').click(); await page.waitForFunction(() => !pageDirty);
      assert.equal(await page.locator('#a-act-min, #a-act-max, #s-hu-periods, #s-hu-break, #s-hu-bmin, #s-hu-bmax, #s-ai-int, #s-ai-jit').count(), 0);
      await page.locator('#btn-pacing-defaults').click();
      assert.equal(await page.locator('#c-col-interval').inputValue(), '3'); assert.equal(await page.locator('#c-col-jitter').inputValue(), '40');
      assert.equal(await page.locator('#c-col-linkint').inputValue(), '10'); assert.equal(await page.locator('#c-col-linkjit').inputValue(), '20');
      assert.equal(await page.locator('#a-user-interval').inputValue(), '30'); assert.equal(await page.locator('#a-user-jitter').inputValue(), '40');
      assert.equal(await page.locator('#a-dm-pause-count').inputValue(), '5'); assert.equal(await page.locator('#a-dm-pause-min').inputValue(), '60'); assert.equal(await page.locator('#a-dm-pause-max').inputValue(), '300');
      assert.equal(await page.locator('#s-search-interval').inputValue(), '60'); assert.equal(await page.locator('#s-search-jitter').inputValue(), '20'); assert.equal(await page.locator('#s-search-daily').inputValue(), '30');
      await page.locator('#s-hu-errors').fill('4');
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-pacing').click()]);
      const saved = requests.filter(r => r.path === '/api/settings').at(-1).body;
      assert.deepEqual(Object.keys(saved).sort(), ['action', 'collect', 'dm', 'human', 'search']);
      assert.deepEqual(saved.action, { userIntervalSec: 30, userIntervalJitter: .4, pacingVersion: 1 });
      assert.deepEqual(saved.collect, { scrollIntervalSec: 3, scrollJitter: .4, linkIntervalSec: 10, linkIntervalJitter: .2 });
      assert.deepEqual(saved.dm, { sessionPause: { count: 5, pauseMinSec: 60, pauseMaxSec: 300 } });
      assert.deepEqual(saved.search, { intervalSec: 60, intervalJitter: .2, dailySearchLimit: 30 });
      assert.deepEqual(saved.human, { maxConsecutiveErrors: 4, timeZone: 'Asia/Shanghai' });
      for (const invalid of ['', '-1', '3601']) {
        await page.locator('#a-user-interval').fill(invalid);
        const before = requests.filter(r => r.path === '/api/settings').length;
        await page.locator('#btn-save-pacing').click();
        await page.waitForFunction(() => document.getElementById('pacing-saved').textContent.startsWith('未保存'));
        assert.equal(requests.filter(r => r.path === '/api/settings').length, before);
      }
      await page.locator('#a-user-interval').fill('10');
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-pacing').click()]);
      await page.locator('#nav a[data-page="leads"]').click(); await page.waitForFunction(() => !pageDirty);
      assert.match(await page.locator('#action-pacing-summary').textContent(), /10 秒 ±40%.*6–14 秒/);
      await page.locator('#action-options summary').click();
      await page.locator('#a-fol-limit').fill('160'); await page.locator('#a-dm-limit').fill('80');
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-act').click()]);
      assert.deepEqual(Object.keys(requests.filter(r => r.path === '/api/settings').at(-1).body).sort(), ['dm', 'follow']);
      await page.screenshot({ path: path.join(screenshotDir, 'actions-1440.png'), fullPage: true });
    });

    await t.test('unsaved message is saved before frozen preview and a save failure never starts a plan', async () => {
      await page.locator('#a-dm-template').fill('您好，{昵称}，请问需要帮助吗？');
      assert.match(await page.locator('#btn-outreach-start').textContent(), /保存配置并预检查/);
      const before = requests.length;
      await page.locator('#btn-outreach-start').click(); await page.waitForSelector('#precheck-modal:not(.hidden)');
      const pathList = requests.slice(before).map(r => r.path);
      assert.ok(pathList.indexOf('/api/settings') >= 0 && pathList.indexOf('/api/settings') < pathList.indexOf('/api/outreach/preview'));
      assert.match(await page.locator('#pc-message-preview').textContent(), /您好，{昵称}，请问需要帮助吗/);
      assert.match(await page.locator('#pc-list').textContent(), /将发送：/);
      await page.keyboard.press('Escape');
      await page.locator('#a-dm-template').fill('尚未保存的新话术'); settingsSaveError = '已有任务运行，无法保存';
      const previews = requests.filter(r => r.path.endsWith('/preview')).length;
      try { await page.locator('#btn-outreach-start').click(); await page.waitForFunction(() => document.getElementById('action-feedback').textContent.includes('无法保存')); assert.equal(requests.filter(r => r.path.endsWith('/preview')).length, previews); assert.equal(await page.locator('#precheck-modal').isVisible(), false); }
      finally { settingsSaveError = ''; }
      await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/settings')), page.locator('#btn-save-act').click()]);
      await page.locator('#btn-task-stop2').click();
      assert.ok(requests.some(r => r.path === '/api/tasks/stop'));
    });

    await t.test('collection account choice, link editor and dirty settings remain usable after delegation', async () => {
      await page.locator('#nav a[data-page="collect"]').click(); await page.waitForFunction(() => !pageDirty);
      await page.locator('#col-account').selectOption('2'); await page.evaluate(() => refresh());
      assert.equal(await page.locator('#col-account').inputValue(), '2');
      await page.locator('.link-input').fill('https://www.douyin.com/video/123'); await page.locator('[data-link-force="0"]').check();
      await page.locator('#btn-link-add').click(); assert.equal(await page.locator('.link-input').count(), 2);
      await page.locator('[data-link-delete="1"]').click(); assert.equal(await page.locator('.link-input').count(), 1);
      await page.locator('#collect-options summary').click();
      await page.locator('#c-col-max').fill('111'); await page.evaluate(() => refresh());
      assert.equal(await page.locator('#c-col-max').inputValue(), '111');
    });

    await t.test('zero and decimal pacing are saved centrally and show the actual bounded wait', async () => {
      await page.locator('#nav a[data-page="settings"]').click(); await page.waitForFunction(() => !pageDirty);
      const original = { scrollIntervalSec: config.collect.scrollIntervalSec, linkIntervalSec: config.collect.linkIntervalSec };
      for (const values of [{ scroll: '0', link: '0' }, { scroll: '0.5', link: '1.5' }]) {
        await page.locator('#c-col-interval').fill(values.scroll); await page.locator('#c-col-linkint').fill(values.link);
        for (const selector of ['#c-col-interval', '#c-col-linkint']) { assert.equal(await page.locator(selector).getAttribute('min'), '0'); assert.equal(await page.locator(selector).evaluate(element => element.checkValidity()), true); }
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-pacing').click()]);
        const saved = requests.filter(request => request.path === '/api/settings').at(-1).body.collect;
        assert.equal(saved.scrollIntervalSec, Number(values.scroll)); assert.equal(saved.linkIntervalSec, Number(values.link));
      }
      assert.match(await page.locator('#pacing-settings').textContent(), /填 0 只取消额外间隔/);
      const rendered = await page.evaluate(() => { renderTask('col-status', { kind: 'collect', stage: 'waiting_comments', running: true, status: '等待下一页', waitingReason: '评论翻页间隔', waitingUntil: Date.now() + 3000, done: 2, total: 8 }); return document.getElementById('col-status').textContent; });
      assert.match(rendered, /评论翻页间隔.*剩余约 3 秒.*可随时停止/);
      await page.locator('#c-col-interval').fill(String(original.scrollIntervalSec)); await page.locator('#c-col-linkint').fill(String(original.linkIntervalSec));
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-pacing').click()]);
      await page.locator('#nav a[data-page="collect"]').click(); await page.waitForFunction(() => !pageDirty);
    });

    await t.test('collection sends invalid nonempty rows for explicit validation and labels partial history honestly', async () => {
      await page.locator('#btn-link-add').click();
      await page.locator('.link-input').nth(1).fill(' https://v.douyin.com/mock-short-link/ ');
      await page.locator('#btn-link-add').click(); // genuinely empty row is ignored
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/collect/start')), page.locator('#btn-collect-start').click()]);
      const request = requests.filter(r => r.path === '/api/collect/start').at(-1);
      assert.deepEqual(request.body.links, [
        { url: 'https://www.douyin.com/video/123', force: true },
        { url: 'https://v.douyin.com/mock-short-link/', force: false }
      ]);
      const rows = page.locator('#video-hist tr');
      assert.equal(await rows.nth(0).locator('td').count(), 5);
      assert.equal(await rows.nth(0).locator('td').nth(2).textContent(), '2 次');
      assert.equal(await rows.nth(1).locator('td').nth(2).textContent(), '3 次');
      assert.match(await rows.nth(1).locator('td').nth(1).textContent(), /2026-10-08.*11:00:00/);
      assert.match(await rows.nth(1).textContent(), /部分（可续采）.*达到翻页上限/s);
      assert.doesNotMatch(await rows.nth(1).textContent(), /800/);
    });

    await t.test('collection start saves edited rules once, shows immediate feedback and never falls through a failed save', async () => {
      await page.locator('#c-col-autoai').uncheck();
      let releaseStart; collectionStartGate = new Promise(resolve => { releaseStart = resolve; });
      const before = requests.length;
      try {
        await Promise.all([page.waitForRequest(r => r.url().endsWith('/api/collect/start')), page.locator('#btn-collect-start').click()]);
        assert.equal(await page.locator('#btn-collect-start').isDisabled(), true);
        assert.equal(await page.locator('#btn-global-stop').isDisabled(), false);
        assert.match(await page.locator('#collect-feedback').textContent(), /正在保存采集配置|正在提交/);
        const calls = requests.slice(before); assert.equal(calls.filter(r => r.path === '/api/collect/start').length, 1);
        assert.ok(calls.findIndex(r => r.path === '/api/settings') < calls.findIndex(r => r.path === '/api/collect/start'));
        assert.equal(calls.find(r => r.path === '/api/settings').body.collect.autoAiAfterCollect, false);
      } finally { releaseStart(); collectionStartGate = null; }
      await page.waitForFunction(() => !collectSubmitBusy);
      await page.locator('#c-col-autoai').check(); settingsSaveError = '采集配置未保存';
      const starts = requests.filter(r => r.path === '/api/collect/start').length;
      try { await page.locator('#btn-collect-start').click(); await page.waitForFunction(() => document.getElementById('collect-feedback').textContent.includes('采集配置未保存')); assert.equal(requests.filter(r => r.path === '/api/collect/start').length, starts); }
      finally { settingsSaveError = ''; }
      await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/settings')), page.locator('#btn-save-col').click()]);
    });

    await t.test('collection completion retains run scope through filters and precheck and distinguishes blocked AI from failed collection', async () => {
      const original = uiTask;
      sampleLeads[0].collectionRunId = 'run-test'; sampleLeads[2].collectionRunId = 'run-test';
      uiTask = { kind: 'collect', running: false, status: '采集已完成，AI 配置需要处理', stage: 'ai_paused', collectionSummary: { runId: 'run-test', accountId: '1', processed: 2, completed: 1, partial: 1, newLeads: 2, commentLeadCount: 2, status: 'completed', aiStatus: 'blocked', aiMessage: '请先配置 API Key' } };
      try {
        await page.evaluate(() => refresh()); await page.waitForSelector('#collection-next:not(.hidden)');
        assert.match(await page.locator('#collection-summary').textContent(), /采集完成.*需要处理 AI 配置.*请先配置 API Key/s);
        assert.doesNotMatch(await page.locator('#collection-summary').textContent(), /采集异常/);
        Object.assign(uiTask.collectionSummary, { aiStatus: 'paused', aiPendingCount: 1, aiCounts: { yes: 1, no: 0, failed: 0, skipped: 1 }, aiMessage: '仍有一条没有当前有效判断' });
        await page.evaluate(() => refresh());
        assert.match(await page.locator('#collection-summary').textContent(), /评论记录\s*2.*判断暂停.*未完成 1/s);
        await page.locator('#btn-collection-leads').click(); await page.waitForFunction(() => !pageDirty);
        await page.waitForFunction(() => document.querySelectorAll('#lead-list tr[data-lead-id]').length === 2 || state.leads.length === 2);
        assert.match(await page.locator('#scope-display').textContent(), /当前筛选结果/);
        assert.equal(requests.filter(r => r.path === '/api/leads').at(-1).query.collectionRunId, 'run-test');
        await page.locator('#chip-filters [data-f="ai_todo"]').click();
        await page.locator('#btn-ai-start').click();
        await page.waitForFunction(() => !aiSubmitBusy);
        assert.equal(requests.filter(r => r.path === '/api/ai/start').at(-1).body.filters.collectionRunId, 'run-test');
        await page.locator('#btn-outreach-start').click(); await page.waitForSelector('#precheck-modal:not(.hidden)');
        assert.equal(requests.filter(r => r.path === '/api/outreach/preview').at(-1).body.filters.collectionRunId, 'run-test');
        await page.locator('#pc-cancel').click();
        await page.locator('[data-clear-run]').click();
        assert.equal(await page.evaluate(() => Object.hasOwn(leadFilter, 'collectionRunId')), false);
        await page.locator('#chip-filters [data-f="all"]').click();
      } finally {
        uiTask = original; delete sampleLeads[0].collectionRunId; delete sampleLeads[2].collectionRunId;
        await page.evaluate(() => { lastCollectionSummary = null; return refresh(); });
        await page.locator('#nav a[data-page="collect"]').click(); await page.waitForFunction(() => !pageDirty);
      }
    });

    await t.test('outreach stages identify current user and pending verification without inventing success', async () => {
      const original = uiTask;
      try {
        uiTask = { kind: 'outreach', running: true, stage: 'filling_dm', status: '填写消息', currentLead: { id: 1, nickname: '<测试用户>' }, currentUserIndex: 2, totalUsers: 3, done: 1, total: 3 };
        await page.locator('#nav a[data-page="leads"]').click(); await page.waitForFunction(() => !pageDirty);
        assert.match(await page.locator('#act-user-summary').textContent(), /<测试用户>.*第 2 .* 3 位/);
        assert.match(await page.locator('#act-stage-flow [aria-current="step"]').textContent(), /填写/);
        for (const stage of ['selecting_conversation', 'checking_dm_history']) {
          uiTask.stage = stage; uiTask.status = stage === 'selecting_conversation' ? '正在消息列表中查找并进入目标对话' : '正在检查目标对话的私信历史'; await page.evaluate(() => refresh());
          assert.match(await page.locator('#act-stage-flow [aria-current="step"]').textContent(), /3打开私信/);
          assert.match(await page.locator('#act-status').textContent(), stage === 'selecting_conversation' ? /查找并进入目标对话/ : /私信历史/);
        }
        uiTask.stage = 'verifying_dm'; uiTask.status = '发送已点击，回执待核验'; await page.evaluate(() => refresh());
        assert.match(await page.locator('#act-stage-flow [aria-current="step"]').textContent(), /核验/);
        assert.match(await page.locator('#act-status').textContent(), /待核验/);
        assert.doesNotMatch(await page.locator('#act-status').textContent(), /已成功|确认成功/);
        uiTask.stage = 'future_stage'; uiTask.status = '平台流程更新后的状态'; await page.evaluate(() => refresh());
        assert.match(await page.locator('#act-status').textContent(), /平台流程更新后的状态/);
        assert.equal(await page.locator('#act-stage-flow [aria-current="step"]').count(), 0);
      } finally { uiTask = original; await page.evaluate(() => refresh()); await page.locator('#nav a[data-page="collect"]').click(); await page.waitForFunction(() => !pageDirty); }
    });

    await t.test('collection preserves pasted multiline share messages and groups force collection explicitly', async () => {
      const shareText = '2.38 复制打开抖音，看看【测试作品】测试描述 https://v.douyin.com/mock-video/ 07/13 :1pm\n1.23 复制打开抖音，看看【图文测试作品】图文说明 https://www.douyin.com/note/456';
      assert.equal(await page.locator('.link-input').first().evaluate(element => element.tagName), 'TEXTAREA');
      assert.match(await page.locator('.link-input').first().getAttribute('aria-label'), /作品链接或分享文本/);
      await page.locator('.link-input').first().fill(shareText);
      await page.locator('.link-input').nth(1).fill('');
      await page.locator('.link-input').nth(2).fill('');
      await page.locator('[data-link-force="0"]').check();
      await page.locator('#btn-link-add').focus(); await page.evaluate(() => refresh());
      assert.equal(await page.locator('.link-input').first().inputValue(), shareText);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/collect/start')), page.locator('#btn-collect-start').click()]);
      assert.deepEqual(requests.filter(r => r.path === '/api/collect/start').at(-1).body.links, [{ url: shareText, force: true }]);
      assert.match(await page.locator('#page-collect').textContent(), /强制重采应用于该输入框中的所有作品/);
    });

    await t.test('missing work description stays distinct from complete comment collection', async () => {
      const item = collectionHistory[1], original = { ...item };
      try {
        delete item.desc; item.descriptionState = 'missing'; item.collectionState = 'complete';
        await page.evaluate(() => refresh());
        await page.waitForFunction(() => document.querySelector('#video-hist tr:nth-child(2) td:nth-child(1)').textContent.includes('描述未获取'));
        const cells = page.locator('#video-hist tr').nth(1).locator('td');
        assert.match(await cells.nth(0).textContent(), /描述未获取/);
        assert.match(await cells.nth(3).textContent(), /完整/);
        item.descriptionState = 'empty'; await page.evaluate(() => refresh());
        await page.waitForFunction(() => document.querySelector('#video-hist tr:nth-child(2) td:nth-child(1)').textContent.includes('作品无文字描述'));
        assert.match(await cells.nth(0).textContent(), /作品无文字描述/);
      } finally {
        Object.keys(item).forEach(key => delete item[key]); Object.assign(item, original);
        await page.waitForFunction(() => !refreshBusy);await page.evaluate(() => refresh());
        await page.waitForFunction(() => document.querySelector('#video-hist tr:nth-child(2) td:nth-child(1)').textContent.includes('图文部分样例'));
      }
    });

    await t.test('note history stays on the note route when queued and is not added twice', async () => {
      await page.locator('.link-input').first().fill('');
      await page.locator('[data-video-id="456"][data-video-action="add"]').click();
      assert.equal(await page.locator('.link-input').last().inputValue(), 'https://www.douyin.com/note/456');
      assert.match(await page.locator('.link-row').last().locator('.link-badge').textContent(), /部分（可续采）/);
      const count = await page.locator('.link-input').count();
      await page.locator('[data-video-id="456"][data-video-action="add"]').click();
      assert.equal(await page.locator('.link-input').count(), count);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/collect/start')), page.locator('#btn-collect-start').click()]);
      assert.deepEqual(requests.filter(r => r.path === '/api/collect/start').at(-1).body.links, [{ url: 'https://www.douyin.com/note/456', force: false }]);
    });

    await t.test('long work text is readable in both collection history and leads, preserving newlines and safe literal text', async () => {
      const item = collectionHistory[1], historyOriginal = { ...item }, leadOriginal = { ...sampleLeads[0] };
      const longText = '超长图文标题\n' + ('图文正文保留全部内容，不截断原始数据。\n'.repeat(130)) + '<img src=x onerror="window.__injected=1">\n最后一行完整保留';
      try {
        Object.assign(item, { workTitle: '超长图文标题', workContent: longText.slice('超长图文标题\n'.length), workText: longText, desc: longText, descriptionState: 'available', descriptionSource: 'page_json' });
        Object.assign(sampleLeads[0], { awemeId: '456', videoLink: item.videoLink, videoDesc: longText });
        await page.waitForFunction(() => !refreshBusy);await page.evaluate(() => refresh());
        await page.waitForFunction(() => document.querySelector('[data-detail-video="456"]')?.closest('td').textContent.includes('超长图文标题'));
        await page.locator('[data-detail-video="456"]').click();
        assert.equal(await page.locator('#field-detail-content').textContent(), longText);
        assert.equal(await page.locator('#field-detail-content img').count(), 0);
        assert.match(await page.locator('#field-detail-summary').textContent(), /图文/);
        assertReadable(await readability(page), '完整图文详情');
        assert.equal(await page.locator('#field-detail-content').evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap');
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__testCopied = text; } } }));
        await page.locator('#field-detail-copy').click();
        assert.equal(await page.evaluate(() => window.__testCopied), longText);
        assert.match(await page.locator('#field-detail-copy-result').textContent(), /完整内容已复制/);
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('isolated denied clipboard'); } } }));
        await page.locator('#field-detail-copy').click();
        assert.match(await page.locator('#field-detail-copy-result').textContent(), /Ctrl\+C/);
        assert.equal(await page.evaluate(() => window.getSelection().toString()), longText);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#field-detail-modal').isVisible(), false);

        await page.locator('#nav a[data-page="leads"]').click(); await page.evaluate(() => loadLeads());
        const workButton = page.locator('#lead-list td[data-field-key="videoDesc"] [data-detail-lead="1"][data-detail-field="videoDesc"]');
        assert.match(await workButton.textContent(), /超长图文标题/);
        assert.doesNotMatch(await workButton.textContent(), /查看作品/);
        await page.evaluate(() => document.querySelector('#page-leads .table-wrap').scrollLeft = 0);
        await workButton.click();
        const expected = projectLead(sampleLeads[0], Object.fromEntries(collectionHistory.map(work => [work.awemeId, work]))).fieldValues.videoDesc;
        assert.equal(await page.locator('#field-detail-content').textContent(), expected);
        assert.match(expected, /最后一行完整保留/);
        assert.equal(await page.locator('#field-detail-content img').count(), 0);
        await page.screenshot({ path: path.join(screenshotDir, 'long-work-detail-1360.png'), fullPage: true });
        await page.locator('#field-detail-close').click();
      } finally {
        await page.evaluate(() => closeModal('field-detail-modal'));
        await page.evaluate(() => { delete navigator.clipboard; delete window.__testCopied; });
        Object.keys(item).forEach(key => delete item[key]); Object.assign(item, historyOriginal);
        Object.keys(sampleLeads[0]).forEach(key => delete sampleLeads[0][key]); Object.assign(sampleLeads[0], leadOriginal);
        await page.evaluate(() => loadLeads());
      }
    });

    await t.test('short AI reasons display directly while historical scores and long reasons remain readable', async () => {
      const originals = sampleLeads.slice(0, 2).map(lead => ({ ...lead }));
      const shortReason = '业务相关，用户询问服务费用';
      const longReason = '旧版完整理由\n' + '历史判断内容需要完整保留。'.repeat(35) + '\n<img src=x onerror="window.__injected=1">\n最后一行历史证据';
      try {
        sampleLeads[0].aiReason = shortReason; sampleLeads[0].aiScore = 90;
        sampleLeads[1].aiReason = longReason;
        await page.locator('#nav a[data-page="leads"]').click();
        await page.evaluate(() => { leadFilter = { f: 'all', commentDays: 0, contact: 'all', s: '', q: '' }; document.getElementById('lead-q').value = ''; return loadLeads(); });
        const row = id => page.locator('#lead-list tr').filter({ has: page.locator(`.lead-select[data-lead-id="${id}"]`) });
        const shortCell = row(1).locator('td[data-field-key="aiNeed"]');
        assert.match(await shortCell.textContent(), new RegExp(shortReason));
        await page.locator('#page-leads .lead-field-settings summary').click();
        await page.locator('[data-lead-field="aiScore"]').check();
        const oldScore = row(1).locator('td[data-field-key="aiScore"]');
        assert.match(await oldScore.textContent(), /90.*历史评分/); assert.match(await oldScore.locator('span[title]').getAttribute('title'), /不按评分决定执行/);
        await openLeadDetail(2);
        assert.match(await page.locator('#field-detail-content').textContent(), /旧版完整理由/);
        assert.equal(await page.locator('#field-detail-content img').count(), 0);
        assert.match(await page.locator('#field-detail-content').textContent(), /最后一行历史证据/);
        await page.locator('#field-detail-close').click();
      } finally {
        if (await page.locator('#field-detail-modal').isVisible()) await page.locator('#field-detail-close').click();
        await page.locator('#lead-fields-reset').click();
        await page.locator('#page-leads .lead-field-settings summary').click();
        for (let index = 0; index < 2; index++) { Object.keys(sampleLeads[index]).forEach(key => delete sampleLeads[index][key]); Object.assign(sampleLeads[index], originals[index]); }
        await page.evaluate(() => loadLeads());
      }
    });

    await t.test('populated lead tables and frozen preview use readable text and maintain contrast', async () => {
      await page.setViewportSize({ width: 1360, height: 880 });
      // These are local mock fixtures only. No actual customer record is read.
      Object.assign(sampleLeads[0], { nickname: '示例卖家 A', demand: '店铺停用后需要怎样准备申诉资料？', time: '2026-10-08 09:30', workTitle: '店铺停用后，怎样准备申诉资料？', workContent: '整理账户停用原因、发票和供应链材料，按实际问题说明整改措施。', videoDesc: '亚马逊账户申诉资料准备', aiReason: '用户明确询问账户申诉服务', doNotContact: false, status: 'new' });
      Object.assign(sampleLeads[1], { nickname: '示例卖家 B', UID: '101', time: '2026-10-08 09:40', demand: '账户资金冻结，需要了解服务费用', workTitle: '图文：账户资金被冻结怎么办', workContent: '核对业绩通知中的问题和要求，保存原始证据并整理处理时间线。', dmState: 'pending_verification', status: 'dm_pending' });
      Object.assign(sampleLeads[2], { nickname: '示例卖家 C', UID: '102', time: '2026-10-08 09:50', workTitle: '协议三申诉要注意哪些事项', workContent: '本条作品介绍申诉材料的整理方式和常见问题。' });
      sampleLeads[0].aiPromptVersion = AI.getRuleSet(config).version;
      sampleLeads[0].aiInputHash = require('node:crypto').createHash('sha256').update(JSON.stringify(AI.leadInput(sampleLeads[0], {}))).digest('hex');
      await page.locator('#nav a[data-page="leads"]').click();
      await page.evaluate(() => { leadFilter = { f: 'all', commentDays: 0, contact: 'all', s: '', q: '' }; document.getElementById('lead-q').value = ''; refresh(); });
      await page.waitForFunction(() => [...document.querySelectorAll('.col-nick .lead-name')].some(element => element.textContent === '示例卖家 A'));
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#page-leads .table-wrap').scrollLeft = 0; });
      assertReadable(await readability(page), '1360px populated leads');
      // Query and inspect in the same browser turn: periodic lead refresh can
      // replace a node between locating its handle and evaluating its style.
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#lead-list td')).fontSize), '15px');
      const compactLayout = await page.evaluate(() => ({
        cells: [...document.querySelectorAll('#lead-list td, #lead-head th, #lead-list button, #lead-list .lead-line')].map(element => ({ text: element.textContent.slice(0, 20), fontSize: getComputedStyle(element).fontSize })),
        rowHeights: [...document.querySelectorAll('#lead-list tr')].map(element => element.getBoundingClientRect().height),
        maxHeight: getComputedStyle(document.querySelector('.lead-table-wrap')).maxHeight,
        horizontalOverflow: document.querySelector('.lead-table-wrap').scrollWidth - document.querySelector('.lead-table-wrap').clientWidth,
        contactRight: document.querySelector('#lead-list .lead-contact').getBoundingClientRect().right,
        viewportRight: document.querySelector('.lead-table-wrap').getBoundingClientRect().right,
        dates: [...document.querySelectorAll('#lead-list .lead-date')].map(element => element.querySelectorAll('.lead-line').length)
      }));
      assert.deepEqual(compactLayout.cells.filter(cell => cell.fontSize !== '15px'), [], 'all compact table text shares a 15px scale');
      assert.ok(compactLayout.rowHeights.every(height => height >= 50 && height <= 64), 'two-line rows stay compact');
      assert.equal(compactLayout.maxHeight, 'none', 'the table does not trap scrolling in a short inner pane');
      assert.ok(compactLayout.horizontalOverflow <= 1, 'the default seven columns fit at 1360px without horizontal scrolling');
      assert.ok(compactLayout.contactRight <= compactLayout.viewportRight + 1, 'the contact column is fully visible at the default desktop width');
      assert.ok(compactLayout.dates.every(lines => lines === 2), 'comment date and time each occupy one line');
      const workCell = page.locator('#lead-list tr').filter({ has: page.locator('.lead-select[data-lead-id="1"]') }).locator('.lead-work');
      assert.equal(await workCell.locator('.lead-title').textContent(), sampleLeads[0].workTitle);
      assert.equal(await workCell.locator('.lead-body').textContent(), sampleLeads[0].workContent);
      await page.evaluate(() => { const details = document.querySelector('#page-leads .lead-field-settings'); if (details) details.removeAttribute('open'); });
      await page.screenshot({ path: path.join(screenshotDir, 'sample-leads-1360.png'), fullPage: true });
      await page.locator('#btn-outreach-start').click();
      await page.waitForSelector('#precheck-modal:not(.hidden)');
      assertReadable(await readability(page), '1360px frozen preview');
      assert.equal(await page.locator('#pc-summary').evaluate(element => getComputedStyle(element).fontSize), '16px');
      await page.screenshot({ path: path.join(screenshotDir, 'sample-precheck-1360.png'), fullPage: true });
      await page.locator('#pc-cancel').click();
    });

    await t.test('AI tasks distinguish estimated tokens from actual response usage and hide stale metrics for other task kinds', async () => {
      const original = structuredClone(uiTask);
      async function refreshTaskSnapshot() {
        // Mock task switches must not race an older in-flight polling snapshot.
        await page.waitForFunction(() => !refreshBusy);
        await page.evaluate(() => refresh());
        await page.waitForFunction(task => !refreshBusy && !pageDirty && state.task.kind === task.kind && state.task.status === task.status && state.task.running === task.running, uiTask);
      }
      try {
        uiTask = { kind: 'ai', running: true, total: 4, done: 0, status: '正在批量判断',
          aiBudget: { inputTokensEstimate: 2800, outputTokensReserved: 800, totalTokensEstimate: 3600, targetTokens: 115200 },
          aiBaseBudget: { inputTokensEstimate: 1100 }, aiUsage: { usage: { prompt_tokens: 1234, completion_tokens: 456 } }, aiCompletionRequests: 3, aiModelRequests: 1 };
        await page.locator('#nav a[data-page="overview"]').click(); await refreshTaskSnapshot();
        const text = await page.locator('#task-box').textContent();
        assert.match(text, /保守估算：输入 2.?800.*返回预留 800.*3.?600.*90% 预算 115.?200 token/);
        assert.match(text, /介绍、要求及消息包装估算：1.?100 token/);
        assert.match(text, /最近回执实际用量：输入 1.?234，输出 456 token.*服务器返回/);
        assert.match(text, /实际接口请求：判断 3 次，模型查询 1 次.*含重试/);
        assert.doesNotMatch(text, /字符\s*[=＝]\s*token/);
        assertReadable(await readability(page), 'AI token预算与回执用量');
        await page.screenshot({ path: path.join(screenshotDir, 'ai-budget-progress-1360.png'), fullPage: true });
        uiTask = { ...uiTask, kind: 'collect', status: '正在采集' };
        await refreshTaskSnapshot();
        for (const id of ['task-box', 'col-status', 'act-status']) {
          assert.match(await page.locator('#' + id).textContent(), /正在采集/);
          assert.doesNotMatch(await page.locator('#' + id).textContent(), /保守估算|返回预留|实际用量|消息包装/);
        }
        uiTask = { ...uiTask, kind: 'ai', running: false, status: '本次AI判断已完成' };
        await refreshTaskSnapshot();
        assert.match(await page.locator('#task-box').textContent(), /已完成.*最近回执实际用量/s);
      } finally { uiTask = original; await refreshTaskSnapshot(); }
    });

    await t.test('system AI logs are selected by default, explain batches and results safely and preserve account selection', async () => {
      await page.locator('#nav a[data-page="logs"]').click();
      await page.waitForFunction(() => document.getElementById('log-box').textContent.includes('编号 1 → 是'));
      assert.equal(await page.locator('#log-account').inputValue(), 'system');
      assert.match(await page.locator('#log-account option[value="system"]').textContent(), /系统.*AI.*日志/);
      assert.ok(requests.some(request => request.path === '/api/logs/system'));
      const text = await page.locator('#log-box').textContent();
      assert.match(text, /批量 · 4 条 · 共享 1 份作品/);
      assert.match(text, /编号 1 → 是.*询问账户申诉资料/);
      assert.match(text, /名单已固定：选中 8 条，本次待判 4 条.*保留已有有效结果/);
      assert.match(text, /已发出请求：模型查询.*累计判断 0 次，模型查询 1 次/);
      assert.match(text, /已发出请求：第 1\/1 批 · 判断.*累计判断 1 次，模型查询 1 次/);
      assert.match(text, /接口重试：第 1\/1 批 · 第 1 次，等待 2 秒.*服务暂不可用/);
      assert.match(text, /本批未直接写入/); assert.match(text, /逐条兜底.*编号 2/);
      assert.match(text, /全部完成.*是 2｜否 1｜失败 1/);
      assert.match(text, /模型容量.*128000 token.*16000 token.*官方文档备用值/);
      assert.match(text, /请求预算：第 1\/1 批 · 估算输入 2800 ＋ 返回预留 800 \/ 90% 预算 115200 token/);
      assert.match(text, /4 条拆成 2 ＋ 2 条/); assert.match(text, /缩批重试 · 2 条/);
      assert.match(text, /超限未发：编号 3/);
      assert.match(text, /实际用量.*输入 1234，输出 456 token.*服务器回执/);
      assert.doesNotMatch(text, /字符\s*[=＝]\s*token|AI_AUDIT/);
      assert.match(text, /<img src=x onerror="window.__injected=1">/);
      assert.equal(await page.locator('#log-box img').count(), 0); assert.equal(await page.evaluate(() => window.__injected), undefined);
      await page.screenshot({ path: path.join(screenshotDir, 'ai-system-logs-1360.png'), fullPage: true });
      await page.locator('#log-account').selectOption('1');
      await page.waitForFunction(() => document.getElementById('log-box').textContent.includes('账号1操作日志'));
      await page.evaluate(() => refresh()); assert.equal(await page.locator('#log-account').inputValue(), '1');
      await page.locator('#log-account').selectOption('system');
      await page.waitForFunction(() => document.getElementById('log-box').textContent.includes('编号 1 → 是'));
    });

    await t.test('industry draft is local, exposes legacy conflicts and preserves API and other presets when saved', async () => {
      const original=structuredClone(config);
      config.ai.apiKey='mock-existing-key';aiPromptWarning='旧提示词包含prompt包装指令';
      await page.locator('#nav a[data-page="settings"]').click();await page.evaluate(()=>{pageDirty=true;return refresh();});await page.waitForFunction(()=>!pageDirty);
      assert.match(await page.locator('#ai-prompt-warning').textContent(),/包装指令/);
      await page.locator('[data-prompt-edit="prompt-3"]').click();
      const keepPresets=config.ai.promptPresets.slice(0,2).map(p=>({...p})), keepAction=structuredClone(config.action), keepCollect=structuredClone(config.collect), before=requests.length;
      await page.locator('#btn-ai-industry-default').click();
      assert.equal(requests.slice(before).filter(r=>r.path==='/api/ai/prompt-draft'||r.path==='/api/settings').length,0,'local draft must not call AI or save');
      assert.equal(await page.locator('#s-ai-prompt').inputValue(),sourceDefaults.ai.promptPresets[0].prompt);
      assert.equal(await page.locator('#prompt-slots input:checked').inputValue(),'prompt-3');
      assert.equal(await page.locator('#s-ai-key').inputValue(),'','明文 Key 不回到输入框');
      assert.match(await page.locator('#s-ai-key').getAttribute('placeholder'),/已保存/);
      assert.equal(config.ai.promptPresets[2].prompt,original.ai.promptPresets[2].prompt,'draft must not mutate persisted config');
      await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/settings')),page.locator('#btn-save-settings').click()]);
      // PUT response headers arrive before the save handler's state refresh.
      // Finish that refresh before restoring the mock backend snapshot.
      await page.waitForFunction(prompt=>!refreshBusy&&state.settings.ai.activePromptId==='prompt-3'&&state.settings.ai.promptPresets.find(p=>p.id==='prompt-3')?.prompt===prompt,sourceDefaults.ai.promptPresets[0].prompt);
      assert.equal(config.ai.apiKey,'mock-existing-key');assert.deepEqual(config.ai.promptPresets.slice(0,2),keepPresets);
      assert.deepEqual(config.action,keepAction);assert.deepEqual(config.collect,keepCollect);assert.equal(config.ai.activePromptId,'prompt-3');
      assert.equal(config.ai.promptPresets[2].prompt,sourceDefaults.ai.promptPresets[0].prompt);
      assert.equal(config.ai.clearNeeds,sourceDefaults.ai.clearNeeds);assert.deepEqual(config.keywords,sourceDefaults.keywords);
      Object.assign(config,original);aiPromptWarning='';
      await page.waitForFunction(()=>!refreshBusy);
      await page.evaluate(()=>{pageDirty=true;return refresh();});await page.waitForFunction(()=>!refreshBusy&&!pageDirty&&state.aiPromptWarning==='');
      assert.equal(await page.locator('#ai-prompt-warning').isVisible(),false);
    });

    await t.test('global stop stays clickable above expired-license login and retains known session token', async () => {
      for (const width of [1440, 1100, 760]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('#nav a[data-page="settings"]').click(); await page.waitForFunction(() => !pageDirty);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(screenshotDir, `settings-${width}.png`), fullPage: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}px 页面不能整体横向溢出`);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('#nav a[data-page="overview"]').click(); await page.waitForFunction(() => !pageDirty);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(screenshotDir, 'overview-1440.png'), fullPage: true });
      expired = true; await page.evaluate(() => refresh()); await page.waitForFunction(() => document.getElementById('login-layer').style.display === 'flex');
      await page.locator('#btn-global-stop').click();
      const request = requests.filter(r => r.path === '/api/tasks/stop').at(-1);
      assert.ok(request); assert.equal(request.token, 'fake-known-session');
    });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('fresh client defaults show empty workspaces and remain usable at desktop and narrow widths', async t => {
  const deps = dependencies();
  if (!deps) { t.skip('No bundled or installed browser available'); return; }
  // Evaluate only the source default object, without importing store.js or
  // opening an existing data directory. This mock carries no historical data.
  const defaults = sourceDefaultSettings();
  defaults.license = { enabled: true };
  const requests = [];
  let lastCollectionSave = null;
  const snapshot = { ok: true, role: 'user', leadFields: publicLeadFields(), settings: defaults, accounts: [], task: { running: false, status: '空闲' }, stats: { total: 0, intent: 0, followed: 0, dmSent: 0, newCount: 0, aiJudged: 0 }, loginUser: '体验账户', license: { mac: '02:00:00:00:00:01', serverTime: '2026-10-08', cache: { username: '体验账户', expiresAt: '2026-11-08' } }, dataDir: '本机数据文件夹' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'");
      res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html;charset=utf-8' : name.endsWith('.js') ? 'application/javascript;charset=utf-8' : 'text/css;charset=utf-8');
      res.end(fs.readFileSync(path.join(__dirname, '..', 'web', name))); return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(url.pathname);
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      const body = JSON.parse(raw);
      if (body.collect) { lastCollectionSave = body.collect; Object.assign(defaults.collect, body.collect); }
    }
    const result = url.pathname === '/api/login' ? { ok: true, token: 'fresh-ui-session' } : url.pathname === '/api/state' ? snapshot : url.pathname === '/api/videos' ? { ok: true, videos: [] } : url.pathname === '/api/leads' ? { ok: true, leadFields: publicLeadFields(), leads: [], total: 0, totalFiltered: 0, facets: { ai: { all: 0, ai_todo: 0, ai_yes: 0, ai_no: 0, ai_stale: 0 } } } : { ok: true };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await deps.playwright.chromium.launch({ headless: true, executablePath: deps.executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const screenshotDir = path.resolve(__dirname, '../../build-tools/ui-review-v2216');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const visualReports = [];
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    for (const width of [1360, 1100, 760, 390]) {
      await page.setViewportSize({ width, height: width === 1360 ? 880 : 1000 });
      const report = await readability(page, true);
      assertReadable(report, `${width}px 登录页`);
      visualReports.push({ width, page: 'login', ...report });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}px 登录页不能整体横向溢出`);
      await page.screenshot({ path: path.join(screenshotDir, `fresh-login-${width}.png`), fullPage: true });
    }
    await page.locator('#login-user').fill('fake-fresh-client'); await page.locator('#login-pass').fill('fake-password'); await page.locator('#btn-login').click();
    await page.waitForFunction(() => document.getElementById('login-layer').style.display === 'none' && !pageDirty);
    assert.equal(await page.locator('#st-total').textContent(), '0');
    assert.match(await page.locator('#ov-accounts').textContent(), /还没有添加采集账号/);
    for (const width of [1360, 1100, 760, 390]) {
      await page.setViewportSize({ width, height: width === 1360 ? 880 : 1000 });
      for (const target of ['overview', 'settings', 'leads', 'accounts', 'collect', 'logs']) {
        await page.locator(`#nav a[data-page="${target}"]`).click(); await page.waitForFunction(() => !pageDirty);
        await page.evaluate(() => window.scrollTo(0, 0));
        if (target === 'settings') {
          assert.equal(await page.locator('#s-ai-key').inputValue(), '');
          assert.equal(await page.locator('#s-ai-model').inputValue(), defaults.ai.model);
          assert.equal(await page.locator('#s-ai-bchars').inputValue(), String(defaults.ai.batchMaxChars));
          assert.equal(await page.locator('#s-ai-bcount').inputValue(), String(defaults.ai.batchMaxCount));
          assert.equal(await page.locator('#s-ai-batch-mode').inputValue(), defaults.ai.batchMode || 'auto');
          assert.equal(await page.locator('#s-ai-bchars').isDisabled(), (defaults.ai.batchMode || 'auto') === 'auto');
          assert.equal(await page.locator('#s-ai-bcount').isDisabled(), (defaults.ai.batchMode || 'auto') === 'auto');
          assert.equal(await page.locator('#s-ai-prompt').inputValue(), defaults.ai.promptPresets[0].prompt);
          assert.equal(await page.locator('#prompt-slots input:checked').inputValue(), 'prompt-1');
          assert.equal(await page.locator('#lic-mac').evaluate(element => getComputedStyle(element).fontSize), '17px');
        } else if (target === 'leads') {
          assert.equal(await page.locator('#a-act-min, #a-act-max').count(), 0); assert.match(await page.locator('#action-pacing-summary').textContent(), /20 秒 ±25%/);
          assert.equal(await page.locator('#a-fol-limit').inputValue(), '150'); assert.equal(await page.locator('#a-dm-limit').inputValue(), '150');
        } else if (target === 'logs') {
          assert.equal(await page.locator('#log-account').inputValue(), 'system', 'system AI logs remain available without any platform account');
        } else if (target === 'collect') {
          assert.equal(await page.locator('#c-col-daily').inputValue(), '240'); assert.equal(await page.locator('#c-col-max').inputValue(), '120');
          assert.equal(await page.locator('#c-col-daily').evaluate(element => element.checkValidity()), true);
          assert.equal(await page.locator('#c-col-max').evaluate(element => element.checkValidity()), true);
          if (width === 1360) {
            await page.locator('#collect-options summary').click();
            await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/settings')), page.locator('#btn-save-col').click()]);
            assert.equal(lastCollectionSave.dailyVideoLimit, 240); assert.equal(lastCollectionSave.maxScrolls, 120);
            assert.equal(defaults.collect.dailyVideoLimit, 240); assert.equal(defaults.collect.maxScrolls, 120);
          }
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}px ${target} 页面整体横向溢出`);
        const report = await readability(page);
        assertReadable(report, `${width}px ${target}`);
        visualReports.push({ width, page: target, ...report });
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
        if (width === 1360 || target === 'settings' || (width === 390 && target === 'overview')) await page.screenshot({ path: path.join(screenshotDir, `fresh-${target}-${width}.png`), fullPage: true });
        if (width === 1360) {
          await page.screenshot({ path: path.join(screenshotDir, `fresh-${target}-${width}-view.png`) });
          if (target === 'settings') {
            await page.evaluate(() => window.scrollTo(0, document.querySelector('.ai-workspace').getBoundingClientRect().top + window.scrollY - 130));
            await page.screenshot({ path: path.join(screenshotDir, 'fresh-ai-workspace-1360-view.png') });
          }
        }
      }
    }
    fs.writeFileSync(path.join(screenshotDir, 'readability-report.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), source: 'isolated local mock with source defaults', reports: visualReports }, null, 2));
    assert.equal(requests.includes('/api/ai/models'), false, 'fresh empty API key should not request provider models');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('account login feedback tracks scan progress and preserves account form edits', async t => {
  const deps = dependencies();
  if (!deps) { t.skip('No bundled or installed browser available'); return; }
  const settings = sourceDefaultSettings();
  settings.license = { enabled: true };
  const accounts = [1, 2].map(id => ({ id, name: '扫码测试账号' + id, loginState: '未登录', loginStatus: 'logged_out', daily: { follow: 0, dm: 0, videos: 0 } }));
  let task = { running: false, status: '空闲' }, openGate = null, expired = false, stateFailure = false, videosFailure = false;
  let accountLoginScan = { phase: 'idle', total: 0, done: 0, accountId: '', message: '', accountStates: {} };
  let checkResult = { ok: true, loggedIn: false, state: 'logged_out', message: '登录窗口仍在等待手机确认。' };
  let actionFailure = false;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'");
      res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html;charset=utf-8' : name.endsWith('.js') ? 'application/javascript;charset=utf-8' : 'text/css;charset=utf-8');
      res.end(fs.readFileSync(path.join(__dirname, '..', 'web', name))); return;
    }
    for await (const chunk of req) { void chunk; }
    requests.push({ path: url.pathname, token: req.headers['x-auth-token'] });
    let result = { ok: true };
    if (url.pathname === '/api/login') result.token = 'scan-test-session';
    else if (url.pathname === '/api/tasks/stop') {
      task = { ...task, running: false, loginState: 'stopped', status: '登录监测已停止', detail: '用户点击停止，尚未确认浏览器登录。' };
      if (['queued', 'running'].includes(accountLoginScan.phase)) accountLoginScan = { ...accountLoginScan, phase: 'stopped', message: '用户停止了启动检查。' };
    }
    else if (expired) { res.statusCode = 401; result = { ok: false, error: '测试授权已到期，禁止开始登录操作' }; }
    else if (url.pathname === '/api/state') {
      if (stateFailure) { res.statusCode = 503; result = { ok: false, error: '测试本机状态服务暂不可用' }; }
      else result = { ok: true, role: 'user', settings, accounts, accountLoginScan, task, stats: { total: 0, intent: 0, followed: 0, dmSent: 0, newCount: 0, aiJudged: 0 }, license: {}, dataDir: 'isolated-fake-data' };
    } else if (url.pathname === '/api/videos') {
      if (videosFailure) { res.statusCode = 503; result = { ok: false, error: '测试作品历史暂不可用' }; }
      else result.videos = [];
    }
    else if (url.pathname === '/api/accounts/1/open') {
      if (openGate) await openGate;
      task = { kind: 'login', accountId: '1', running: true, loginState: 'pending', status: '等待扫码登录', detail: '请在手机确认。检测剩余 295 秒。' };
    } else if (url.pathname === '/api/accounts/1/check') {
      if (actionFailure) { res.statusCode = 502; result = { ok: false, error: '测试浏览器连接已断开，检查失败' }; }
      else result = checkResult;
    } else if (url.pathname === '/api/accounts' && req.method === 'POST') {
      res.statusCode = 400; result = { ok: false, error: '测试账号名称已存在，请修改名称' };
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await deps.playwright.chromium.launch({ headless: true, executablePath: deps.executablePath });
  const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
  const errors = [], dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const row = id => page.locator(`[data-account-row="${id}"] .account-login-cell`);
  const action = kind => page.locator(`[data-account-id="1"][data-account-action="${kind}"]`);
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('#login-user').fill('fake-software-login'); await page.locator('#login-pass').fill('fake-password'); await page.locator('#btn-login').click();
    await page.waitForFunction(() => document.getElementById('login-layer').style.display === 'none' && !pageDirty);
    await page.locator('#nav a[data-page="accounts"]').click(); await page.waitForFunction(() => !pageDirty);
    assert.equal(await page.locator('#account-login-status').getAttribute('aria-live'), 'polite');
    await page.locator('#acc-name').fill('正在编辑的新账号'); await page.locator('#acc-proxy').fill('http://fake.local:8000'); await page.locator('#acc-note').fill('不要覆盖表单');

    await t.test('startup progress uses unchecked current evidence and never triggers browser checks from polling', async () => {
      for (const account of accounts) { account.loginStatus = 'authenticated'; account.loginState = '已登录'; account.loginMessage = '上次保存的已登录'; }
      task = { kind: 'collect', accountId: '1', running: true, status: '正在采集当前作品' };
      accountLoginScan = { phase: 'queued', total: 2, done: 0, accountId: '', message: '等待当前任务结束后自动检查。', accountStates: { '1': { state: 'unknown', checked: false, message: '本次启动待检查' }, '2': { state: 'unknown', checked: false, message: '本次启动待检查' } } };
      await page.evaluate(() => refresh());
      assert.equal(await page.locator('#account-startup-status').getAttribute('aria-live'), 'polite');
      assert.match(await page.locator('#account-startup-status').textContent(), /等待中.*0\/2/);
      assert.match(await page.locator('#account-startup-status').textContent(), /等待当前任务结束/);
      for (const id of [1, 2]) assert.equal(await row(id).getAttribute('data-login-state'), 'unknown');
      assert.doesNotMatch(await page.locator('#ov-accounts').textContent(), /已登录/);
      for (const id of ['col-account', 'act-account', 'act-account', 'log-account']) assert.match(await page.locator(`#${id}`).textContent(), /登录状态待确认/);
      assert.equal(await page.locator('#acc-list button:disabled').count(), 8);
      assert.equal(await page.locator('#btn-add-acc').isDisabled(), true);
      const addRequests = requests.filter(request => request.path === '/api/accounts').length;
      await page.locator('#btn-add-acc').evaluate(button => button.click());
      assert.equal(requests.filter(request => request.path === '/api/accounts').length, addRequests);
      assert.equal(await page.locator('#btn-global-stop').isEnabled(), true);
      assert.match(await page.locator('#task-box').textContent(), /正在采集当前作品/);

      task = { running: false, status: '空闲' };
      accountLoginScan.phase = 'running'; accountLoginScan.accountId = '1'; accountLoginScan.message = '正在依次读取浏览器反馈。';
      accountLoginScan.accountStates['1'] = { state: 'checking', checked: false, message: '正在检查专用浏览器。' };
      await page.evaluate(() => refresh());
      assert.equal(await row(1).getAttribute('data-login-state'), 'checking');
      assert.match(await row(1).textContent(), /检查中/);
      assert.equal(await page.locator('#btn-add-acc').isDisabled(), true);
      assert.match(await page.locator('#account-startup-status').textContent(), /当前账号：扫码测试账号1/);
      assert.match(await page.locator('#col-account').textContent(), /检查中/);
      assertReadable(await readability(page), '启动自动检查账号页');
      const startupReview = path.resolve(__dirname, '../../build-tools/ui-review-v2213');
      fs.mkdirSync(startupReview, { recursive: true });
      await page.screenshot({ path: path.join(startupReview, 'startup-login-check-1360.png'), fullPage: true });

      accounts[0].loginMessage = '专用浏览器已取得平台登录响应'; accounts[0].loginCheckedAt = '2026-10-08 14:00:01';
      accountLoginScan.done = 1; accountLoginScan.accountId = '2';
      accountLoginScan.accountStates['1'] = { state: 'authenticated', checked: true, message: '扫描快照' };
      accountLoginScan.accountStates['2'] = { state: 'checking', checked: false, message: '正在检查第二个账号。' };
      await page.waitForFunction(() => document.getElementById('account-startup-status').textContent.includes('1/2') && document.querySelector('[data-account-row="2"] .account-login-cell').dataset.loginState === 'checking', null, { timeout: 6500 });
      assert.equal(await row(1).getAttribute('data-login-state'), 'authenticated');
      assert.match(await row(1).textContent(), /平台登录响应/);
      assert.doesNotMatch(await row(1).textContent(), /扫描快照/);

      accounts[1].loginStatus = 'logged_out'; accounts[1].loginState = '未登录'; accounts[1].loginMessage = '平台明确返回需要登录';
      accountLoginScan = { ...accountLoginScan, phase: 'completed', done: 2, accountId: '', message: '已完成检查。', accountStates: { ...accountLoginScan.accountStates, '2': { state: 'logged_out', checked: true, message: '扫描快照' } } };
      await page.evaluate(() => refresh());
      assert.match(await page.locator('#account-startup-status').textContent(), /已完成.*2\/2/);
      assert.equal(await row(2).getAttribute('data-login-state'), 'logged_out');
      assert.equal(await page.locator('#acc-list button:disabled').count(), 0);
      assert.equal(await page.locator('#btn-add-acc').isEnabled(), true);
      assert.equal(requests.filter(request => /^\/api\/accounts\/\d+\/(?:open|check|close)$/.test(request.path)).length, 0, 'automatic checks belong to the backend, never refresh or navigation');
      assert.equal(await page.locator('#acc-name').inputValue(), '正在编辑的新账号');
      assert.equal(await page.locator('#acc-proxy').inputValue(), 'http://fake.local:8000');
      assert.equal(await page.locator('#acc-note').inputValue(), '不要覆盖表单');
    });

    await t.test('completed startup snapshots never override later account evidence or history failures', async () => {
      for (const [phase, message] of [['verification_required', '平台要求人工验证'], ['unknown', '新的作品页没有足够登录证据']]) {
        accounts[0].loginStatus = phase; accounts[0].loginState = loginPhaseDescription(phase); accounts[0].loginMessage = message;
        await page.evaluate(() => refresh());
        assert.equal(await row(1).getAttribute('data-login-state'), phase);
        assert.match(await row(1).textContent(), new RegExp(message));
      }
      videosFailure = true;
      accounts[0].loginStatus = 'authenticated'; accounts[0].loginState = '已登录'; accounts[0].loginMessage = '作品历史失败时仍得到最新登录响应';
      await page.evaluate(() => refresh());
      assert.equal(await row(1).getAttribute('data-login-state'), 'authenticated');
      assert.match(await row(1).textContent(), /最新登录响应/);
      assert.doesNotMatch(await page.locator('#account-login-status').textContent(), /账号状态更新未完成/);
      await page.locator('#nav a[data-page="collect"]').click(); await page.waitForFunction(() => !pageDirty);
      assert.match(await page.locator('#video-hist').textContent(), /作品历史暂不可用/);
      videosFailure = false;
      await page.locator('#nav a[data-page="accounts"]').click(); await page.waitForFunction(() => !pageDirty);
    });

    await t.test('stopping startup inspection leaves unchecked accounts pending and global stop callable', async () => {
      accounts[1].loginStatus = 'authenticated'; accounts[1].loginState = '已登录'; accounts[1].loginMessage = '旧登录记录';
      accountLoginScan = { phase: 'running', total: 2, done: 1, accountId: '2', message: '正在检查第二个账号。', accountStates: { '1': { state: 'authenticated', checked: true }, '2': { state: 'checking', checked: false } } };
      await page.evaluate(() => refresh());
      await page.locator('#btn-global-stop').click();
      await page.waitForFunction(() => document.getElementById('account-startup-status').dataset.state === 'stopped');
      assert.match(await page.locator('#account-startup-status').textContent(), /已停止.*1\/2/);
      assert.equal(await row(2).getAttribute('data-login-state'), 'unknown');
      assert.match(await row(2).textContent(), /检查已停止/);
      assert.doesNotMatch(await row(2).textContent(), /正在检查/);
      assert.equal(await page.locator('#btn-global-stop').isEnabled(), true);
      assert.equal(await page.locator('#acc-list button:disabled').count(), 0);
      assert.equal(await page.locator('#btn-add-acc').isEnabled(), true);
      assert.ok(requests.some(request => request.path === '/api/tasks/stop' && request.token === 'scan-test-session'));
      accountLoginScan = { phase: 'idle', total: 0, done: 0, accountId: '', message: '', accountStates: {} };
      for (const account of accounts) { account.loginStatus = 'logged_out'; account.loginState = '未登录'; account.loginMessage = ''; }
      task = { running: false, status: '空闲' }; await page.evaluate(() => refresh());
    });

    await t.test('opening gives immediate feedback; periodic polling ties scan success to the correct account', async () => {
      let releaseOpen;
      openGate = new Promise(resolve => { releaseOpen = resolve; });
      await action('open').click();
      await page.waitForFunction(() => document.getElementById('account-login-status').textContent.includes('已开始，请稍候'));
      assert.equal(await action('check').isDisabled(), true);
      assert.equal(await page.locator('#btn-global-stop').isEnabled(), true);
      releaseOpen(); openGate = null;
      await page.waitForFunction(() => document.querySelector('[data-account-row="1"] .account-login-cell').textContent.includes('检测剩余 295 秒'));
      assert.equal(await row(1).getAttribute('data-login-state'), 'pending');
      assert.equal(await row(2).getAttribute('data-login-state'), 'logged_out');
      accounts[0].loginState = '已登录'; accounts[0].loginStatus = 'authenticated'; accounts[0].loginMessage = '手机扫码确认完成，浏览器已取得登录证据。';
      task = { ...task, running: false, loginState: 'authenticated', status: '登录成功', detail: '手机扫码确认完成，浏览器已取得登录证据。' };
      // No forced refresh: this verifies the actual 2.5-second polling loop.
      await page.waitForFunction(() => document.querySelector('[data-account-row="1"] .account-login-cell').dataset.loginState === 'authenticated', null, { timeout: 6500 });
      assert.match(await page.locator('#account-login-status').textContent(), /扫码测试账号1.*已登录/);
      assert.match(await row(1).textContent(), /手机扫码确认完成/);
      assert.equal(await row(2).getAttribute('data-login-state'), 'logged_out');
      assert.equal(await page.locator('#acc-name').inputValue(), '正在编辑的新账号');
      assert.equal(await page.locator('#acc-proxy').inputValue(), 'http://fake.local:8000');
      assert.equal(await page.locator('#acc-note').inputValue(), '不要覆盖表单');
      assertReadable(await readability(page), '扫码反馈账号页');
    });

    await t.test('completed check requests never mistake ok for logged-in evidence', async () => {
      for (const sample of [
        { ok: true, loggedIn: false, state: 'logged_out', message: '仍需扫码并在手机确认。' },
        { ok: true, loggedIn: false, state: 'unknown', message: '页面证据不足，请人工查看浏览器。' },
        { ok: true, loggedIn: false, state: 'verification_required', message: '浏览器显示验证码，请人工完成。' }
      ]) {
        checkResult = sample; await action('check').click();
        await page.waitForFunction(({ phase, message }) => {
          const cell = document.querySelector('[data-account-row="1"] .account-login-cell');
          return cell.dataset.loginState === phase && cell.textContent.includes(message);
        }, { phase: sample.state, message: sample.message });
        assert.notEqual(await row(1).getAttribute('data-login-state'), 'authenticated');
      }
      checkResult = { ok: true, loggedIn: true, state: 'authenticated', message: '已确认登录，授权操作检查完成。' };
      await action('check').click();
      await page.waitForFunction(() => document.querySelector('[data-account-row="1"] .account-login-cell').textContent.includes('授权操作检查完成'));
      assert.equal(await row(1).getAttribute('data-login-state'), 'authenticated');
      assert.deepEqual(dialogs, [], 'account result should be persistent inline feedback rather than an alert');
    });

    await t.test('fresh account evidence replaces a completed manual-check notice without a login task change', async () => {
      task = { kind: 'collect', accountId: '1', running: false, status: '空闲' };
      await page.evaluate(() => refresh());
      checkResult = { ok: true, loggedIn: true, state: 'authenticated', message: '旧的手动检查已确认登录。' };
      await action('check').click();
      await page.waitForFunction(() => document.querySelector('[data-account-row="1"] .account-login-cell').textContent.includes('旧的手动检查'));
      accounts[0].loginStatus = 'logged_out'; accounts[0].loginState = '未登录';
      accounts[0].loginMessage = '平台最新反馈：登录已失效'; accounts[0].loginCheckedAt = '2026-10-08 14:00:03';
      await page.evaluate(() => refresh());
      assert.equal(await row(1).getAttribute('data-login-state'), 'logged_out');
      assert.match(await row(1).textContent(), /最新反馈：登录已失效/);
      assert.doesNotMatch(await row(1).textContent(), /旧的手动检查/);
      assert.match(await page.locator('#col-account').textContent(), /未登录/);
    });

    await t.test('an old completed login task cannot override the current logged-out account', async () => {
      task = { kind: 'login', accountId: '1', running: false, loginState: 'authenticated', status: '旧的登录成功', detail: '这是上次登录监测的结果。' };
      accounts[0].loginStatus = 'logged_out'; accounts[0].loginState = '未登录';
      accounts[0].loginMessage = '当前浏览器明确返回未登录'; accounts[0].loginCheckedAt = '2026-10-08 14:00:04';
      await page.evaluate(() => refresh());
      assert.equal(await row(1).getAttribute('data-login-state'), 'logged_out');
      assert.match(await row(1).textContent(), /当前浏览器明确返回未登录/);
      assert.doesNotMatch(await row(1).textContent(), /上次登录监测|旧的登录成功/);
      assert.match(await page.locator('#account-login-status').textContent(), /未登录/);
      assert.match(await page.locator('#col-account').textContent(), /未登录/);
      assert.doesNotMatch(await page.locator('#ov-accounts').textContent(), /已登录/);
    });

    await t.test('a running QR login task keeps live pending progress until it finishes', async () => {
      task = { kind: 'login', accountId: '1', running: true, loginState: 'pending', status: '等待扫码登录', detail: '手机确认仍在等待中，检测剩余 280 秒。' };
      await page.evaluate(() => refresh());
      assert.equal(await row(1).getAttribute('data-login-state'), 'pending');
      assert.match(await row(1).textContent(), /检测剩余 280 秒/);
      assert.match(await page.locator('#account-login-status').textContent(), /等待扫码/);
      assert.equal(await page.locator('#btn-global-stop').isEnabled(), true);
      task = { ...task, running: false, loginState: 'timeout', status: '登录等待超时' };
      await page.evaluate(() => refresh());
      assert.equal(await row(1).getAttribute('data-login-state'), 'logged_out');
      assert.doesNotMatch(await row(1).textContent(), /检测剩余 280 秒/);
    });

    await t.test('login monitor displays timeout, verification, closed browser and stopped reasons', async () => {
      for (const [phase, message] of [
        ['verification_required', '请先在浏览器完成人工验证。'],
        ['browser_closed', '登录浏览器已被关闭，监测结束。'],
        ['timeout', '五分钟内未检测到登录，请重新打开登录。'],
        ['stopped', '用户点击停止，本次登录监测已取消。'],
        ['unknown', '页面证据不足，登录状态仍待确认。']
      ]) {
        task = { kind: 'login', accountId: '1', running: phase === 'verification_required', loginState: phase, status: loginPhaseDescription(phase), detail: message };
        accounts[0].loginStatus = phase; accounts[0].loginState = loginPhaseDescription(phase); accounts[0].loginMessage = message;
        await page.evaluate(() => refresh());
        await page.waitForFunction(({ phase, message }) => document.getElementById('account-login-status').dataset.state === phase && document.getElementById('account-login-status').textContent.includes(message), { phase, message });
        assert.equal(await row(1).getAttribute('data-login-state'), phase);
        assert.equal(await page.locator('#btn-global-stop').isEnabled(), true);
      }
    });

    await t.test('task inspection replaces stale account feedback and identical messages display once', async () => {
      const message = '当前作品页登录待确认';
      accounts[0].loginStatus = 'unknown'; accounts[0].loginState = '登录待确认'; accounts[0].loginMessage = message;
      accounts[0].loginCheckedAt = '2026-10-08 12:00:02'; accounts[0].loginAt = '2026-10-08 11:10:11';
      task = { kind: 'collect', accountId: '1', running: false, status: '任务暂停：' + message, detail: message };
      await page.evaluate(() => refresh());
      await page.waitForFunction(() => document.querySelector('[data-account-row="1"] .account-login-cell').dataset.loginState === 'unknown');
      assert.match(await row(1).textContent(), /最近检查：2026-10-08 12:00:02/);
      assert.match(await row(1).textContent(), /最近确认登录：2026-10-08 11:10:11/);
      assert.doesNotMatch(await row(1).textContent(), /授权操作检查完成/);
      task = { kind: 'login', accountId: '1', running: false, loginState: 'unknown', status: message, detail: message };
      await page.evaluate(() => refresh());
      const text = await row(1).textContent();
      assert.equal(text.split(message).length - 1, 1, 'status/detail copies must not appear twice');
      assert.equal(await row(2).getAttribute('data-login-state'), 'logged_out');
    });

    await t.test('account errors preserve exact failure reasons and do not reject promises', async () => {
      actionFailure = true; await action('check').click();
      await page.waitForFunction(() => document.getElementById('account-login-status').textContent.includes('测试浏览器连接已断开'));
      assert.equal(await row(1).getAttribute('data-login-state'), 'error');
      actionFailure = false;
      await page.locator('#btn-add-acc').click();
      await page.waitForFunction(() => document.getElementById('account-login-status').textContent.includes('测试账号名称已存在'));
      assert.equal(await page.locator('#acc-name').inputValue(), '正在编辑的新账号');
      assert.equal(await page.locator('#acc-note').inputValue(), '不要覆盖表单');
      assert.equal(await page.locator('#btn-add-acc').isEnabled(), true);
      assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
    });

    await t.test('state polling failures report inline and successful recovery clears stale polling errors', async () => {
      stateFailure = true; await page.evaluate(() => refresh());
      assert.match(await page.locator('#account-login-status').textContent(), /状态更新未完成.*本机状态服务暂不可用/);
      stateFailure = false;
      task = { kind: 'login', accountId: '1', running: false, loginState: 'authenticated', status: '登录成功', detail: '本机状态服务已恢复，已确认登录。' };
      accounts[0].loginStatus = 'authenticated'; accounts[0].loginState = '已登录'; accounts[0].loginMessage = '本机状态服务已恢复，已确认登录。';
      // Begin a new account check so a previous account-operation error is also replaced.
      checkResult = { ok: true, loggedIn: true, state: 'authenticated', message: '状态服务已恢复。' }; await action('check').click();
      await page.waitForFunction(() => document.getElementById('account-login-status').dataset.state === 'authenticated');
      assert.doesNotMatch(await page.locator('#account-login-status').textContent(), /更新未完成/);
    });

    await t.test('license failures show the authorization reason while the global stop remains callable', async () => {
      expired = true; await action('open').click();
      await page.waitForFunction(() => document.getElementById('login-layer').style.display === 'flex');
      assert.match(await page.locator('#login-err').textContent(), /测试授权已到期/);
      assert.match(await page.locator('#account-login-status').textContent(), /授权已到期/);
      await page.locator('#btn-global-stop').click();
      const stopped = requests.findLast(entry => entry.path === '/api/tasks/stop');
      assert.ok(stopped); assert.equal(stopped.token, 'scan-test-session');
      await page.waitForFunction(() => !document.getElementById('btn-global-stop').disabled);
      assert.equal(await page.locator('#btn-global-stop').isEnabled(), true);
      assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
    });
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

function loginPhaseDescription(phase) {
  return { verification_required: '需要人工验证', browser_closed: '浏览器已关闭', timeout: '登录等待超时', stopped: '登录监测已停止', unknown: '登录状态待确认' }[phase];
}
