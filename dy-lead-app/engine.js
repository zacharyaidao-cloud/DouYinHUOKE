/**
 * 抖音获客软件 - 自动化引擎（Playwright 驱动浏览器）
 * 每个账号一个独立持久化浏览器配置（登录态永久保存），支持每账号独立代理。
 * 每账号可选外部专用浏览器或客户端内嵌页面，两种模式分别保存登录资料。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const crypto = require('crypto');
const workflow = require('./workflow');
const { matchIntent: screenKeywords } = require('./lib/keyword-screen');
const { ActionScheduler, TaskStopError, bounded } = require('./scheduler');
const { createLoginMonitor, inspectLoginState } = require('./lib/login-state');
const { createAccountLoginController } = require('./lib/account-login');
const { createAccountLoginScan } = require('./lib/account-login-scan');
const { assertTaskLogin } = require('./lib/task-login');
const { parseVideoLinks, normalizeVideoLink, workIdFromLink } = require('./lib/video-links');
const { openComments, scrollComments, landingWork, navigateCollectionPage } = require('./lib/collection-browser');
const { selectWorkDetail, workDescription } = require('./lib/work-metadata');
const { recordWorkDetail, recordPageMetadata } = require('./lib/work-record');
const { readPageWorkMetadata } = require('./lib/page-work-metadata');
const { readPageComments } = require('./lib/page-comments');
const { userMetadata, identifier } = require('./lib/user-metadata');
const { commentEvidence } = require('./lib/comment-evidence');
const { resolveBrowserRuntime, browserLaunchError } = require('./lib/browser-runtime');
const { createEmbeddedBrowserClient } = require('./lib/embedded-browser-client');
let embeddedBrowserClient;
let hooks = {
  authorize: async () => { throw new TaskStopError('尚未初始化授权校验，已拒绝对外操作', 'AUTH_REQUIRED'); },
  dmVerifier: async ({ receipt } = {}) => receipt && typeof receipt.getOutcome === 'function'
    ? receipt.getOutcome()
    : ({ state: 'pending_verification', reason: '尚未取得本次目标消息的明确业务回执，请人工核验' })
};
let taskAbort = null;
function configure(options = {}) {
  if (options.authorize !== undefined) {
    if (typeof options.authorize !== 'function') throw new Error('authorize 必须为函数');
    hooks.authorize = options.authorize;
  }
  if (options.dmVerifier !== undefined) {
    if (typeof options.dmVerifier !== 'function') throw new Error('dmVerifier 必须为函数');
    hooks.dmVerifier = options.dmVerifier;
  }
}
async function authorize(meta) {
  if (taskState.stopRequested && taskState.running) throw new TaskStopError();
  let r;
  try { r = await hooks.authorize(meta); }
  catch (e) { throw new TaskStopError(e.message || '授权校验失败，已暂停任务', 'AUTH_REQUIRED'); }
  if (r === false || r && (r.ok === false || r.valid === false)) throw new TaskStopError(r && r.error || '授权失效，任务已暂停', 'AUTH_REQUIRED');
}
function makeScheduler(settings, { errorBoundary = 'action' } = {}) {
  return new ActionScheduler({ settings, stopped: () => taskState.stopRequested, authorize, sleep: SLEEP, update: setTask, errorBoundary });
}
function checkpoint(patch) {
  const current = typeof store.getTaskCheckpoint === 'function' ? store.getTaskCheckpoint() || {} : {};
  const next = { ...current, ...patch, updatedAt: store.nowStr() };
  if (typeof store.setTaskCheckpoint === 'function') store.setTaskCheckpoint(next);
  taskState.checkpoint = next;
  return next;
}

/* ---------- 浏览器选择：系统 Chrome 优先，无则内置 Chromium ---------- */
function pickBrowserOpts() {
  return { executablePath: resolveBrowserRuntime({ appDir: __dirname }).executablePath };
}

function logBrowserFailure(accountId, failure, source = '') {
  try {
    store.log(accountId, `浏览器启动失败 [${failure.code}] ${failure.message}${source ? '（' + source + (failure.browserExitCode == null ? '' : '，退出码: ' + failure.browserExitCode) + '）' : ''}`);
  } catch (_) { /* A log write failure must not replace the launch diagnosis. */ }
}

const SLEEP = ms => new Promise(resolve => {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  const tick = () => {
    if (taskState.stopRequested || Date.now() >= end) return resolve();
    setTimeout(tick, Math.min(250, end - Date.now()));
  };
  tick();
});

/** 代理字符串解析：http://user:pass@host:port / socks5://host:port */
function parseProxy(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\w+):\/\/(?:([^:@]+):([^@]*)@)?([^:]+):(\d+)$/);
  if (!m) return null;
  return {
    server: `${m[1]}://${m[4]}:${m[5]}`,
    username: m[2] || undefined,
    password: m[3] || undefined
  };
}

/* ===================== 任务状态（供界面轮询） ===================== */

const taskState = {
  accountId: null,
  kind: null, // collect | follow | dm | login | login_scan
  running: false,
  // 分发任务在批次之间 running 会短暂为 false；这个标志覆盖整个分发生命周期，
  // 不能再用 kind 兼职，否则任务结束后 kind 残留会让 engineBusy 永远为真。
  distributionActive: false,
  stopRequested: false,
  // 单调递增的停止请求序号。批次重启会重置 stopRequested，但不会回退它。
  stopEpoch: 0,
  status: '',
  done: 0,
  total: 0,
  errors: [],
  startedAt: null,
  attempts: 0,
  consecutiveErrors: 0,
  waitingUntil: null
};

function setTask(patch) {
  if (patch.running === true) {
    taskState.stopRequested = false;
    taskState.detail = '';
    taskState.startedAt = store.nowStr();
    taskState.attempts = 0;
    taskState.consecutiveErrors = 0;
    taskState.waitingUntil = null;
    taskState.aiBudget = null;
    taskState.aiUsage = null;
    taskState.aiBaseBudget = null;
    taskState.stage = patch.kind === 'ai' ? 'ai' : 'preparing';
    taskState.currentLead = null;
    taskState.currentUserIndex = null;
    taskState.totalUsers = null;
    taskState.currentWork = null;
    taskState.waitingReason = null;
    taskAbort = new AbortController();
  }
  Object.assign(taskState, patch);
  if (patch.running === false) { taskState.waitingUntil = null; taskState.waitingReason = null; }
}

/* ===================== 浏览器上下文管理 ===================== */

const contexts = new Map(); // accountId -> { context, page }

function getAlive(accountId) {
  const c = contexts.get(String(accountId));
  if (c && c.context) return c;
  return null;
}

