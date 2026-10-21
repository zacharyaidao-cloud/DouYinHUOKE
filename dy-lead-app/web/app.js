/* 抖音获客软件 - 客户端界面 */
const $ = id => document.getElementById(id);
const desktopVersion = typeof window.desktop?.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(window.desktop.version) ? window.desktop.version : '';
$('client-build').textContent = desktopVersion ? '客户端 ' + desktopVersion + (window.desktop.browser ? ' · 双浏览器模式' : '') : '网页调试模式 · 无客户端版本';
let state = null;
let token = sessionStorage.getItem('dy_token') || '';
let leadFilter = { f: 'all', s: '', q: '', commentDays: 7, contact: 'all' };
let leadSort = { k: 'id', dir: -1 };
let precheckPlan = null;
let precheckRequestBusy = false;
let outreachSubmitBusy = false;
let actionFeedback = null;
let actionStateError = '';
const selectedLeadIds = new Set();
let leadLoadSequence = 0;
let refreshBusy = false;
let resolveVerification = null;
let linkRows = [{ url: '', force: false }];
const selectedQueueRows = new Set();
let pageDirty = true; // 页面刚切换时需要加载表单（轮询期间不覆盖用户正在编辑的内容）
let lastUserActivity = Date.now();
let promptPresets = [];
let editingPromptId = 'prompt-1';
let activePromptId = 'prompt-1';
let modelChoices = [];
let modelLoadSequence = 0;
let lastModalFocus = null;
let generatedPromptDraft = null;
let aiSubmitBusy = false;
let aiFeedback = null;
let leadAiPendingCount = 0;
let collectSubmitBusy = false;
let collectConfigDirty = false;
let actionConfigDirty = false;
let pacingConfigDirty = false;
let collectFeedback = null;
let lastCollectionSummary = null;

const accountFeedback = new Map();
let lastAccountNotice = null;
let accountRefreshError = '';
let leadFieldSchema = null;
let leadFieldSignature = '';
const leadExtraFields = new Set();
try {
  const saved = JSON.parse(localStorage.getItem('hm-lead-view-fields-v1') || '[]');
  if (Array.isArray(saved)) saved.filter(key => typeof key === 'string').forEach(key => leadExtraFields.add(key));
} catch (_) { /* A damaged display preference does not change the data or task scope. */ }
for (const event of ['pointerdown', 'keydown', 'input', 'wheel']) document.addEventListener(event, () => { lastUserActivity = Date.now(); }, { passive: true });

/* ---------- 登录 ---------- */
function showLogin() {
  $('login-layer').style.display = 'flex';
  $('login-err').textContent = '';
  scheduleEmbeddedBrowserSync();
}
function hideLogin() { $('login-layer').style.display = 'none'; loadEmbeddedBrowsers(); }

$('btn-login').addEventListener('click', async () => {
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const j = await r.json();
    if (j.ok) {
      token = j.token;
      sessionStorage.setItem('dy_token', token);
      hideLogin();
      $('login-pass').value = '';
      refresh();
    } else {
      $('login-err').textContent = j.error || '登录失败';
    }
  } catch (e) { $('login-err').textContent = '无法连接服务'; }
});
$('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-login').click(); });

$('btn-logout').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch (_) { /* 清理本地会话 */ }
  token = '';
  sessionStorage.removeItem('dy_token');
  showLogin();
});

$('btn-open-datadir').addEventListener('click', async () => {
  await api('/open-data-dir', { method: 'POST' });
});

/* ---------- API ---------- */
async function api(path, opts) {
  const r = await fetch('/api' + path, {
    method: opts && opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token, 'x-user-active': Date.now() - lastUserActivity < 3000 ? '1' : '0' },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (r.status === 401) {
    // Keep the known session so an expired license can still stop its task.
    showLogin();
    const failure = await r.json().catch(() => ({}));
    $('login-err').textContent = failure.error || '登录或授权已失效，请重新登录';
    throw new Error(failure.error || '登录或授权已失效');
  }
  const result = await r.json();
  if (!r.ok || result.ok === false) throw new Error(result.error || '操作失败');
  return result;
}

/* ---------- 页面切换 ---------- */
function navigateTo(page, focusId) {
  const active = document.querySelector('#nav a.active');
  if (page === 'browser' && active && active.dataset.page !== 'browser') embeddedReturnPage = active.dataset.page;
  document.querySelectorAll('#nav a').forEach(a => { const selected = a.dataset.page === page; a.classList.toggle('active', selected); if (selected) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('hidden', p.id !== 'page-' + page));
  if (!active || active.dataset.page !== page) pageDirty = true;
  document.body.classList.toggle('browser-workspace', page === 'browser');
  if (page === 'browser') { embeddedBrowserError = ''; renderEmbeddedBrowser(); loadEmbeddedBrowsers(); }
  scheduleEmbeddedBrowserSync();
  refresh();
  if (focusId && $(focusId)) { $(focusId).scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  else window.scrollTo({ top: 0 });
}
document.querySelectorAll('#nav a').forEach(a => {
  a.setAttribute('role', 'button'); a.tabIndex = 0;
  a.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); a.click(); } });
  a.addEventListener('click', () => navigateTo(a.dataset.page));
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-goto]');
  if (button) navigateTo(button.dataset.goto, button.dataset.focus);
});

/* ---------- 内嵌账号浏览器 ---------- */
// Platform pages run in a separate main-process view, never in this renderer.
// show() only selects an already opened account; /accounts/:id/open remains
// the sole UI entry for starting an account login browser.
const embeddedBrowser = window.desktop && window.desktop.browser;
let embeddedAccounts = [], embeddedActiveId = '', embeddedPresentedId = '', embeddedPendingId = '';
let embeddedReturnPage = 'overview', embeddedBrowserError = '', embeddedBoundsKey = '';
let embeddedSyncFrame = 0, embeddedSyncChain = Promise.resolve(), embeddedStateRevision = 0;
let embeddedUnsubscribe = null, embeddedResizeObserver = null;
let embeddedIntroDismissed = false;
try { embeddedIntroDismissed = localStorage.getItem('hm-embedded-browser-intro-v230') === '1'; } catch (_) {}
function embeddedWorkbenchReady() { return !!token && $('login-layer').style.display === 'none'; }
function embeddedSelected() { return embeddedAccounts.find(account => account.id === embeddedActiveId); }
function embeddedPageVisible() {
  return embeddedWorkbenchReady() && !$('page-browser').classList.contains('hidden') && document.visibilityState !== 'hidden'
    && ['precheck-modal', 'verification-modal', 'field-detail-modal'].every(id => $(id).classList.contains('hidden'));
}
function embeddedBounds() {
  const rect = $('browser-view-slot').getBoundingClientRect();
  const header = document.querySelector('.app-topbar').getBoundingClientRect(), stop = $('btn-global-stop').getBoundingClientRect();
  let left = Math.max(0, Math.ceil(rect.left)), top = Math.max(0, Math.ceil(rect.top), Math.ceil(header.bottom));
  let right = Math.min(window.innerWidth, Math.floor(rect.right)), bottom = Math.min(window.innerHeight - 8, Math.floor(rect.bottom));
  // Native views are above DOM z-index. Keep the global stop outside their
  // rectangle, including the mobile layout where stop moves to the bottom.
  if (stop.right > left && stop.left < right && stop.bottom > top && stop.top < bottom) {
    if (stop.top > top + 120) bottom = Math.min(bottom, Math.floor(stop.top) - 8);
    else top = Math.max(top, Math.ceil(stop.bottom) + 8);
  }
  return right - left >= 240 && bottom - top >= 120 ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}
function browserError(error) {
  embeddedBrowserError = error && error.message || '账号浏览器暂时无法显示，请重试或回到账号管理。';
  renderEmbeddedBrowser();
  scheduleEmbeddedBrowserSync();
}
async function syncEmbeddedBrowser() {
  if (!embeddedBrowser) return;
  const selected = embeddedSelected(), bounds = embeddedPageVisible() && selected && !embeddedBrowserError ? embeddedBounds() : null;
  if (!bounds) {
    if (embeddedPresentedId || embeddedAccounts.some(account => account.visible)) {
      embeddedPresentedId = ''; embeddedBoundsKey = '';
      await embeddedBrowser.hide();
    }
    return;
  }
  const id = selected.id, key = JSON.stringify(bounds);
  if (key !== embeddedBoundsKey) { await embeddedBrowser.setBounds(bounds); embeddedBoundsKey = key; }
  if (!embeddedPageVisible() || embeddedActiveId !== id) { embeddedBoundsKey = ''; await embeddedBrowser.hide(); embeddedPresentedId = ''; return; }
  if (embeddedPresentedId !== id) {
    embeddedPresentedId = id;
    try { await embeddedBrowser.show(id); }
    catch (error) {
      embeddedPresentedId = ''; embeddedBoundsKey = '';
      // A failed account switch must not leave the previous native webpage
      // covering the retry control or looking like the newly selected account.
      try { await embeddedBrowser.hide(); } catch (_) {}
      throw error;
    }
    if (!embeddedPageVisible() || embeddedActiveId !== id) { await embeddedBrowser.hide(); embeddedPresentedId = ''; embeddedBoundsKey = ''; }
  }
}
function scheduleEmbeddedBrowserSync() {
  if (!embeddedBrowser || embeddedSyncFrame) return;
  embeddedSyncFrame = requestAnimationFrame(() => {
    embeddedSyncFrame = 0;
    embeddedSyncChain = embeddedSyncChain.then(syncEmbeddedBrowser).catch(browserError);
  });
}
function renderEmbeddedBrowser() {
  const selected = embeddedSelected();
  $('browser-tabs').innerHTML = embeddedAccounts.map(account => '<button class="browser-tab" role="tab" data-browser-account="' + esc(account.id) + '" data-loading="' + account.loading + '" aria-selected="' + (account.id === embeddedActiveId) + '" aria-controls="browser-view-slot" title="' + esc(account.name) + '"><span class="status-dot" aria-hidden="true"></span><span class="browser-tab-name">' + esc(account.name) + '</span></button>').join('');
  $('browser-url').value = selected && selected.url || '';
  $('browser-page-status').textContent = selected ? selected.name + ' · ' + (selected.loading ? '网页加载中…' : selected.title || '账号网页') : embeddedPendingId ? '正在打开账号浏览器…' : '尚未打开账号浏览器';
  const task = state && state.task;
  $('browser-task-status').textContent = taskActive(task) ? '任务进行中 · ' + (task.status || '正在处理') : '任务空闲';
  $('browser-task-status').title = $('browser-task-status').textContent;
  $('browser-upgrade-note').classList.toggle('hidden', !embeddedBrowser || embeddedIntroDismissed);
  $('browser-error').classList.toggle('hidden', !embeddedBrowserError);
  $('browser-error').textContent = embeddedBrowserError;
  for (const id of ['btn-browser-back', 'btn-browser-forward', 'btn-browser-reload']) $(id).disabled = !embeddedBrowser || !selected;
  $('browser-empty-title').textContent = !embeddedBrowser ? '请使用桌面客户端' : embeddedPendingId && !selected ? '账号浏览器正在打开' : selected ? '账号网页将在这里显示' : '先打开一个账号';
  $('browser-empty-detail').textContent = !embeddedBrowser ? '内嵌账号浏览器需要新版桌面客户端。账号登录与任务仍从账号管理开始。'
    : embeddedPendingId && !selected ? '请稍候。浏览器就绪后会自动显示；若未打开，请返回账号管理查看操作结果。'
      : selected ? '这里显示当前账号的网页。切换账号标签可查看其他已打开的账号。' : '进入账号管理，选择“内嵌浏览器”再打开登录，可在这里操作；外部模式会打开独立窗口。';
  $('btn-browser-show').classList.toggle('hidden', !embeddedBrowser || !selected);
  $('btn-browser-empty-accounts').classList.toggle('hidden', !!selected);
}
function acceptEmbeddedBrowserState(value, fromEvent = false) {
  const rows = Array.isArray(value) ? value : value && value.accounts;
  if (!Array.isArray(rows)) return;
  if (fromEvent) embeddedStateRevision++;
  const seen = new Set();
  embeddedAccounts = rows.filter(row => row && ['string', 'number'].includes(typeof row.id) && String(row.id).length <= 128 && !seen.has(String(row.id)) && seen.add(String(row.id)))
    .map(row => ({ id: String(row.id), name: String(row.name || '未命名账号').slice(0, 200), url: String(row.url || '').slice(0, 8192), title: String(row.title || '').slice(0, 300), loading: row.loading === true, visible: row.visible === true }));
  const requestedId = value && value.activeAccountId != null ? String(value.activeAccountId) : '';
  if (embeddedAccounts.some(account => account.id === embeddedPendingId)) { embeddedActiveId = embeddedPendingId; embeddedPendingId = ''; }
  else if (fromEvent && value.showRequested === true && embeddedAccounts.some(account => account.id === requestedId)) embeddedActiveId = requestedId;
  else if (!embeddedSelected()) embeddedActiveId = (embeddedAccounts.find(account => account.id === requestedId) || embeddedAccounts.find(account => account.visible) || embeddedAccounts[0] || {}).id || '';
  if (!embeddedAccounts.some(account => account.id === embeddedPresentedId && account.visible)) { embeddedPresentedId = ''; embeddedBoundsKey = ''; }
  renderEmbeddedBrowser();
  if (fromEvent && value && value.showRequested === true && embeddedSelected() && embeddedWorkbenchReady()) {
    embeddedBrowserError = '';
    navigateTo('browser');
  } else scheduleEmbeddedBrowserSync();
}
async function loadEmbeddedBrowsers() {
  if (!embeddedBrowser || !embeddedWorkbenchReady()) { renderEmbeddedBrowser(); return; }
  const revision = embeddedStateRevision;
  try { const result = await embeddedBrowser.list(); if (revision === embeddedStateRevision) acceptEmbeddedBrowserState(result); }
  catch (error) { browserError(error); }
}
$('browser-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-browser-account]');
  if (!button || !embeddedAccounts.some(account => account.id === button.dataset.browserAccount)) return;
  embeddedActiveId = button.dataset.browserAccount; embeddedBrowserError = '';
  renderEmbeddedBrowser(); scheduleEmbeddedBrowserSync();
});
$('browser-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !embeddedAccounts.length) return;
  event.preventDefault();
  const current = Math.max(0, embeddedAccounts.findIndex(account => account.id === embeddedActiveId));
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? embeddedAccounts.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + embeddedAccounts.length) % embeddedAccounts.length;
  embeddedActiveId = embeddedAccounts[index].id; embeddedBrowserError = ''; renderEmbeddedBrowser(); scheduleEmbeddedBrowserSync();
  [...$('browser-tabs').querySelectorAll('button')][index].focus();
});
$('btn-browser-workspace').addEventListener('click', () => navigateTo(embeddedReturnPage || 'overview'));
$('btn-browser-note-dismiss').addEventListener('click', () => {
  embeddedIntroDismissed = true;
  try { localStorage.setItem('hm-embedded-browser-intro-v230', '1'); } catch (_) {}
  renderEmbeddedBrowser(); scheduleEmbeddedBrowserSync();
});
$('btn-browser-show').addEventListener('click', () => { embeddedBrowserError = ''; embeddedPresentedId = ''; renderEmbeddedBrowser(); scheduleEmbeddedBrowserSync(); });
for (const [id, method] of [['btn-browser-back', 'back'], ['btn-browser-forward', 'forward'], ['btn-browser-reload', 'reload']]) $(id).addEventListener('click', async () => {
  if (!embeddedBrowser || !embeddedSelected()) return;
  const accountId = embeddedActiveId; $(id).disabled = true;
  try {
    embeddedSyncChain = embeddedSyncChain.then(syncEmbeddedBrowser);
    await embeddedSyncChain;
    if (embeddedPageVisible() && embeddedActiveId === accountId && embeddedPresentedId === accountId) await embeddedBrowser[method]();
  } catch (error) { browserError(error); }
  finally { renderEmbeddedBrowser(); }
});
if (embeddedBrowser) {
  if (typeof embeddedBrowser.onState === 'function') embeddedUnsubscribe = embeddedBrowser.onState(value => acceptEmbeddedBrowserState(value, true));
  if (typeof ResizeObserver === 'function') {
    embeddedResizeObserver = new ResizeObserver(scheduleEmbeddedBrowserSync);
    for (const element of [$('browser-view-slot'), $('btn-global-stop'), document.querySelector('.app-topbar')]) embeddedResizeObserver.observe(element);
  }
  for (const event of ['resize', 'scroll']) window.addEventListener(event, scheduleEmbeddedBrowserSync, { passive: true });
  document.addEventListener('visibilitychange', scheduleEmbeddedBrowserSync);
  window.addEventListener('beforeunload', () => {
    if (typeof embeddedUnsubscribe === 'function') embeddedUnsubscribe();
    if (embeddedResizeObserver) embeddedResizeObserver.disconnect();
    Promise.resolve(embeddedBrowser.hide()).catch(() => {});
  });
}
renderEmbeddedBrowser();

