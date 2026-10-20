'use strict';
/**
 * 实网冒烟：在真实抖音页面上按顺序跑一遍最小闭环，检查每个基础动作是否收到平台自己的对应响应。
 *
 *   1 个关键词搜 1 页 → 取 2 个作品各采 2 页评论 → 对测试用户执行关注 + 私信
 *
 * 用法（在仓库根目录）：
 *   node build-tools/smoke-real.js                  只打印计划（默认 --dry-run，不启动浏览器、不读写数据）
 *   node build-tools/smoke-real.js --run            真的在账号浏览器里操作
 *   node build-tools/smoke-real.js --run --config=路径  指定配置文件（默认 build-tools/smoke-real.config.json）
 *
 * 配置文件由使用者自己填写（参考 smoke-real.config.example.json），脚本里不放任何真实账号；
 * 配置文件与报告 smoke-real-report.json 都已加入 .gitignore。
 *
 * 原则与正式任务一致：只在账号自己的浏览器里做真人动作（输入、点击、滚动），
 * 数据与结果一律取页面自己发出的签名接口响应，不构造、不重放任何平台请求。
 * 本脚本不写线索库，不改账号设置；需要先在软件里关闭该账号的浏览器窗口（资料目录不能被占用）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'dy-lead-app');
const REPORT = path.join(__dirname, 'smoke-real-report.json');
const argValue = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || '';
const RUN = process.argv.includes('--run');
const CONFIG = path.resolve(argValue('config') || path.join(__dirname, 'smoke-real.config.json'));
const COMMENT_PATH = '/aweme/v1/web/comment/list/';
const PROFILE_PATHS = ['/aweme/v1/web/user/profile/other/', '/aweme/v1/web/user/profile/other'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 动作之间的真人间隔（毫秒，随机抖动）。冒烟只跑一轮，间隔取保守值。
const pause = (min = 2500, max = 5000) => sleep(min + Math.round(Math.random() * (max - min)));

function fail(message) { console.error(message); process.exit(2); }

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    fail(`找不到配置文件：${CONFIG}\n请复制 build-tools/smoke-real.config.example.json 为 smoke-real.config.json 并填写。`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { fail(`配置文件不是有效 JSON：${error.message}`); }
  const config = {
    accountId: String(raw.accountId || '').trim(),
    keyword: String(raw.keyword || '').trim(),
    workType: ['video', 'note', 'mixed'].includes(raw.workType) ? raw.workType : 'video',
    works: Math.min(5, Math.max(1, Number(raw.works) || 2)),
    commentPages: Math.min(5, Math.max(1, Number(raw.commentPages) || 2)),
    follow: raw.follow !== false,
    dm: raw.dm !== false,
    message: String(raw.message || '').trim(),
    testUser: raw.testUser && typeof raw.testUser === 'object' ? {
      homepage: String(raw.testUser.homepage || '').trim(),
      uid: String(raw.testUser.uid || '').trim(),
      UID: String(raw.testUser.UID || '').trim()
    } : null
  };
  const problems = [];
  if (!/^[\w-]{1,100}$/.test(config.accountId)) problems.push('accountId：填写软件里该账号的账号ID（字母数字下划线）');
  if (!config.keyword) problems.push('keyword：填写一个搜索关键词');
  if ((config.follow || config.dm) && !config.testUser) problems.push('testUser：关注/私信需要填写测试用户（或把 follow、dm 都设为 false）');
  if (config.testUser) {
    let url;
    try { url = new URL(config.testUser.homepage); } catch (_) { /* reported below */ }
    const sec = url && url.protocol === 'https:' && ['www.douyin.com', 'douyin.com'].includes(url.hostname)
      && /^\/user\/([\w-]{8,256})\/?$/.exec(url.pathname);
    if (!sec) problems.push('testUser.homepage：填写测试用户主页 https://www.douyin.com/user/<sec_uid>');
    else {
      if (!config.testUser.uid) config.testUser.uid = sec[1];
      if (config.testUser.uid !== sec[1]) problems.push('testUser.uid 必须与主页地址里的 sec_uid 一致');
      config.testUser.homepage = `https://www.douyin.com/user/${sec[1]}`;
    }
    if (config.testUser.UID && !/^[1-9]\d{0,18}$/.test(config.testUser.UID)) problems.push('testUser.UID：数字 UID（可留空，留空时从主页响应读取）');
  }
  if (config.dm && !config.message) problems.push('message：填写私信测试文案');
  if (problems.length) fail('配置不完整：\n- ' + problems.join('\n- '));
  return config;
}