async function launchAccount(accountId, { headless = false, checkStopped = () => {}, onCreated } = {}) {
  await authorize({ accountId, kind: 'browser' });
  checkStopped();
  const acc = store.getAccounts().find(a => String(a.id) === String(accountId));
  if (!acc) throw new Error('账号不存在');
  const embedded = acc.browserMode === 'embedded';
  if (embedded && process.env.DY_LEAD_EMBEDDED_BROWSER !== '1') {
    throw browserLaunchError(Object.assign(new Error('内嵌浏览器需要桌面客户端'), { code: 'BROWSER_EMBEDDED_UNAVAILABLE' }));
  }
  const existing = getAlive(accountId);
  if (existing) {
    if (existing.page.isClosed()) {
      const openPage = existing.context.pages().find(page => !page.isClosed());
      if (openPage) existing.page = openPage;
    }
    const sameMode = !!existing.embedded === embedded;
    if (sameMode && !existing.page.isClosed() && existing.embedded) {
      if (existing.headless && !headless) { await existing.show(); checkStopped(); existing.headless = false; }
      return existing;
    }
    if (sameMode && !existing.page.isClosed() && !(existing.headless === true && !headless)) return existing;
    // A visible login request must never reuse an invisible startup context.
    // Wait for release of the exact old profile before starting the new window.
    try { await existing.context.close(); }
    catch (error) { throw browserLaunchError(error); }
    if (getAlive(accountId)?.context === existing.context) contexts.delete(String(accountId));
  }
  let userDataDir, runtime;
  try {
    // Validate with the same account identifier rule before constructing either
    // directory. Never point Electron at, mutate or downgrade a Chrome profile.
    const oldProfile = store.profileDir(acc.id);
    userDataDir = embedded ? path.join(path.resolve(store.DATA_DIR), 'electron-profiles', path.basename(oldProfile)) : oldProfile;
    runtime = embedded ? { source: '客户端内嵌 Chromium' } : resolveBrowserRuntime({ appDir: __dirname });
  } catch (error) {
    const failure = browserLaunchError(error);
    logBrowserFailure(acc.id, failure);
    throw failure;
  }
  const browserOpts = { executablePath: runtime.executablePath };
  const opts = {
    ...browserOpts,
    headless,
    chromiumSandbox: true,
    viewport: { width: 1280, height: 860 },
    // 同一 profile 被上一次异常退出的窗口占用时，Playwright 可能一直等 CDP。
    // 45 秒内起不来就交给上层给出可操作提示，避免界面无限“检查中”。
    timeout: 45000,
    args: ['--window-size=1280,900']
  };
  const proxy = parseProxy(acc.proxy);
  if (proxy) opts.proxy = proxy;

  checkStopped();
  let context, embeddedAlive;
  try {
    if (embedded) {
      if (!embeddedBrowserClient) embeddedBrowserClient = createEmbeddedBrowserClient({ chromium });
      if (!embeddedBrowserClient.isAvailable()) throw Object.assign(new Error('内嵌浏览器连接不可用'), { code: 'BROWSER_EMBEDDED_UNAVAILABLE' });
      embeddedAlive = await embeddedBrowserClient.open({ accountId: String(acc.id), name: acc.name, profileDir: userDataDir, proxy, visible: !headless, checkStopped });
      context = embeddedAlive.context;
    } else context = await chromium.launchPersistentContext(userDataDir, opts);
  }
  catch (error) {
    const failure = browserLaunchError(error);
    logBrowserFailure(acc.id, failure, runtime.source);
    throw failure;
  }
  try {
    checkStopped();
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    checkStopped();
    const loginMonitor = createLoginMonitor(context, page);
    const alive = { ...embeddedAlive, embedded, context, page, loginMonitor, headless: !!headless };
    contexts.set(String(acc.id), alive);
    page.on('response', response => passiveProfileResponse(response).catch(() => {}));
    context.on('close', () => {
      loginMonitor.dispose();
      if (getAlive(acc.id)?.context === context) contexts.delete(String(acc.id));
    });
    if (typeof onCreated === 'function') onCreated(alive);
    const browserSource = runtime.source;
    store.log(acc.id, `浏览器已启动（${browserSource}，user-data: ${userDataDir}${proxy ? '，代理: ' + proxy.server : ''}）`);
    return alive;
  } catch (error) {
    try { await context.close(); } catch (_) { /* release an aborted launch */ }
    throw error;
  }
}

async function closeAccount(accountId, { strict = false } = {}) {
  const c = contexts.get(String(accountId));
  if (c) {
    try { await c.context.close(); } catch (e) {
      if (strict) throw new Error('账号浏览器未能关闭，请关闭该窗口后重试切换；原模式和资料已保留');
    }
    contexts.delete(String(accountId));
  }
}

/* ===================== 登录检测 ===================== */

async function isLoggedIn(page) {
  return (await inspectLoginState(page)).loggedIn;
}

async function checkAccountPageHealth(page, accountId, uid) {
  return assertTaskLogin(page, accountId, { store, health: () => assertPageHealth(page, accountId, uid), checkStopped: () => {
    if (taskState.stopRequested && taskState.running) throw new TaskStopError();
  } });
}

const loginController = createAccountLoginController({
  store, taskState, setTask, authorize, launchAccount, getAlive, sleep: SLEEP,
  getMonitor: alive => alive.loginMonitor || createLoginMonitor(alive.context, alive.page)
});
const openForLogin = accountId => loginController.openForLogin(accountId);
const checkLogin = accountId => loginController.checkLogin(accountId);
const scanAccountLogins = createAccountLoginScan({
  store, taskState, setTask, authorize, launchAccount, getAlive,
  getSignal: () => taskAbort && taskAbort.signal,
  getMonitor: alive => {
    if (!alive.loginMonitor) alive.loginMonitor = createLoginMonitor(alive.context, alive.page);
    return alive.loginMonitor;
  }
});

/* ===================== 工具：解析接口数据 ===================== */