/* ---------- 渲染 ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stBadge(st) {
  const map = { new: ['b-new', '未处理'], followed: ['b-followed', '已关注'], dm_sent: ['b-dm', '已私信'], followed_dm: ['b-dm', '已关注+已私信'], replied: ['b-followed', '已回复'], no_dm: ['b-nodm', '无法私信'], skipped: ['b-nodm', '跳过'], do_not_contact: ['b-failed', '不再联系'], dm_pending: ['b-pending', '私信待核验'], follow_pending: ['b-pending', '关注待核验'], dm_failed: ['b-failed', '私信失败'], follow_failed: ['b-failed', '关注失败'] };
  const [cls, txt] = map[st] || ['b-new', st || '?'];
  return `<span class="badge ${cls}">${txt}</span>`;
}

function fillAccounts(selectId) {
  const sel = $(selectId);
  const selected = sel.value;
  const accounts = state.accounts || [];
  if (selectId === 'log-account') {
    sel.innerHTML = '<option value="system">系统 / AI 判断日志</option>' + accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}（${esc(loginPhaseLabels[loginFeedbackFor(a).phase])}）</option>`).join('');
    if (selected === 'system' || accounts.some(a => String(a.id) === selected)) sel.value = selected;
    return;
  }
  sel.innerHTML = accounts.map(a => `<option value="${a.id}">${esc(a.name)}（${esc(loginPhaseLabels[loginFeedbackFor(a).phase])}）</option>`).join('');
  if (!accounts.length) sel.innerHTML = '<option value="">（请先添加账号）</option>';
  if (accounts.some(a => String(a.id) === selected)) sel.value = selected;
}

function renderAiBudget(task) {
  if (!task || task.kind !== 'ai') return '';
  const budget = task.aiBudget;
  const number = value => Number.isFinite(value) ? value.toLocaleString() : '—';
  let detail = budget ? `<div class="task-detail">保守估算：输入 ${number(budget.inputTokensEstimate)} ＋ 返回预留 ${number(budget.outputTokensReserved)} ＝ ${number(budget.totalTokensEstimate)} / ${Math.round((budget.targetRatio || .9) * 100)}% 预算 ${number(budget.targetTokens)} token</div>` : '';
  if (task.aiBaseBudget) detail += `<div class="task-detail">介绍、要求及消息包装估算：${number(task.aiBaseBudget.inputTokensEstimate)} token</div>`;
  const usage = task.aiUsage && task.aiUsage.usage;
  if (usage) detail += `<div class="task-detail">最近回执实际用量：输入 ${number(usage.prompt_tokens)}，输出 ${number(usage.completion_tokens)} token；以服务器返回为准</div>`;
  if (Number.isFinite(task.aiCompletionRequests)) detail += `<div class="task-detail">实际接口请求：判断 ${number(task.aiCompletionRequests)} 次，模型查询 ${number(task.aiModelRequests || 0)} 次（含重试）</div>`;
  if (task.auditWarning) detail += `<div class="task-detail err">${esc(task.auditWarning)}</div>`;
  return detail;
}
const taskStageLabels = { opening_profile: '打开用户主页', following: '关注', opening_dm: '打开私信', selecting_conversation: '从消息列表查找并进入目标对话', checking_dm_history: '检查目标对话的私信历史', filling_dm: '填写消息', sending_dm: '发送消息', verifying_dm: '核验发送回执', user_done: '本用户处理结束', waiting_user: '等待下一位用户', waiting_work: '等待下一个作品', waiting_comments: '等待下一页评论', opening_work: '打开作品', opening_comments: '定位评论区', collecting: '采集评论', collecting_comments: '采集评论', collected: '采集结束', ai: 'AI 批量判断', review_ready: '等待筛选名单', ai_paused: 'AI 判断已暂停' };
function taskProgressMarkup(task) {
  if (!task) return '';
  const stage = taskStageLabels[task.stage];
  const end = Number(task.waitingUntil) || Date.parse(task.waitingUntil || '');
  const seconds = Number.isFinite(end) && end > Date.now() ? Math.ceil((end - Date.now()) / 1000) : null;
  const reason = { work: '下一作品间隔', user: '下一用户间隔', comments: '评论翻页间隔' }[task.waitingReason] || task.waitingReason;
  const waiting = task.running && !/剩余.*秒/.test(task.status || '') && (reason || seconds !== null) ? '<div class="task-detail">' + esc(reason || stage || '等待网页就绪') + (seconds !== null ? ' · 剩余约 ' + seconds + ' 秒' : '') + ' · 可随时停止</div>' : '';
  const total = Number(task.total || task.totalUsers || 0), done = Math.min(total, Math.max(0, Number(task.done) || 0));
  const meter = total > 0 ? '<div class="task-meter" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + done + '"><span style="width:' + Math.min(100, done / total * 100) + '%"></span></div>' : '';
  return (stage ? '<div class="task-stage-label">当前阶段 · ' + esc(stage) + '</div>' : '') + waiting + meter;
}
function taskActive(task) { return !!(task && (task.running || task.distributionActive)); }
function renderTask(elId, task) {
  const el = $(elId); if (!el) return;
  const active = taskActive(task);
  el.className = 'task-box' + (active ? ' running' : '');
  const total = Number(task && (task.total || task.totalUsers) || 0);
  const progress = total ? '（' + esc(task.done || 0) + '/' + esc(total) + '）' : '';
  el.innerHTML = (active ? '进行中 · ' : '') + esc(task && task.status || '等待开始任务') + progress + (task && task.detail ? '<div class="task-detail">' + esc(task.detail) + '</div>' : '') + taskProgressMarkup(task) + renderAiBudget(task);
}
function rangeText(seconds, jitter) {
  const base = Number(seconds) || 0, rate = Number(jitter) || 0;
  const round = value => Number(value.toFixed(1));
  return base + ' 秒 ±' + Math.round(rate * 100) + '%（' + round(base * (1 - rate)) + '–' + round(base * (1 + rate)) + ' 秒）';
}
function renderWorkflowStatus() {
  if (!state) return;
  const c = state.settings.collect || {}, a = state.settings.action || {};
  $('collect-pacing-summary').textContent = '翻页 ' + rangeText(c.scrollIntervalSec, c.scrollJitter) + '；作品之间 ' + rangeText(c.linkIntervalSec, c.linkIntervalJitter);
  $('action-pacing-summary').textContent = '用户之间 ' + rangeText(a.userIntervalSec ?? 10, a.userIntervalJitter ?? .4) + '；同一主页内连续完成操作';
  const ready = (state.accounts || []).filter(account => loginFeedbackFor(account).phase === 'authenticated').length;
  $('flow-accounts').textContent = ready ? ready + ' 个账号已登录' : '先检查专用浏览器登录';
  const next = $('overview-next');
  if (taskActive(state.task)) { next.dataset.goto = state.task.kind === 'ai' ? 'leads' : ['follow', 'dm', 'outreach'].includes(state.task.kind) ? 'actions' : state.task.kind === 'login' ? 'accounts' : state.task.kind === 'dm_distribution' ? 'leads' : 'collect'; next.textContent = '查看当前任务'; $('overview-next-title').textContent = '任务正在进行'; $('overview-next-detail').textContent = state.task.status || '可查看实时进度，或随时停止。'; }
  else if (!ready) { next.dataset.goto = 'accounts'; next.textContent = '进入账号管理'; $('overview-next-title').textContent = '先让采集账号就绪'; $('overview-next-detail').textContent = '打开专用浏览器，扫码后以实际登录反馈为准。'; }
  else { next.dataset.goto = 'collect'; next.textContent = '添加作品链接'; $('overview-next-title').textContent = '账号已就绪，开始本次采集'; $('overview-next-detail').textContent = '采集评论 → AI 判断 → 筛选名单 → 关注与私信。'; }
  if (state.task && state.task.collectionSummary) lastCollectionSummary = state.task.collectionSummary;
  const summary = lastCollectionSummary, summaryBox = $('collection-summary');
  summaryBox.classList.toggle('hidden', !summary);
  if (summary) {
    const collectionStatus = { collecting: '采集中', completed: '采集完成', paused: '采集暂停', error: '采集异常' }[summary.status] || summary.status || '本次采集记录';
    const aiStatus = { pending: '等待判断', running: '正在批量判断', completed: '判断完成', paused: '判断暂停', blocked: '需要处理 AI 配置', skipped: '本次未自动判断' }[summary.aiStatus] || summary.aiStatus || '';
    const counts = summary.aiCounts;
    summaryBox.innerHTML = '<strong>' + esc(collectionStatus) + '</strong><div class="collection-metrics"><span>处理作品 <b>' + esc(summary.processed ?? 0) + '</b></span><span>完整 <b>' + esc(summary.completed ?? 0) + '</b></span><span>可续采 <b>' + esc(summary.partial ?? 0) + '</b></span><span>新增线索 <b>' + esc(summary.newLeads ?? 0) + '</b></span><span>评论记录 <b>' + esc(summary.commentLeadCount ?? 0) + '</b></span></div>' + (aiStatus ? '<p class="note"><strong>AI：' + esc(aiStatus) + '</strong>' + (counts ? ' · 是 ' + esc(counts.yes ?? 0) + ' / 否 ' + esc(counts.no ?? 0) + ' / 未完成 ' + esc(summary.aiPendingCount ?? counts.failed ?? 0) : '') + (summary.aiMessage ? '<br>' + esc(summary.aiMessage) : '') + '</p>' : '');
  }
  $('collection-next').classList.toggle('hidden', !summary || !summary.runId || !Number(summary.commentLeadCount));
  renderCollectStatus(); renderActionStages(); renderConfigActions();
}
function renderCollectStatus() {
  if (collectFeedback && collectFeedback.signature !== actionTaskSignature(state && state.task) && collectFeedback.phase !== 'error') collectFeedback = null;
  const box = $('collect-feedback'); box.className = 'task-box' + (!collectFeedback ? ' hidden' : collectFeedback.phase === 'error' ? ' err' : ' running'); box.textContent = collectFeedback && collectFeedback.message || '';
  renderTask('col-status', state && state.task);
}
function setCollectFeedback(phase, message) { collectFeedback = { phase, message, signature: actionTaskSignature(state && state.task) }; renderCollectStatus(); }
function renderActionStages() {
  const task = state && state.task, isOutreach = task && ['outreach', 'follow', 'dm'].includes(task.kind);
  const steps = [['opening_profile', '主页'], ['following', '关注'], ['opening_dm', '打开私信'], ['filling_dm', '填写'], ['sending_dm', '发送'], ['verifying_dm', '核验']];
  const stage = task && ({ selecting_conversation: 'opening_dm', checking_dm_history: 'opening_dm' }[task.stage] || task.stage);
  $('act-stage-flow').innerHTML = steps.map(([key,label], index) => '<div class="action-stage ' + (isOutreach && stage === key ? 'active' : '') + '"' + (isOutreach && stage === key ? ' aria-current="step"' : '') + '><span>' + (index + 1) + '</span><strong>' + label + '</strong></div>').join('');
  const current = isOutreach && task.currentLead;
  $('act-user-summary').classList.toggle('hidden', !current);
  $('act-user-summary').textContent = current ? ('当前用户：' + (current.nickname || current.id || '未命名用户') + (task.currentUserIndex ? ' · 第 ' + task.currentUserIndex + ' / ' + (task.totalUsers || task.total || '—') + ' 位' : '') + (task.currentUserOutcome ? '\n' + task.currentUserOutcome : '')) : '';
}
$('btn-collection-leads').addEventListener('click', () => {
  const summary = lastCollectionSummary; if (!summary || !summary.runId) return;
  selectedLeadIds.clear();
  leadFilter = { f: 'all', s: '', q: '', commentDays: 7, contact: 'all', collectionRunId: String(summary.runId) }; $('lead-q').value = '';
  $('lead-comment-days').value = '7';
  for (const chip of document.querySelectorAll('#chip-filters .chip')) { chip.classList.toggle('active', chip.dataset.f === 'all'); chip.setAttribute('aria-pressed', chip.dataset.f === 'all' ? 'true' : 'false'); }
  for (const chip of document.querySelectorAll('#chip-status .chip')) chip.classList.toggle('active', chip.dataset.s === '');
  if (summary.accountId != null) { $('act-account').value = String(summary.accountId); }
  navigateTo('leads'); renderSelectionInfo();
});
$('lead-run-scope').addEventListener('click', event => {
  if (!event.target.closest('[data-clear-run]')) return;
  delete leadFilter.collectionRunId; renderSelectionInfo(); loadLeads();
});

function renderOverview() {
  if (!state) return;
  $('st-total').textContent = state.stats.total;
  $('st-intent').textContent = state.stats.intent;
  $('st-followed').textContent = state.stats.followed;
  $('st-dm').textContent = state.stats.dmSent;
  $('st-new').textContent = state.stats.newCount;
  $('st-ai').textContent = state.stats.aiJudged || 0;
  renderTask('task-box', state.task);

  const tbody = $('ov-accounts').querySelector('tbody');
  $('ov-accounts').classList.toggle('empty-table', !(state.accounts || []).length);
  tbody.innerHTML = (state.accounts || []).map(a => `
    <tr><td>${esc(a.name)}</td><td>${esc(loginPhaseLabels[loginFeedbackFor(a).phase])}</td>
    <td>${a.daily.followAttempts || a.daily.follow || 0}/${state.settings.follow.dailyLimit} · 成功 ${a.daily.follow || 0}</td>
    <td>${a.daily.dmAttempts || a.daily.dm || 0}/${state.settings.dm.dailyLimit} · 成功 ${a.daily.dm || 0}</td>
    <td>${a.daily.collectAttempts || a.daily.videoAttempts || a.daily.videos || 0}/${state.settings.collect.dailyVideoLimit} · 已处理 ${a.daily.videos || 0}</td></tr>`).join('') || `<tr><td colspan="5" class="empty-cell">${emptyState('◎', '还没有添加采集账号', '进入账号管理，添加并登录您的抖音账号')}</td></tr>`;
}

const loginPhaseLabels = {
  authenticated: '已登录', logged_out: '未登录', pending: '等待扫码 / 确认',
  checking: '检查中',
  verification_required: '需要人工验证', browser_closed: '浏览器已关闭', unknown: '登录状态待确认',
  timeout: '登录等待超时', stopped: '登录监测已停止', error: '操作未完成', info: '账号操作完成'
};
function loginPhase(value, running = false) {
  if (Object.hasOwn(loginPhaseLabels, value)) return value;
  const text = String(value || '');
  if (/超时/.test(text)) return 'timeout';
  if (/停止|已取消/.test(text)) return 'stopped';
  if (/关闭/.test(text)) return 'browser_closed';
  if (/验证|验证码|滑块/.test(text)) return 'verification_required';
  if (/未登录|需要登录/.test(text)) return 'logged_out';
  if (/已登录|登录成功|扫码成功/.test(text)) return 'authenticated';
  if (/失败|错误/.test(text)) return 'error';
  return running ? 'pending' : 'unknown';
}
function loginTaskSignature(task) {
  return task && task.kind === 'login' ? JSON.stringify([String(task.accountId), task.running, task.status, task.detail, task.loginState, task.state]) : '';
}
function accountStateSignature(account) {
  return account ? JSON.stringify([account.loginStatus, account.loginState, account.loginMessage, account.loginCheckedAt, account.loginAt]) : '';
}
function startupScanAccountFeedback(account) {
  const scan = state && state.accountLoginScan;
  const current = scan && scan.accountStates && scan.accountStates[String(account.id)];
  if (!scan || !['queued', 'running', 'stopped'].includes(scan.phase) || !current || current.checked !== false) return null;
  return {
    phase: scan.phase === 'running' && current.state === 'checking' ? 'checking' : 'unknown',
    message: scan.phase === 'stopped' ? '本次启动检查已停止，当前登录状态尚未确认；可点击“检查”重新核验。' : current.message || '本次启动尚未完成登录检查。',
    busy: false
  };
}
function startupScanBusy() {
  return !!(state && state.accountLoginScan && ['queued', 'running'].includes(state.accountLoginScan.phase));
}
function loginFeedbackFor(account) {
  const id = String(account.id), local = accountFeedback.get(id);
  const scanning = startupScanAccountFeedback(account);
  if (scanning) { accountFeedback.delete(id); return scanning; }
  const task = state && state.task;
  const related = task && task.kind === 'login' && String(task.accountId) === id;
  if (local && (local.busy || (local.taskSignature === loginTaskSignature(task) && local.accountSignature === accountStateSignature(account)))) return local;
  if (local) accountFeedback.delete(id);
  if (related && task.running) return {
    phase: loginPhase(task.loginState || task.state || task.status, task.running),
    message: [...new Set([task.status, task.detail].filter(Boolean))].join('；'), busy: false
  };
  return { phase: loginPhase(account.loginStatus || account.loginState), message: account.loginMessage || '', busy: false };
}
function showAccountNotice(id, phase, message, busy = false) {
  const account = id == null ? null : ((state && state.accounts) || []).find(item => String(item.id) === String(id));
  const notice = { id: id == null ? null : String(id), phase, message, busy, taskSignature: loginTaskSignature(state && state.task), accountSignature: accountStateSignature(account) };
  if (notice.id != null) accountFeedback.set(notice.id, notice);
  lastAccountNotice = notice;
  accountRefreshError = '';
  renderAccounts();
}
function renderStartupLoginScan() {
  const box = $('account-startup-status'), scan = state && state.accountLoginScan;
  if (!scan || scan.phase === 'idle') { box.classList.add('hidden'); return; }
  const total = Number.isFinite(Number(scan.total)) ? Math.max(0, Number(scan.total)) : 0;
  const done = Number.isFinite(Number(scan.done)) ? Math.max(0, Math.min(total, Number(scan.done))) : 0;
  const labels = { queued: '启动登录检查等待中', running: '正在自动检查登录', completed: '启动登录检查已完成', stopped: '启动登录检查已停止' };
  const defaults = { queued: '等待当前任务结束后，程序会依次检查已有账号。', running: '正在读取账号专用浏览器的当前登录证据，可随时停止。', completed: '检查结果已更新到下方账号列表。', stopped: '尚未检查的账号保留为登录状态待确认，可手动重新检查。' };
  const account = (state.accounts || []).find(item => String(item.id) === String(scan.accountId));
  box.className = 'task-box account-status' + (['queued', 'running', 'stopped'].includes(scan.phase) ? ' running' : '');
  box.dataset.state = scan.phase;
  box.innerHTML = `<strong>${esc(labels[scan.phase] || '启动登录检查')}（${done}/${total}）</strong>${scan.phase === 'running' && account ? `<div class="task-detail">当前账号：${esc(account.name)}</div>` : ''}<div class="task-detail">${esc(scan.message || defaults[scan.phase] || '')}</div>${['queued', 'running'].includes(scan.phase) ? '<div class="row" style="margin-top:6px"><button id="btn-stop-scan" class="normal">停止检查</button><span class="hint">停止后未检查的账号保留为“待确认”，可单独点“检查”。</span></div>' : ''}`;
}
$('account-startup-status').addEventListener('click', async event => {
  if (!event.target.closest('#btn-stop-scan')) return;
  event.target.disabled = true;
  try { await api('/tasks/stop', { method: 'POST' }); } catch (_) { /* 状态由刷新呈现 */ }
  finally { refresh(); }
});
function renderAccountNotice() {
  const box = $('account-login-status'), task = state && state.task;
  if (accountRefreshError) {
    box.className = 'task-box account-status err'; box.dataset.state = 'error';
    box.textContent = `账号状态更新未完成：${accountRefreshError}`;
    return;
  }
  let notice = lastAccountNotice, name = '';
  if (notice && notice.id != null) {
    const account = (state.accounts || []).find(a => String(a.id) === notice.id);
    if (account) { name = account.name; notice = loginFeedbackFor(account); }
  } else if (!notice && task && task.kind === 'login') {
    const account = (state.accounts || []).find(a => String(a.id) === String(task.accountId));
    if (account) { name = account.name; notice = loginFeedbackFor(account); }
  }
  if (!notice) {
    box.className = 'task-box account-status';
    delete box.dataset.state;
    box.textContent = '软件会自动检查已有账号；也可用“检查”按钮重新核验。扫码登录和账号操作的结果将在此显示。';
    return;
  }
  const phase = notice.phase;
  box.className = 'task-box account-status' + (phase === 'authenticated' ? ' ok' : ['error', 'timeout'].includes(phase) ? ' err' : ['checking', 'pending', 'verification_required', 'unknown'].includes(phase) ? ' running' : '');
  box.dataset.state = phase;
  box.innerHTML = `<strong>${name ? esc(name) + ' · ' : ''}${esc(loginPhaseLabels[phase] || '账号操作')}</strong>${notice.message ? `<div class="task-detail">${esc(notice.message)}</div>` : ''}`;
}
function renderAccounts() {
  if (!state) return;
  $('btn-add-acc').disabled = startupScanBusy();
  const list = $('acc-list');
  list.closest('table').classList.toggle('empty-table', !(state.accounts || []).length);
  list.innerHTML = (state.accounts || []).map(a => {
    const feedback = loginFeedbackFor(a);
    // 任何任务运行期间（含登录轮询）都不允许再操作账号浏览器；
    // 新增账号是本地写入，不受此限制。
    const taskBusy = taskActive(state && state.task);
    const locked = feedback.busy || startupScanBusy() || taskBusy;
    return `<tr data-account-row="${esc(a.id)}">
      <td>${a.id}</td>
      <td>${esc(a.name)}${a.note ? `<br><span class="subtext">${esc(a.note)}</span>` : ''}</td>
      <td class="account-login-cell" data-login-state="${esc(feedback.phase)}"><strong>${esc(loginPhaseLabels[feedback.phase] || a.loginState)}</strong>${feedback.message ? `<span class="subtext">${esc(feedback.message)}</span>` : ''}${a.loginCheckedAt ? `<span class="subtext">最近检查：${esc(a.loginCheckedAt)}</span>` : ''}${a.loginAt ? `<span class="subtext">最近确认登录：${esc(a.loginAt)}</span>` : ''}</td>
      <td><select data-account-mode="${esc(a.id)}" aria-label="${esc(a.name)}的浏览器模式" ${locked || taskBusy ? 'disabled' : ''}><option value="external" ${a.browserMode !== 'embedded' ? 'selected' : ''}>外部专用浏览器</option><option value="embedded" ${a.browserMode === 'embedded' ? 'selected' : ''} ${!embeddedBrowser ? 'disabled' : ''}>内嵌浏览器</option></select></td>
      <td>${esc(a.proxy || '—')}</td>
      <td>${a.daily.follow} / ${a.daily.dm} / ${a.daily.videos}</td>
      <td class="account-action-cell"><div class="account-actions">
        <button data-account-id="${esc(a.id)}" data-account-action="open" ${locked ? 'disabled' : ''}>打开登录</button>
        <button data-account-id="${esc(a.id)}" data-account-action="check" ${locked ? 'disabled' : ''}>检查</button>
        <button data-account-id="${esc(a.id)}" data-account-action="close" ${locked ? 'disabled' : ''}>关浏览器</button>
        <button class="danger" data-account-id="${esc(a.id)}" data-account-action="del" ${locked ? 'disabled' : ''}>删除</button>
      </div></td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="empty-cell">${emptyState('◎', '添加第一个抖音账号', '填写账号名称后，点击添加账号，再打开浏览器登录')}</td></tr>`;
  renderStartupLoginScan();
  renderAccountNotice();
}

function emptyState(icon, title, detail) {
  return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">${esc(icon)}</span><strong>${esc(title)}</strong><p>${esc(detail)}</p></div>`;
}

/* ---------- 线索库 ---------- */
function applyLeadFieldSchema(schema) {
  if (!schema || !Array.isArray(schema.fields) || !schema.fields.length || !Array.isArray(schema.groups)) throw new Error('未取得有效的数据字段定义，请刷新后重试');
  const keys = new Set();
  for (const field of schema.fields) {
    if (!field || typeof field.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(field.key) || keys.has(field.key) || typeof field.label !== 'string' || !schema.groups.some(group => group.id === field.group)) throw new Error('数据字段定义无效，请检查本机服务版本');
    keys.add(field.key);
  }
  leadFieldSchema = schema;
  const signature = JSON.stringify(schema);
  if (signature !== leadFieldSignature) {
    leadFieldSignature = signature;
    renderLeadFieldOptions();
  }
}
function visibleLeadFields() {
  if (!leadFieldSchema) return [];
  const fixed = compactFieldKeys();
  return leadFieldSchema.fields.filter(field => !fixed.has(field.key) && leadExtraFields.has(field.key));
}
function compactFieldKeys() {
  return new Set((leadFieldSchema && leadFieldSchema.compactColumns || []).flatMap(column => column.fields));
}
function persistLeadFieldView() {
  try { localStorage.setItem('hm-lead-view-fields-v1', JSON.stringify([...leadExtraFields])); } catch (_) { /* Display preferences can remain in memory. */ }
}
function renderLeadFieldOptions() {
  if (!leadFieldSchema) return;
  const fixed = compactFieldKeys();
  $('lead-field-options').innerHTML = leadFieldSchema.groups.map(group => {
    const fields = leadFieldSchema.fields.filter(field => field.group === group.id);
    return `<fieldset><legend>${esc(group.label)}</legend><div class="field-choice-list">${fields.map(field => `<label><input type="checkbox" data-lead-field="${esc(field.key)}" ${fixed.has(field.key) || leadExtraFields.has(field.key) ? 'checked' : ''} ${fixed.has(field.key) ? 'disabled' : ''}>${esc(field.label)}</label>`).join('')}</div></fieldset>`;
  }).join('');
}
$('lead-field-options').addEventListener('change', event => {
  const input = event.target.closest('[data-lead-field]');
  if (!input || !leadFieldSchema || compactFieldKeys().has(input.dataset.leadField) || !leadFieldSchema.fields.some(field => field.key === input.dataset.leadField)) return;
  if (input.checked) leadExtraFields.add(input.dataset.leadField); else leadExtraFields.delete(input.dataset.leadField);
  persistLeadFieldView(); renderLeads();
});
$('lead-fields-reset').addEventListener('click', () => { leadExtraFields.clear(); persistLeadFieldView(); renderLeadFieldOptions(); renderLeads(); });
function leadFieldValue(lead, key) {
  return lead.fieldValues && Object.hasOwn(lead.fieldValues, key) ? lead.fieldValues[key] : '';
}
function longTextCell(value, attributes) {
  const full = String(value == null ? '' : value);
  return full ? `<button class="lead-cell-button" ${attributes} title="点击查看完整内容"><span class="lead-two-lines">${esc(full.slice(0, 400))}${full.length > 400 ? '…' : ''}</span></button>` : '<span class="empty-placeholder">—</span>';
}
function safeHttpLink(value) {
  try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; }
}
function renderLeadField(lead, field) {
  const value = leadFieldValue(lead, field.key);
  const text = value == null || value === '' ? '<span class="empty-placeholder">—</span>' : esc(value);
  if (field.key === 'aiNeed') return `${value ? `<span class="badge ${isAiCurrent(lead) && value === '是' ? 'b-intent' : 'b-nodm'}">${esc(value)}</span>` : ''}${lead.aiDone && !isAiCurrent(lead) ? '<span class="badge b-pending">旧规则</span>' : ''}<button class="mini" data-lead-id="${esc(lead.id)}" data-lead-action="judge">${lead.aiDone ? '重判' : '判断'}</button>`;
  if (field.key === 'aiScore') return `<span title="历史评分仅供查阅；新版不生成评分，也不按评分决定执行">${text}${value !== '' && value != null ? '<span class="subtext">历史评分</span>' : ''}</span>`;
  if (field.key === 'aiReason' && Array.from(String(value || '')).length <= 30) return text;
  if (field.key === 'trigger') return value ? `<span class="badge b-intent">✔${esc(value)}</span>` : text;
  if (field.key === 'status') return stBadge(value);
  if (field.key === 'videoDesc' && !value) return `<span class="badge b-pending" title="${esc(leadFieldValue(lead, 'descriptionReason') || '评论完整度与作品描述分别核验；未获取的描述可在后续作品采集时补充。')}">${lead.workTextState === 'empty' ? '作品无文字描述' : '描述未获取'}</span>`;
  if (field.type === 'longtext' || ['videoDesc', 'demand', 'aiReason'].includes(field.key)) return longTextCell(value, `data-detail-lead="${esc(lead.id)}" data-detail-field="${esc(field.key)}"`);
  if (field.type === 'url' || field.key === 'homepage') {
    const href = safeHttpLink(value);
    return href ? `<button class="lead-copy" data-copy-lead="${esc(lead.id)}" data-copy-field="${esc(field.key)}">复制链接</button>` : '<span class="lead-muted">—</span>';
  }
  return `<span class="lead-two-lines" title="${esc(value)}">${text}</span>`;
}
let lastLeadRenderSig = '';
function renderLeads() {
  const tbody = $('lead-list');
  const leads = state.leads || [];
  const columns = leadFieldSchema && leadFieldSchema.compactColumns;
  if (!Array.isArray(columns) || !columns.length) throw new Error('未取得紧凑列表定义，请检查本机服务版本');
  const extras = visibleLeadFields(), fields = [...columns, ...extras];
  // 数据、排序、附加字段与勾选都未变化时跳过重绘，避免空闲轮询每 2.5 秒整表重建导致的闪烁与点击丢失
  const renderSig = JSON.stringify([leadSort.k, leadSort.dir, extras.map(f => f.key), [...selectedLeadIds].sort(), leads.map(l => { const { comments, ...rest } = l; return rest; })]);
  if (renderSig === lastLeadRenderSig) return;
  lastLeadRenderSig = renderSig;
  const table = tbody.closest('table');
  table.style.minWidth = (1040 + extras.reduce((n, f) => n + Math.min(420, Math.max(110, Number(f.width) || 150)), 0)) + 'px';
  $('lead-head').innerHTML = fields.map(field => `<th ${field.key !== 'id' ? 'tabindex="0" data-k="' + esc(field.key) + '"' : ''} data-field-key="${esc(field.key)}" class="${esc(field.className || '')}" ${extras.length ? 'style="width:' + Math.min(420, Math.max(54, Number(field.width) || 150)) + 'px"' : ''} aria-sort="${leadSort.k === field.key ? leadSort.dir > 0 ? 'ascending' : 'descending' : 'none'}">${field.key === 'id' ? '<input id="lead-select-all" type="checkbox" aria-label="勾选当前可见线索"> ' : ''}${esc(field.label)}${leadSort.k === field.key && field.key !== 'id' ? leadSort.dir > 0 ? ' ↑' : ' ↓' : ''}</th>`).join('');
  $('lead-field-summary').textContent = `7 列紧凑视图${extras.length ? '＋' + extras.length + ' 个附加字段' : ''}`;
  tbody.closest('table').classList.toggle('empty-table', !leads.length);
  tbody.innerHTML = leads.map(l => `
    <tr class="${selectedLeadIds.has(String(l.id)) ? 'is-selected' : ''}">
      ${columns.map(column => `<td data-field-key="${esc(column.key)}" class="${esc(column.className || '')}">${compactLeadCell(l, column.key)}</td>`).join('')}
      ${extras.map(field => `<td data-field-key="${esc(field.key)}">${renderLeadField(l, field)}</td>`).join('')}
    </tr>`).join('') || `<tr><td colspan="${fields.length}" class="empty-cell">${emptyState('▤', '当前范围没有线索', '调整筛选条件，或采集作品后查看评论线索')}</td></tr>`;
  renderSelectionInfo();
}

function dateCell(value) {
  const parts = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(String(value || ''));
  return parts ? `<span class="lead-line">${esc(parts[1])}</span><span class="lead-line lead-muted">${esc(parts[2])}</span>` : `<span class="lead-line lead-muted">${esc(value || '—')}</span>`;
}
function workCell(title, body, full, type, attributes, emptyStateValue) {
  const text = String(body || full || '');
  if (!title && !text) return `<button class="lead-cell-button" ${attributes}><span class="lead-two-lines lead-muted">${emptyStateValue === 'empty' ? '作品无文字描述' : '描述未获取'}</span></button>`;
  return `<button class="lead-cell-button" ${attributes} title="点击查看完整作品内容">${title ? `<span class="lead-line lead-title">${esc(title)}</span><span class="lead-line lead-body">${esc(text || type || '')}</span>` : `<span class="lead-two-lines lead-body">${type ? '<span class="lead-title">' + esc(type) + ' · </span>' : ''}${esc(text.slice(0, 400))}${text.length > 400 ? '…' : ''}</span>`}</button>`;
}
function compactLeadCell(lead, key) {
  const id = esc(lead.id), detail = `data-lead-detail="${id}"`;
  if (key === 'id') return `<span class="lead-line"><input class="lead-select" type="checkbox" data-lead-id="${id}" ${selectedLeadIds.has(String(lead.id)) ? 'checked' : ''} aria-label="勾选 ${esc(lead.nickname)}"></span><span class="lead-line">${id}</span>`;
  if (key === 'nickname') return `<button class="lead-cell-button" ${detail} title="查看线索详情"><span class="lead-line lead-name">${esc(lead.nickname || '未命名用户')}</span></button>${safeHttpLink(leadFieldValue(lead, 'homepage')) ? `<button class="lead-copy lead-line" data-copy-lead="${id}" data-copy-field="homepage">复制主页</button>` : '<span class="lead-line lead-muted">主页未获取</span>'}`;
  if (key === 'time') return dateCell(leadFieldValue(lead, 'time'));
  if (key === 'demand') return longTextCell(leadFieldValue(lead, key), `data-detail-lead="${id}" data-detail-field="demand"`);
  if (key === 'videoDesc') return workCell(leadFieldValue(lead, 'workTitle'), leadFieldValue(lead, 'workContent'), leadFieldValue(lead, 'videoDesc'), leadFieldValue(lead, 'workType'), `data-detail-lead="${id}" data-detail-field="videoDesc"`, lead.workTextState);
  if (key === 'aiNeed') {
    const category = lead.aiCategory || (leadAiExclusionReason(lead) ? 'ai_excluded' : isAiCurrent(lead) ? lead.aiNeed === '是' ? 'ai_yes' : 'ai_no' : lead.aiDone || lead.aiNeed ? 'ai_stale' : 'ai_todo');
    const label = { ai_yes: '是 · 可考虑联系', ai_no: '否 · 不建议联系', ai_todo: '未判断', ai_stale: '需重判', ai_excluded: '不参与判断' }[category] || '未判断';
    const reason = category === 'ai_excluded' ? leadAiExclusionReason(lead) : leadFieldValue(lead, 'aiReason') || (category === 'ai_stale' ? '规则或线索内容已变化' : category === 'ai_todo' ? '等待 AI 判断' : '');
    return `<button class="lead-cell-button" ${detail} title="查看判断详情 / 重新判断"><span class="lead-line ${category === 'ai_yes' ? 'lead-ai-yes' : category === 'ai_stale' ? 'lead-status-pending' : 'lead-ai-no'}">${label}</span><span class="lead-line lead-muted">${esc(reason)}</span></button>`;
  }
  if (key === 'contact') {
    if (lead.doNotContact || lead.status === 'do_not_contact') return `<button class="lead-cell-button" ${detail}><span class="lead-line lead-status-failure">不再联系</span><span class="lead-line lead-muted">查看详情</span></button>`;
    if (lead.replied || lead.status === 'replied') return `<button class="lead-cell-button" ${detail}><span class="lead-line lead-status-success">已回复</span><span class="lead-line lead-muted">查看详情</span></button>`;
    const line = kind => {
      const name = kind === 'dm' ? '私信' : '关注';
      const ownAction = kind === 'dm' || String(lead.followAttemptAccountId || lead.accountId) === String(lead.accountId);
      const outcome = ownAction && (lead[kind + 'State'] || lead[kind + 'Outcome']);
      const legacyPending = !outcome && ownAction && lead.status === (kind === 'dm' ? 'dm_pending' : 'follow_pending');
      const legacyFailed = !outcome && ownAction && lead.status === (kind === 'dm' ? 'dm_failed' : 'follow_failed');
      if (outcome === 'pending_verification' || legacyPending) return `<span class="lead-line lead-status-pending">${name}待核验</span>`;
      if (kind === 'dm' && lead.noDm && lead.noDmConfirmed) return '<span class="lead-line lead-status-failure">无法私信</span>';
      const priorDm = kind === 'dm' && (Number(lead.dmCount) > 0 || ['dm_sent', 'followed_dm'].includes(lead.status)
        || [lead.dmHistoryObserved, lead.dmHistorySentObserved].some(row => row?.state === 'already_sent'));
      if (priorDm && (outcome === 'confirmed_failure' || legacyFailed)) return `<span class="lead-line lead-status-success" title="${esc('已有私信记录；最近操作失败原因见详情：' + (lead.dmFailedReason || ''))}">历史已私信 · 最近私信失败</span>`;
      if (outcome === 'confirmed_failure' || legacyFailed) {
        return `<span class="lead-line lead-status-failure" title="${esc(lead[kind + 'FailedReason'] || '')}">最近${name}失败</span>`;
      }
      const success = kind === 'dm'
        ? outcome === 'confirmed_success' || Number(lead.dmCount) > 0 || ['dm_sent', 'followed_dm'].includes(lead.status)
        : lead.followState === 'confirmed_success' || lead.followOutcome === 'confirmed_success' || !!lead.followedAt || ['followed', 'followed_dm'].includes(lead.status);
      const observed = kind === 'dm' ? lead.dmHistorySentObserved || lead.dmHistoryObserved : lead.followObserved;
      const historical = observed && (kind === 'dm' ? observed.state === 'already_sent' : observed.state === 'following');
      const label = kind === 'dm' ? success ? '私信已确认' : historical ? '历史已私信' : '暂无私信记录' : historical ? '主页已关注' : success ? '曾确认关注' : '暂无关注记录';
      return `<span class="lead-line ${success || historical ? 'lead-status-success' : 'lead-muted'}">${label}</span>`;
    };
    return `<button class="lead-cell-button" ${detail} title="查看联系结果 / 人工核验">${line('follow')}${line('dm')}</button>`;
  }
  return '';
}

function showLeadDetail(lead) {
  const sections = leadFieldSchema.groups.map(group => {
    const fields = leadFieldSchema.fields.filter(field => field.group === group.id && leadFieldValue(lead, field.key) !== '');
    return fields.length ? `【${group.label}】\n` + fields.map(field => `${field.label}：${leadFieldValue(lead, field.key)}`).join('\n\n') : '';
  }).filter(Boolean).join('\n\n');
  const failureDetails = [['关注失败原因', lead.followFailedReason], ['私信失败原因', lead.dmFailedReason]].filter(([, value]) => value).map(([name, value]) => name + '：' + value).join('\n\n');
  const historicalDm = lead.dmHistorySentObserved || lead.dmHistoryObserved;
  const historyDetails = historicalDm && historicalDm.state === 'already_sent' ? '【网页历史】\n' + (historicalDm.source === 'browser_chat_dom' ? '当前目标聊天中发现本人发出的历史消息，状态栏未显示异常；不代表对方已读。' : '网页响应确认存在本人发出的历史消息。') + '此观察不是本次发送回执，不计入本软件确认次数。\n最近发送时间：' + (historicalDm.lastSentAt ? new Date(historicalDm.lastSentAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未确认，禁止自动重复') : '';
  showFieldDetail(`线索 ${lead.id} · ${lead.nickname || '未命名用户'}`, [sections, failureDetails ? '【最近操作失败原因】\n' + failureDetails : '', historyDetails].filter(Boolean).join('\n\n'), '本软件操作结果与网页历史分开保留；关注关系在执行时重新核对。');
  const exclusionReason = leadAiExclusionReason(lead);
  $('lead-detail-actions').innerHTML = `<button class="mini" data-lead-id="${esc(lead.id)}" data-lead-action="judge"${exclusionReason ? ` disabled title="${esc(exclusionReason)}"` : ''}>${exclusionReason ? '不参与判断' : lead.aiDone ? '重新判断' : 'AI 判断'}</button>` + leadOperationButtons(lead);
  $('lead-detail-actions').classList.remove('hidden');
}

function isAiCurrent(lead) {
  if (typeof lead.aiResultCurrent === 'boolean') return lead.aiResultCurrent;
  return !!lead.aiDone && !!lead.aiPromptVersion && lead.aiPromptVersion === (state && state.aiRuleVersion);
}
function leadAiExclusionReason(lead) {
  return lead.aiExclusionReason || (lead.isAuthor ? '作品作者不参与 AI 判断' : !String(lead.demand || '').trim() ? '评论为空，无法进行 AI 判断' : '');
}

function outcomeBadge(lead, kind) {
  const value = lead[kind + 'State'];
  const name = kind === 'dm' ? '私信' : '关注';
  if (value === 'pending_verification') return `<span class="badge b-pending">${name}待核验</span>`;
  if (value === 'confirmed_failure') return `<span class="badge b-failed" title="${esc(lead[kind + 'FailedReason'] || '')}">${name}确认失败</span>`;
  return '';
}

function leadOperationButtons(lead) {
  const button = (action, text) => `<button class="mini" data-lead-id="${esc(lead.id)}" data-lead-action="${action}">${text}</button>`;
  let buttons = button('open', lead.profileCapturedAt ? '查看主页 / 更新资料' : '查看主页 / 补资料');
  for (const kind of ['dm', 'follow']) {
    if (lead[kind + 'State'] === 'pending_verification' && (kind === 'dm' || String(lead.followAttemptAccountId || lead.accountId) === String(lead.accountId))) {
      buttons += button(kind + '-success', `${kind === 'dm' ? '私信' : '关注'}核验成功`) + button(kind + '-failed', `${kind === 'dm' ? '私信' : '关注'}核验失败`);
    }
  }
  if (!lead.replied && !lead.doNotContact) buttons += button('replied', '已回复');
  if (!lead.doNotContact) buttons += button('do_not_contact', '不再联系');
  if (!lead.aiDone && !lead.aiNeed && !lead.manualApproved && !lead.doNotContact && !lead.replied) buttons += button('manual_approved', '人工批准');
  if (lead.manualApproved) buttons += '<span class="badge b-followed">已人工批准</span>';
  return buttons;
}

async function handleLeadClick(event) {
  const copy = event.target.closest('[data-copy-lead]');
  if (copy) {
    const lead = (state.leads || []).find(item => String(item.id) === copy.dataset.copyLead);
    const link = lead && safeHttpLink(leadFieldValue(lead, copy.dataset.copyField));
    if (link) await copyLink(link, copy);
    return;
  }
  const whole = event.target.closest('[data-lead-detail]');
  if (whole) {
    const lead = (state.leads || []).find(item => String(item.id) === whole.dataset.leadDetail);
    if (lead) showLeadDetail(lead);
    return;
  }
  const detail = event.target.closest('[data-detail-lead]');
  if (detail) {
    const lead = (state.leads || []).find(item => String(item.id) === detail.dataset.detailLead);
    const field = leadFieldSchema && leadFieldSchema.fields.find(item => item.key === detail.dataset.detailField);
    if (lead && field) showFieldDetail(field.label, leadFieldValue(lead, field.key), `线索 ${lead.id} · ${lead.nickname || ''}${field.key === 'videoDesc' ? ' · 作品标题与正文完整保存，列表仅显示摘要。' : ''}`);
    return;
  }
  const button = event.target.closest('[data-lead-action]');
  if (!button) return;
  const id = button.dataset.leadId, action = button.dataset.leadAction;
  if (!$('field-detail-modal').classList.contains('hidden')) closeModal('field-detail-modal');
  if (action === 'judge') { await judgeOne(id); return; }
  if (action === 'open') {
    const accountId = $('act-account').value;
    if (!accountId) throw new Error('请先选择执行账号');
    await api('/leads/' + encodeURIComponent(id) + '/open', { method: 'POST', body: { accountId } });
  } else if (/^(?:dm|follow)-(?:success|failed)$/.test(action)) {
    const [kind, outcome] = action.split('-');
    const note = await requestVerificationNote(kind, outcome);
    if (note === null) return;
    if (!note.trim()) throw new Error('请填写核验依据，防止误重发');
    await api('/leads/' + encodeURIComponent(id) + '/resolve', { method: 'POST', body: { kind, outcome, note: note.trim() } });
  } else {
    if (action === 'manual_approved' && !confirm('确认已审阅该用户需求并批准联系？人工批准仅适用于尚未 AI 判断的线索。')) return;
    if (action === 'do_not_contact' && !confirm('将该用户标记为不再联系，后续自动任务会跳过。')) return;
    await api('/leads/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { status: action } });
  }
  await loadLeads(); refresh();
}
$('lead-list').addEventListener('click', handleLeadClick);
$('lead-detail-actions').addEventListener('click', handleLeadClick);
async function copyLink(link, button) {
  try { await navigator.clipboard.writeText(link); button.textContent = '已复制'; }
  catch (_) { showFieldDetail('复制链接', link, '自动复制不可用，请复制下方链接。'); }
}

function requestVerificationNote(kind, outcome) {
  if (resolveVerification) throw new Error('已有待确认的核验操作');
  $('verification-title').textContent = `${kind === 'dm' ? '私信' : '关注'}核验${outcome === 'success' ? '成功' : '失败'}`;
  $('verification-note').value = ''; $('verification-error').textContent = '';
  openModal('verification-modal', 'verification-note');
  return new Promise(resolve => { resolveVerification = resolve; });
}

function completeVerification(note) {
  const resolve = resolveVerification; resolveVerification = null;
  closeModal('verification-modal');
  if (resolve) resolve(note);
}
$('verification-cancel').addEventListener('click', () => completeVerification(null));
$('verification-confirm').addEventListener('click', () => {
  const note = $('verification-note').value.trim();
  if (!note) { $('verification-error').textContent = '请填写核验依据'; return; }
  completeVerification(note);
});

$('lead-list').addEventListener('change', event => {
  if (!event.target.matches('.lead-select')) return;
  const id = event.target.dataset.leadId;
  if (event.target.checked) selectedLeadIds.add(id); else selectedLeadIds.delete(id);
  renderSelectionInfo();
});

$('lead-head').addEventListener('change', event => {
  if (event.target.id !== 'lead-select-all') return;
  for (const lead of state && state.leads || []) {
    if (event.target.checked) selectedLeadIds.add(String(lead.id)); else selectedLeadIds.delete(String(lead.id));
  }
  renderLeads();
});

function renderSelectionInfo() {
  const visible = state && state.leads || [];
  const count = visible.filter(lead => selectedLeadIds.has(String(lead.id))).length;
  const size = selectedLeadIds.size;
  // 执行范围自动判定并只做展示：有勾选走勾选，否则走当前筛选结果
  $('scope-display').textContent = size ? `执行范围：已勾选 ${size} 条` : '执行范围：当前筛选结果';
  const badge = $('selection-count');
  badge.textContent = size ? `已勾选 ${size} 条${size > count ? `（${size - count} 条不在当前筛选列表，执行仍按勾选）` : '（可跨筛选保留）'}`
    : '尚未勾选线索';
  badge.classList.toggle('active', size > 0);
  badge.classList.toggle('empty', size === 0);
  $('btn-clear-selection').classList.toggle('empty', size === 0);
  $('lead-select-all').checked = visible.length > 0 && count === visible.length;
  $('lead-select-all').indeterminate = count > 0 && count < visible.length;
  const runScope = $('lead-run-scope'); runScope.classList.toggle('hidden', !leadFilter.collectionRunId);
  runScope.innerHTML = leadFilter.collectionRunId ? '<span>范围：本次采集的评论用户。继续筛选会保留此范围；勾选范围仍以已勾选用户为准。</span><button class="normal" data-clear-run>查看全部采集</button>' : '';
  renderAiTask();
}

function filterDescription() {
  const names = { all: '全部 AI 结果', ai_todo: '未判断', ai_yes: 'AI 判断为是', ai_no: 'AI 判断为否', ai_stale: '需重判', ai_excluded: '不参与判断（作者或空评论）' };
  const statusNames = { new: '未处理', followed: '已关注', dm_sent: '已私信', followed_dm: '已关注和私信', no_dm: '无法私信', replied: '已回复', do_not_contact: '不再联系', dm_failed: '私信失败', follow_failed: '关注失败' };
  return [leadFilter.collectionRunId ? '本次采集' : '全部采集', names[leadFilter.f] || '全部', leadFilter.commentDays ? `评论 ${leadFilter.commentDays} 天内` : '', leadFilter.s ? '状态：' + (statusNames[leadFilter.s] || leadFilter.s) : '', leadFilter.q ? '搜索：' + leadFilter.q : ''].filter(Boolean).join(' · ');
}

function taskScope() {
  // Read the search box at action time, before its debounce has completed.
  leadFilter.q = $('lead-q').value.trim();
  // 执行范围自动判定：有勾选走勾选，否则走当前筛选结果
  if (selectedLeadIds.size) return { filters: { f: 'all', s: '', q: '' }, leadIds: Array.from(selectedLeadIds) };
  return { filters: { ...leadFilter } };
}
// 有勾选时把范围说清楚再执行：勾选可以跨筛选保留，但绝不能让用户以为
// 程序“自己挑人”。要按筛选执行，先清空勾选。
function confirmExecutionScope() {
  const size = selectedLeadIds.size;
  if (!size) return true;
  const visible = (state && state.leads || []).length;
  const outside = size > visible ? `（其中 ${size - visible} 条不在当前显示列表）` : '';
  return confirm(`本次执行按“已勾选”名单进行：共 ${size} 条${outside}。\n\n如果希望按当前筛选结果执行，请先点“清空勾选”。是否继续？`);
}
$('btn-clear-selection').addEventListener('click', () => { selectedLeadIds.clear(); renderLeads(); });

async function judgeOne(id) {
  if (aiSubmitBusy) return;
  const lead = state?.leads?.find(row => String(row.id) === String(id));
  if (lead && leadAiExclusionReason(lead)) { setAiFeedback('error', leadAiExclusionReason(lead)); return; }
  aiSubmitBusy = true;
  setAiFeedback('pending', '正在提交单条判断，可在这里查看进度并随时停止。');
  try {
    const r = await api('/ai/judge-one', { method: 'POST', body: { leadId: id } });
    if (!r || !r.ok) throw new Error(r?.error || '判断结果未写入');
    setAiFeedback('done', '单条判断已完成，结果已更新。');
    await loadLeads();
  } catch (error) { setAiFeedback('error', error.message || '判断请求未完成，请查看任务进度'); }
  finally { aiSubmitBusy = false; renderAiTask(); refresh(); }
}

$('lead-head').addEventListener('click', event => {
    const th = event.target.closest('th[data-k]');
    if (!th) return;
    const k = th.dataset.k;
    if (leadSort.k === k) leadSort.dir = -leadSort.dir;
    else { leadSort.k = k; leadSort.dir = -1; }
    renderLeadsSorted();
});
$('lead-head').addEventListener('keydown', event => {
  if (event.target.matches('th[data-k]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.click(); }
});

function renderLeadsSorted() {
  const leads = state.leads || [];
  const k = leadSort.k, dir = leadSort.dir;
  leads.sort((a, b) => {
    const va = k === 'contact' ? a.contactCategory || a.status || 'new' : leadFieldValue(a, k), vb = k === 'contact' ? b.contactCategory || b.status || 'new' : leadFieldValue(b, k);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'zh-CN') * dir;
  });
  renderLeads();
}

document.querySelectorAll('#chip-filters .chip').forEach(c => {
  c.addEventListener('click', () => {
    document.querySelectorAll('#chip-filters .chip').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
    c.classList.add('active');
    c.setAttribute('aria-pressed', 'true');
    leadFilter.f = c.dataset.f;
    renderSelectionInfo();
    loadLeads();
  });
});
document.querySelectorAll('#chip-status .chip').forEach(c => {
  c.addEventListener('click', () => {
    document.querySelectorAll('#chip-status .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    leadFilter.s = c.dataset.s;
    renderSelectionInfo();
    loadLeads();
  });
});

$('lead-q').addEventListener('input', debounce(() => { leadFilter.q = $('lead-q').value.trim(); loadLeads(); }, 400));
$('lead-comment-days').addEventListener('change', () => {
  leadFilter.commentDays = Number($('lead-comment-days').value);
  leadFilter.q = $('lead-q').value.trim();
  renderSelectionInfo(); loadLeads();
});
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function loadLeads() {
  const sequence = ++leadLoadSequence;
  const p = new URLSearchParams({ ...leadFilter, limit: '500' });
  const r = await api('/leads?' + p);
  if (sequence !== leadLoadSequence || !state) return;
  applyLeadFieldSchema(r.leadFields);
  state.leads = r.leads || [];
  for (const element of document.querySelectorAll('[data-ai-count]')) element.textContent = r.facets && r.facets.ai ? String(r.facets.ai[element.dataset.aiCount] || 0) : '—';
  const filteredCount = Number.isFinite(r.totalFiltered) ? r.totalFiltered : state.leads.length;
  $('leads-total').textContent = `共 ${r.total} 条`;
  $('filter-count').textContent = `筛选出 ${filteredCount} 条 / 共 ${r.total} 条${filteredCount > state.leads.length ? `（当前显示最近 ${state.leads.length} 条）` : ''}`;
  const pending = Number.isFinite(r.aiPending) ? r.aiPending : state.stats && Number.isFinite(state.stats.aiPending) ? state.stats.aiPending : state.leads.filter(l => !isAiCurrent(l) && !l.isAuthor).length;
  leadAiPendingCount = pending;
  renderAiTask();
  renderLeadsSorted();
}

$('btn-ai-start').addEventListener('click', async () => {
  if (aiSubmitBusy) return;
  aiSubmitBusy = true;
  try {
    const scope = taskScope();
    setAiFeedback('pending', '正在提交当前筛选或勾选范围，任务会固定本次名单。');
    const force = $('ai-force-rejudge').checked;
    await api('/ai/start', { method: 'POST', body: { ...scope, ...(force ? { force: true } : {}) } });
    $('ai-force-rejudge').checked = false;
    setAiFeedback('submitted', force ? 'AI 任务已提交，正在重新判断本次固定名单。' : 'AI 任务已提交，正在读取进度。未判断及旧规则结果将依次处理。');
  } catch (error) { setAiFeedback('error', error.message || '启动请求未完成，请检查任务进度'); }
  finally { aiSubmitBusy = false; renderAiTask(); refresh(); }
});

function setAiFeedback(phase, message) {
  aiFeedback = { phase, message, signature: actionTaskSignature(state && state.task) };
  renderAiTask();
}
function renderAiTask() {
  const task = state && state.task, box = $('ai-task-status');
  const excludedScope = !selectedLeadIds.size && leadFilter.f === 'ai_excluded';
  $('btn-ai-start').disabled = aiSubmitBusy || taskActive(task) || excludedScope;
  $('ai-force-rejudge').disabled = $('btn-ai-start').disabled;
  $('ai-pending').textContent = excludedScope ? '（作者或空评论不参与）' : selectedLeadIds.size ? `（已勾选 ${selectedLeadIds.size} 条）` : $('ai-force-rejudge').checked ? '（重新判断当前筛选范围）' : leadAiPendingCount ? `（待判断 ${leadAiPendingCount} 条）` : '';
  if (aiFeedback && aiFeedback.signature !== actionTaskSignature(task)) aiFeedback = null;
  if (aiFeedback) {
    box.className = 'task-box' + (aiFeedback.phase === 'error' ? ' err' : ['pending', 'submitted'].includes(aiFeedback.phase) ? ' running' : '');
    box.textContent = aiFeedback.message;
  } else if (task && (task.kind === 'ai' || taskActive(task))) {
    renderTask('ai-task-status', task);
  } else {
    box.className = 'task-box hidden'; box.textContent = '';
  }
}
$('ai-force-rejudge').addEventListener('change', renderAiTask);

$('btn-export').addEventListener('click', async () => {
  const button = $('btn-export');
  if (button.disabled) return;
  try {
    const scope = $('lead-export-scope').value;
    leadFilter.q = $('lead-q').value.trim();
    if (scope === 'selected' && !selectedLeadIds.size) throw new Error('尚未勾选线索，请先勾选再导出');
    const body = { scope, filters: { ...leadFilter }, ...(scope === 'selected' ? { leadIds: Array.from(selectedLeadIds) } : {}) };
    button.disabled = true;
    const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-auth-token': token }, body: JSON.stringify(body) });
    if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || '导出失败，请重试'); }
    const objectUrl = URL.createObjectURL(await response.blob());
    const a = document.createElement('a'); a.href = objectUrl;
    const filename = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('Content-Disposition') || '');
    try { a.download = filename ? decodeURIComponent(filename[1]) : '华贸获客-线索导出.xlsx'; } catch (_) { a.download = '华贸获客-线索导出.xlsx'; }
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    setActionFeedback('done', '导出文件已生成，范围：' + { filters: '当前筛选', selected: '已勾选线索', all: '全部线索' }[scope]);
  } catch (error) { setActionFeedback('error', error.message || '导出失败'); }
  finally { button.disabled = false; }
});

/* ---------- 预检查（关注/私信） ---------- */
function actionTaskSignature(task) {
  return JSON.stringify(task ? [task.kind, task.running, task.status, task.done, task.total] : []);
}
function setActionFeedback(phase, message) {
  actionFeedback = message ? { phase, message, signature: actionTaskSignature(state && state.task) } : null;
  const leadBox = $('lead-action-feedback');
  leadBox.className = 'task-box' + (!actionFeedback ? ' hidden' : phase === 'error' ? ' err' : phase === 'pending' ? ' running' : '');
  leadBox.textContent = message || '';
  const box = $('action-feedback');
  box.className = 'task-box' + (!actionFeedback ? ' hidden' : phase === 'error' ? ' err' : phase === 'pending' ? ' running' : '');
  box.textContent = message || '';
}
function renderActionStatus() {
  if (actionStateError) {
    const box = $('act-status');
    box.className = 'task-box err';
    box.textContent = `无法读取本机任务状态：${actionStateError}。执行结果尚未确认，正在自动重试；可随时点击“停止所有任务”。${state && state.task && state.task.status ? '最后已知状态：' + state.task.status : ''}`;
    return;
  }
  renderTask('act-status', state && state.task);
  if (actionFeedback && actionFeedback.phase === 'submitted' && actionFeedback.signature !== actionTaskSignature(state && state.task)) setActionFeedback(null, '');
}
function renderOutreachControls() {
  // 多账号模式只走“开始分发”，单账号的预检查/执行按钮必须保持禁用。
  // 每次刷新都会调用这里，不能只在切换下拉框时设置一次。
  const isDist = $('act-mode').value === 'distribution';
  const busy = taskActive(state && state.task);
  for (const id of ['btn-follow-start', 'btn-dm-start', 'btn-outreach-start']) $(id).disabled = isDist || busy || precheckRequestBusy || outreachSubmitBusy;
  for (const id of ['a-fol-enabled', 'a-dm-enabled', 'a-dm-template']) $(id).disabled = isDist || busy;
  for (const id of ['btn-dist-preview', 'btn-dist-start']) $(id).disabled = busy || precheckRequestBusy || outreachSubmitBusy;
  $('pc-cancel').disabled = outreachSubmitBusy;
}
async function openPrecheck(kind) {
  if (precheckRequestBusy || outreachSubmitBusy) return;
  if (!confirmExecutionScope()) return;
  const accId = $('act-account').value;
  if (!accId) { alert('请先选择账号'); return; }
  precheckRequestBusy = true; renderOutreachControls();
  setActionFeedback('pending', '正在生成预检查名单，请稍候…');
  try {
  if (actionConfigDirty) await saveActionConfig();
  const r = await api(`/${kind}/preview`, { method: 'POST', body: { accountId: accId, ...taskScope() } });
  if (!r.planId || r.accountId == null || r.kind !== kind) throw new Error('预检查计划无效，请重试');
  precheckPlan = Object.freeze({ planId: r.planId, accountId: String(r.accountId), kind: r.kind });
  $('pc-title').textContent = { follow: '关注预检查', dm: '私信预检查', outreach: '按用户关注与私信预检查' }[kind];
  const accountName = (state.accounts || []).find(a => String(a.id) === precheckPlan.accountId)?.name || precheckPlan.accountId;
  const actions = r.actions || {};
  const quotaInfo = r.remaining ? `<br>今日剩余尝试额度：关注 ${esc(r.remaining.follow ?? '—')} · 私信 ${esc(r.remaining.dm ?? '—')} · 主页访问 ${esc(r.remaining.profile ?? '—')}` : '';
  const repeat = r.contactPolicy && r.contactPolicy.repeat;
  const policyInfo = actions.dm && repeat ? `<br>本次重复联系规则：${repeat.enabled ? '允许，至少间隔 ' + esc(repeat.intervalDays) + ' 天' : '不允许再次联系已私信用户'}` : '';
  const warnings = Array.isArray(r.warnings) ? r.warnings.filter(Boolean) : [];
  const frozenMessage = typeof r.dmTemplate === 'string' ? r.dmTemplate : r.plan && r.plan.dmTemplate;
  $('pc-message-preview').classList.toggle('hidden', !actions.dm || !frozenMessage);
  $('pc-message-preview').textContent = actions.dm && frozenMessage ? '本次固定话术模板：\n' + frozenMessage : '';
  $('pc-summary').innerHTML = `账号 <b>${esc(accountName)}</b> · ${r.scope === 'selected' ? '已勾选' : '当前筛选'} <b>${esc(r.filteredCount)}</b> 条 · 固定执行 <b>${esc(r.count)}</b> 位用户<br>操作：${[actions.follow ? '关注' : '', actions.dm ? '私信' : ''].filter(Boolean).join('、') || esc(kind)}${quotaInfo}${policyInfo}${warnings.length ? '<div class="note">' + warnings.map(esc).join('；') + '</div>' : ''}`;
  if (!r.count) {
    $('pc-list').innerHTML = `<div class="precheck-empty">${esc(r.skippedReason || '没有符合条件的线索（检查筛选条件/账号/额度）')}</div>`;
    $('pc-confirm').disabled = true;
  } else {
    $('pc-confirm').disabled = false;
    $('pc-list').innerHTML = r.leads.slice(0, 100).map(l => `
      <div class="pc-item">
        <div><b>${esc(l.nickname)}</b> ${l.aiNeed ? `<span class="badge b-intent">AI:${esc(l.aiNeed)}</span>` : ''} ${l.trigger ? `<span class="badge b-intent">✔${esc(l.trigger)}</span>` : ''}</div>
        ${l.actions ? `<div class="note">本用户操作：${[l.actions.follow ? '关注' : '', l.actions.dm ? '私信' : ''].filter(Boolean).join('、') || '无'}</div>` : ''}
        ${l.messagePreview ? `<div class="pc-message"><strong>将发送：</strong>${esc(l.messagePreview)}</div>` : ''}
        <div class="pc-demand">${esc(l.demand || '')}${l.dmCount ? `<span class="repeat-note">（本软件已确认私信 ${esc(l.dmCount)} 次）</span>` : ''}</div>
      </div>`).join('') + (r.count > 100 ? `<div class="precheck-more">…等共 ${r.count} 条</div>` : '');
  }
  $('pc-feedback').className = 'task-box hidden'; $('pc-feedback').textContent = '';
  setActionFeedback(null, '');
  openModal('precheck-modal', 'pc-cancel');
  } catch (error) {
    setActionFeedback('error', `预检查未完成：${error.message || '无法连接本机服务，请重试'}`);
    document.querySelector('#nav a[data-page="leads"]').click();
    $('action-feedback').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally { precheckRequestBusy = false; renderOutreachControls(); }
}

$('pc-cancel').addEventListener('click', () => { if (outreachSubmitBusy) return; closeModal('precheck-modal'); precheckPlan = null; });
$('pc-confirm').addEventListener('click', async () => {
  if (!precheckPlan || outreachSubmitBusy) return;
  const plan = precheckPlan;
  outreachSubmitBusy = true; $('pc-confirm').disabled = true; renderOutreachControls();
  $('pc-feedback').className = 'task-box running';
  $('pc-feedback').textContent = '正在提交固定名单并启动任务，请稍候；停止所有任务仍可使用。';
  setActionFeedback('pending', '正在启动固定名单任务，请稍候…');
  try {
    await api('/' + plan.kind + '/start', { method: 'POST', body: { accountId: plan.accountId, planId: plan.planId } });
    closeModal('precheck-modal'); precheckPlan = null;
    setActionFeedback('submitted', '任务请求已提交，正在读取最新进度。实际执行结果以下方任务进度为准。');
    document.querySelector('#nav a[data-page="leads"]').click();
    $('act-status').scrollIntoView({ behavior: 'smooth', block: 'center' });
    refresh();
  } catch (error) {
    const message = `启动请求未完成：${error.message || '无法连接本机服务'}。请检查任务进度；确认当前任务未运行后，再重新预检查。`;
    $('pc-feedback').className = 'task-box err'; $('pc-feedback').textContent = message;
    setActionFeedback('error', message);
  } finally { outreachSubmitBusy = false; $('pc-confirm').disabled = false; renderOutreachControls(); }
});

$('btn-follow-start').addEventListener('click', () => openPrecheck('follow'));
$('btn-dm-start').addEventListener('click', () => openPrecheck('dm'));
$('btn-outreach-start').addEventListener('click', () => openPrecheck('outreach'));

/* ---------- 多账号私信分发 ---------- */
let distributionPool = [];
let distDirty = false;
$('act-mode').addEventListener('change', () => {
  const isDist = $('act-mode').value === 'distribution';
  $('distribution-box').classList.toggle('hidden', !isDist);
  $('action-switches-host').classList && 0; // noop
  for (const id of ['btn-outreach-start', 'btn-follow-start', 'btn-dm-start']) $(id).disabled = isDist || precheckRequestBusy || outreachSubmitBusy;
  for (const id of ['a-fol-enabled', 'a-dm-enabled', 'a-dm-template']) $(id).disabled = isDist;
  if (isDist) renderDistributionPool();
});
function distributionOrder() {
  const saved = state && state.settings && Array.isArray(state.settings.dm.poolAccounts)
    ? state.settings.dm.poolAccounts.map(p => ({ accountId: String(p.accountId), template: typeof p.template === 'string' ? p.template : '' })) : [];
  if (!distributionPool.length) distributionPool = saved.slice();
  return distributionPool;
}
function distributionEntry(id) {
  const existing = distributionPool.find(entry => entry.accountId === id);
  return existing || { accountId: id, template: '' };
}
function renderDistributionPool() {
  const accounts = state.accounts || [];
  const dmState = state.dmAccountState || {};
  distributionOrder();
  const box = $('distribution-pool');
  if (!accounts.length) { box.innerHTML = '<div class="note">请先在「账号管理」添加账号</div>'; return; }
  box.innerHTML = accounts.map(acc => {
    const id = String(acc.id);
    const inPool = distributionPool.some(entry => entry.accountId === id);
    const template = distributionEntry(id).template;
    const usage = acc.daily || {};
    const st = dmState[id] || {};
    let badge;
    if (st.disabledUntil && Number(st.disabledUntil) > Date.now()) badge = '<span class="badge b-failed" title="' + esc(st.lastStopReason || '') + '">今日上限 · 明日8点恢复</span>';
    else if (st.frequentUntil && Number(st.frequentUntil) > Date.now()) badge = '<span class="badge b-pending">频繁冷却 剩' + Math.max(1, Math.ceil((Number(st.frequentUntil) - Date.now()) / 60000)) + '分</span>';
    else badge = '<span class="badge b-followed">正常</span>';
    // 未登录账号放进分发池会在启动浏览器时失败，必须在下单前就能看见。
    const loginPhaseNow = loginFeedbackFor(acc).phase;
    const loginBadge = loginPhaseNow === 'authenticated' ? '' : '<span class="badge b-failed">' + esc(loginPhaseLabels[loginPhaseNow] || '未登录') + '</span>';
    const capText = st.estimatedDailyCap ? ' · 预计上限 ~' + st.estimatedDailyCap : '';
    const blockedNow = st.disabledUntil && Number(st.disabledUntil) > Date.now() || st.frequentUntil && Number(st.frequentUntil) > Date.now();
    const templateRow = inPool ? `<div class="dist-template-row"><label class="hint">该账号独立话术（留空用全局话术）</label><textarea class="dist-template" data-acc="${esc(id)}" rows="2" placeholder="留空＝使用上方全局私信话术">${esc(template)}</textarea></div>` : '';
    return `<div class="dist-account"><label class="dist-check-label"><input type="checkbox" class="dist-check" data-acc="${esc(id)}" ${inPool ? 'checked' : ''}> ${esc(acc.name || id)}</label>${loginBadge}${badge}<span class="hint">今日已私信 ${Number(usage.dm) || 0}${capText}</span><span class="dist-btns">${inPool ? `<button class="mini dist-up" data-acc="${esc(id)}" title="轮转顺序上移">↑</button><button class="mini dist-down" data-acc="${esc(id)}" title="轮转顺序下移">↓</button>` : ''}${blockedNow ? `<button class="mini dist-clear" data-acc="${esc(id)}">恢复账号</button>` : ''}</span>${templateRow}</div>`;
  }).join('');
}
$('distribution-pool').addEventListener('change', event => {
  if (!event.target.matches('.dist-check')) return;
  const id = event.target.dataset.acc;
  if (event.target.checked) { if (!distributionPool.some(entry => entry.accountId === id)) distributionPool.push({ accountId: id, template: '' }); }
  else distributionPool = distributionPool.filter(entry => entry.accountId !== id);
  distDirty = true; renderDistributionPool();
});
$('distribution-pool').addEventListener('input', event => {
  if (!event.target.matches('.dist-template')) return;
  const entry = distributionEntry(event.target.dataset.acc);
  if (!distributionPool.includes(entry)) distributionPool.push(entry);
  entry.template = event.target.value;
  distDirty = true;
});
$('distribution-pool').addEventListener('click', async event => {
  const button = event.target.closest('.dist-up,.dist-down,.dist-clear');
  if (!button) return;
  const id = button.dataset.acc;
  if (button.classList.contains('dist-clear')) {
    try { await api('/dm-distribution/clear-state', { method: 'POST', body: { accountId: id } }); refresh(); } catch (e) { alert(e.message); }
    return;
  }
  const index = distributionPool.findIndex(entry => entry.accountId === id);
  const swap = button.classList.contains('dist-up') ? index - 1 : index + 1;
  if (index < 0 || swap < 0 || swap >= distributionPool.length) return;
  [distributionPool[index], distributionPool[swap]] = [distributionPool[swap], distributionPool[index]];
  distDirty = true; renderDistributionPool();
});
async function persistDistributionPool() {
  const pool = distributionOrder().map(entry => ({ accountId: entry.accountId, template: typeof entry.template === 'string' ? entry.template : '' }));
  await api('/settings', { method: 'PUT', body: { dm: { poolAccounts: pool } } });
  if (state && state.settings) state.settings.dm.poolAccounts = pool;
  distDirty = false;
}
function renderDistSummary(r) {
  const box = $('dist-summary');
  if (!r) { box.textContent = ''; return; }
  const lines = [];
  if (r.scope) lines.push(r.scope.mode === 'selected' ? `名单来源：<b>已勾选 ${r.scope.count} 条</b>` : '名单来源：<b>当前筛选结果</b>');
  if (r.totalCandidates != null) {
    lines.push(r.sourceRows != null
      ? `本次范围 <b>${r.sourceRows}</b> 条评论${r.duplicateRows ? `（同一用户重复 ${r.duplicateRows} 条）` : ''} → 可联系 <b>${r.totalCandidates}</b> 位用户`
      : `可联系候选 <b>${r.totalCandidates}</b> 人`);
  }
  if (Array.isArray(r.perAccount)) for (const p of r.perAccount) {
    const stateText = p.blocked === 'daily_limit' ? '（今日上限·明8点恢复）' : p.blocked === 'frequent' ? '（频繁冷却中）' : '';
    const capText = p.estimatedCap ? ` · 预计上限 ~${p.estimatedCap}${p.capSource === 'reference' ? '（参考）' : ''}` : '';
    lines.push(`${esc(p.name)}：分配 <b>${p.count}</b> 人 · 今日已私信 ${p.todaySent}${capText}${stateText}`);
  }
  if (r.unassigned) lines.push(`待分配（额度不够/账号不可用）：<b>${r.unassigned}</b> 人，明日8点后继续`);
  if (Array.isArray(r.exclusions) && r.exclusions.length) lines.push('未进入分发：' + r.exclusions.map(item => `${esc(item.reason)} ${esc(item.count)} 条`).join('；'));
  const poolIds = new Set(distributionOrder().map(entry => String(entry.accountId)));
  const unlogged = (state.accounts || []).filter(a => poolIds.has(String(a.id)) && loginFeedbackFor(a).phase !== 'authenticated');
  if (unlogged.length) lines.push('<span style="color:#9d261f">⚠️ 账户池中有未登录账号：' + unlogged.map(a => esc(a.name)).join('、') + '；这些账号的批次会启动失败，请先登录或取消勾选</span>');
  if (Array.isArray(r.sameIpWarning) && r.sameIpWarning.length) lines.push('<span style="color:#9d261f">⚠️ 以下账号共用同一 IP，建议一账号一代理：' + r.sameIpWarning.map(g => g.join('/')).join('；') + '</span>');
  box.innerHTML = lines.join('<br>');
}
$('btn-dist-preview').addEventListener('click', async () => {
  try {
    if (distDirty) await persistDistributionPool();
    const r = await api('/dm-distribution/preview', { method: 'POST', body: { poolAccounts: distributionOrder(), ...taskScope() } });
    distributionPreview = r; renderDistSummary(r);
    $('dist-unsaved').textContent = '';
  } catch (error) { $('dist-summary').innerHTML = '<span style="color:#9d261f">' + esc(error.message || '生成方案失败') + '</span>'; }
});
$('btn-dist-start').addEventListener('click', async () => {
  if (!distributionOrder().length) { alert('请先勾选私信账户'); return; }
  if (!confirmExecutionScope()) return;
  const poolIds = new Set(distributionOrder().map(entry => String(entry.accountId)));
  const unlogged = (state.accounts || []).filter(a => poolIds.has(String(a.id)) && loginFeedbackFor(a).phase !== 'authenticated');
  if (unlogged.length && !confirm(`账户池中有未登录账号：${unlogged.map(a => a.name).join('、')}。\n继续分发会尝试启动这些账号，可能失败。是否继续？`)) return;
  try {
    if (distDirty) await persistDistributionPool();
    const r = await api('/dm-distribution/start', { method: 'POST', body: { poolAccounts: distributionOrder(), ...taskScope() } });
    if (r && r.ok) { $('dist-unsaved').textContent = '分发任务已启动'; refresh(); }
  } catch (error) { $('dist-unsaved').textContent = error.message || '启动失败'; }
});
$('btn-task-stop5').addEventListener('click', async () => { await api('/tasks/stop', { method: 'POST' }); refresh(); });
function renderDistributionProgress() {
  const box = $('dist-progress');
  const task = state && state.task;
  if (task && task.kind === 'dm_distribution') {
    const active = taskActive(task);
    box.className = 'task-box' + (active ? ' running' : '');
    const s = task.distributionSummary || {};
    box.textContent = (active ? '进行中 · ' : '') + (task.status || '')
      + (s && s.perAccount && Object.keys(s.perAccount).length ? '\n' + Object.values(s.perAccount).map(p => p.name + ' 成功' + (p.success || 0)).join('｜') : '')
      + (s && s.unassigned != null ? '\n待分配：' + s.unassigned : '');
  } else {
    box.className = 'task-box hidden';
  }
}
$('btn-global-stop').addEventListener('click', async () => {
  $('btn-global-stop').disabled = true;
  try { await api('/tasks/stop', { method: 'POST' }); refresh(); }
  finally { $('btn-global-stop').disabled = false; }
});
$('btn-task-stop2').addEventListener('click', async () => { await api('/tasks/stop', { method: 'POST' }); refresh(); });
$('btn-task-stop3').addEventListener('click', async () => { await api('/tasks/stop', { method: 'POST' }); refresh(); });

function openModal(id, focusId) {
  lastModalFocus = document.activeElement;
  $(id).classList.remove('hidden'); $(focusId).focus();
  scheduleEmbeddedBrowserSync();
}
function closeModal(id) {
  $(id).classList.add('hidden');
  if (lastModalFocus && document.contains(lastModalFocus)) lastModalFocus.focus();
  lastModalFocus = null;
  scheduleEmbeddedBrowserSync();
}
function showFieldDetail(title, content, summary) {
  $('lead-detail-actions').classList.add('hidden'); $('lead-detail-actions').innerHTML = '';
  $('field-detail-title').textContent = title || '完整内容';
  $('field-detail-summary').textContent = summary || '';
  $('field-detail-content').textContent = String(content == null ? '' : content);
  $('field-detail-copy-result').textContent = '';
  openModal('field-detail-modal', 'field-detail-close');
}
$('field-detail-close').addEventListener('click', () => closeModal('field-detail-modal'));
$('field-detail-modal').querySelector('.modal-mask').addEventListener('click', () => closeModal('field-detail-modal'));
$('field-detail-copy').addEventListener('click', async () => {
  const content = $('field-detail-content');
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(content.textContent);
    $('field-detail-copy-result').textContent = '完整内容已复制';
  } catch (_) {
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(content); selection.removeAllRanges(); selection.addRange(range);
    content.focus();
    $('field-detail-copy-result').textContent = '无法自动复制，已选中完整内容，请按 Ctrl+C 复制。';
  }
});
document.addEventListener('keydown', event => {
  const modal = ['field-detail-modal', 'verification-modal', 'precheck-modal'].map($).find(element => !element.classList.contains('hidden'));
  if (!modal || $('login-layer').style.display === 'flex') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (modal.id === 'precheck-modal' && outreachSubmitBusy) return;
    if (modal.id === 'verification-modal') completeVerification(null);
    else { closeModal(modal.id); if (modal.id === 'precheck-modal') precheckPlan = null; }
  } else if (event.key === 'Tab') {
    const focusables = [...modal.querySelectorAll('button:not(:disabled), textarea, input, select, [tabindex="0"]'), $('btn-global-stop')];
    const index = focusables.indexOf(document.activeElement);
    const next = event.shiftKey ? (index <= 0 ? focusables.length - 1 : index - 1) : (index + 1) % focusables.length;
    event.preventDefault(); focusables[next].focus();
  }
});

/* ---------- 采集页：链接管理器 + 历史 ---------- */
function linkWorkId(text) {
  const links = [...String(text || '').replace(/\\([:\/.])/g, '$1').matchAll(/https?:\/\/[^\s<>"'，。；、）【】,;]+/gi)];
  if (!links.length) return '';
  const ids = new Set();
  for (const link of links) {
    try {
      const address = new URL(link[0].replace(/[.,;:!?)\]}]+$/g, ''));
      const match = /^\/(?:video|note)\/(\d{1,24})\/?$/.exec(address.pathname);
      if (address.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(address.hostname) || address.username || address.password || address.port || !match) return '';
      ids.add(match[1]);
    } catch (_) { return ''; }
  }
  return ids.size === 1 ? [...ids][0] : '';
}
function collectionHistoryMap() {
  const list = state && state.videoHistory || Object.entries(state && state.videos || {}).map(([id, item]) => ({ ...item, awemeId: id }));
  return new Map(list.map(item => [String(item.awemeId), item]));
}
function collectionCategory(history) {
  if (history && ['complete', 'partial', 'interrupted'].includes(history.collectionState)) return history.collectionState;
  if (history && (Number(history.scanCount) > 0 || history.lastCollectAt || history.lastCompleteAt) || state && state.videoHistoryError) return 'unknown';
  return 'uncollected';
}
function lastCollectionTime(history) {
  const times = [history && history.lastCollectAt, history && history.lastCompleteAt].filter(Boolean).map(value => {
    const text = String(value).trim().replace(' ', 'T');
    return Date.parse(text + (/Z$|[+-]\d\d:\d\d$/.test(text) ? '' : '+08:00'));
  }).filter(Number.isFinite);
  return times.length ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(Math.max(...times)) : '时间未记录';
}
function collectionStatusCell(history, fallback = '未采集') {
  const recorded = history && (history.collectionState || Number(history.scanCount) > 0 || history.lastCollectAt || history.lastCompleteAt);
  if (!recorded) return `<span class="lead-muted">${esc(fallback)}</span>`;
  const time = lastCollectionTime(history);
  return `<span class="collection-first-line">${collectionBadge(history)}</span><span class="collection-last-time lead-muted" title="最后一次采集：${esc(time)}">${esc(time)}</span>`;
}
function queueEntries(filter = $('queue-status-filter').value) {
  const history = collectionHistoryMap();
  return linkRows.map((row, idx) => {
    const id = linkWorkId(row.url), hist = history.get(id);
    const category = !String(row.url || '').trim() ? 'empty' : id ? collectionCategory(hist) : 'unknown';
    return { row, idx, hist, category };
  }).filter(item => filter === 'all' || item.category === filter || item.category === 'empty');
}
function renderQueueSummary() {
  const entries = queueEntries().filter(item => String(item.row.url || '').trim());
  const visible = entries.length;
  for (const row of selectedQueueRows) if (!linkRows.includes(row) || !String(row.url || '').trim()) selectedQueueRows.delete(row);
  const selected = entries.filter(item => selectedQueueRows.has(item.row)).length;
  const total = linkRows.filter(row => String(row.url || '').trim()).length;
  $('queue-filter-summary').textContent = `当前 ${visible} 组 / 共 ${total} 组 · 已选 ${selected} 组`;
  const all = $('queue-select-all');
  all.checked = visible > 0 && selected === visible;
  all.indeterminate = selected > 0 && selected < visible;
  all.disabled = !visible;
  $('btn-link-delete-selected').disabled = !selected;
  syncForceAll();
  for (const checkbox of $('link-rows').querySelectorAll('[data-link-select]')) {
    const row = linkRows[Number(checkbox.dataset.linkSelect)];
    checkbox.checked = selectedQueueRows.has(row);
    checkbox.disabled = !String(row?.url || '').trim();
  }
}
function renderLinkRows() {
  const box = $('link-rows');
  const active = document.activeElement;
  renderQueueSummary();
  if (active && active.classList && active.classList.contains('link-input')) { refreshLinkBadges(); return; } // 保留输入内容和光标
  box.innerHTML = queueEntries().map(({ row: r, idx, hist, category }) => {
    const badge = collectionStatusCell(hist, category === 'empty' ? '待输入' : category === 'unknown' ? '待识别／未核验' : '未采集');
    return `<tr class="link-row" data-idx="${idx}">
      <td class="link-number"><label class="queue-row-select"><input type="checkbox" data-link-select="${idx}" aria-label="选择第 ${idx + 1} 组输入" ${selectedQueueRows.has(r) ? 'checked' : ''} ${String(r.url || '').trim() ? '' : 'disabled'}><span>${idx + 1}</span></label></td>
      <td><textarea class="link-input" rows="2" placeholder="粘贴作品链接或完整分享文本，支持多条，每条一行" aria-label="第 ${idx + 1} 组作品链接或分享文本" data-link-index="${idx}">${esc(r.url)}</textarea></td>
      <td class="collection-status-cell"><span class="link-badge">${badge}</span></td>
      <td><label class="force-lab"><input type="checkbox" data-link-force="${idx}" ${r.force ? 'checked' : ''}> 强制重采</label></td>
      <td><button class="normal" data-link-delete="${idx}" aria-label="删除第 ${idx + 1} 组输入">删除</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty-cell">当前分类没有输入，请切换采集状态或添加输入框。</td></tr>';
  syncForceAll();
}
function refreshLinkBadges() {
  const history = collectionHistoryMap();
  for (const row of $('link-rows').querySelectorAll('.link-row')) {
    const text = String(linkRows[Number(row.dataset.idx)]?.url || '').trim();
    const id = linkWorkId(text), hist = history.get(id);
    row.querySelector('.link-badge').innerHTML = collectionStatusCell(hist, !text ? '待输入' : !id || collectionCategory(hist) === 'unknown' ? '待识别／未核验' : '未采集');
  }
}
function updateLinkUrl(i, v) {
  linkRows[i].url = v;
  refreshLinkBadges(); renderQueueSummary();
}
$('queue-status-filter').addEventListener('change', () => { renderLinkRows(); renderConfigActions(); });
$('link-rows').addEventListener('input', event => {
  if (event.target.matches('[data-link-index]')) updateLinkUrl(Number(event.target.dataset.linkIndex), event.target.value);
});
$('link-rows').addEventListener('change', event => {
  if (event.target.matches('[data-link-force]')) { linkRows[Number(event.target.dataset.linkForce)].force = event.target.checked; syncForceAll(); }
  if (event.target.matches('[data-link-select]')) {
    const row = linkRows[Number(event.target.dataset.linkSelect)];
    if (row && String(row.url || '').trim()) event.target.checked ? selectedQueueRows.add(row) : selectedQueueRows.delete(row);
    renderQueueSummary();
  }
});
// 强制重采统一处理：表头“全部”作用于当前筛选出的有链接的行；按钮作用于已勾选的行（全部已强制时为取消）
function syncForceAll() {
  const rows = queueEntries().filter(({ row }) => String(row.url || '').trim());
  const box = $('queue-force-all');
  box.checked = rows.length > 0 && rows.every(({ row }) => row.force);
  box.indeterminate = !box.checked && rows.some(({ row }) => row.force);
  const selected = rows.filter(({ row }) => selectedQueueRows.has(row));
  const button = $('btn-link-force-selected');
  button.disabled = !selected.length;
  button.textContent = selected.length && selected.every(({ row }) => row.force) ? `已选取消强制重采（${selected.length}）` : `已选设为强制重采${selected.length ? `（${selected.length}）` : ''}`;
}
$('queue-force-all').addEventListener('change', event => {
  for (const { row } of queueEntries()) if (String(row.url || '').trim()) row.force = event.target.checked;
  renderLinkRows();
});
$('btn-link-force-selected').addEventListener('click', () => {
  const selected = queueEntries().filter(({ row }) => String(row.url || '').trim() && selectedQueueRows.has(row)).map(({ row }) => row);
  const value = !selected.every(row => row.force);
  for (const row of selected) row.force = value;
  renderLinkRows();
});
$('queue-select-all').addEventListener('change', event => {
  for (const { row } of queueEntries()) if (String(row.url || '').trim()) event.target.checked ? selectedQueueRows.add(row) : selectedQueueRows.delete(row);
  renderQueueSummary();
});
$('btn-link-delete-selected').addEventListener('click', () => {
  const removed = new Set(queueEntries().filter(item => String(item.row.url || '').trim() && selectedQueueRows.has(item.row)).map(item => item.row));
  linkRows = linkRows.filter(row => !removed.has(row));
  for (const row of removed) selectedQueueRows.delete(row);
  if (!linkRows.length) linkRows.push({ url: '', force: false });
  renderLinkRows(); renderConfigActions();
});
$('link-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-link-delete]');
  if (!button) return;
  linkRows.splice(Number(button.dataset.linkDelete), 1);
  if (!linkRows.length) linkRows.push({ url: '', force: false }); renderLinkRows();
});
$('btn-link-add').addEventListener('click', () => { linkRows.push({ url: '', force: false }); renderLinkRows(); });

function renderVideoHistory() {
  if (state && state.videoHistoryError) {
    $('video-hist').closest('table').classList.add('empty-table');
    $('video-hist-count').textContent = '更新未完成';
    $('video-hist').innerHTML = `<tr><td colspan="5" class="empty-cell">作品采集历史暂时无法更新：${esc(state.videoHistoryError)}</td></tr>`;
    return;
  }
  const list = (state && state.videoHistory) || [];
  $('video-hist').closest('table').classList.toggle('empty-table', !list.length);
  $('video-hist-count').textContent = `共 ${list.length} 条`;
  $('video-hist').innerHTML = list.map(v => `
    <tr>
      <td class="work-history-text">${workCell(v.workTitle, v.workContent, v.workText || v.desc, v.workType === 'note' || /\/note\//.test(v.videoLink || '') ? '图文' : '视频', `data-detail-video="${esc(v.awemeId)}"`, v.workTextState || v.descriptionState)}</td>
      <td>${dateCell(v.lastCollectAt || v.lastCompleteAt)}</td>
      <td>${esc(Number(v.scanCount) || 0)} 次</td>
      <td><span class="lead-line">${collectionBadge(v, false)}</span><span class="lead-line lead-muted" title="${esc(v.collectionReason || '')}">${esc(collectionReasonLabel(v))}</span></td>
      <td><div class="work-history-actions"><button data-video-id="${esc(v.awemeId)}" data-video-action="add">加入队列</button><button data-video-id="${esc(v.awemeId)}" data-video-action="copy">复制链接</button><button class="danger" data-video-id="${esc(v.awemeId)}" data-video-action="delete">删除</button></div></td>
    </tr>`).join('') || `<tr><td colspan="5" class="empty-cell">${emptyState('↓', '还没有采集记录', '首次采集完成后，可在这里查看完整度和再次采集')}</td></tr>`;
}
function collectionReasonLabel(video) {
  if (video.collectionState === 'complete' && /has_more\s*=\s*0/.test(video.collectionReason || '')) return '一级评论已采集完';
  return video.collectionReason || '完整度尚未核验';
}

function collectionBadge(video, includeCount = true) {
  const labels = { complete: '完整', partial: '部分（可续采）', interrupted: '中断（可续采）' };
  const label = labels[video.collectionState] || '完整度未核验';
  const cls = video.collectionState === 'complete' ? 'b-followed' : 'b-pending';
  return `<span class="badge ${cls}" title="${esc(video.collectionReason || '')}">${label}${includeCount ? ' · ' + (Number(video.scanCount) || 0) + ' 次' : ''}</span>`;
}
function addHistToQueue(id) {
  if (!linkRows.some(r => [...String(r.url || '').matchAll(/\/(?:video|note)\/(\d+)/g)].some(match => match[1] === String(id)))) {
    const history = ((state && state.videoHistory) || []).find(item => String(item.awemeId) === String(id));
    const historyUrl = history && /^https:\/\/www\.douyin\.com\/(?:video|note)\/\d+\/?(?:[?#].*)?$/.test(history.videoLink || '') ? history.videoLink : 'https://www.douyin.com/video/' + id;
    linkRows.push({ url: historyUrl, force: false });
    renderLinkRows();
  }
}
$('video-hist').addEventListener('click', async event => {
  const detail = event.target.closest('[data-detail-video]');
  if (detail) {
    const item = ((state && state.videoHistory) || []).find(video => String(video.awemeId) === detail.dataset.detailVideo);
    if (item) {
      const source = { api: '浏览器作品详情响应', page_json: '当前作品页面数据', page_dom: '当前作品页面文字', page_meta: '当前作品页面元信息' }[item.descriptionSource] || '';
      showFieldDetail('作品 · 标题与内容', item.workText || item.desc || '', [`作品 ${item.awemeId}`, item.workType === 'note' || /\/note\//.test(item.videoLink || '') ? '图文' : '视频', source, item.descriptionReason || '列表只显示摘要，此处显示已保存的完整内容。', item.collectionReason || ''].filter(Boolean).join(' · '));
    }
    return;
  }
  const button = event.target.closest('[data-video-action]');
  if (!button) return;
  if (button.dataset.videoAction === 'add') addHistToQueue(button.dataset.videoId);
  else if (button.dataset.videoAction === 'copy') {
    const item = ((state && state.videoHistory) || []).find(video => String(video.awemeId) === button.dataset.videoId);
    const link = item && safeHttpLink(item.videoLink);
    if (link) await copyLink(link, button);
  }
  else { await api('/videos/' + encodeURIComponent(button.dataset.videoId), { method: 'DELETE' }); refresh(); }
});

/* ---------- 关键词搜索找作品 ---------- */
const selectedSearchWorks = new Set();
function renderSearchSelection() {
  const list = filteredSearchResults();
  const count = list.filter(w => selectedSearchWorks.has(String(w.awemeId))).length;
  const total = ((state && state.searchResults) || []).length;
  $('search-count').textContent = `共 ${total} 条${$('search-status-filter').value === 'all' ? '' : ' · 当前 ' + list.length + ' 条'} · 已选 ${count} 条`;
  const hidden = selectedSearchWorks.size - count;
  $('search-selection-note').textContent = '全选与加入队列仅作用于当前分类' + (hidden ? ` · 其他分类保留 ${hidden} 条勾选` : '');
  const all = $('search-select-all');
  all.checked = list.length > 0 && count === list.length;
  all.indeterminate = count > 0 && count < list.length;
  all.disabled = !list.length;
  $('btn-search-toqueue').disabled = !count;
}
function filteredSearchResults() {
  const filter = $('search-status-filter').value, history = collectionHistoryMap();
  return ((state && state.searchResults) || []).filter(w => filter === 'all' || collectionCategory(history.get(String(w.awemeId))) === filter);
}
// 发布时间：日期 + 距今天数；旧版本搜到的结果没有发布时间显示“—”
function publishTimeCell(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '<span class="hint">—</span>';
  const date = new Date(value * 1000), days = Math.floor((Date.now() - date.getTime()) / 86400000);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}<br><span class="hint">${days <= 0 ? '今天' : days + ' 天前'}</span>`;
}
function renderSearchResults() {
  const list = filteredSearchResults(), history = collectionHistoryMap();
  const box = $('search-list');
  box.closest('table').classList.toggle('empty-table', !list.length);
  const ids = new Set(((state && state.searchResults) || []).map(w => String(w.awemeId)));
  selectedSearchWorks.forEach(id => { if (!ids.has(id)) selectedSearchWorks.delete(id); });
  box.innerHTML = list.slice().reverse().map(w => `
    <tr class="${selectedSearchWorks.has(String(w.awemeId)) ? 'is-selected' : ''}">
      <td><input type="checkbox" class="search-select" data-search-id="${esc(w.awemeId)}" ${selectedSearchWorks.has(String(w.awemeId)) ? 'checked' : ''} aria-label="勾选加入采集队列"></td>
      <td>${esc(w.keyword || '')}</td>
      <td class="search-work-text" title="${esc(w.desc || '')}"><span class="field-text-preview">${esc(w.desc || '（无标题）')}</span></td>
      <td>${esc(w.authorName || '')}</td>
      <td>${esc(Number(w.commentCount) || 0)}</td>
      <td>${publishTimeCell(w.createTime)}</td>
      <td>${w.workType === 'note' ? '<span class="badge b-pending">图文</span>' : '<span class="badge b-intent">视频</span>'}</td>
      <td class="collection-status-cell">${collectionStatusCell(history.get(String(w.awemeId)), collectionCategory(history.get(String(w.awemeId))) === 'unknown' ? '待识别／未核验' : '未采集')}</td>
    </tr>`).join('') || `<tr><td colspan="8" class="empty-cell">${emptyState('⌕', '当前分类没有搜索结果', '可切换采集状态，或输入关键词开始搜索')}</td></tr>`;
  renderSearchSelection();
}
$('search-select-all').addEventListener('change', event => {
  const list = filteredSearchResults();
  for (const w of list) {
    const id = String(w.awemeId);
    if (event.target.checked) selectedSearchWorks.add(id); else selectedSearchWorks.delete(id);
  }
  renderSearchResults();
});
$('search-status-filter').addEventListener('change', () => { $('search-toqueue-msg').textContent = ''; renderSearchResults(); });
$('btn-search-clear-selection').addEventListener('click', () => { selectedSearchWorks.clear(); renderSearchResults(); });
$('search-list').addEventListener('change', event => {
  if (!event.target.matches('.search-select')) return;
  const id = event.target.dataset.searchId;
  if (event.target.checked) selectedSearchWorks.add(id); else selectedSearchWorks.delete(id);
  event.target.closest('tr').classList.toggle('is-selected', event.target.checked);
  renderSearchSelection();
});
function renderSearchFeedback() {
  const task = state && state.task;
  const box = $('search-feedback');
  if (task && task.kind === 'search') {
    box.className = 'task-box running';
    const s = task.searchSummary || {};
    box.textContent = (task.running ? '进行中 · ' : '') + (task.status || '')
      + (s && s.currentKeyword ? '\n关键词：' + s.currentKeyword + '｜翻页 ' + (s.pages || 0) + '｜累计新增 ' + (s.works || 0) + ' 个作品' : '');
  } else {
    box.className = 'task-box hidden';
  }
}
/* ---------- 搜索输入草稿：关键词与搜索选项自动保存到本机，重启或刷新后恢复 ---------- */
const SEARCH_DRAFT_FIELDS = { keywords: 's-kws', workType: 's-type', minComments: 's-minc', publishedWithinDays: 's-days', maxPages: 's-maxp' };
let searchDraftTimer = null, searchDraftLoaded = false;
function searchDraftValues() { return Object.fromEntries(Object.entries(SEARCH_DRAFT_FIELDS).map(([key, id]) => [key, $(id).value])); }
function saveSearchDraft() {
  clearTimeout(searchDraftTimer);
  searchDraftTimer = setTimeout(() => { api('/search/draft', { method: 'POST', body: searchDraftValues() }).catch(() => {}); }, 600);
}
async function loadSearchDraft() {
  if (searchDraftLoaded) return;
  searchDraftLoaded = true;
  try {
    const draft = ((await api('/search/draft')) || {}).draft || {};
    for (const [key, id] of Object.entries(SEARCH_DRAFT_FIELDS)) {
      if (draft[key] == null || draft[key] === '') continue;
      const element = $(id);
      // 只在用户还没输入时恢复，不覆盖正在输入的内容
      if (key === 'keywords' && element.value.trim()) continue;
      if (element.tagName === 'SELECT' && ![...element.options].some(option => option.value === draft[key])) continue;
      element.value = draft[key];
    }
  } catch (e) { searchDraftLoaded = false; }
}
for (const id of Object.values(SEARCH_DRAFT_FIELDS)) { $(id).addEventListener('input', saveSearchDraft); $(id).addEventListener('change', saveSearchDraft); }

/* ---------- 关键词统计 ---------- */
function renderKeywordStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  $('kw-stats-count').textContent = list.length ? `共 ${list.length} 个关键词` : '';
  if (!list.length) { $('kw-stats-list').innerHTML = '<tr><td colspan="12" class="hint">还没有搜索记录（每次搜索后自动统计）</td></tr>'; return; }
  const n = value => Number(value) || 0;
  $('kw-stats-list').innerHTML = list.map(row => `<tr>
    <td><b>${esc(row.keyword)}</b><div class="hint">${row.fromHistory ? '来自以往搜索结果' : '搜过 ' + n(row.searchCount) + ' 次'}</div></td>
    <td>${esc(row.lastSearchAt || '—')}<div class="hint">${[row.lastPages ? '翻 ' + n(row.lastPages) + ' 页' : '', row.lastPublishedWithinDays ? '近 ' + n(row.lastPublishedWithinDays) + ' 天' : '不限时间'].filter(Boolean).join('｜')}</div></td>
    <td>${n(row.lastTotal)}</td><td>${n(row.lastWithinWeek)}</td><td>${n(row.lastKept)}<div class="hint">新增 ${n(row.lastAdded)}</div></td>
    <td>${n(row.worksFound)}</td><td>${n(row.worksCollected)}</td><td>${n(row.comments)}</td>
    <td>${n(row.aiDemand)}<span class="hint">（${n(row.aiDemandUsers)} 人）</span></td><td>${n(row.keywordDemand)}</td><td>${n(row.contacted)}</td>
    <td><button class="normal kw-reuse" data-kw="${esc(row.keyword)}" title="把这个词加到搜索关键词输入框">再搜</button></td>
  </tr>`).join('');
}
async function loadKeywordStats() {
  try { renderKeywordStats(((await api('/search/keyword-stats')) || {}).rows); } catch (e) { /* 统计读取失败不打断轮询 */ }
}
$('kw-stats-list').addEventListener('click', event => {
  const button = event.target.closest('.kw-reuse');
  if (!button) return;
  const keyword = button.dataset.kw, box = $('s-kws');
  const current = box.value.split('\n').map(k => k.trim()).filter(Boolean);
  if (!current.includes(keyword)) { box.value = [...current, keyword].join('\n'); saveSearchDraft(); }
  box.focus();
});
$('search-options').addEventListener('toggle', () => { if ($('search-options').open) { loadSearchDraft(); loadKeywordStats(); } });

$('btn-search-start').addEventListener('click', async () => {
  const keywords = String($('s-kws').value || '').split('\n').map(k => k.trim()).filter(Boolean);
  if (!keywords.length) { $('search-feedback').className = 'task-box err'; $('search-feedback').textContent = '请先输入至少一个搜索关键词'; return; }
  if (keywords.length > 50) { $('search-feedback').className = 'task-box err'; $('search-feedback').textContent = '最多 50 个关键词'; return; }
  const accountId = $('col-account').value;
  if (!accountId) { $('search-feedback').className = 'task-box err'; $('search-feedback').textContent = '请先选择采集账号'; return; }
  try {
    const r = await api('/search/start', { method: 'POST', body: { accountId, keywords, workType: $('s-type').value, maxPages: checkedNumber('s-maxp', 1, 50, '翻页数'), minCommentCount: checkedNumber('s-minc', 0, 100000, '最少评论数'), publishedWithinDays: Number($('s-days').value) } });
    if (r && r.ok) { $('search-feedback').className = 'task-box running'; $('search-feedback').textContent = '搜索任务已启动，进度见下方状态'; }
  } catch (error) {
    $('search-feedback').className = 'task-box err'; $('search-feedback').textContent = error.message || '启动失败';
  }
});
$('btn-search-toqueue').addEventListener('click', () => {
  const list = filteredSearchResults();
  const picked = list.filter(w => selectedSearchWorks.has(String(w.awemeId)));
  if (!picked.length) { $('search-toqueue-msg').textContent = '请先勾选要加入队列的作品'; return; }
  let added = 0;
  for (const w of picked) {
    const id = String(w.awemeId);
    if (linkRows.some(r => [...String(r.url || '').matchAll(/\/(?:video|note)\/(\d+)/g)].some(match => match[1] === id))) continue;
    const link = w.workType === 'note' ? 'https://www.douyin.com/note/' + id : 'https://www.douyin.com/video/' + id;
    linkRows.push({ url: link, force: false });
    added++;
  }
  if (added) { renderLinkRows(); $('search-toqueue-msg').textContent = `已加入 ${added} 个作品到采集队列`; }
  else $('search-toqueue-msg').textContent = '所选作品已在队列中，未重复添加';
  setTimeout(() => { $('search-toqueue-msg').textContent = ''; }, 4000);
});
$('btn-search-clear').addEventListener('click', async () => {
  if (!confirm('清空全部搜索结果列表？')) return;
  await api('/search/clear', { method: 'POST' });
  selectedSearchWorks.clear();
  refresh();
});

function checkedNumber(id, min, max, label) {
  const text = $(id).value.trim(), value = Number(text);
  if (!text || !Number.isFinite(value) || value < min || value > max) throw new Error(label + '请填写 ' + min + ' 至 ' + max + ' 的有效数字');
  return value;
}
function renderConfigActions() {
  const running = taskActive(state && state.task);
  $('btn-collect-start').disabled = collectSubmitBusy || running;
  $('btn-collect-start').textContent = collectSubmitBusy ? '正在提交…' : collectConfigDirty ? '保存配置并开始采集' : $('c-col-autoai').checked ? '开始采集并判断' : '开始采集';
  $('collect-unsaved').textContent = collectConfigDirty ? '有未保存修改，开始时先保存' : '';
  $('action-unsaved').textContent = actionConfigDirty ? '有未保存修改，预检查前先保存' : '';
  $('btn-outreach-start').textContent = actionConfigDirty ? '保存配置并预检查' : '预检查关注与私信';
}
function loadCollectForm() {
  if (collectConfigDirty) return;
  const s = state.settings.collect;
  $('c-col-cooldown').value = s.cooldownHours;
  $('c-col-daily').value = s.dailyVideoLimit;
  $('c-col-max').value = s.maxScrolls;
  $('c-col-skipempty').checked = !!s.skipEmptyText;
  $('c-col-autoai').checked = s.autoAiAfterCollect !== false;
  $('c-col-aiwindow').value = String([0, 1, 3, 7].includes(Number(s.autoJudgeWindowDays)) ? s.autoJudgeWindowDays : 7);
  renderConfigActions();
}
async function saveCollectConfig() {
  const autoJudgeWindowDays = Number($('c-col-aiwindow').value) || 0;
  const collect = { cooldownHours: checkedNumber('c-col-cooldown', 0, 720, '重采冷却'), dailyVideoLimit: checkedNumber('c-col-daily', 1, 500, '每日作品上限'), maxScrolls: checkedNumber('c-col-max', 10, 500, '翻页轮数'), skipEmptyText: $('c-col-skipempty').checked, autoAiAfterCollect: $('c-col-autoai').checked };
  await api('/settings', { method: 'PUT', body: { collect, ai: { autoJudgeWindowDays } } });
  Object.assign(state.settings.collect, collect); state.settings.ai.autoJudgeWindowDays = autoJudgeWindowDays; collectConfigDirty = false; renderConfigActions();
  $('col-saved').textContent = '已保存';
}
for (const id of ['c-col-cooldown', 'c-col-daily', 'c-col-max', 'c-col-skipempty', 'c-col-autoai', 'c-col-aiwindow']) $(id).addEventListener('input', () => { collectConfigDirty = true; $('col-saved').textContent = ''; renderConfigActions(); });
$('btn-save-col').addEventListener('click', async () => {
  $('btn-save-col').disabled = true;
  try { await saveCollectConfig(); await refresh(); }
  catch (error) { $('col-saved').textContent = '未保存：' + error.message; }
  finally { $('btn-save-col').disabled = false; }
});
$('btn-collect-start').addEventListener('click', async () => {
  if (collectSubmitBusy) return;
  collectSubmitBusy = true; renderConfigActions();
  try {
    const links = queueEntries().map(({ row: r }) => ({ url: String(r.url || '').trim(), force: !!r.force })).filter(r => r.url);
    if (!links.length) throw new Error('当前分类没有可采集输入，请添加作品或切换采集状态');
    const accountId = $('col-account').value; if (!accountId) throw new Error('请先添加并选择采集账号');
    setCollectFeedback('pending', collectConfigDirty ? '正在保存采集配置…' : '正在提交作品队列…');
    if (collectConfigDirty) await saveCollectConfig();
    await api('/collect/start', { method: 'POST', body: { accountId, links } });
    setCollectFeedback('submitted', '队列已提交，正在读取进度。完成后按已保存设置处理本次评论用户。');
  } catch (error) { setCollectFeedback('error', error.message || '采集启动未完成'); }
  finally { collectSubmitBusy = false; renderConfigActions(); refresh(); }
});
$('btn-task-stop').addEventListener('click', async () => { await api('/tasks/stop', { method: 'POST' }); refresh(); });

function loadActionsForm() {
  if (actionConfigDirty) return;
  const f = state.settings.follow, d = state.settings.dm;
  $('a-fol-enabled').checked = f.enabled; $('a-fol-limit').value = f.dailyLimit;
  $('a-dm-enabled').checked = d.enabled; $('a-dm-limit').value = d.dailyLimit;
  $('a-dm-skip').checked = d.skipAuthor;
  $('a-dm-repeat').checked = !!(d.repeat && d.repeat.enabled);
  $('a-dm-repd').value = (d.repeat && d.repeat.intervalDays) || 7;
  $('a-dm-template').value = d.template;
  renderConfigActions();
}
async function saveActionConfig() {
  const body = {
    follow: { enabled: $('a-fol-enabled').checked, dailyLimit: checkedNumber('a-fol-limit', 1, 300, '每日关注上限') },
    dm: { enabled: $('a-dm-enabled').checked, dailyLimit: checkedNumber('a-dm-limit', 1, 200, '每日私信上限'), skipAuthor: $('a-dm-skip').checked, repeat: { enabled: $('a-dm-repeat').checked, intervalDays: checkedNumber('a-dm-repd', 1, 365, '重复联系天数') }, template: $('a-dm-template').value }
  };
  if (body.dm.enabled && !body.dm.template.trim()) throw new Error('请填写私信话术后再预检查');
  await api('/settings', { method: 'PUT', body });
  Object.assign(state.settings.follow, body.follow); Object.assign(state.settings.dm, body.dm);
  actionConfigDirty = false; renderConfigActions(); $('act-saved').textContent = '已保存';
}
for (const id of ['a-fol-enabled', 'a-fol-limit', 'a-dm-enabled', 'a-dm-limit', 'a-dm-skip', 'a-dm-repeat', 'a-dm-repd', 'a-dm-template']) $(id).addEventListener('input', () => { actionConfigDirty = true; $('act-saved').textContent = ''; renderConfigActions(); });
$('btn-save-act').addEventListener('click', async () => {
  $('btn-save-act').disabled = true;
  try { await saveActionConfig(); await refresh(); }
  catch (error) { $('act-saved').textContent = '未保存：' + error.message; setActionFeedback('error', error.message); }
  finally { $('btn-save-act').disabled = false; }
});

function loadPacingForm() {
  if (pacingConfigDirty) return;
  const c = state.settings.collect || {}, a = state.settings.action || {}, h = state.settings.human || {};
  const sp = state.settings.dm && state.settings.dm.sessionPause || {}, se = state.settings.search || {};
  $('c-col-interval').value = c.scrollIntervalSec ?? 3; $('c-col-jitter').value = Math.round((c.scrollJitter ?? .4) * 100);
  $('c-col-linkint').value = c.linkIntervalSec ?? 10; $('c-col-linkjit').value = Math.round((c.linkIntervalJitter ?? .2) * 100);
  $('a-user-interval').value = a.userIntervalSec ?? 30; $('a-user-jitter').value = Math.round((a.userIntervalJitter ?? .4) * 100);
  $('a-dm-pause-count').value = sp.count ?? 5; $('a-dm-pause-min').value = sp.pauseMinSec ?? 300; $('a-dm-pause-max').value = sp.pauseMaxSec ?? 300;
  $('s-search-interval').value = se.intervalSec ?? 60; $('s-search-jitter').value = Math.round((se.intervalJitter ?? .2) * 100); $('s-search-daily').value = se.dailySearchLimit ?? 30;
  $('s-hu-errors').value = h.maxConsecutiveErrors || 3; renderPacingRanges();
}
function renderPacingRanges() {
  for (const [target, interval, jitter] of [['pacing-scroll-range', 'c-col-interval', 'c-col-jitter'], ['pacing-work-range', 'c-col-linkint', 'c-col-linkjit'], ['pacing-user-range', 'a-user-interval', 'a-user-jitter']]) $(target).textContent = rangeText($(interval).value, Number($(jitter).value) / 100);
  const pc = Number($('a-dm-pause-count').value) || 0, pmin = Number($('a-dm-pause-min').value) || 0, pmax = Number($('a-dm-pause-max').value) || 0;
  $('pacing-dm-pause-range').textContent = pc > 0 ? `每发 ${pc} 条休息 ${pmin}–${pmax} 秒随机` : '未启用强制休息';
  const sbase = Number($('s-search-interval').value) || 0, sj = Number($('s-search-jitter').value) || 0;
  $('pacing-search-range').textContent = '关键词间隔 ' + rangeText(sbase, sj / 100) + '；每日上限 ' + ($('s-search-daily').value || 0) + ' 次';
}
for (const id of ['c-col-interval', 'c-col-jitter', 'c-col-linkint', 'c-col-linkjit', 'a-user-interval', 'a-user-jitter', 'a-dm-pause-count', 'a-dm-pause-min', 'a-dm-pause-max', 's-search-interval', 's-search-jitter', 's-search-daily', 's-hu-errors']) $(id).addEventListener('input', () => { pacingConfigDirty = true; $('pacing-saved').textContent = '尚未保存'; renderPacingRanges(); });
$('btn-pacing-defaults').addEventListener('click', () => {
  for (const [id, value] of Object.entries({ 'c-col-interval': 3, 'c-col-jitter': 40, 'c-col-linkint': 10, 'c-col-linkjit': 20, 'a-user-interval': 30, 'a-user-jitter': 40, 'a-dm-pause-count': 5, 'a-dm-pause-min': 60, 'a-dm-pause-max': 300, 's-search-interval': 60, 's-search-jitter': 20, 's-search-daily': 30 })) $(id).value = value;
  pacingConfigDirty = true; $('pacing-saved').textContent = '已填入默认值，保存后生效'; renderPacingRanges();
});
$('btn-save-pacing').addEventListener('click', async () => {
  $('btn-save-pacing').disabled = true;
  try {
    const body = {
      collect: { scrollIntervalSec: checkedNumber('c-col-interval', 0, 30, '翻页基准'), scrollJitter: checkedNumber('c-col-jitter', 0, 90, '翻页抖动') / 100, linkIntervalSec: checkedNumber('c-col-linkint', 0, 3600, '作品间隔'), linkIntervalJitter: checkedNumber('c-col-linkjit', 0, 90, '作品抖动') / 100 },
      action: { userIntervalSec: checkedNumber('a-user-interval', 0, 3600, '用户间隔'), userIntervalJitter: checkedNumber('a-user-jitter', 0, 90, '用户抖动') / 100, pacingVersion: 1 },
      dm: { sessionPause: { count: checkedNumber('a-dm-pause-count', 1, 200, '私信休息条数'), pauseMinSec: checkedNumber('a-dm-pause-min', 5, 86400, '最短休息'), pauseMaxSec: checkedNumber('a-dm-pause-max', 5, 86400, '最长休息') } },
      search: { intervalSec: checkedNumber('s-search-interval', 10, 86400, '搜索间隔'), intervalJitter: checkedNumber('s-search-jitter', 0, 90, '搜索抖动') / 100, dailySearchLimit: checkedNumber('s-search-daily', 1, 200, '每日搜索上限') },
      human: { maxConsecutiveErrors: checkedNumber('s-hu-errors', 1, 20, '连续异常阈值'), timeZone: 'Asia/Shanghai' }
    };
    if (body.dm.sessionPause.pauseMinSec > body.dm.sessionPause.pauseMaxSec) throw new Error('私信强制休息的最短时长不能超过最长时长');
    await api('/settings', { method: 'PUT', body });
    for (const [key, value] of Object.entries(body)) Object.assign(state.settings[key], value);
    pacingConfigDirty = false; $('pacing-saved').textContent = '任务节奏已保存'; renderWorkflowStatus(); refresh();
  } catch (error) { $('pacing-saved').textContent = '未保存：' + error.message; }
  finally { $('btn-save-pacing').disabled = false; }
});

/* ---------- 账号操作 ---------- */
async function act(id, action) {
  const label = { open: '打开登录浏览器', check: '检查登录状态', close: '关闭浏览器', del: '删除账号' }[action] || '账号操作';
  if (action === 'del' && !confirm('删除账号？其浏览器登录配置会保留在磁盘，线索数据不受影响。')) return;
  showAccountNotice(id, 'pending', `${label}已开始，请稍候…`, true);
  try {
    if (action === 'open') {
      await api(`/accounts/${encodeURIComponent(id)}/open`, { method: 'POST' });
      showAccountNotice(id, 'pending', '登录浏览器已开始打开。请在浏览器扫码并确认；程序每 2.5 秒更新监测结果。');
      if (embeddedBrowser && state.accounts.find(a => String(a.id) === String(id))?.browserMode === 'embedded') { embeddedPendingId = String(id); navigateTo('browser'); }
    } else if (action === 'check') {
      const r = await api(`/accounts/${encodeURIComponent(id)}/check`, { method: 'POST' });
      // ok means the request completed; it does not prove platform login.
      const phase = r.loggedIn === true && (!r.state || r.state === 'authenticated') ? 'authenticated' : r.state === 'authenticated' ? 'unknown' : loginPhase(r.state);
      showAccountNotice(id, phase, r.message || (phase === 'authenticated' ? '已确认浏览器登录成功。' : phase === 'logged_out' ? '浏览器尚未登录，请扫码并在手机确认。' : '暂未取得足够登录证据，请查看浏览器页面后重试检查。'));
    } else if (action === 'close') {
      await api(`/accounts/${encodeURIComponent(id)}/close`, { method: 'POST' });
      showAccountNotice(id, 'browser_closed', '浏览器已关闭，登录监测已结束。浏览器登录资料仍保存在本机。');
    } else if (action === 'del') {
      await api(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      accountFeedback.delete(String(id));
      showAccountNotice(null, 'info', '账号已删除。浏览器登录资料和线索数据仍保存在磁盘。');
    }
    await refresh();
    if (embeddedBrowser && ['close', 'del'].includes(action)) await loadEmbeddedBrowsers();
  } catch (e) {
    showAccountNotice(id, 'error', `${label}未完成：${e.message || '无法连接本机服务，请重试'}`);
  }
}
$('acc-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-account-action]');
  if (button) await act(button.dataset.accountId, button.dataset.accountAction);
});
$('acc-list').addEventListener('change', async event => {
  const select = event.target.closest('[data-account-mode]');
  if (!select) return;
  const id = select.dataset.accountMode, browserMode = select.value;
  select.disabled = true;
  showAccountNotice(id, 'pending', '正在切换浏览器，登录资料会保留…', true);
  try {
    await api(`/accounts/${encodeURIComponent(id)}`, { method: 'PUT', body: { browserMode } });
    showAccountNotice(id, 'unknown', `已切换到${browserMode === 'embedded' ? '内嵌浏览器' : '外部专用浏览器'}。请点击“打开登录”；当前模式需要重新检查登录状态。`);
    if (embeddedPendingId === String(id)) embeddedPendingId = '';
    await refresh();
    if (embeddedBrowser) await loadEmbeddedBrowsers();
  } catch (e) {
    showAccountNotice(id, 'error', '切换未完成：' + e.message);
    await refresh().catch(() => {});
  }
});
$('act-account').addEventListener('change', () => { renderSelectionInfo(); });

$('btn-add-acc').addEventListener('click', async () => {
  const name = $('acc-name').value.trim() || undefined;
  const proxy = $('acc-proxy').value.trim();
  const note = $('acc-note').value.trim();
  $('btn-add-acc').disabled = true;
  try {
    await api('/accounts', { method: 'POST', body: { name, proxy, note } });
    $('acc-name').value = ''; $('acc-proxy').value = ''; $('acc-note').value = '';
    showAccountNotice(null, 'info', '账号已添加。点击对应账号的“打开登录”，在浏览器扫码并确认。');
    await refresh();
  } catch (e) {
    showAccountNotice(null, 'error', `添加账号未完成：${e.message || '无法连接本机服务，请重试'}`);
  } finally { $('btn-add-acc').disabled = false; }
});

/* ---------- 全局设置（关键词/AI/真人化/授权） ---------- */
function renderLicensePanel() {
  $('lic-user-box').classList.toggle('hidden', state.role !== 'user');
}

$('btn-lu-change').addEventListener('click', async () => {
  const r = await api('/license/changepass', { method: 'POST', body: { oldPassword: $('lu-old').value, newPassword: $('lu-new').value } });
  if (r && r.ok) {
    $('lu-msg').textContent = '✅ 修改成功';
    $('lu-old').value = ''; $('lu-new').value = '';
  } else {
    $('lu-msg').textContent = '❌ ' + ((r && r.error) || '修改失败');
  }
  setTimeout(() => { $('lu-msg').textContent = ''; }, 3000);
});

async function loadSettingsForm() {
  const s = state.settings;
  if (state.license) {
    $('lic-mac').textContent = state.license.mac || '-';
    $('lic-datadir').textContent = state.dataDir || '-';
    $('lic-servertime').textContent = state.license.serverTime || '（未同步）';
    const cache = state.license.cache || {};
    $('lic-username').textContent = state.loginUser || cache.username || '—';
    $('lic-expiry').textContent = cache.expiresAt || '—';
    $('lic-status').textContent = state.license.configurationError ? '授权需处理' : cache.offline ? '离线授权有效' : '授权有效';
  }
  renderLicensePanel();
  $('s-ai-enabled').checked = s.ai.enabled;
  // 服务端不再下发明文 Key：留空表示沿用，输入新值才覆盖。
  $('s-ai-key').value = '';
  $('s-ai-key').placeholder = s.ai.apiKeySet ? '已保存，留空表示不修改' : '填写您的 DeepSeek API Key';
  renderModelChoices(s.ai.model ?? 'deepseek-flash');
  $('ai-model-msg').textContent = '尚未刷新官方列表';
  loadPacingForm();
  $('s-ai-bchars').value = s.ai.batchMaxChars;
  $('s-ai-bcount').value = s.ai.batchMaxCount;
  $('s-ai-batch-mode').value = s.ai.batchMode || 'auto';
  renderBatchMode();
  $('s-ai-timeout').value = s.ai.requestTimeoutSec || 60;
  $('s-ai-biz').value = s.ai.businessDesc;
  $('s-ai-target').value = s.ai.targetCustomers || '';
  $('s-ai-needs').value = s.ai.clearNeeds || '';
  $('s-ai-misjudgments').value = s.ai.misjudgments || '';
  promptPresets = ['prompt-1', 'prompt-2', 'prompt-3'].map((id, index) => {
    const preset = (s.ai.promptPresets || []).find(item => item.id === id);
    return { id, name: preset?.name || `提示词 ${index + 1}`, prompt: preset?.prompt || (index === 0 ? s.ai.prompt || '' : '') };
  });
  activePromptId = promptPresets.some(item => item.id === s.ai.activePromptId) ? s.ai.activePromptId : 'prompt-1';
  editingPromptId = activePromptId;
  renderPromptEditor();
  $('s-kw-intent').value = (s.keywords.intent || []).join(', ');
  $('s-kw-exclude').value = (s.keywords.exclude || []).join(', ');
  if (s.ai.apiKeySet) refreshModels();
}

function businessInput() {
  return { businessDesc: $('s-ai-biz').value, targetCustomers: $('s-ai-target').value, clearNeeds: $('s-ai-needs').value, misjudgments: $('s-ai-misjudgments').value };
}

function renderModelChoices(selected) {
  const choices = modelChoices.slice();
  if (selected && !choices.some(item => item.id === selected)) choices.unshift({ id: selected, name: `${selected}（已选，待官方验证）` });
  $('s-ai-model').innerHTML = '<option value="">请选择官方模型</option>' + choices.map(item => `<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`).join('');
  $('s-ai-model').value = selected;
}
async function refreshModels() {
  const sequence = ++modelLoadSequence;
  $('btn-ai-models').disabled = true;
  $('ai-model-msg').textContent = '正在获取官方模型…';
  try {
    const result = await api('/ai/models');
    if (sequence !== modelLoadSequence) return;
    const selected = $('s-ai-model').value;
    modelChoices = Array.isArray(result.models) ? result.models.filter(item => item && typeof item.id === 'string') : [];
    renderModelChoices(selected);
    renderSelectedModelInfo();
  } catch (error) {
    if (sequence !== modelLoadSequence) return;
    $('ai-model-msg').textContent = `刷新失败：${error.message}。已选模型保持不变。`;
    $('ai-model-msg').classList.add('model-error');
  } finally { if (sequence === modelLoadSequence) $('btn-ai-models').disabled = false; }
}
$('btn-ai-models').addEventListener('click', refreshModels);
function renderSelectedModelInfo() {
  const model = modelChoices.find(item => item.id === $('s-ai-model').value);
  const limits = model && Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? `；上下文 ${model.contextWindow.toLocaleString()} token${Number.isInteger(model.maxOutputTokens) && model.maxOutputTokens > 0 ? `，最大输出 ${model.maxOutputTokens.toLocaleString()} token` : ''}` : '';
  $('ai-model-msg').textContent = model ? `已获取 ${modelChoices.length} 个官方模型${limits}` : '当前所选模型不在官方列表中，请选择可用模型后保存';
  $('ai-model-msg').classList.toggle('model-error', !model);
}
$('s-ai-model').addEventListener('change', renderSelectedModelInfo);

function rememberPromptEditor() {
  const preset = promptPresets.find(item => item.id === editingPromptId);
  if (preset) { preset.name = $('s-ai-prompt-name').value.trim() || `提示词 ${promptPresets.indexOf(preset) + 1}`; preset.prompt = $('s-ai-prompt').value; }
}
function renderPromptSlots() {
  $('prompt-slots').innerHTML = promptPresets.map((preset, index) => `<div class="prompt-slot ${preset.id === editingPromptId ? 'editing' : ''}"><button type="button" class="prompt-edit" data-prompt-edit="${preset.id}" aria-pressed="${preset.id === editingPromptId}"><span>预设 ${index + 1}</span><strong>${esc(preset.name)}</strong></button><label><input type="radio" name="active-prompt" value="${preset.id}" ${preset.id === activePromptId ? 'checked' : ''}> 使用这一版</label></div>`).join('');
  renderActivePromptSummary();
}
function renderActivePromptSummary() {
  const savedId = state.settings.ai.activePromptId || 'prompt-1';
  const saved = (state.settings.ai.promptPresets || []).find(item => item.id === savedId);
  const next = promptPresets.find(item => item.id === activePromptId);
  $('ai-active-summary').textContent = `已保存使用：${saved?.name || '提示词 1'}。本次选择：${next?.name || '提示词 1'}；点击保存后生效。`;
  $('ai-prompt-warning').textContent = state.aiPromptWarning ? `已保存的提示词存在冲突：${state.aiPromptWarning}。可选空白预设后填入优化行业预设，保留原提示词。` : '';
  $('ai-prompt-warning').classList.toggle('hidden', !state.aiPromptWarning);
  const editing = promptPresets.find(item => item.id === editingPromptId);
  $('ai-editor-title').textContent = `正在编辑：${editing?.name || '提示词'}（编辑不会自动启用）`;
}
function renderPromptEditor() {
  const preset = promptPresets.find(item => item.id === editingPromptId);
  $('s-ai-prompt-name').value = preset?.name || '';
  $('s-ai-prompt').value = preset?.prompt || '';
  renderPromptSlots();
}
$('prompt-slots').addEventListener('click', event => {
  const button = event.target.closest('[data-prompt-edit]');
  if (!button) return;
  rememberPromptEditor(); editingPromptId = button.dataset.promptEdit; renderPromptEditor();
});
$('prompt-slots').addEventListener('change', event => {
  if (event.target.name !== 'active-prompt') return;
  rememberPromptEditor(); activePromptId = event.target.value; renderActivePromptSummary();
});
$('s-ai-prompt-name').addEventListener('input', () => { rememberPromptEditor(); renderPromptSlots(); });

$('btn-ai-industry-default').addEventListener('click', () => {
  const defaults=state.aiIndustryDefaults;
  if(!defaults?.prompt||!defaults.businessInput||!defaults.keywords) throw new Error('行业预设尚未加载，请刷新后重试');
  rememberPromptEditor();
  const preset=promptPresets.find(item=>item.id===editingPromptId);
  if(!preset) throw new Error('请选择一份可编辑的提示词');
  const fields={businessDesc:'s-ai-biz',targetCustomers:'s-ai-target',clearNeeds:'s-ai-needs',misjudgments:'s-ai-misjudgments'};
  for(const [field,id] of Object.entries(fields)) $(id).value=defaults.businessInput[field];
  preset.name='亚马逊账户服务（复核优化）';preset.prompt=defaults.prompt;activePromptId=preset.id;
  $('s-kw-intent').value=defaults.keywords.intent.join(', ');$('s-kw-exclude').value=defaults.keywords.exclude.join(', ');
  renderPromptEditor();
  $('ai-draft-msg').textContent='已填入当前预设、四项业务资料和关键词草稿，并选为使用这一版。保存设置后生效；API Key、其它预设和操作设置保留。';
});

$('btn-ai-draft').addEventListener('click', async () => {
  rememberPromptEditor();
  const target = { ...promptPresets.find(item => item.id === editingPromptId) };
  $('btn-ai-draft').disabled = true; $('ai-draft-msg').textContent = '生成中…';
  try {
    const result = await api('/ai/prompt-draft', { method: 'POST', body: { businessInput: businessInput() } });
    rememberPromptEditor();
    const destination = promptPresets.find(item => item.id === target.id);
    if (!destination || destination.prompt !== target.prompt) {
      generatedPromptDraft = { id: target.id, name: target.name, prompt: result.prompt };
      $('ai-generated-draft').value = result.prompt;
      $('ai-generated-draft-summary').textContent = `生成期间「${target.name}」的内容已变更，已保留您的修改。这份草稿可由您决定是否应用到原预设。`;
      $('ai-generated-draft-panel').classList.remove('hidden');
      $('ai-draft-msg').textContent = '草稿已保留，尚未覆盖、保存或启用。';
    } else {
      destination.prompt = result.prompt;
      if (editingPromptId === target.id) $('s-ai-prompt').value = result.prompt;
      $('ai-draft-msg').textContent = `已生成到「${destination.name}」，尚未保存或启用。请选择使用预设后保存。`;
    }
  } catch (error) { $('ai-draft-msg').textContent = error.message; throw error; }
  finally { $('btn-ai-draft').disabled = false; }
});
$('btn-ai-generated-apply').addEventListener('click', () => {
  if (!generatedPromptDraft) return;
  rememberPromptEditor();
  const preset = promptPresets.find(item => item.id === generatedPromptDraft.id);
  if (!preset) throw new Error('原预设已不存在，请重新生成');
  preset.prompt = generatedPromptDraft.prompt;
  if (editingPromptId === preset.id) $('s-ai-prompt').value = preset.prompt;
  $('ai-draft-msg').textContent = `已应用到「${preset.name}」，尚未保存或启用。`;
  generatedPromptDraft = null; $('ai-generated-draft-panel').classList.add('hidden');
});
$('btn-ai-generated-dismiss').addEventListener('click', () => { generatedPromptDraft = null; $('ai-generated-draft-panel').classList.add('hidden'); });
$('btn-ai-batch-recommended').addEventListener('click', () => {
  $('s-ai-batch-mode').value = 'auto';
  renderBatchMode();
  $('ai-batch-msg').textContent = '已选择自动组批：75% → 50% → 30% → 每批最多200条。超时或回执失败后逐档调整，剩余任务沿用当前档位。点击“保存设置”后生效；原手动预算和判断规则保留。';
});
function renderBatchMode() {
  const auto = $('s-ai-batch-mode').value === 'auto';
  $('s-ai-bchars').disabled = auto;
  $('s-ai-bcount').disabled = auto;
}
$('s-ai-batch-mode').addEventListener('change', renderBatchMode);
$('btn-ai-test').addEventListener('click', async () => {
  const samples = $('s-ai-samples').value.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  if (!samples.length || samples.length > 20) throw new Error('请输入 1 至 20 条匿名评论样例');
  $('btn-ai-test').disabled = true;
  try {
    const result = await api('/ai/prompt-test', { method: 'POST', body: { prompt: $('s-ai-prompt').value, businessInput: businessInput(), samples } });
    $('ai-test-results').innerHTML = (result.results || []).map(item => `<div class="sample-result"><b>${esc(item.i)}. ${esc(item.need)}</b><div>${esc(item.comment)}</div><div class="note">${esc(item.reason)}</div></div>`).join('');
  } finally { $('btn-ai-test').disabled = false; }
});
$('btn-save-settings').addEventListener('click', async () => {
  const num = id => Number($(id).value) || 0;
  const kw = id => $(id).value.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean);
  rememberPromptEditor();
  const active = promptPresets.find(item => item.id === activePromptId);
  if (!active?.prompt.trim()) throw new Error('使用中的提示词不能为空。请填写它，或选择另一版提示词。');
  if (!$('s-ai-model').value) throw new Error('请选择 DeepSeek 模型；模型列表可在保存 API Key 后刷新。');
  const previousKey = ''; // 明文 Key 不下发到界面，留空保存即沿用服务端已存值
  const body = {
    keywords: { intent: kw('s-kw-intent'), exclude: kw('s-kw-exclude') },
    ai: { enabled: $('s-ai-enabled').checked, apiKey: $('s-ai-key').value.trim(), model: $('s-ai-model').value, batchMode: $('s-ai-batch-mode').value, batchMaxChars: num('s-ai-bchars'), batchMaxCount: num('s-ai-bcount'), ...businessInput(), requestTimeoutSec: num('s-ai-timeout'), promptPresets: promptPresets.map(item => ({ ...item })), activePromptId }
  };
  await api('/settings', { method: 'PUT', body });
  $('settings-saved').textContent = '✅ 已保存';
  setTimeout(() => { $('settings-saved').textContent = ''; }, 2000);
  await refresh();
  renderActivePromptSummary();
  if (body.ai.apiKey && body.ai.apiKey !== previousKey) await refreshModels();
});

/* ---------- 日志 ---------- */
function formatAiLog(line) {
  const match = String(line).match(/^(.*?)(?:AI_AUDIT)\s+(\{.*\})$/);
  if (!match) return line;
  let item;
  try { item = JSON.parse(match[2]); } catch (_) { return line; }
  const modes = { batch: '批量', single: '单条', fallback_single: '逐条兜底', split_batch: '拆批重试', retry_batch:'缩批重试',budget_rejected:'超限未发' };
  const batch = item.batchNo ? `第 ${item.batchNo}/${item.batchCount || '?'} 批 · ` : '';
  const counts = `是 ${item.yes ?? item.yesCount ?? 0}｜否 ${item.no ?? item.noCount ?? 0}｜失败 ${item.failed ?? item.failCount ?? 0}｜跳过 ${item.skipped ?? 0}`;
  let text;
  switch (item.event) {
    case 'selection': text = `AI 名单已固定：选中 ${item.selectedCount} 条，本次待判 ${item.pendingCount} 条；${item.force ? '重新判断已有结果' : '保留已有有效结果'}`; break;
    case 'plan': text = `AI 组批：待判 ${item.count} 条，共 ${item.batchCount} 批；${item.strategy || '手动'} · ${Math.round((item.targetRatio || .9)*100)}% 预算${item.executionMaxCount <= 200 ? `，每批最多 ${item.executionMaxCount} 条` : ''}；规则 ${item.ruleVersion}`; break;
    case 'request': text = `AI 准备请求：${batch}${modes[item.mode] || item.mode} · ${item.count} 条 · 共享 ${item.workCount} 份作品${item.strategy ? ' · '+item.strategy : ''}；${item.reason || ''}`; break;
    case 'request_sent': text = `AI 已发出请求：${item.kind === 'models' ? '模型查询' : batch + '判断'}；累计判断 ${item.completionRequestCount || 0} 次，模型查询 ${item.modelRequestCount || 0} 次（含重试）`; break;
    case 'provider_retry': text = `AI 接口重试：${batch}第 ${item.retryNo} 次，等待 ${(Number(item.delayMs) || 0) / 1000} 秒；${item.reason || ''}`; break;
    case 'budget': text = `AI 请求预算：${batch}估算输入 ${item.inputTokensEstimate ?? '—'} ＋ 返回预留 ${item.outputTokensReserved ?? '—'} / ${Math.round((item.targetRatio || .9)*100)}% 预算 ${item.targetTokens ?? '—'} token`; break;
    case 'result': text = `AI ${modes[item.mode] || '判断'}结果：${batch}编号 ${item.leadId} → ${item.outcome === 'success' ? item.need : item.outcome === 'skipped' ? '未写入' : '失败'}；${item.reason || ''}`; break;
    case 'response_invalid': text = `AI 回执无效：${batch}${item.message || item.code}；本批未直接写入`; break;
    case 'request_failed': text = `AI 请求失败：${batch}${item.reason || ''}`; break;
    case 'fallback': text = `AI 逐条兜底：${batch}编号 ${item.leadId}；原因：${item.reason || ''}`; break;
    case 'batch_completed': text = `AI 本批完成：${batch}${counts}｜逐条兜底 ${item.fallback || 0}`; break;
    case 'completed': text = `AI 全部完成：${counts}｜逐条兜底 ${item.fallbackCount || 0}`; break;
    case 'paused': text = `AI 已暂停：${counts}；${item.reason || ''}`; break;
    case 'model_capacity': text = `AI 模型容量：${item.model} · 上下文 ${item.contextWindow} token，最大输出 ${item.maxOutputTokens} token；初始采用${Math.round((item.targetRatio || .9)*100)}%预算，保守估算${item.sourceKind === 'official_document_fallback' ? '；容量使用已核对官方文档备用值' : '；容量来自模型接口'}`; break;
    case 'budget_recovery': text = `AI 调整组批：${item.fromStrategy} → ${item.strategy}；${item.reason}。剩余 ${item.count} 条重新规划 ${item.batchCount} 批，首批 ${item.firstBatchCount} 条，已保存结果不重复处理`; break;
    case 'budget_strategy_skipped': text = `AI 跳过 ${item.strategy} 档：${item.reason}`; break;
    case 'budget_rejected': text = `AI 超限未发：编号 ${item.leadId}；${item.reason || ''}`; break;
    case 'retry_split': text = item.splitKind === 'timeout' ? `AI 超时缩批：${batch}${item.count} 条拆成 ${item.chunkCount} 个子批，每批最多 ${item.chunkSize} 条；${item.reason || ''}` : `AI 缩批重试：${batch}${item.count} 条拆成 ${item.leftCount} ＋ ${item.rightCount} 条；${item.reason || ''}`; break;
    case 'usage': text = `AI 实际用量：${batch}输入 ${item.usage?.prompt_tokens ?? '—'}，输出 ${item.usage?.completion_tokens ?? '—'} token（服务器回执）`; break;
    default: return line;
  }
  return match[1] + text;
}
async function renderLogs() {
  const accId = $('log-account').value;
  if (!accId) { $('log-box').textContent = '请先添加账号'; return; }
  const r = await api('/logs/' + accId);
  $('log-box').textContent = (r.lines || []).map(formatAiLog).join('\n') || '暂无日志';
}
$('btn-refresh-log').addEventListener('click', refresh);
$('log-account').addEventListener('change', renderLogs);

/* ---------- 轮询 ---------- */
let loginRefreshTimer = null;
function scheduleLoginRefresh() {
  const task = state && state.task;
  const running = !!(task && task.kind === 'login' && task.running);
  const loginVisible = $('login-layer') && $('login-layer').style.display !== 'none';
  if (!running || loginVisible) {
    if (loginRefreshTimer) { clearTimeout(loginRefreshTimer); loginRefreshTimer = null; }
    return;
  }
  // 扫码确认后不必等常规 2.5 秒轮询：登录任务期间用 1 秒节奏追一次状态。
  if (loginRefreshTimer) return;
  loginRefreshTimer = setTimeout(() => { loginRefreshTimer = null; refresh(); }, 1000);
}
async function refresh() {
  if (!token || refreshBusy) return;
  refreshBusy = true;
  let accountStateLoaded = false;
  const previousTask = state && state.task;
  try {
    const searchResults = state && state.searchResults;
    const videoHistory = state && state.videoHistory;
    state = await api('/state');
    // 登录任务结束的瞬间丢掉本地“正在打开登录”提示，卡片直接显示真实登录态。
    if (previousTask && previousTask.kind === 'login' && previousTask.running
        && !(state.task && state.task.kind === 'login' && state.task.running)) {
      accountFeedback.delete(String(previousTask.accountId));
    }
    // Keep the displayed selection usable while the following API reads wait.
    if (searchResults) state.searchResults = searchResults;
    if (videoHistory) state.videoHistory = videoHistory;
    accountStateLoaded = true;
    accountRefreshError = '';
    actionStateError = '';
    renderOverview(); renderAccounts();
    fillAccounts('col-account'); fillAccounts('act-account'); fillAccounts('log-account');
    renderActionStatus(); renderSelectionInfo(); renderOutreachControls(); renderWorkflowStatus();
    renderEmbeddedBrowser();
    try { state.videoHistory = ((await api('/videos')) || {}).videos || []; }
    catch (e) { state.videoHistoryError = e.message || '无法连接本机服务，请重试'; }
    const vis = p => !$(p).classList.contains('hidden');
    // Settings load only on navigation; polling preserves unsaved form edits.
    if (vis('page-settings') && pageDirty) loadSettingsForm();
    if (vis('page-leads')) loadLeads();
    if (vis('page-logs')) renderLogs();
    if (vis('page-collect')) {
      if (pageDirty) loadCollectForm();
      renderLinkRows(); renderVideoHistory();
      renderSearchFeedback();
      if ($('search-options') && $('search-options').open) {
        try { state.searchResults = ((await api('/search/results')) || {}).results || []; renderSearchResults(); } catch (e) { /* 本地结果读取失败不打断轮询 */ }
        loadSearchDraft(); loadKeywordStats();
      }
    }
    if (vis('page-leads') && pageDirty) loadActionsForm();
    if (vis('page-leads')) { renderDistributionPool(); renderDistributionProgress(); }
    pageDirty = false;
  } catch (e) {
    if (!accountStateLoaded) { actionStateError = e.message || '无法连接本机服务'; renderActionStatus(); }
    if (!accountStateLoaded && !$('page-accounts').classList.contains('hidden')) {
      accountRefreshError = e.message || '无法连接本机服务，请重试';
      renderAccountNotice();
    }
  }
  finally { refreshBusy = false; scheduleLoginRefresh(); }
}

if (token) {
  api('/state').then(s => { state = s; hideLogin(); refresh(); }).catch(() => showLogin());
} else {
  showLogin();
}
setInterval(refresh, 2500);
window.addEventListener('unhandledrejection', event => {
  event.preventDefault();
  alert(event.reason && event.reason.message || '操作失败，请检查服务连接');
});