const mask = value => value ? String(value).slice(0, 4) + '…' + String(value).slice(-4) : '';

function plan(config) {
  const steps = [
    `启动账号 ${config.accountId} 的浏览器（软件里该账号的独立资料目录）`,
    `搜索关键词「${config.keyword}」（范围 ${config.workType}），只看第 1 页，等待搜索接口响应`,
    `取前 ${config.works} 个作品，每个打开评论区后翻 ${config.commentPages} 页，每页等待评论接口响应`
  ];
  if (config.follow || config.dm) steps.push(`打开测试用户主页（sec_uid ${mask(config.testUser.uid)}），等待主页接口响应`);
  if (config.follow) steps.push('点击关注，等待本次关注接口回执（status_code=0 且 follow_status=1/2）');
  if (config.dm) steps.push('打开私信 → 核对接收人（协议优先、昵称后备）→ 填写 → 点击发送，等待 IM 发送回执（cmd100 status=0）');
  steps.push(`结果表写入 ${path.relative(ROOT, REPORT)}`);
  return steps;
}

/* ---------------- 实网执行 ---------------- */

function createRecorder() {
  const rows = [];
  return {
    rows,
    async step(action, operation) {
      const started = Date.now();
      const row = { action, responseReceived: false, response: '', elapsedMs: 0, errorCode: '' };
      try {
        const outcome = await operation() || {};
        Object.assign(row, { responseReceived: !!outcome.responseReceived, response: outcome.response || '', errorCode: outcome.errorCode || '' });
        if (outcome.detail) row.detail = outcome.detail;
        return outcome;
      } catch (error) {
        row.errorCode = error.code || 'EXCEPTION';
        row.detail = String(error.message || error).slice(0, 300);
        return { failed: true, error };
      } finally {
        row.elapsedMs = Date.now() - started;
        rows.push(row);
        console.log(`${row.errorCode ? '✖' : row.responseReceived ? '✔' : '…'} ${action}  ${row.response}${row.errorCode ? '  [' + row.errorCode + ']' : ''}  ${row.elapsedMs}ms`);
      }
    }
  };
}

// 只观察当前页自己发出的接口响应：路径匹配后解析 JSON，满足条件即返回。
function waitForResponse(page, match, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true; clearTimeout(timer); page.off('response', onResponse);
      resolve(value);
    };
    const onResponse = response => {
      let url;
      try { url = new URL(response.url()); } catch (_) { return; }
      if (!/(^|\.)douyin\.com$/.test(url.hostname) || !match.path(url)) return;
      response.json().then(json => { const value = match.accept(json, url, response.status()); if (value) finish(value); }).catch(() => {});
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    page.on('response', onResponse);
  });
}