function fmtTs(sec) {
  if (!sec) return '';
  const d = new Date(Number(sec) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dedupeKey(l) {
  // Older history may store a generic video URL for an image work. The work ID
  // also removes stale share queries, so revisiting its note URL cannot create
  // duplicate comments merely because its renderer or address changed.
  return [l.accountId, workIdFromLink(l.videoLink) || l.videoLink, l.uid, (l.demand || l.nickname || '').trim()].join('||');
}

function matchIntent(text, keywords) {
  return screenKeywords(text, keywords);
}

function applyTemplate(tpl, lead) {
  return String(tpl || '')
    .replace(/\{昵称\}/g, lead.nickname || '')
    .replace(/\{评论内容\}/g, (lead.demand || '').slice(0, 40))
    .replace(/\{属地\}/g, lead.region || '');
}

function applyProfileData(user, sourcePath = '/aweme/v1/web/user/profile/other/') {
  const secUid = user && identifier(user.sec_uid);
  if (!secUid) return 0;
  const all = store.getLeads(), hits = all.filter(l => String(l.uid) === secUid);
  const capturedAt = store.nowStr();
  const fields = userMetadata(user, { sourcePath, capturedAt });
  for (const lead of hits) {
    const sources = { ...(lead.userFieldSources || {}), ...(fields.userFieldSources || {}) };
    Object.assign(lead, fields, { userFieldSources: sources });
    if (sourcePath === '/aweme/v1/web/user/profile/other/') {
      lead.profileSourcePath = sourcePath;
      lead.profileCapturedAt = capturedAt;
    }
  }
  if (hits.length) store.setLeads(all);
  return hits.length;
}
async function passiveProfileResponse(response) {
  const u = new URL(response.url());
  if (u.protocol !== 'https:' || !/(^|\.)douyin\.com$/.test(u.hostname) || u.pathname !== '/aweme/v1/web/user/profile/other/') return;
  const json = await response.json();
  if (!json || ![0, '0'].includes(json.status_code) || !json.user) return;
  const requestedUser = u.searchParams.get('sec_user_id');
  if (requestedUser && requestedUser !== identifier(json.user.sec_uid)) return;
  applyProfileData(json.user, u.pathname);
}

/* ===================== 线索状态（关注/私信独立标志） ===================== */

/** 由独立标志推导显示状态：未处理/已关注/已私信/已关注+已私信/无法私信/已回复 */
function refreshLeadStatus(l) {
  const followed = !!l.followedAt;
  const dmDone = (l.dmCount || 0) > 0;
  if (l.replied) l.status = 'replied';
  else if (l.doNotContact) l.status = 'do_not_contact';
  else if (l.dmState === 'pending_verification') l.status = 'dm_pending';
  else if (l.followState === 'pending_verification') l.status = 'follow_pending';
  else if (l.noDm && l.noDmConfirmed) l.status = 'no_dm';
  else if (l.dmState === 'confirmed_failure') l.status = 'dm_failed';
  else if (l.followState === 'confirmed_failure') l.status = 'follow_failed';
  else if (followed && dmDone) l.status = 'followed_dm';
  else if (followed) l.status = 'followed';
  else if (dmDone) l.status = 'dm_sent';
  else l.status = 'new';
  return l.status;
}

/** 旧数据迁移：status 单值 → 独立标志 */
function migrateLeads() {
  const leads = store.getLeads();
  let changed = false;
  for (const l of leads) {
    if (['followed', 'followed_dm'].includes(l.status) && !l.followedAt) { l.followedAt = store.nowStr(); changed = true; }
    if (['dm_sent', 'followed_dm'].includes(l.status) && (!l.dmLastAt || !(l.dmCount > 0))) { l.dmLastAt = l.dmLastAt || l.dmSentAt || store.nowStr(); l.dmCount = Math.max(1, Number(l.dmCount) || 0); changed = true; }
    // 旧版仅凭按钮缺失标记 no_dm，不能当成永久的平台权限结论。
    if (l.noDm && !l.noDmConfirmed || l.status === 'no_dm' && !l.noDmConfirmed) { l.noDm = false; l.dmFailedReason = '旧版私信权限结论未核验，需在实际访问时检查'; changed = true; }
    if (l.status === 'no_dm' && l.noDmConfirmed && !l.noDm) { l.noDm = true; changed = true; }
    if (l.status === 'replied' && !l.replied) { l.replied = true; changed = true; }
    if (l.dmCount == null) { l.dmCount = 0; changed = true; }
    const oldStatus = l.status;
    refreshLeadStatus(l);
    if (oldStatus !== l.status) changed = true;
  }
  if (changed) store.setLeads(leads);
  return leads;
}

/** 关注队列：还没关注的（可过滤意向/AI） */
function selectedLeads(all, accountId, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('线索范围必须为对象');
  if (options.leadIds !== undefined && !Array.isArray(options.leadIds)) throw new Error('leadIds 必须为数组');
  let scoped = options.crossAccount === true ? [...all] : all.filter(l => String(l.accountId) === String(accountId));
  if (options.leadIds !== undefined) {
    if (options.leadIds.some(id => !['string', 'number'].includes(typeof id) || !String(id).trim())) throw new Error('线索 ID 无效');
    const ids = new Set(options.leadIds.map(String));
    if ([...ids].some(id => !scoped.some(l => String(l.id) === id))) throw new Error('选中线索已删除或不属于当前账号，请刷新后预检查');
    scoped = scoped.filter(l => ids.has(String(l.id)));
  }
  if (options.filters !== undefined) {
    if (!options.filters || typeof options.filters !== 'object' || Array.isArray(options.filters)) throw new Error('filters 必须为对象');
    if (options.filters.f && !['all', 'trigger', 'ai', 'unfollowed', 'undm', 'pending', 'ai_todo', 'ai_yes', 'ai_no', 'ai_stale'].includes(options.filters.f)) throw new Error('筛选模式无效，请刷新后重试');
    scoped = require('./lead-query').filterLeads(scoped, store.getVideos(), options.filters, { settings: store.getSettings(), now: Date.now() });
  }
  return scoped;
}
function buildFollowQueue(accountId, settings, options = {}) {
  const all = store.getLeads(), history = workflow.historyIndex(all, settings);
  return workflow.uniqueContacts(selectedLeads(all, accountId, options).filter(l => workflow.eligibility(l, 'follow', history, settings, Date.now(), store.getVideos()).ok), settings);
}

function saveLeadAction(lead, kind, settings = store.getSettings()) {
  const all = store.getLeads();
  const fields = kind === 'follow'
    ? ['followedAt', 'followFailedReason', 'followAttemptAt', 'followAttemptId', 'followAttemptAccountId', 'followState', 'followOutcome', 'followEvidence']
    : ['dmCount', 'dmLastAt', 'dmSentAt', 'noDm', 'noDmConfirmed', 'dmFailedReason', 'dmState', 'dmOutcome', 'dmAttemptAt', 'dmAttemptId', 'dmAttemptAccountId', 'dmEvidence', 'dmMessageHash'];
  for (const current of all) {
    if (workflow.contactKey(current, settings) !== workflow.contactKey(lead, settings)) continue;
    if (kind === 'follow' && String(current.accountId) !== String(lead.accountId)) continue;
    for (const field of fields) if (Object.hasOwn(lead, field)) {
      if (lead[field] === undefined) delete current[field];
      else current[field] = lead[field];
    }
    refreshLeadStatus(current);
  }
  store.setLeads(all);
}

// Observed website history is separate from this application's action receipt.
// Updating it must never create success, a sent count or a new action attempt.
function saveContactObservation(leadId, kind, observation) {
  if (!['follow', 'dm'].includes(kind) || !observation || typeof observation !== 'object' || Array.isArray(observation)) throw new Error('联系观察摘要无效');
  const all = store.getLeads(), settings = store.getSettings(), lead = all.find(row => String(row.id) === String(leadId));
  if (!lead) throw new Error('线索不存在，未保存联系观察');
  const accountId = String(observation.accountId || '');
  if (!accountId) throw new Error('联系观察缺少执行账号');
  const states = kind === 'follow' ? ['following', 'not_following', 'unknown'] : ['already_sent', 'no_outbound', 'unknown'];
  if (!states.includes(observation.state)) throw new Error('联系观察状态无效');
  const checkedAtMs = workflow.observedTime(observation.checkedAtMs || observation.checkedAt);
  if (!checkedAtMs || checkedAtMs > Date.now()) throw new Error('联系观察时间无效');
  const summary = {
    state: observation.state, accountId,
    checkedAt: typeof observation.checkedAt === 'string' ? observation.checkedAt : new Date(checkedAtMs).toISOString(), checkedAtMs,
    source: typeof observation.source === 'string' ? observation.source.slice(0, 100) : '',
    evidence: typeof observation.evidence === 'string' ? observation.evidence.slice(0, 300) : ''
  };
  if (kind === 'dm') {
    summary.complete = observation.complete === true;
    summary.lastSentAt = typeof observation.lastSentAt === 'number' && Number.isFinite(observation.lastSentAt)
      && observation.lastSentAt > 0 && observation.lastSentAt <= checkedAtMs ? observation.lastSentAt : null;
    if (summary.state === 'no_outbound' && !summary.complete) summary.state = 'unknown';
    if (summary.state === 'unknown') return summary;
  }
  const field = kind === 'follow' ? 'followObserved' : 'dmHistoryObserved';
  let changed = false;
  for (const current of all) {
    // 私信观察跨账号共享（记录自带执行账号）；关注观察仅保存到执行账号所在行
    if (workflow.contactKey(current, settings) !== workflow.contactKey(lead, settings)) continue;
    if (kind === 'follow' && String(current.accountId) !== accountId) continue;
    const previousAt = workflow.observedTime(current[field] && (current[field].checkedAtMs || current[field].checkedAt));
    if (previousAt > checkedAtMs) continue;
    if (kind === 'dm') {
      const previousSent = current.dmHistorySentObserved || (current.dmHistoryObserved && current.dmHistoryObserved.state === 'already_sent' ? current.dmHistoryObserved : null);
      // A later incomplete/unknown view must not erase confirmed outbound history.
      if (previousSent) current.dmHistorySentObserved = { ...previousSent };
      if (summary.state === 'already_sent') {
        const saved = { ...summary };
        if (previousSent) {
          if (!previousSent.lastSentAt && !summary.complete) saved.lastSentAt = null;
          else if (previousSent.lastSentAt && saved.lastSentAt) saved.lastSentAt = Math.max(previousSent.lastSentAt, saved.lastSentAt);
        }
        current.dmHistorySentObserved = saved;
      }
    }
    current[field] = { ...summary };
    changed = true;
  }
  if (changed) store.setLeads(all);
  return summary;
}

/** 私信队列：没私信过的，或允许重复且已过间隔天数；排除作者/关闭私信/已回复 */
function buildDmQueue(accountId, settings, options = {}) {
  const all = store.getLeads();
  return workflow.uniqueContacts(selectedLeads(all, accountId, options).filter(l => workflow.eligibility(l, 'dm', all, settings, Date.now(), store.getVideos()).ok), settings);
}

const planCache = [];
function readPlans() { return typeof store.getPlans === 'function' ? store.getPlans() : planCache; }
function writePlans(plans) { if (typeof store.setPlans === 'function') store.setPlans(plans); else planCache.splice(0, planCache.length, ...plans); }
function createPlan(accountId, kind = 'outreach', options = {}) {
  if (!['follow', 'dm', 'outreach'].includes(kind)) throw new Error('计划类型无效');
  if (!store.getAccounts().some(a => String(a.id) === String(accountId))) throw new Error('账号不存在');
  const settings = store.getSettings(), all = store.getLeads();
  const actions = { follow: kind === 'follow' || kind === 'outreach' && options.follow !== false && !!settings.follow.enabled, dm: kind === 'dm' || kind === 'outreach' && options.dm !== false && !!settings.dm.enabled };
  const dmTemplate = actions.dm
    ? (typeof options.dmTemplate === 'string' && options.dmTemplate.trim() ? options.dmTemplate : settings.dm.template)
    : '';
  if (actions.dm && (typeof dmTemplate !== 'string' || !dmTemplate.trim())) throw new Error('私信话术必须为非空文本，请先保存有效话术再预检查');
  const selected = selectedLeads(all, accountId, { ...options, crossAccount: options.crossAccount === true });
  const videos = store.getVideos(), quota = workflow.getQuotas(settings, store.getDailyUsage(accountId));
  const remaining = { follow: quota.follow.remaining, dm: quota.dm.remaining, profile: quota.profile.remaining };
  // 预检只计算当前额度，不占用额度。每位用户同时冻结其操作，运行期间仅允许收窄。
  // 历史按 contactKey 建一次索引：否则每条线索都要全库扫描，1.7 万条约 30 秒。
  const now = Date.now(), history = workflow.historyIndex(all, settings);
  const decisionOptions = { accountId: String(accountId) };
  const decisions = new Map(), matched = [];
  for (const lead of selected) {
    // 采集账号与执行账号解耦：任意执行账号都按统一规则做关注与私信。
    // 是否已关注由 workflow.eligibility 依据「执行账号自己的关注历史」判定（跨账号各自独立）。
    const follow = actions.follow ? workflow.eligibility(lead, 'follow', history, settings, now, videos, decisionOptions) : { ok: false };
    const dm = actions.dm ? workflow.eligibility(lead, 'dm', history, settings, now, videos, decisionOptions) : { ok: false };
    if (!follow.ok && !dm.ok) continue;
    decisions.set(String(lead.id), { follow: follow.ok, dm: dm.ok });
    matched.push(lead);
  }
  const candidates = workflow.uniqueContacts(matched, settings);
  const available = { ...remaining }, queue = [], perUserActions = new Map();
  const limited = { follow: 0, dm: 0, profile: 0 }, plannedCounts = { follow: 0, dm: 0, profile: 0 };
  for (const lead of candidates) {
    const decision = decisions.get(String(lead.id)) || { follow: false, dm: false };
    const eligible = { follow: decision.follow, dm: decision.dm };
    const planned = { follow: eligible.follow && available.follow > 0, dm: eligible.dm && available.dm > 0 };
    for (const action of ['follow', 'dm']) if (eligible[action] && !planned[action]) limited[action]++;
    if (!planned.follow && !planned.dm) continue;
    if (!available.profile) { limited.profile++; continue; }
    queue.push(lead); perUserActions.set(String(lead.id), planned);
    available.profile--; plannedCounts.profile++;
    for (const action of ['follow', 'dm']) if (planned[action]) { available[action]--; plannedCounts[action]++; }
  }
  const frozenMessages = new Map();
  for (const lead of queue) {
    if (!perUserActions.get(String(lead.id)).dm) continue;
    const message = applyTemplate(dmTemplate, lead).trim();
    if (!message) throw new Error(`编号 ${lead.id} 的私信话术代入后为空，请补充话术再预检查`);
    frozenMessages.set(String(lead.id), message);
  }
  const warnings = [];
  if (limited.follow) warnings.push(`今日关注尝试额度限制了 ${limited.follow} 位用户的关注操作`);
  if (limited.dm) warnings.push(`今日私信尝试额度限制了 ${limited.dm} 位用户的私信操作`);
  if (limited.profile) warnings.push(`今日主页访问额度不足，${limited.profile} 位用户未进入执行名单`);
  const skippedReason = warnings.join('；') || (!candidates.length ? selected.length ? '当前筛选没有符合 AI/人工确认及联系历史条件的用户' : '当前筛选没有线索' : '');
  const id = crypto.randomUUID();
  const plan = {
    id, planId: id, schemaVersion: 3, accountId: String(accountId), kind, actions, businessId: workflow.businessId(settings),
    crossAccount: options.crossAccount === true,
    scope: options.leadIds !== undefined ? 'selected' : 'filters',
    contactPolicy: workflow.contactPolicy(settings),
    requiresRelationCheck: true,
    dmTemplate,
    leadIds: queue.map(l => String(l.id)), count: queue.length, filteredCount: selected.length, matchedCount: candidates.length,
    remaining, quota, plannedCounts, skippedReason, warnings,
    filters: options.filters || {}, owner: String(options.owner || ''), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    fingerprint: workflow.settingsFingerprint(settings, actions),
    leads: queue.map(l => ({ id: l.id, uid: l.uid, nickname: l.nickname, demand: l.demand, aiNeed: l.aiNeed, aiScore: l.aiScore, trigger: l.trigger, dmCount: l.dmCount || 0, dmLastAt: l.dmLastAt || '', actions: perUserActions.get(String(l.id)), messagePreview: frozenMessages.get(String(l.id)) || '' }))
  };
  writePlans([...readPlans().filter(p => Date.parse(p.expiresAt) > Date.now()).slice(-99), plan]);
  return { ok: true, ...plan };
}
function resolvePlan(accountId, kind, options, settings) {
  if (!options || !options.planId) throw new Error('请先对当前筛选结果预检查，再确认执行该名单');
  const plan = readPlans().find(p => p.id === options.planId || p.planId === options.planId);
  if (!plan || plan.accountId !== String(accountId) || plan.kind !== kind) throw new Error('预检查计划不存在，或账号/操作不一致');
  if (plan.schemaVersion !== 3 || !plan.contactPolicy) throw new Error('预检查来自旧流程，请重新预检查当前名单、联系规则和话术');
  if (plan.consumed || plan.state === 'consumed') throw new Error('该预检查计划已经执行，请重新预检查');
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.now()) throw new Error('预检查已过期，请重新检查当前筛选结果');
  if (JSON.stringify(plan.contactPolicy) !== JSON.stringify(workflow.contactPolicy(settings))) throw new Error('重复联系规则已改变，请重新预检查');
  if (workflow.settingsFingerprint(settings, plan.actions) !== plan.fingerprint) throw new Error('业务规则或私信话术已改变，请重新预检查');
  plan.consumed = true; plan.state = 'consumed'; plan.consumedAt = new Date().toISOString();
  writePlans(readPlans().map(current => current.id === plan.id ? plan : current));
  return plan;
}

/* ===================== 采集任务 ===================== */

/** 分享文本、短链接和 video / note 共用一个作品队列。 */
function parseVideoList(input) {
  return parseVideoLinks(input);
}

/** 采集单个视频，返回 { newLeads } */
async function collectOne(accountId, page, workInput, settings, scheduler, beforeCollect = () => '', onCommentLeads = () => {}, collectionRunId = '') {
  const item = typeof workInput === 'object' ? { ...workInput } : { ...normalizeVideoLink(`https://www.douyin.com/video/${workInput}`), force: false };
  let videoId = item.id, url = item.url, work = item;
  let lastHasMore = null, lastTotal = null, newLeads = 0, detailCaptured = null, lastCursor = null;
  let commentResponseCount = 0, paginationRevision = 0, highestCursor = null, highestRequestCursor = null, noProgressRounds = 0;
  const paginationSources = new Map();
  const pendingResponses = new Set();
  const pendingCommentResponses = new Set(), pendingDetailResponses = new Set();
  const detailCancellations = new Set(), feedbackWaiters = new Set();
  let commentChain = Promise.resolve(), detailChain = Promise.resolve(), detailCancelled = false;
  const earlyResponses = [];
  let finished = false, failure = '', failureError = null, targetReady = false, skipReason = '';
  let responseFailure = null;
  const rejectedCommentResponses = new Set();
  const rejectCommentResponse = reason => {
    if (rejectedCommentResponses.has(reason) || rejectedCommentResponses.size >= 8) return;
    rejectedCommentResponses.add(reason);
    store.log(accountId, `采集：目标评论响应未采纳（${reason}）；保留已采集评论，等待有效分页反馈`);
  };
  const signal = taskAbort && taskAbort.signal;
  const readJson = (response, optional = false) => new Promise((resolve, reject) => {
    if (optional && detailCancelled) { resolve(null); return; }
    if (!optional && responseFailure) { reject(responseFailure); return; }
    if (signal && signal.aborted) { reject(new TaskStopError()); return; }
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', aborted);
      if (optional) detailCancellations.delete(cancel);
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(new TaskStopError());
    const cancel = () => finish(null, null);
    const timer = setTimeout(() => {
      if (optional) { finish(null, null); return; }
      responseFailure = new TaskStopError('作品响应读取超时，已暂停采集，请检查网络后续采', 'COLLECTION_RESPONSE_TIMEOUT');
      finish(responseFailure);
    }, 15000);
    if (signal) signal.addEventListener('abort', aborted, { once: true });
    if (optional) detailCancellations.add(cancel);
    Promise.resolve().then(() => response.json()).then(value => finish(null, value), error => finish(error));
  });

  const onResponse = async resp => {
    let acceptedResponse = false;
    try {
      const address = new URL(resp.url());
      if (!/(^|\.)douyin\.com$/.test(address.hostname)) return;
      if (address.pathname === '/aweme/v1/web/comment/list/') {
        // 只收目标视频的评论（页面相关推荐会加载其他视频的评论，需过滤）
        const awemeParam = address.searchParams.get('aweme_id');
        if (awemeParam !== videoId) return;
        const httpStatus = resp.status();
        if (httpStatus < 200 || httpStatus >= 300) { rejectCommentResponse(`HTTP ${httpStatus}`); return; }
        let j;
        try { j = await readJson(resp); }
        catch (error) {
          if (error instanceof TaskStopError) throw error;
          rejectCommentResponse('响应体无法解析为 JSON'); return;
        }
        if (!j || ![0, '0'].includes(j.status_code)) { rejectCommentResponse('业务状态未确认成功'); return; }
        const cursorText = String(j.cursor == null ? '' : j.cursor);
        const cursor = /^\d+$/.test(cursorText) && Number.isSafeInteger(Number(cursorText)) ? Number(cursorText) : null;
        const requestCursorText = address.searchParams.get('cursor') || '';
        const requestCursor = /^\d+$/.test(requestCursorText) && Number.isSafeInteger(Number(requestCursorText)) ? Number(requestCursorText) : null;
        // A successful final page may have comments:null while total retains
        // the work-wide count. Completion comes from explicit has_more:0,
        // not from that optional statistic. Never accept an absent/malformed
        // list or a null page that still claims more data.
        const nullTerminal = Object.hasOwn(j, 'comments') && j.comments === null
          && [0, '0'].includes(j.has_more)
          && cursor !== null && requestCursor !== null;
        const totalText = typeof j.total === 'number' || typeof j.total === 'string' ? String(j.total) : '';
        const reportedTotal = /^\d+$/.test(totalText) && Number.isSafeInteger(Number(totalText)) ? Number(totalText) : null;
        const comments = nullTerminal ? [] : j.comments;
        if (!Array.isArray(comments)
          || comments.some(comment => !comment || typeof comment !== 'object' || Array.isArray(comment))) {
          rejectCommentResponse('评论字段格式无效，不能确认分页完成'); return;
        }
        acceptedResponse = true;
        commentResponseCount++;
        // The note renderer can paginate a located-comment list alongside
        // the ordinary list. Its lower cursors are real progress, even when
        // another list has already fetched the same comments farther ahead.
        // Credentials, timestamps and changing page size are not identities.
        const sourceKey = JSON.stringify([
          address.searchParams.get('pc_img_format'), address.searchParams.has('insert_ids'),
          address.searchParams.get('sort_type') || '0', address.searchParams.get('comment_type') || '0',
          address.searchParams.get('item_type') || '0'
        ]);
        let source = paginationSources.get(sourceKey);
        if (!source) {
          // The ordinary list (no insert_ids) is primary: its end is the work's end.
          source = { id: paginationSources.size + 1, primary: !address.searchParams.has('insert_ids'), highestCursor: null, highestRequestCursor: null, lastHasMore: null, observedCommentIds: new Set() };
          paginationSources.set(sourceKey, source);
        }
        const hasMoreValue = [0, 1, '0', '1'].includes(j.has_more) ? Number(j.has_more) : null;
        const newerSourceRequest = requestCursor !== null && (source.highestRequestCursor === null || requestCursor > source.highestRequestCursor);
        const staleSourcePage = requestCursor !== null && source.highestRequestCursor !== null && requestCursor < source.highestRequestCursor
          || !newerSourceRequest && cursor !== null && source.highestCursor !== null && cursor < source.highestCursor;
        const newerRequest = requestCursor !== null && (highestRequestCursor === null || requestCursor > highestRequestCursor);
        // Response arrival order need not match page-request order. A late old
        // page may still contain useful comments, but cannot roll pagination
        // backwards or replace a newer page's has_more completion evidence.
        const stalePage = requestCursor !== null && highestRequestCursor !== null && requestCursor < highestRequestCursor
          || !newerRequest && cursor !== null && highestCursor !== null && cursor < highestCursor;
        let advanced = !staleSourcePage && cursor !== null && (source.highestCursor === null || cursor > source.highestCursor);
        // Each list's own completion evidence; only its own older pages are stale.
        if (!staleSourcePage && hasMoreValue !== null) source.lastHasMore = hasMoreValue;
        if (!staleSourcePage && cursor !== null) source.highestCursor = source.highestCursor === null ? cursor : Math.max(source.highestCursor, cursor);
        if (!staleSourcePage && requestCursor !== null) source.highestRequestCursor = source.highestRequestCursor === null ? requestCursor : Math.max(source.highestRequestCursor, requestCursor);
        if (!stalePage && cursor !== null) highestCursor = highestCursor === null ? cursor : Math.max(highestCursor, cursor);
        if (!stalePage && requestCursor !== null) highestRequestCursor = highestRequestCursor === null ? requestCursor : Math.max(highestRequestCursor, requestCursor);
        let freshComments = 0;
        for (const comment of comments) {
          const identity = comment.cid != null ? String(comment.cid) : JSON.stringify([comment.user && (comment.user.sec_uid || comment.user.uid), comment.text, comment.create_time, comment.level]);
          if (!source.observedCommentIds.has(identity)) { source.observedCommentIds.add(identity); freshComments++; if (!staleSourcePage) advanced = true; }
        }
        // A list's own stale completion page is never progress. A page behind
        // another list counts only when it brought this list new comments.
        if (hasMoreValue !== 1 && (staleSourcePage || stalePage && !freshComments)) advanced = false;
        if (advanced) {
          paginationRevision++;
          if (paginationSources.size > 1) store.log(accountId, `采集：分页来源 ${source.id} 已推进（请求游标 ${requestCursor == null ? '未知' : requestCursor}，返回游标 ${cursor == null ? '未知' : cursor}，${comments.length} 条评论${stalePage ? '；低于其他来源游标，仍属本来源有效进展' : ''}）`);
        }
        // The note renderer's located list may run ahead of the ordinary list,
        // so completion is per list: the primary list ending, or every list
        // ending, completes the work even when its cursor is behind another.
        const previousHasMore = lastHasMore;
        const sourceStates = [...paginationSources.values()];
        if (sourceStates.some(state => state.primary && state.lastHasMore === 0) || sourceStates.every(state => state.lastHasMore === 0)) lastHasMore = 0;
        else if (!stalePage) lastHasMore = hasMoreValue;
        if (!stalePage) {
          // Some empty final pages reset total to zero; others retain the
          // actual count. Missing/invalid statistics cannot erase a known one.
          if (reportedTotal !== null && !(nullTerminal && reportedTotal === 0 && lastTotal > 0)) lastTotal = reportedTotal;
          lastCursor = j.cursor;
        }
        if (lastHasMore === 0 && previousHasMore !== 0) {
          store.log(accountId, `采集：目标评论末页已确认（${work.type === 'note' ? '图文' : '视频'}，请求游标 ${requestCursor == null ? '未知' : requestCursor}，返回游标 ${cursor == null ? '未知' : cursor}，has_more=0，评论字段 ${nullTerminal ? 'null（空列表）' : `数组 ${comments.length} 条`}，总评论 ${lastTotal == null ? '未知' : lastTotal}）`);
        }
        const leads = store.getLeads();
        const seen = new Map(leads.map(lead => [dedupeKey(lead), lead]));
        let maxId = leads.reduce((x, l) => Math.max(x, Number(l.id) || 0), 0);
        const t = store.nowStr();
        let added = 0, supplemented = 0;
        const capturedLeadIds = [];
        for (const c of comments) {
          if (![1, '1'].includes(c.level)) continue;
          const text = typeof c.text === 'string' ? c.text.trim() : '';
          // 跳过无文字评论（纯表情/图片评论，无法判断意向）
          if (settings.collect.skipEmptyText && !text) continue;
          const u2 = c.user || {};
          const mth = matchIntent(text, settings.keywords);
          const captured = {
            ...userMetadata(u2, { sourcePath: address.pathname, capturedAt: t }),
            commentLevel: 1, commentSourcePath: address.pathname, commentCapturedAt: t
          };
          if (typeof c.ip_label === 'string' && c.ip_label.trim()) captured.region = c.ip_label;
          if (typeof c.digg_count === 'number' && Number.isFinite(c.digg_count)) captured.diggCount = c.digg_count;
          if (typeof c.reply_comment_total === 'number' && Number.isFinite(c.reply_comment_total)) captured.replyCount = c.reply_comment_total;
          const lead = {
            id: ++maxId,
            uid: '', account: '', UID: '', nickname: '', signature: '', homepage: '',
            trigger: mth.kw,
            demand: text,
            ...commentEvidence(c),
            region: c.ip_label || '',
            videoLink: url,
            fetchTime: t,
            isAuthor: [1, '1'].includes(c.label_type) || Boolean(u2.sec_uid && u2.sec_uid === ((detailCaptured && detailCaptured.authorSecUid) || (store.getVideos()[videoId] || {}).authorSecUid)),
            intent: mth.hit,
            excluded: mth.excluded,
            diggCount: c.digg_count != null ? c.digg_count : '',
            replyCount: c.reply_comment_total != null ? c.reply_comment_total : '',
            status: 'new',
            accountId: String(accountId), businessId: workflow.businessId(settings),
            ...(collectionRunId ? { collectionRunId } : {}),
            ...captured
          };
          if (!lead.uid) continue;
          const key = dedupeKey(lead);
          if (seen.has(key)) {
            const existing = seen.get(key);
            const sources = { ...(existing.userFieldSources || {}), ...(captured.userFieldSources || {}) };
            Object.assign(existing, captured, commentEvidence(c, existing), { userFieldSources: sources });
            if (collectionRunId) existing.collectionRunId = collectionRunId;
            if (lead.isAuthor) existing.isAuthor = true;
            capturedLeadIds.push(String(existing.id));
            supplemented++;
            continue;
          }
          seen.set(key, lead);
          leads.push(lead);
          capturedLeadIds.push(String(lead.id));
          added++;
        }
        if (added || supplemented) {
          store.setLeads(leads);
          newLeads += added;
          onCommentLeads(capturedLeadIds, { added, supplemented });
          store.log(accountId, `采集：捕获评论接口（新增 ${added} 条，回填 ${supplemented} 条，视频总评论 ${j.total}）`);
        }
        checkpoint({ currentVideoId: videoId, rounds, lastCursor, lastHasMore, newLeads, commentResponseCount, noProgressRounds, paginationSourceCount: paginationSources.size });
      } else if (address.pathname === '/aweme/v1/web/aweme/detail/') {
        const detailId = address.searchParams.get('aweme_id');
        if (detailId && detailId !== videoId) return;
        const j = await readJson(resp, true);
        if (detailCancelled) return;
        const aw = selectWorkDetail(j, videoId);
        // 只收目标视频的详情（相关推荐也会触发其他视频的详情接口）
        if (!aw || !aw.aweme_id || String(aw.aweme_id) !== videoId) return;
        acceptedResponse = true;
        {
          const recorded = recordWorkDetail({ store, videoId, url, workType: work.type, aw, fmtTs, sourcePath: address.pathname });
          detailCaptured = { authorSecUid: recorded.authorSecUid };
          store.log(accountId, `采集：作品详情入库（描述${recorded.descriptionState === 'available' ? '已获取' : '待确认'}）`);
        }
      }
    } catch (e) {
      // Unusable external JSON may be ignored. Once target data is accepted,
      // a local processing/save failure must never become a complete scan.
      if (acceptedResponse || e instanceof TaskStopError) {
        responseFailure = e instanceof TaskStopError ? e : new TaskStopError('作品数据处理或本地保存失败，已暂停采集，请检查日志和数据目录后续采', 'COLLECTION_SAVE_FAILED');
      }
    }
  };
  const trackedResponse = response => {
    if (finished) return;
    if (!targetReady) {
      try {
        const address = new URL(response.url());
        if (/(^|\.)douyin\.com$/.test(address.hostname) && ['/aweme/v1/web/comment/list/', '/aweme/v1/web/aweme/detail/'].includes(address.pathname) && earlyResponses.length < 100) earlyResponses.push(response);
      } catch (_) { /* only valid platform response addresses are buffered */ }
      return;
    }
    let address;
    try { address = new URL(response.url()); } catch (_) { return; }
    if (!/(^|\.)douyin\.com$/.test(address.hostname)) return;
    const isComment = address.pathname === '/aweme/v1/web/comment/list/';
    const isDetail = address.pathname === '/aweme/v1/web/aweme/detail/';
    if (!isComment && !isDetail) return;
    const targetId = address.searchParams.get('aweme_id');
    if (isComment ? targetId !== videoId : targetId && targetId !== videoId) return;
    // Keep each stream's observed order, but never let an optional detail body
    // block comment decoding or the next browser-generated comment page.
    const promise = (isComment ? commentChain : detailChain).then(() => onResponse(response));
    if (isComment) commentChain = promise.catch(() => {}); else detailChain = promise.catch(() => {});
    const pending = isComment ? pendingCommentResponses : pendingDetailResponses;
    pending.add(promise);
    pendingResponses.add(promise);
    promise.finally(() => {
      pending.delete(promise); pendingResponses.delete(promise);
      if (isComment) for (const wake of [...feedbackWaiters]) wake();
    });
  };
  page.on('response', trackedResponse);

  let rounds = 0;
  const waitForFeedback = () => new Promise(resolve => {
    let settled = false;
    const wake = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); feedbackWaiters.delete(wake);
      if (signal) signal.removeEventListener('abort', wake);
      resolve();
    };
    const timer = setTimeout(wake, 200);
    feedbackWaiters.add(wake);
    if (signal) signal.addEventListener('abort', wake, { once: true });
    if (signal && signal.aborted) wake();
  });
  const waitForComments = async ready => {
    // Wait for browser-generated responses; never replay captured signed URLs.
    // A decoded response wakes this wait immediately. A comment body already
    // received is allowed its bounded read deadline before any further scroll.
    for (let attempt = 0; attempt < 40; attempt++) {
      scheduler.checkStopped();
      if (responseFailure) throw responseFailure;
      if (pendingCommentResponses.size) await Promise.allSettled([...pendingCommentResponses]);
      scheduler.checkStopped();
      if (responseFailure) throw responseFailure;
      if (ready()) return;
      await waitForFeedback();
    }
    scheduler.checkStopped();
    if (responseFailure) throw responseFailure;
  };
  // 页面跳转与读取竞态：跳转销毁执行上下文时等待稳定后重试，避免整任务中断。
  const navigationRace = error => /Execution context was destroyed|Cannot find context with specified id/.test(String(error && error.message || ''));
  const evaluateStable = async (fn, arg) => {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await page.evaluate(fn, arg); }
      catch (error) {
        lastError = error;
        if (!navigationRace(error) || attempt === 3) throw error;
        setTask({ status: '页面发生跳转，等待稳定后重试读取，可随时停止', waitingUntil: null });
        await SLEEP(700 + Math.round(Math.random() * 600));
        try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch { /* 继续重试读取 */ }
      }
    }
    throw lastError;
  };
  const safeHealth = async () => {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      scheduler.checkStopped();
      try {
        await checkAccountPageHealth(page, accountId);
        scheduler.checkStopped();
        let current;
        try { current = landingWork(page.url()); }
        catch (_) { throw new TaskStopError('页面离开了当前作品，已暂停采集', 'TARGET_MISMATCH'); }
        if (current.id !== videoId || current.needsCanonicalNavigation) throw new TaskStopError('页面切换到了其他目标，已暂停当前作品采集', 'TARGET_MISMATCH');
        if (current.type === 'note' && work.type !== 'note') {
          work = { ...work, type: 'note', url: current.url }; url = current.url;
          setTask({ currentWork: { id: videoId, url } });
          store.log(accountId, '采集：当前作品已切换到图文页面，继续核对目标评论');
        }
        return;
      }
      catch (error) {
        lastError = error;
        const transition = navigationRace(error) || error.code === 'LOGIN_UNCONFIRMED' && error.pageTransition === true;
        if (!transition || attempt === 3) throw error;
        setTask({ status: '作品页面正在切换，等待重新确认登录与评论区，可随时停止', waitingUntil: null });
        store.log(accountId, `采集：页面切换中，重新检查当前目标与登录状态（${attempt + 1}/3）`);
        await SLEEP(700 + Math.round(Math.random() * 600));
        scheduler.checkStopped();
        try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch { /* 继续重试 */ }
      }
    }
    throw lastError;
  };
  const capturePageDescription = async () => {
    // A renderer may stream its work data after the document is ready. Retry
    // this local read after comment collection if the first read was missing.
    scheduler.checkStopped();
    const pageMetadata = await evaluateStable(readPageWorkMetadata, videoId);
    scheduler.checkStopped();
    recordPageMetadata({ store, videoId, url, workType: work.type, pageMetadata, pageUrl: page.url() });
  };
  try {
    // 只有两个实际作品之间等待；短链展开与规范地址跳转不重复加间隔。
    const navigate = address => scheduler.run({ accountId, kind: 'video', videoId }, () => {
      setTask({ stage: 'opening_work', currentWork: { id: videoId || '', url: address }, status: '正在打开作品页面' });
      return navigateCollectionPage(page, address, {
        authorize: meta => authorize({ accountId, videoId, ...meta }), checkStopped: () => scheduler.checkStopped(), signal
      });
    });
    await navigate(url);
    let landed = landingWork(page.url());
    if (item.id && landed.id !== item.id) throw new TaskStopError('作品跳转目标与输入不一致，已停止采集', 'TARGET_MISMATCH');
    if (landed.needsCanonicalNavigation) { await navigate(landed.url); landed = landingWork(page.url()); }
    if (item.id && landed.id !== item.id) throw new TaskStopError('作品跳转目标与输入不一致，已停止采集', 'TARGET_MISMATCH');
    // Explicit image-work URLs keep their note identity even when the platform
    // chooses a different renderer for the same work ID.
    work = { ...landed, force: item.force, ...(item.type === 'note' ? { type: 'note', url: item.url } : {}) };
    videoId = work.id; url = work.url;
    skipReason = beforeCollect(work) || '';
    url = work.url;
    if (skipReason) return { newLeads: 0, skipped: true, skipReason, work };
    targetReady = true;
    earlyResponses.splice(0).forEach(trackedResponse);
    await Promise.allSettled([...pendingCommentResponses]);
    if (responseFailure) throw responseFailure;
    scheduler.checkStopped();
    // A document may be ready before its SPA body. Retry only that explicit
    // loading state; a login prompt, failed session or verification still
    // stops immediately. Every check reads the same live browser evidence.
    for (let attempt = 0; attempt < 40; attempt++) {
      scheduler.checkStopped();
      try { await safeHealth(); break; }
      catch (error) {
        const loading = ['LOGIN_PENDING', 'LOGIN_UNCONFIRMED'].includes(error.code)
          && /账号页面尚未加载完成|抖音页面仍在加载/.test(error.message)
          || navigationRace(error);
        if (!loading || attempt === 39) throw error;
        setTask({ status: '作品页面尚在加载，等待浏览器确认账号状态，可随时停止', waitingUntil: null });
        await waitForFeedback();
      }
    }

    // Image-work renderers may embed details in the document without sending
    // the video detail endpoint. Read only this already-loaded target page;
    // no extra navigation, signed request replay or full-page text guessing.
    await capturePageDescription();

    // 2026-10-20 实测：直接打开作品页时第一页评论常内嵌在页面数据里，点“评论”页签也不会再请求
    // comment/list；不满一页的作品永远等不到评论接口。先读内嵌第一页，按同一套规则入库；
    // 它带 has_more，满一页时后续翻页仍由页面自己的评论接口推进。
    // 内嵌数据随页面流式到达，打开后立即读可能还没有：这里读一次，放弃前（未收到评论接口时）再读一次。
    const readEmbeddedComments = async () => {
      const embedded = await evaluateStable(readPageComments, videoId).catch(() => null);
      scheduler.checkStopped();
      if (embedded && embedded.ok) {
        const payload = embedded.payload;
        await onResponse({
          url: () => `https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=${videoId}&cursor=0&count=${payload.comments.length}`,
          status: () => 200,
          json: async () => payload
        });
        if (responseFailure) throw responseFailure;
        store.log(accountId, `采集：读取页面内嵌的第一页评论 ${payload.comments.length} 条（has_more=${payload.has_more}，总评论 ${payload.total == null ? '未知' : payload.total}）`);
      }
    };
    if (lastHasMore !== 0 && commentResponseCount === 0) await readEmbeddedComments();

    const sc = settings.collect;
    if (lastHasMore !== 0) {
      setTask({ stage: 'opening_comments', status: '正在等待作品评论入口就绪', currentWork: { id: videoId, url }, done: 0, total: sc.maxScrolls });
      let entry;
      for (let attempt = 0; attempt < 40; attempt++) {
        scheduler.checkStopped();
        if (responseFailure) throw responseFailure;
        if (lastHasMore === 0) break;
        entry = await evaluateStable(openComments, { probe: true });
        scheduler.checkStopped();
        if (entry && ['ready', 'available'].includes(entry.state)) break;
        await waitForFeedback();
      }
      if (lastHasMore !== 0) {
        if (!entry || !['ready', 'available'].includes(entry.state)) throw new TaskStopError('未找到当前作品的评论入口或评论区域，已暂停；请打开评论后继续采集', 'COMMENT_PANEL_NOT_FOUND');
        setTask({ status: '正在打开作品评论区，等待目标评论接口反馈', done: 0, total: sc.maxScrolls });
        const panel = await scheduler.run({ accountId, kind: 'open_comments', operation: 'open_comments', videoId }, async () => {
          await safeHealth();
          scheduler.checkStopped();
          return evaluateStable(openComments);
        });
        if (!panel || panel.state === 'missing') throw new TaskStopError('未找到当前作品的评论入口或评论区域，已暂停；请打开评论后继续采集', 'COMMENT_PANEL_NOT_FOUND');
        if (commentResponseCount === 0) await waitForComments(() => commentResponseCount > 0);
        if (commentResponseCount === 0) await readEmbeddedComments();
        if (commentResponseCount === 0) throw new TaskStopError('打开评论后仍未收到目标作品的评论响应，已暂停；请检查网络或页面提示后继续采集', 'COMMENT_RESPONSE_MISSING');
      }
    }
    if (lastHasMore !== 0) scheduler.scheduleBoundary('scroll');
    while (rounds < (sc.maxScrolls || 120)) {
      if (taskState.stopRequested) { setTask({ status: '已手动停止' }); break; }
      if (lastHasMore === 0) break;
      rounds++;
      const previousRevision = paginationRevision;
      const act = await scheduler.run({ accountId, kind: 'scroll', videoId }, async () => {
        setTask({ stage: 'collecting_comments', status: `正在翻至第 ${rounds} 轮评论` });
        await safeHealth();
        scheduler.checkStopped();
        return evaluateStable(scrollComments);
      });
      setTask({ status: `正在等待第 ${rounds} 轮目标评论响应，收到后继续`, waitingUntil: null });
      await waitForComments(() => lastHasMore === 0 || paginationRevision !== previousRevision);
      noProgressRounds = paginationRevision === previousRevision && lastHasMore !== 0 ? noProgressRounds + 1 : 0;
      checkpoint({ currentVideoId: videoId, rounds, lastCursor, lastHasMore, newLeads, commentResponseCount, noProgressRounds, paginationSourceCount: paginationSources.size });
      const panelState = act && act.state || 'not_ready';
      const stateLabel = { scrolled: '评论区已滚至加载位置', at_end: '评论区到底', not_ready: '评论区域未就绪' }[panelState] || '评论区域待确认';
      setTask({ status: `翻页采集第 ${rounds} 轮（${stateLabel}），已新增 ${newLeads} 条`, detail: `目标评论响应 ${commentResponseCount} 次｜当前游标 ${lastCursor == null ? '待确认' : lastCursor}｜连续无进展 ${noProgressRounds}/3`, done: rounds, total: sc.maxScrolls });
      if (noProgressRounds >= 3) {
        const sources = [...paginationSources.values()].map(source => `${source.id}:请求${source.highestRequestCursor == null ? '未知' : source.highestRequestCursor}/返回${source.highestCursor == null ? '未知' : source.highestCursor}`).join('，');
        store.log(accountId, `采集暂停诊断：目标作品 ${videoId}，类型 ${work.type === 'note' ? '图文' : '视频'}，已采纳响应 ${commentResponseCount} 次，最后游标 ${lastCursor == null ? '未知' : lastCursor}，has_more=${lastHasMore == null ? '未知' : lastHasMore}，连续无进展 ${noProgressRounds} 轮，分页来源 ${sources}`);
        throw new TaskStopError('连续 3 轮未取得目标评论分页进展，已暂停；请检查评论面板、网络或页面提示后继续采集', 'COLLECTION_NO_PROGRESS');
      }
      if (lastHasMore === 0) {
        store.log(accountId, `视频 ${videoId} 采集完成：新增 ${newLeads} 条（总评论 ${lastTotal}）`);
        break;
      }
    }
    if (!taskState.stopRequested) await capturePageDescription();
  } catch (e) {
    failureError = e;
    failure = e.message;
    throw e;
  } finally {
    // 关键：任务结束必须移除监听器，否则之后用户浏览其他视频会被误采集
    finished = true;
    page.off('response', trackedResponse);
    // Optional details can finish quickly after the last comment, but a hung
    // body must not hold collection open for its full 15-second read deadline.
    // Cancellation settles the reads and suppresses any later metadata write.
    if (pendingDetailResponses.size && !(signal && signal.aborted)) {
      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, 250);
        if (signal) signal.addEventListener('abort', finish, { once: true });
        Promise.allSettled([...pendingDetailResponses]).then(finish);
      });
    }
    detailCancelled = true;
    for (const cancel of [...detailCancellations]) cancel();
    await Promise.allSettled([...pendingResponses]);
    if (videoId && !skipReason) {
      const videos = store.getVideos(), info = videos[videoId] || { awemeId: videoId, videoLink: url };
      if (!info.desc && !info.descriptionState) Object.assign(info, workDescription(null, info));
      const complete = lastHasMore === 0 && !taskState.stopRequested && !failure && !responseFailure;
      info.videoLink = url; info.workType = work.type;
      info.collectionState = complete ? 'complete' : taskState.stopRequested || failure || responseFailure ? 'interrupted' : 'partial';
      info.collectionReason = complete ? '平台评论接口返回 has_more=0' : failure || (responseFailure && responseFailure.message) || (taskState.stopRequested ? '手动停止' : lastHasMore === null ? '没有有效的目标分页完成反馈，无法确认完整度' : '达到翻页上限，仍有更多评论');
      info.collectionCheckpoint = { rounds, lastCursor, lastHasMore, lastTotal, newLeads, commentResponseCount, noProgressRounds, paginationSourceCount: paginationSources.size, updatedAt: store.nowStr() };
      videos[videoId] = info;
      try { store.setVideos(videos); }
      catch (_) {
        const primary = failureError || responseFailure;
        if (primary) {
          primary.message += '；采集状态也未能保存，请检查本地数据目录';
          throw primary;
        }
        throw new TaskStopError('采集状态保存失败，已暂停，请检查本地数据目录后续采', 'COLLECTION_SAVE_FAILED');
      }
    }
  }
  if (responseFailure) throw responseFailure;
  return { newLeads, complete: lastHasMore === 0 && !taskState.stopRequested, rounds, lastCursor, lastTotal, work };
}

/** 多链接队列采集：逐条采集，链接之间按设置间隔（随机抖动）等待 */
async function collectTask(accountId, videoInput) {
  return collectionTasks.collectTask(accountId, videoInput);
}

/* ===================== 按用户执行：一次主页访问 ===================== */
const { createActions, assertPageHealth } = require('./engine-actions');
const actions = createActions({
  store, taskState, setTask, SLEEP, makeScheduler, getAlive, launchAccount,
  saveLeadAction, saveContactObservation, resolvePlan, checkpoint, applyTemplate,
  checkPageHealth: checkAccountPageHealth,
  // 关注走核心实现（点击前现找按钮、只认 commit/follow/user 响应），见 core/follow.js 与正确流程规格 4.2
  followAction: require('./core/follow').follow,
  getHooks: () => hooks, getSignal: () => taskAbort && taskAbort.signal
});
const { followTask, dmTask, outreachTask, openLeadProfile } = actions;

/* ===================== AI：同规则、固定范围、安全回写 ===================== */
const { createAiTasks } = require('./engine-ai-tasks');
const { aiJudgeOne, aiJudgeBatch, aiTask } = createAiTasks({
  store, taskState, setTask, failTask, makeScheduler, checkpoint,
  getSignal: () => taskAbort && taskAbort.signal
});
const { createCollectionTasks } = require('./engine-collection-tasks');
// 单作品采集走核心流程（core/collect.js，按实测规格判完成）；短链等需先跳转解析的链接仍由旧 collectOne 处理。
const { createCoreCollectOne } = require('./engine-core-collect');
const collectOneCore = createCoreCollectOne({ store, workflow, setTask, legacyCollectOne: collectOne, dedupeKey, matchIntent, checkPageHealth: checkAccountPageHealth, fmtTs });
const collectionTasks = createCollectionTasks({
  store, taskState, setTask, failTask, makeScheduler, checkpoint, parseVideoList,
  getAlive, launchAccount, collectOne: collectOneCore, runAi: options => aiTask(options)
});
const { createSearchTasks } = require('./engine-search-tasks');
const searchTasks = createSearchTasks({
  store, taskState, setTask, failTask, makeScheduler, checkpoint,
  getAlive, launchAccount, checkPageHealth: checkAccountPageHealth
});
const { createDmDistribution } = require('./engine-dm-distribution');
const dmDistribution = createDmDistribution({
  store, taskState, setTask, failTask, checkpoint,
  createPlan, runOutreach: (accountId, options) => outreachTask(accountId, options), getSignal: () => taskAbort && taskAbort.signal,
  closeAccount: accountId => closeAccount(accountId)
});