async function main() {
  const config = loadConfig();
  console.log(RUN ? '实网冒烟（--run）计划：' : '实网冒烟计划（--dry-run，未执行任何操作；加 --run 才会真的操作）：');
  plan(config).forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
  if (!RUN) return;

  const { chromium } = require(path.join(APP, 'node_modules', 'playwright-core'));
  const store = require(path.join(APP, 'store'));
  const { resolveBrowserRuntime } = require(path.join(APP, 'lib', 'browser-runtime'));
  const { navigateSearch } = require(path.join(APP, 'engine-search-tasks'));
  const searchWorks = require(path.join(APP, 'lib', 'search-works'));
  const { SEARCH_PATH } = searchWorks;
  // 综合页第一页是流式多段 JSON：有 parseSearchBody 就用它，否则按单个 JSON 解析。
  const parseSearchText = text => typeof searchWorks.parseSearchBody === 'function' ? searchWorks.parseSearchBody(text)
    : (() => { try { return searchWorks.parseSearchResponse(JSON.parse(text)); } catch (_) { return { ok: false, works: [], hasMore: false, reason: '响应正文不是单个 JSON' }; } })();
  const { openComments, scrollComments, navigateCollectionPage } = require(path.join(APP, 'lib', 'collection-browser'));
  const adapter = require(path.join(APP, 'lib', 'outreach-browser'));
  const { createFollowReceiptObserver, createDmReceiptObserver } = require(path.join(APP, 'lib', 'action-receipts'));
  const { observeDmHistory } = require(path.join(APP, 'lib', 'dm-history-observer'));

  const account = store.getAccounts().find(item => String(item.id) === config.accountId);
  if (!account) fail(`软件里没有账号 ${config.accountId}`);
  if (account.browserMode === 'embedded') fail('该账号使用客户端内嵌浏览器，冒烟脚本只支持系统 Chrome 资料目录');
  // 与 engine.parseProxy 相同的写法：scheme://[user:pass@]host:port
  const proxyMatch = account.proxy && String(account.proxy).trim().match(/^(\w+):\/\/(?:([^:@]+):([^@]*)@)?([^:]+):(\d+)$/);
  const proxy = proxyMatch ? { server: `${proxyMatch[1]}://${proxyMatch[4]}:${proxyMatch[5]}`, username: proxyMatch[2] || undefined, password: proxyMatch[3] || undefined } : undefined;

  const recorder = createRecorder();
  const report = { startedAt: new Date().toISOString(), account: mask(config.accountId), keyword: config.keyword, workType: config.workType, steps: recorder.rows };
  const scheduler = { checkStopped() {} };
  const navigation = { authorize: async () => true, checkStopped() {} };
  let context;
  try {
    const launched = await recorder.step('启动账号浏览器', async () => {
      const runtime = resolveBrowserRuntime({ appDir: APP });
      context = await chromium.launchPersistentContext(store.profileDir(account.id), {
        executablePath: runtime.executablePath, headless: false, chromiumSandbox: true, viewport: { width: 1280, height: 860 },
        timeout: 45000, args: ['--window-size=1280,900'], ...(proxy ? { proxy } : {})
      });
      return { responseReceived: true, response: runtime.source };
    });
    if (launched.failed) return;
    const page = context.pages()[0] || await context.newPage();

    // 1) 搜索 1 页
    let works = [];
    await recorder.step(`搜索「${config.keyword}」第 1 页`, async () => {
      // 与正式搜索一致：点范围页签前清空“综合”页已到的结果，只认页签切换后的第 1 页响应。
      let latest = null, epoch = 0;
      const onResponse = response => {
        let url;
        try { url = new URL(response.url()); } catch (_) { return; }
        if (!/(^|\.)douyin\.com$/.test(url.hostname) || !SEARCH_PATH.test(url.pathname)) return;
        const generation = epoch;
        response.text().then(text => { if (generation === epoch && !latest) latest = parseSearchText(text); }).catch(() => {});
      };
      page.on('response', onResponse);
      try {
        const nav = await navigateSearch(page, config.keyword, config.workType, scheduler, { onBeforeTab: () => { epoch++; latest = null; } });
        for (const until = Date.now() + 20000; !latest && Date.now() < until;) await sleep(250);
        if (!latest) return { errorCode: 'SEARCH_RESPONSE_MISSING', detail: `页签确认：${nav.tabVerified}` };
        const parsed = latest;
        works = parsed.works.filter(work => /\/(?:video|note)\/\d+/.test(work.link || '')).slice(0, config.works);
        return { responseReceived: true, response: `作品 ${parsed.works.length} 个 has_more=${parsed.hasMore ? 1 : 0} 页签确认=${nav.tabVerified}`,
          errorCode: parsed.ok ? (works.length ? '' : 'SEARCH_NO_WORKS') : 'SEARCH_STATUS', detail: parsed.reason };
      } finally { page.off('response', onResponse); }
    });

    // 2) 每个作品采 N 页评论
    for (const [index, work] of works.entries()) {
      await pause();
      const id = /\/(?:video|note)\/(\d+)/.exec(work.link)[1];
      const commentResponse = timeoutMs => waitForResponse(page, { path: url => url.pathname === COMMENT_PATH && url.searchParams.get('aweme_id') === id,
        accept: json => ({ json }) }, timeoutMs);
      const describe = json => `status_code=${json.status_code ?? '-'} 评论 ${Array.isArray(json.comments) ? json.comments.length : 0} 条 has_more=${json.has_more ?? '-'}`;
      let hasMore = true;
      const first = await recorder.step(`作品${index + 1} 打开 + 评论第 1 页`, async () => {
        const responded = commentResponse(30000);
        await navigateCollectionPage(page, `https://www.douyin.com/${work.link.includes('/note/') ? 'note' : 'video'}/${id}`, navigation);
        let entry = null;
        for (let attempt = 0; attempt < 40 && !(entry && ['ready', 'available'].includes(entry.state)); attempt++) {
          entry = await page.evaluate(openComments, { probe: true }).catch(() => null);
          if (!entry || !['ready', 'available'].includes(entry.state)) await sleep(250);
        }
        if (!entry || !['ready', 'available'].includes(entry.state)) return { errorCode: 'COMMENT_PANEL_NOT_FOUND' };
        if (entry.state === 'available') await page.evaluate(openComments);
        const result = await responded;
        if (!result) return { errorCode: 'COMMENT_RESPONSE_MISSING', detail: `评论入口状态：${entry.state}` };
        hasMore = Number(result.json.has_more) === 1;
        return { responseReceived: true, response: describe(result.json), errorCode: result.json.status_code === 0 ? '' : 'COMMENT_STATUS' };
      });
      for (let pageNo = 2; pageNo <= config.commentPages && !first.failed && !first.errorCode && hasMore; pageNo++) {
        await pause(1500, 3000);
        await recorder.step(`作品${index + 1} 评论第 ${pageNo} 页`, async () => {
          const responded = commentResponse(20000);
          const scroll = await page.evaluate(scrollComments).catch(() => null);
          const result = await responded;
          if (!result) return { errorCode: 'NO_PROGRESS', detail: `滚动状态：${scroll && scroll.state}` };
          hasMore = Number(result.json.has_more) === 1;
          return { responseReceived: true, response: describe(result.json), errorCode: result.json.status_code === 0 ? '' : 'COMMENT_STATUS' };
        });
      }
    }

    // 3) 测试用户：主页 → 关注 → 私信
    if (config.follow || config.dm) {
      await pause();
      const lead = { uid: config.testUser.uid, UID: config.testUser.UID, homepage: config.testUser.homepage };
      const visited = await recorder.step('打开测试用户主页', async () => {
        const responded = waitForResponse(page, { path: url => PROFILE_PATHS.includes(url.pathname),
          accept: json => json && json.user && json.user.sec_uid === lead.uid ? { json } : null }, 30000);
        await navigateCollectionPage(page, lead.homepage, navigation);
        const result = await responded;
        if (!result) return { errorCode: 'PROFILE_RESPONSE_MISSING' };
        const numeric = String(result.json.user.uid || '');
        if (!lead.UID && /^[1-9]\d{0,18}$/.test(numeric)) lead.UID = numeric;
        return { responseReceived: true, response: `status_code=${result.json.status_code ?? '-'} follow_status=${result.json.user.follow_status ?? '-'} 数字UID${lead.UID ? '已取得' : '缺失'}` };
      });
      const options = { checkStopped() {} };
      if (config.follow && !visited.failed) {
        await pause();
        await recorder.step('关注测试用户', async () => {
          const prepared = await adapter.prepareFollow(page, lead, options);
          if (prepared.state === 'already') return { response: '主页已显示关注关系，未点击', errorCode: 'FOLLOW_ALREADY' };
          if (prepared.state !== 'ready') return { errorCode: 'FOLLOW_CONTROL_UNAVAILABLE', detail: prepared.reason };
          const receipt = createFollowReceiptObserver({ page, targetUid: lead.uid, targetSecUid: lead.uid, targetNumericUid: lead.UID || undefined, timeoutMs: 15000 });
          receipt.arm();
          await prepared.click();
          const outcome = await receipt.wait();
          return { responseReceived: outcome.state === 'confirmed_success', response: outcome.evidence || outcome.reason,
            errorCode: outcome.state === 'confirmed_success' ? '' : 'FOLLOW_PENDING_VERIFICATION' };
        });
      }
      if (config.dm && !visited.failed) {
        await pause();
        const receipt = createDmReceiptObserver({ page, targetUid: lead.uid, targetSecUid: lead.uid, targetNumericUid: lead.UID || undefined });
        const history = observeDmHistory({ page, targetSecUid: lead.uid, targetNumericUid: lead.UID || undefined });
        const dmOptions = { ...options, recipientProtocol: () => history.getRecipientEvidence() };
        const diagnostic = () => { const value = adapter.getDiagnostic(page); return `接收人依据=${value.recipientEvidence || 'unconfirmed'} 协议核验=${value.recipientProtocol || 'none'}`; };
        try {
          const opened = await recorder.step('打开私信会话并核对接收人', async () => {
            if (!await adapter.openDirectMessage(page, lead, dmOptions)) return { errorCode: adapter.getDiagnostic(page).code || 'DM_ENTRY_UNAVAILABLE' };
            const ready = await adapter.ensureDirectMessageConversation(page, lead, dmOptions);
            const historyOutcome = await history.wait({ timeoutMs: 1500, keepAlive: true });
            const protocol = history.getRecipientEvidence();
            return { responseReceived: protocol.targetResponses > 0, errorCode: ready ? '' : adapter.getDiagnostic(page).code || 'DM_RECIPIENT_UNCONFIRMED',
              response: `${diagnostic()} 目标会话历史请求/响应=${protocol.targetRequests}/${protocol.targetResponses} 其他会话=${protocol.foreignRequests} 无法归属=${protocol.unattributedRequests} 历史=${historyOutcome.state}` };
          });
          if (!opened.failed && !opened.errorCode) {
            await recorder.step('填写并发送私信', async () => {
              if (!await adapter.fillDirectMessage(page, lead, config.message, dmOptions)) return { errorCode: adapter.getDiagnostic(page).code || 'DM_EDITOR_UNAVAILABLE' };
              const prepared = await adapter.prepareSend(page, lead, config.message, dmOptions);
              if (prepared.state !== 'ready') return { errorCode: prepared.code || 'DM_SEND_UNAVAILABLE', detail: prepared.reason };
              // 与正式流程一致：发送前冻结历史观察，本次发送的流量不会被当成历史或接收人证据。
              history.dispose();
              receipt.arm({ message: config.message });
              await prepared.click();
              await receipt.waitForReceipt({ timeoutMs: 30000 });
              const outcome = receipt.getOutcome();
              return { responseReceived: ['confirmed_success', 'confirmed_failure'].includes(outcome.state), response: `${outcome.state} ${outcome.evidence || outcome.reason || ''} ${diagnostic()}`.trim(),
                errorCode: outcome.state === 'confirmed_success' ? '' : outcome.failureCode || (outcome.state === 'confirmed_failure' ? 'DM_REJECTED' : 'DM_PENDING_VERIFICATION') };
            });
          }
        } finally { history.dispose(); receipt.dispose(); }
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.passed = recorder.rows.length > 0 && recorder.rows.every(row => !row.errorCode);
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.table(recorder.rows.map(row => ({ 动作: row.action, 收到对应响应: row.responseReceived ? '是' : '否', 耗时ms: row.elapsedMs, 错误码: row.errorCode || '-' })));
    console.log(`报告已写入 ${REPORT}`);
    if (context) await context.close().catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exit(1); });