function stopTask() {
  // 分发任务在批次之间 running 会短暂为 false，但整体仍在运行，必须能停止
  if (taskState.running || taskState.distributionActive) {
    taskState.stopRequested = true;
    taskState.stopEpoch = (Number(taskState.stopEpoch) || 0) + 1;
    if (taskAbort) taskAbort.abort();
    taskState.status = '正在停止…';
    return { ok: true };
  }
  return { ok: true, idle: true };
}
async function shutdown() {
  stopTask();
  await Promise.allSettled([...contexts.keys()].map(closeAccount));
  if (embeddedBrowserClient) await embeddedBrowserClient.dispose();
  return { ok: true };
}

/** 任务启动前的错误也要显示到界面状态里 */
function failTask(msg) {
  if (!taskState.running) taskState.status = msg;
  return { ok: false, error: msg };
}

module.exports = {
  configure, createPlan, outreachTask, openLeadProfile, shutdown,
  taskState, launchAccount, closeAccount, openForLogin, checkLogin, scanAccountLogins, isLoggedIn,
  collectTask, followTask, dmTask, aiTask, aiJudgeOne, aiJudgeBatch, stopTask,
  searchTask: searchTasks.searchTask,
  dmDistributionTask: dmDistribution.dmDistributionTask,
  dmDistributionPreview: dmDistribution.dmDistributionPreview,
  parseProxy, applyTemplate, matchIntent, parseVideoList,
  pickBrowserOpts,
  buildFollowQueue, buildDmQueue, migrateLeads, refreshLeadStatus, saveLeadAction, saveContactObservation,
  applyProfileData, passiveProfileResponse, collectOne
};
