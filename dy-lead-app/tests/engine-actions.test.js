const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
// Reuse the same behavioral cases against the actual packaged JS without a
// full live-browser batch or copying customer data into a test installation.
const testApp = process.env.OUTREACH_TEST_APP_DIR || path.resolve(__dirname, '..');
const { createActions } = require(path.join(testApp, 'engine-actions'));
const browserActions = require(path.join(testApp, 'lib/browser-actions'));
const { ActionScheduler } = require(path.join(testApp, 'scheduler'));
const W = require(path.join(testApp, 'workflow'));
const AI = require(path.join(testApp, 'ai'));
const { EventEmitter } = require('node:events');
function fixture({ dmAccountState = null, count = 1, verifier, revokeAt, authorizeHook, onFocus, onSend, missingDm = false, editorMissing = false, diagnostic = {}, sendThrows = false, sendPreflightError = false, sendMissing = false, sendOutcome = true, health = 'ok', mutateAfterVisit, initialLead, actionIntervalSec = 0, human = {}, waitHook, followReceipt = 'success', followOutcome = 'clicked', followThrows = false, followPreflightError = false, followClickHook, navigateProfilePage, signal, beforeAdapterUiAction, selectConversation = false, profileRelation, dmHistory, lateDmHistory, repeat, domHistory, dmFeedback, crossAccount = false, leadAccountId = '1', planActions = { follow: true, dm: true }, followAction } = {}) {
  const settings = { ai: { prompt: '需求规则' }, action: { pacingVersion: 1, userIntervalSec: actionIntervalSec, userIntervalJitter: 0 }, human: { workPeriods: [], breakEvery: 0, maxConsecutiveErrors: 3, ...human }, follow: { enabled: true, dailyLimit: 20, intervalMinSec: 100, intervalMaxSec: 200 }, dm: { enabled: true, dailyLimit: 20, template: '你好', intervalMinSec: 200, intervalMaxSec: 300, repeat: { enabled: false } }, outreach: { businessId: 'default' } };
  if (repeat) settings.dm.repeat = repeat;
  let leads = Array.from({ length: count }, (_, i) => {
    const l = { id: i + 1, uid: 'user' + (i + 1), accountId: leadAccountId, homepage: 'https://www.douyin.com/user/user' + (i + 1), demand: '具体需求', aiNeed: '是', aiReason: '询问相关处理方法', aiDone: true };
    if (initialLead) initialLead(l, i);
    l.aiPromptVersion = AI.getRuleSet(settings).version; l.aiInputHash = W.aiInputHash(l); return l;
  });
  const plan = { id: 'plan', kind: 'outreach', actions: planActions, accountId: '1', leadIds: leads.map(l => String(l.id)), leads: leads.map(l => ({ id: l.id, uid: l.uid })), crossAccount, fingerprint: W.settingsFingerprint(settings, planActions) };
  const usage = {}, visited = [], clicked = [], authorized = [], saved = [], events = [], logs = [], launches = [], statuses = [], focuses = [], stages = [], messages = [], navigationOptions = [], uiActions = [];
  const trace = [];
  const historyTargets = [];
  let time = Date.parse('2026-10-08T02:00:00Z'), currentUrl = 'https://www.douyin.com/', checkpoint = {};
  const event = kind => { trace.push(kind); events.push({ kind, time, user: new URL(currentUrl).pathname.split('/').pop() }); };
  const state = { running: false, stopRequested: false, errors: [] };
  const store = {
    getSettings: () => settings, getLeads: () => structuredClone(leads), getVideos: () => ({}),
    getDailyUsage: () => ({ ...usage }), bumpDaily: (id, field) => { usage[field] = (usage[field] || 0) + 1; },
    nowStr: () => '2026-10-08 12:00:00', log: (accountId, message) => logs.push(message)
  };
  // 可选：账号状态存储（强制休息计数持久化测试用）；{ value } 由测试持有
  if (dmAccountState) Object.assign(store, { opDayStr: () => '2026-10-08',
    getDmAccountState: () => structuredClone(dmAccountState.value || {}), setDmAccountState: next => { dmAccountState.value = structuredClone(next); } });
  const page = new EventEmitter(), frame = { page: () => page };
  const emitFollow = () => {
    const uid = new URL(currentUrl).pathname.split('/').pop();
    const request = { url: () => 'https://www.douyin.com/aweme/v1/web/commit/follow/user/', method: () => 'POST',
      postData: () => 'sec_user_id=' + encodeURIComponent(followReceipt === 'wrong-target' ? 'other' : uid) + '&type=1',
      headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }), frame: () => frame };
    page.emit('request', request);
    page.emit('response', { url: request.url, request: () => request, status: () => 200, headers: () => ({}),
      body: async () => Buffer.from(JSON.stringify(followReceipt === 'unknown-schema' ? { status_code: 0 } : { status_code: 0, follow_status: 1 })) });
  };
  Object.assign(page, { isClosed: () => false, url: () => currentUrl, mainFrame: () => frame,
    bringToFront: async () => { focuses.push({ time }); if (onFocus) onFocus(state); },
    goto: async url => { visited.push(url); currentUrl = url; event('visit'); if (mutateAfterVisit) mutateAfterVisit(leads); },
    evaluate: async (fn, arg) => {
      if (fn === browserActions.readPageHealth) return typeof health === 'function' ? health({ state, events, authorized }) : health;
      if (fn === browserActions.clickFollow) {
        if (followOutcome === 'clicked') { clicked.push('follow'); event('follow'); }
        if (followThrows) throw new Error('connection lost during follow click');
        if (followReceipt !== 'none' && followOutcome === 'clicked') emitFollow();
        return followOutcome;
      }
      if (fn === browserActions.isFollowConfirmed) throw new Error('DOM colour cannot confirm a follow receipt');
      if (fn === browserActions.openDirectMessage) { event('openDm'); return !missingDm; }
      if (fn === browserActions.fillDirectMessage) { event('fillDm'); messages.push(arg); return !editorMissing; }
      if (fn === browserActions.sendDirectMessage) { if (!sendOutcome) return false; clicked.push('dm'); event('dm'); if (sendThrows) throw new Error('connection lost after click'); if (onSend) onSend({ page, frame, leads, usage }); return true; }
      throw new Error('Unexpected page mock: ' + String(fn));
    }
  });
  const setTask = p => { if (p.running === true) state.stopRequested = false; Object.assign(state, p); if (p.status) statuses.push(p.status); if (p.stage) stages.push(p.stage); };
  const beforeUiAction = async (phase, options) => {
    if (beforeAdapterUiAction) await beforeAdapterUiAction(phase, { state, leads, events, authorized });
    await options.beforeUiAction();
    options.checkStopped();
    uiActions.push({ phase, authorization: authorized.at(-1) });
  };
  const browserActionAdapter = {
    prepareFollow: async (page, lead, options) => ({ state: followOutcome === 'already' ? 'already' : followOutcome === 'missing' ? 'missing' : 'ready',
      click: async () => {
        if (followClickHook) await followClickHook({ lead, leads, state, events, authorized, page, usage });
        if (followPreflightError) throw Object.assign(new Error('目标主页已改变，本次没有点击'), { actionNotStarted: true, code: 'TARGET_MISMATCH' });
        await beforeUiAction('follow', options);
        return (await page.evaluate(browserActions.clickFollow)) === 'clicked';
      } }),
    openDirectMessage: async (page, lead, options) => {
      if (!missingDm) await beforeUiAction('open', options);
      return page.evaluate(browserActions.openDirectMessage);
    },
    ensureDirectMessageConversation: async (page, lead, options) => {
      if (selectConversation) await beforeUiAction('conversation', options);
      trace.push('conversation');
      return !editorMissing;
    },
    fillDirectMessage: async (page, lead, message, options) => {
      if (!editorMissing) await beforeUiAction('fill', options);
      return page.evaluate(browserActions.fillDirectMessage, message);
    },
    getDiagnostic: () => diagnostic,
    readDirectMessageHistory: async () => (typeof domHistory === 'function' ? domHistory({ events, leads, messages }) : domHistory) || { state: 'ready', history: { state: 'unknown' } },
    prepareSend: async (page, lead, message, options) => ({ state: sendMissing ? 'missing' : 'ready', readFeedback: async () => dmFeedback || null, click: async () => {
      if (sendPreflightError) throw Object.assign(new Error('目标会话已改变，本次没有点击'), { actionNotStarted: true, code: 'TARGET_MISMATCH' });
      await beforeUiAction('send', options);
      return page.evaluate(browserActions.sendDirectMessage, message);
    } })
  };
  const deps = {
    observeProfileRelation: () => {
      trace.push('observeRelation');
      return { wait: async () => profileRelation || { state: 'unknown' }, dispose: () => {} };
    },
    observeDmHistory: options => {
      historyTargets.push(options.targetNumericUid);
      trace.push('observeHistory');
      let snapshot = { state: 'unknown' }, disposed = false;
      return {
        wait: async ({ keepAlive }) => {
          assert.equal(keepAlive, true);
          trace.push('checkHistory');
          snapshot = typeof dmHistory === 'function' ? dmHistory({ state, settings, leads }) : dmHistory || snapshot;
          return snapshot;
        },
        getSnapshot: () => {
          assert.equal(disposed, false, 'pre-send history must not be read after freezing');
          return typeof lateDmHistory === 'function' ? lateDmHistory({ state, settings, leads, events, authorized }) : snapshot;
        },
        dispose: () => { disposed = true; }
      };
    },
    saveContactObservation: (id, kind, observation) => {
      const lead = leads.find(l => String(l.id) === String(id));
      lead[kind === 'follow' ? 'followObserved' : 'dmHistoryObserved'] = structuredClone(observation);
      if (kind === 'dm' && observation.state === 'already_sent') lead.dmHistorySentObserved = structuredClone(observation);
      saved.push({ kind: kind + 'Observation', lead: structuredClone(lead) });
    },
    store, browserActionAdapter, taskState: state, setTask, SLEEP: async ms => { time += ms; }, getAlive: () => ({ page, headless: true }),
    navigateProfilePage: async (targetPage, url, options) => {
      navigationOptions.push(options);
      if (navigateProfilePage) return navigateProfilePage(targetPage, url, options, state);
      options.checkStopped(); await options.authorize({ kind: 'video_redirect' }); options.checkStopped();
      return targetPage.goto(url);
    },
    launchAccount: async (accountId, options) => { launches.push({ accountId, headless: options.headless }); options.checkStopped(); return { page, headless: false }; },
    makeScheduler: (s, options = {}) => new ActionScheduler({ settings: s, ...options, stopped: () => state.stopRequested, now: () => time, random: () => 0, sleep: async ms => { time += ms; if (waitHook) waitHook({ state, events, time }); }, update: setTask, authorize: async m => { authorized.push(m); return authorizeHook ? authorizeHook(m, { state, events, authorized }) : m.kind !== revokeAt; } }),
    saveLeadAction: (l, kind) => { leads = leads.map(row => row.uid === l.uid ? JSON.parse(JSON.stringify({ ...row, ...l })) : row); saved.push({ kind, lead: structuredClone(l) }); },
    resolvePlan: () => plan, checkpoint: p => { checkpoint = { ...checkpoint, ...p }; },
    getHooks: () => ({ dmVerifier: verifier ? args => verifier(args, { leads, usage }) : async () => ({ state: 'pending_verification', reason: 'unknown receipt' }) }), getSignal: () => signal,
    applyTemplate: (t, l) => t, receiptTimeoutMs: 5,
    ...(followAction ? { followAction } : {})
  };
  return { actions: createActions(deps), leads: () => leads, visited, clicked, authorized, usage, state, saved, events, trace, historyTargets, logs, launches, focuses, statuses, stages, messages, navigationOptions, uiActions, checkpoint: () => checkpoint, plan, page };
}
test('本次主页响应已关注时跳过关注，仍进入目标对话、查历史后发送', async () => {
  const f = fixture({ profileRelation: { state: 'following', source: 'browser_profile_response', evidence: 'profile_follow_status_1' },
    verifier: async () => ({ state: 'confirmed_success', evidence: 'matching current send receipt' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.followCount, 0); assert.equal(result.dmCount, 1);
  assert.deepEqual(f.clicked, ['dm']); assert.equal(f.usage.followAttempts || 0, 0);
  assert.equal(f.leads()[0].followObserved.state, 'following');
  assert.deepEqual(f.trace, ['observeRelation', 'visit', 'observeHistory', 'openDm', 'conversation', 'checkHistory', 'fillDm', 'dm']);
});

test('网页确认历史已发时先记历史并按关闭重复规则跳过，不填写、不创建本次发送', async () => {
  const f = fixture({ dmHistory: { state: 'already_sent', source: 'browser_history_response', evidence: 'matched outgoing message', lastSentAt: null, complete: false } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.dmCount, 0); assert.equal(result.failedCount, 0);
  assert.deepEqual(f.clicked, ['follow']); assert.deepEqual(f.messages, []);
  assert.equal(f.usage.dmAttempts || 0, 0); assert.equal(f.leads()[0].dmState, undefined);
  assert.equal(f.leads()[0].dmHistorySentObserved.state, 'already_sent');
  assert.equal(f.leads()[0].dmCount, undefined);
  assert(f.trace.indexOf('conversation') < f.trace.indexOf('checkHistory'));
});

test('网页历史未知按用户规则首发，不提示或保存未知历史标记', async () => {
  const f = fixture({ dmHistory: { state: 'unknown', reason: '无法取得完整历史' } });
  await f.actions.outreachTask('1', { planId: 'plan' });
  assert.deepEqual(f.clicked, ['follow', 'dm']);
  assert.equal(f.saved.some(item => item.kind === 'dmObservation'), false);
  assert.equal(f.leads()[0].dmHistoryObserved, undefined);
  assert.doesNotMatch(f.logs.join('\n'), /无法取得完整历史|历史待核验/);
  assert(f.trace.indexOf('checkHistory') < f.trace.indexOf('fillDm'));
});

test('迟到历史在填写后或发送授权后到达时跳过点击，不创建发送次数或待核验', async () => {
  for (const phase of ['filled', 'send-authorized']) {
    const f = fixture({ lateDmHistory: ({ events, authorized }) => {
      const arrived = phase === 'filled' ? events.some(e => e.kind === 'fillDm') : authorized.filter(e => e.kind === 'dm').length >= 2;
      return arrived ? { state: 'already_sent', source: 'im-history-cmd301', evidence: 'matched prior outbound', lastSentAt: null, complete: false } : { state: 'unknown' };
    } });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, true, phase); assert.equal(result.dmCount, 0); assert.equal(result.failedCount, 0);
    assert.deepEqual(f.clicked, ['follow']); assert.equal(f.messages.length, 1);
    assert.equal(f.usage.dmAttempts || 0, 0); assert.equal(f.leads()[0].dmAttemptId, undefined);
    assert.equal(f.leads()[0].dmHistorySentObserved.state, 'already_sent');
    assert.equal(f.leads()[0].dmState, undefined);
    assert.equal(f.saved.filter(item => item.kind === 'dmObservation').length, 1);
  }
});

test('迟到历史若已开启重复且有可靠过期时间仍可发送，重复检查不重复写入', async () => {
  const observation = { state: 'already_sent', source: 'im-history-cmd301', evidence: 'matched prior outbound', lastSentAt: Date.now() - 10 * 86400000, complete: true };
  const f = fixture({ repeat: { enabled: true, intervalDays: 7 }, lateDmHistory: ({ events }) => events.some(e => e.kind === 'fillDm') ? observation : { state: 'unknown' },
    verifier: async () => ({ state: 'confirmed_success', evidence: 'matching current send receipt' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.dmCount, 1); assert.deepEqual(f.clicked, ['follow', 'dm']);
  assert.equal(f.saved.filter(item => item.kind === 'dmObservation').length, 1);
});

test('迟到历史复核期间停止任务，不写发送次数或继续点击', async () => {
  const f = fixture({ lateDmHistory: ({ state, events }) => {
    if (events.some(e => e.kind === 'fillDm')) state.stopRequested = true;
    return { state: 'unknown' };
  } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.deepEqual(f.clicked, ['follow']); assert.equal(f.usage.dmAttempts || 0, 0);
});

test('网页已发历史只有开启重复并已过可靠最近时间间隔才继续', async () => {
  for (const [lastSentAt, shouldSend] of [[Date.now() - 10 * 86400000, true], [Date.now() - 1000, false], [null, false]]) {
    const f = fixture({ repeat: { enabled: true, intervalDays: 7 },
      dmHistory: { state: 'already_sent', lastSentAt, complete: lastSentAt !== null, source: 'browser_history_response', evidence: 'matched outgoing message' },
      verifier: async () => ({ state: 'confirmed_success', evidence: 'matching current send receipt' }) });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, true); assert.equal(result.dmCount, Number(shouldSend));
    assert.equal(f.messages.length, Number(shouldSend)); assert.equal(f.usage.dmAttempts || 0, Number(shouldSend));
  }
});

test('历史检查期间重复规则改变或用户停止均不能继续填写发送', async () => {
  for (const type of ['rule', 'stop']) {
    const f = fixture({ dmHistory: ({ settings, state }) => {
      if (type === 'rule') settings.dm.repeat.enabled = true;
      else state.stopRequested = true;
      return { state: 'unknown' };
    } });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, false); assert.deepEqual(f.clicked, ['follow']); assert.deepEqual(f.messages, []);
    assert.equal(f.usage.dmAttempts || 0, 0);
  }
});

test('本次关注响应未知时按目标主页按钮判断已关注，并保存当前账号关系', async () => {
  const f = fixture({ followOutcome: 'already' });
  await f.actions.outreachTask('1', { planId: 'plan' });
  assert.deepEqual(f.clicked, ['dm']); assert.equal(f.leads()[0].followObserved.source, 'profile_control');
  assert.equal(f.leads()[0].followObserved.accountId, '1'); assert.equal(f.usage.follow || 0, 0);
});

test('主页响应补全数字UID后历史及本次发送使用最新同目标资料', async () => {
  const f = fixture({ mutateAfterVisit: leads => { for (const lead of leads) { lead.UID = '123456789'; lead.aiInputHash = W.aiInputHash(lead); } } });
  await f.actions.outreachTask('1', { planId: 'plan' });
  assert.deepEqual(f.historyTargets, ['123456789']); assert.deepEqual(f.clicked, ['follow', 'dm']);
});

test('同次私信人工核验后迟到协议成功或未知不能二次计数或覆盖人工结论', async () => {
  for (const manualOutcome of ['success', 'failed']) for (const receiptState of ['confirmed_success', 'pending_verification']) {
    const f = fixture({ verifier: async (_args, { leads, usage }) => {
      const lead = leads[0]; lead.dmState = lead.dmOutcome = manualOutcome === 'success' ? 'confirmed_success' : 'confirmed_failure';
      lead.verificationHistory = [{ kind: 'dm', attemptId: lead.dmAttemptId, outcome: manualOutcome }];
      if (manualOutcome === 'success') { lead.dmCount = 1; lead.dmLastAt = '2026-10-08 12:00:00'; usage.dm = 1; }
      return { state: receiptState, evidence: receiptState === 'confirmed_success' ? 'current receipt' : '' };
    } });
    await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(f.usage.dmAttempts, 1); assert.equal(f.usage.dm || 0, Number(manualOutcome === 'success'));
    assert.equal(f.leads()[0].dmCount || 0, Number(manualOutcome === 'success'));
    assert.equal(f.leads()[0].dmState, manualOutcome === 'success' ? 'confirmed_success' : 'confirmed_failure');
    assert(f.statuses.some(status => status.includes('私信保留已有核验结果')));
    assert(!f.statuses.some(status => status.includes('平台已确认接受本次私信')));
  }
});

test('同次关注人工核验成功后迟到未知回执不覆盖或重复计数', async () => {
  const f = fixture({ followReceipt: 'none', followClickHook: ({ leads, usage }) => {
    setTimeout(() => {
      const lead = leads[0]; lead.followState = lead.followOutcome = 'confirmed_success';
      lead.followedAt = '2026-10-08 12:00:00'; usage.follow = 1;
      lead.verificationHistory = [{ kind: 'follow', attemptId: lead.followAttemptId, outcome: 'success' }];
    }, 0);
  } });
  await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(f.usage.followAttempts, 1); assert.equal(f.usage.follow, 1);
  assert.equal(f.leads()[0].followState, 'confirmed_success');
  assert.equal(f.leads()[0].followObserved.source, 'existing_verification');
  assert(f.statuses.some(status => status.includes('关注保留已有核验结果')));
});

test('FOLLOW_ALREADY 回滚前保留同次人工成功和失败终态，不删除尝试或重复计数', async () => {
  for (const outcome of ['success', 'failed']) {
    let attemptId;
    const f = fixture({ followClickHook: ({ leads, usage }) => {
      const lead = leads[0]; attemptId = lead.followAttemptId;
      lead.followState = lead.followOutcome = outcome === 'success' ? 'confirmed_success' : 'confirmed_failure';
      lead.followEvidence = 'manual verification';
      lead.verificationHistory = [{ kind: 'follow', attemptId, outcome }];
      if (outcome === 'success') { lead.followedAt = '2026-10-08 12:00:00'; usage.follow = 1; }
      throw Object.assign(new Error('主页已显示关注关系'), { code: 'FOLLOW_ALREADY', actionNotStarted: true });
    } });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, true);
    assert.equal(f.leads()[0].followState, outcome === 'success' ? 'confirmed_success' : 'confirmed_failure');
    assert.equal(f.leads()[0].followAttemptId, attemptId); assert.equal(f.leads()[0].followEvidence, 'manual verification');
    assert.equal(f.usage.followAttempts || 0, 0); assert.equal(f.usage.follow || 0, Number(outcome === 'success'));
    assert(!f.clicked.includes('follow')); assert.equal(result.followCount, Number(outcome === 'success'));
    assert.equal(result.failedCount, Number(outcome === 'failed'));
    assert(f.statuses.some(status => status.includes('关注保留已有核验结果')));
  }
});

test('FOLLOW_ALREADY 的过期尝试不得恢复旧快照或继续后续私信', async () => {
  const f = fixture({ followClickHook: ({ leads }) => {
    Object.assign(leads[0], { followAttemptId: 'newer-attempt', followState: 'pending_verification', followEvidence: 'newer evidence' });
    throw Object.assign(new Error('主页已显示关注关系'), { code: 'FOLLOW_ALREADY', actionNotStarted: true });
  } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.match(result.error, /操作记录已改变/);
  assert.equal(f.leads()[0].followAttemptId, 'newer-attempt');
  assert.equal(f.leads()[0].followState, 'pending_verification'); assert.equal(f.leads()[0].followEvidence, 'newer evidence');
  assert.deepEqual(f.clicked, []); assert.equal(f.usage.follow || 0, 0); assert.equal(f.usage.followAttempts || 0, 0);
});

test('发送适配器确认未点击时仍返回已有人工终态，不误报失败或平台回执', async () => {
  for (const outcome of ['success', 'failed']) {
    let f;
    f = fixture({ sendOutcome: false, beforeAdapterUiAction: (phase, { leads }) => {
      if (phase !== 'send') return;
      const lead = leads[0]; lead.dmState = lead.dmOutcome = outcome === 'success' ? 'confirmed_success' : 'confirmed_failure';
      lead.verificationHistory = [{ kind: 'dm', attemptId: lead.dmAttemptId, outcome }];
      if (outcome === 'success') { lead.dmCount = 1; lead.dmLastAt = '2026-10-08 12:00:00'; f.usage.dm = 1; }
    } });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, true); assert.equal(result.dmCount, Number(outcome === 'success'));
    assert.equal(result.failedCount, Number(outcome === 'failed'));
    assert.equal(f.leads()[0].dmCount || 0, Number(outcome === 'success'));
    assert.equal(f.leads()[0].dmState, outcome === 'success' ? 'confirmed_success' : 'confirmed_failure');
    assert.equal(f.usage.dm || 0, Number(outcome === 'success')); assert.equal(f.usage.dmAttempts || 0, 0);
    assert.deepEqual(f.clicked, ['follow']);
    assert(f.statuses.some(status => status.includes('私信保留已有核验结果')));
    assert(!f.statuses.some(status => status.includes('平台已确认接受本次私信')));
  }
});

test('主页导航传递停止信号，每次跳转独立授权且不重新消耗用户间隔', async () => {
  const controller = new AbortController();
  const f = fixture({ count: 2, actionIntervalSec: 10, signal: controller.signal });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(f.navigationOptions.length, 2);
  assert.ok(f.navigationOptions.every(options => options.signal === controller.signal));
  assert.deepEqual(f.authorized.filter(meta => meta.kind === 'profile_redirect').map(meta => [meta.accountId, meta.uid]), [['1', 'user1'], ['1', 'user2']]);
  const visits = f.events.filter(event => event.kind === 'visit');
  assert.equal(visits[1].time - visits[0].time, 10000);
  const denied = fixture({ revokeAt: 'profile_redirect' });
  assert.equal((await denied.actions.outreachTask('1', { planId: 'plan' })).ok, false);
  assert.deepEqual(denied.visited, []); assert.deepEqual(denied.clicked, []);
  const stopped = fixture({ signal: controller.signal, navigateProfilePage: async (page, url, options, state) => {
    assert.equal(options.signal, controller.signal); state.stopRequested = true; controller.abort(); options.checkStopped();
  } });
  assert.equal((await stopped.actions.outreachTask('1', { planId: 'plan' })).ok, false);
  assert.deepEqual(stopped.visited, []); assert.deepEqual(stopped.clicked, []);
});
test('按用户同一次访问完成关注和私信，未知回执待核验不计成功', async () => {
  const f = fixture(); const r = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(r.ok, true); assert.equal(f.visited.length, 1); assert.deepEqual(f.clicked, ['follow', 'dm']);
  assert.equal(r.pendingCount, 1); assert.equal(f.usage.dm || 0, 0);
  assert.equal(f.leads()[0].dmState, 'pending_verification'); assert.equal(f.leads()[0].dmAttemptAccountId, '1');
  assert.ok(f.saved.some(s => s.kind === 'dm' && s.lead.dmState === 'pending_verification'));
  const again = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(again.followCount, 1); assert.equal(f.clicked.filter(x => x === 'dm').length, 1);
});
test('IM主域候选只记安全网络诊断，保留待核验且不把HTTP200交给成功验证器', async () => {
  let verifiedEvents, bodyReads = 0;
  const f = fixture({ onSend: ({ page, frame }) => {
    const request = { url: () => 'https://imapi.douyin.com/v1/message/send/?token=private-token&uid=private-uid',
      method: () => 'POST', frame: () => frame,
      headers: () => ({ 'content-type': 'application/x-protobuf; token=private-header', cookie: 'private-cookie' }),
      postData: () => { bodyReads++; return 'private-message-body'; } };
    page.emit('request', request);
    page.emit('response', { request: () => request, url: request.url, status: () => 200,
      headers: () => ({ 'content-type': 'application/json; token=private-header', 'set-cookie': 'private-cookie' }),
      body: async () => { bodyReads++; return Buffer.from('private-response-body'); } });
  }, verifier: async ({ events }) => { verifiedEvents = [...events]; return { state: 'pending_verification', reason: 'unknown receipt' }; } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.pendingCount, 1); assert.equal(result.dmCount, 0);
  assert.equal(f.leads()[0].dmState, 'pending_verification'); assert.equal(f.usage.dm || 0, 0);
  assert.equal(f.usage.dmAttempts, 1); assert.deepEqual(verifiedEvents, []); assert.equal(bodyReads, 0);
  const logs = f.logs.filter(log => log.startsWith('私信网络观察（仅诊断，不代表发送成功）：'));
  assert.equal(logs.length, 1);
  const metadata = JSON.parse(logs[0].split('：')[1]);
  assert.equal(metadata.length, 1); assert.equal(metadata[0].origin, 'https://imapi.douyin.com');
  assert.equal(metadata[0].phase, 'response'); assert.equal(metadata[0].status, 200);
  assert.equal(metadata[0].contentType, 'application/x-protobuf'); assert.equal(metadata[0].responseContentType, 'application/json');
  assert.equal(metadata[0].scope, 'transport_metadata'); assert.equal(metadata[0].protocolEvaluation, 'not_performed');
  assert.equal(metadata[0].targetMatched, undefined); assert.equal(metadata[0].unsupportedProtocol, undefined);
  assert.doesNotMatch(f.logs.join('\n'), /private-token|private-uid|private-header|private-cookie|private-message-body|private-response-body/);
  for (const event of ['request', 'response', 'requestfailed', 'close']) assert.equal(f.page.listenerCount(event), 0);
});
test('关注明确网络回执才成功，缺失/错目标/未知schema待核验且同页私信继续、不自动重试', async () => {
  for (const followReceipt of ['none', 'wrong-target', 'unknown-schema']) {
    const f = fixture({ followReceipt, verifier: async () => ({ state: 'confirmed_success', evidence: 'mock matching DM receipt' }) });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, true); assert.equal(result.followCount, 0); assert.equal(result.pendingCount, 1); assert.equal(result.dmCount, 1);
    assert.deepEqual(f.clicked, ['follow', 'dm']); assert.equal(f.usage.follow || 0, 0);
    assert.equal(f.leads()[0].followState, 'pending_verification'); assert.ok(f.leads()[0].followAttemptId);
    const again = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(again.skipped, 1); assert.deepEqual(f.clicked, ['follow', 'dm']);
    for (const event of ['request', 'response', 'close']) assert.equal(f.page.listenerCount(event), 0);
  }
});
test('DOM显示已关注只保护性跳过，不计成功、不扣尝试、不新增待核验；点击连接异常保留待核验', async () => {
  const f = fixture({ followOutcome: 'already', followReceipt: 'none', verifier: async () => ({ state: 'confirmed_success', evidence: 'mock DM receipt' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.followCount, 0); assert.equal(result.pendingCount, 0); assert.equal(result.skipped, 1); assert.deepEqual(f.clicked, ['dm']);
  assert.equal(f.leads()[0].followedAt, undefined); assert.equal(f.leads()[0].followState, undefined); assert.equal(f.usage.followAttempts || 0, 0);
  const g = fixture({ followThrows: true, followReceipt: 'none' });
  const uncertain = await g.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(uncertain.failedCount, 0); assert.equal(uncertain.pendingCount, 1);
  assert.equal(g.leads()[0].followState, 'pending_verification');
  const again = await g.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(g.clicked.filter(kind => kind === 'follow').length, 1); assert.equal(again.followCount, 0);
});
test('关注入口缺失或适配器明确未点击时确认失败，不扣尝试、不留下待核验锁', async () => {
  for (const followOutcome of ['missing', 'not-clicked']) {
    const f = fixture({ followOutcome, followReceipt: 'none', initialLead: lead => { lead.dmCount = 1; } });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, true); assert.equal(result.failedCount, 1); assert.equal(result.pendingCount, 0);
    assert.deepEqual(f.clicked, []); assert.equal(f.usage.followAttempts || 0, 0);
    assert.equal(f.leads()[0].followState, 'confirmed_failure');
    assert.equal(W.eligibility(f.leads()[0], 'follow', f.leads(), {
      ai: { prompt: '需求规则' }, follow: { enabled: true }, dm: {}, outreach: { businessId: 'default' }
    }).ok, true, 'explicitly unclicked follow may be prechecked again');
  }
});
test('发送控件缺失或明确未点击时不扣私信尝试，也不保存待核验锁', async () => {
  for (const options of [{ sendMissing: true }, { sendOutcome: false }]) {
    const f = fixture(options);
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, true); assert.equal(result.failedCount, 1); assert.equal(result.pendingCount, 0);
    assert.deepEqual(f.clicked, ['follow']); assert.equal(f.usage.dmAttempts || 0, 0);
    assert.equal(f.leads()[0].dmState, 'confirmed_failure');
  }
});
test('第二目标关注控件明确未点击时记录真实失败，重新健康及授权检查后仍执行独立私信', async () => {
  for (const code of ['FOLLOW_CONTROL_AMBIGUOUS', 'FOLLOW_CONTROL_UNAVAILABLE', 'FOLLOW_CONTROL_CHANGED']) {
    let unclicked = false, authorizationsAtFailure = 0, healthAfterFailure = 0;
    const f = fixture({ count: 2, verifier: async () => ({ state: 'confirmed_success', evidence: 'matching mock DM receipt' }),
      followClickHook: ({ lead, authorized }) => {
        if (lead.uid !== 'user2') return;
        unclicked = true; authorizationsAtFailure = authorized.length;
        throw Object.assign(new Error('关注入口变化，本次没有点击'), { code, actionNotStarted: true });
      },
      health: () => { if (unclicked) healthAfterFailure++; return 'ok'; }
    });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, true); assert.equal(result.followCount, 1); assert.equal(result.dmCount, 2);
    assert.equal(result.failedCount, 1); assert.equal(result.pendingCount, 0);
    assert.deepEqual(f.clicked, ['follow', 'dm', 'dm']); assert.equal(f.visited.length, 2);
    assert.equal(f.usage.followAttempts, 1); assert.equal(f.usage.dmAttempts, 2);
    assert.equal(f.state.attempts, 5, 'two visits, one follow and two sends; unclicked follow is not an action');
    assert.equal(f.leads()[1].followState, 'confirmed_failure'); assert.match(f.leads()[1].followFailedReason, new RegExp(code));
    assert.equal(f.leads()[1].followedAt, undefined); assert.ok(healthAfterFailure > 0);
    assert.equal(f.authorized[authorizationsAtFailure].kind, 'ui'); assert.equal(f.authorized[authorizationsAtFailure].uid, 'user2');
    assert.equal(f.checkpoint().state, 'completed');
    for (const event of ['request', 'response', 'close']) assert.equal(f.page.listenerCount(event), 0);
  }
});

test('准备后发现已关注会完整恢复原关注快照，不新增成功、待核验或尝试', async () => {
  const priorRecords = [{}, { followState: 'confirmed_failure', followOutcome: 'confirmed_failure', followFailedReason: 'prior failure',
    followAttemptId: 'prior-attempt', followAttemptAt: '2026-10-01 09:00:00', followAttemptAccountId: '1', followEvidence: 'prior evidence' }];
  for (const prior of priorRecords) {
    const f = fixture({ initialLead: lead => Object.assign(lead, prior),
      followClickHook: () => { throw Object.assign(new Error('已关注，本次未点击'), { code: 'FOLLOW_ALREADY', actionNotStarted: true }); },
      verifier: async () => ({ state: 'confirmed_success', evidence: 'matching mock DM receipt' })
    });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    const actual = Object.fromEntries(Object.entries(f.leads()[0]).filter(([field]) => field.startsWith('follow')));
    assert.deepEqual(actual, prior); assert.deepEqual(f.clicked, ['dm']);
    assert.equal(result.followCount, 0); assert.equal(result.pendingCount, 0); assert.equal(result.failedCount, 0);
    assert.equal(result.skipped, 1); assert.equal(result.dmCount, 1); assert.equal(f.usage.followAttempts || 0, 0);
    assert.equal(f.state.attempts, 2, 'only the visit and DM are counted');
    assert.equal(f.usage.follow || 0, 0);
  }
});

test('准备期间出现另一尝试的已确认关注时保留新记录并暂停旧尝试', async () => {
  const confirmed = { followState: 'confirmed_success', followOutcome: 'confirmed_success', followedAt: '2026-10-08 09:00:00',
    followAttemptId: 'confirmed-history', followAttemptAt: '2026-10-08 08:59:59', followAttemptAccountId: '1', followEvidence: 'confirmed receipt', followFailedReason: '' };
  const f = fixture({ followClickHook: ({ leads }) => {
    Object.assign(leads[0], confirmed);
    throw Object.assign(new Error('已关注，本次未点击'), { code: 'FOLLOW_ALREADY', actionNotStarted: true });
  } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.deepEqual(Object.fromEntries(Object.keys(confirmed).map(field => [field, f.leads()[0][field]])), confirmed);
  assert.equal(result.followCount, 0); assert.equal(f.usage.followAttempts || 0, 0); assert.equal(f.usage.follow || 0, 0);
  assert.equal(result.ok, false); assert.match(result.error, /操作记录已改变/);
  assert.deepEqual(f.clicked, []);
});

test('明确未点击关注后的新授权失败、登录失效及停止仍暂停且不打开私信', async () => {
  for (const barrier of ['authorization', 'login', 'stop']) {
    let failed = false;
    const f = fixture({ count: 2,
      followClickHook: ({ state }) => {
        failed = true; if (barrier === 'stop') state.stopRequested = true;
        throw Object.assign(new Error('关注入口已改变'), { code: 'FOLLOW_CONTROL_CHANGED', actionNotStarted: true });
      },
      authorizeHook: () => !(failed && barrier === 'authorization'),
      health: () => failed && barrier === 'login' ? 'login' : 'ok'
    });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, false); assert.equal(f.checkpoint().state, 'paused'); assert.equal(f.visited.length, 1);
    assert.deepEqual(f.clicked, []); assert.equal(f.events.some(event => event.kind === 'openDm'), false);
    assert.equal(f.usage.followAttempts || 0, 0); assert.equal(f.usage.dmAttempts || 0, 0);
    assert.equal(f.leads()[0].followState, 'confirmed_failure');
  }
});

test('未点击标记不吞目标、会话、授权、停止或未知异常，非白名单不会继续同用户私信', async () => {
  for (const code of ['TARGET_MISMATCH', 'SESSION_CHANGED', 'AUTH_REQUIRED', 'LOGIN_REQUIRED', 'TASK_STOPPED', 'DM_RECIPIENT_MISMATCH', 'FOLLOW_PREPARATION_CONSUMED', 'UNKNOWN_PRECLICK']) {
    const f = fixture({ followClickHook: () => { throw Object.assign(new Error(code), { code, actionNotStarted: true }); } });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.deepEqual(f.clicked, []); assert.equal(f.events.some(event => event.kind === 'openDm'), false);
    assert.equal(f.usage.followAttempts || 0, 0); assert.equal(f.leads()[0].followState, 'confirmed_failure');
    if (['FOLLOW_PREPARATION_CONSUMED', 'UNKNOWN_PRECLICK'].includes(code)) {
      assert.equal(f.state.errors[0].error, code); assert.equal(result.failedCount, 1);
    } else { assert.equal(result.ok, false); assert.equal(f.checkpoint().state, 'paused'); }
  }
  const uncertain = fixture({ followClickHook: () => { throw Object.assign(new Error('no unclicked proof'), { code: 'FOLLOW_CONTROL_CHANGED' }); } });
  const result = await uncertain.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.pendingCount, 1); assert.equal(uncertain.leads()[0].followState, 'pending_verification');
  assert.equal(uncertain.usage.followAttempts, 1); assert.equal(uncertain.events.some(event => event.kind === 'openDm'), false);
});

test('准备后目标变化且适配器确认没有开始点击时，失败无额度或待核验，并暂停名单', async () => {
  for (const action of ['follow', 'dm']) {
    const f = fixture({ count: 2, ...(action === 'follow' ? { followPreflightError: true } : { sendPreflightError: true }) });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, false); assert.match(result.error, /目标.*已改变/);
    assert.equal(f.visited.length, 1); assert.equal(f.usage[action + 'Attempts'] || 0, 0);
    assert.equal(f.leads()[0][action + 'State'], 'confirmed_failure');
    assert.deepEqual(f.clicked, action === 'follow' ? [] : ['follow']);
    assert.equal(f.checkpoint().state, 'paused');
    assert.equal(f.page.listenerCount('request'), 0); assert.equal(f.page.listenerCount('response'), 0);
  }
});
test('正常点击但回执未知的四位用户保持待核验，不误当连续账号异常暂停', async () => {
  const f = fixture({ count: 4, followReceipt: 'none' });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(f.visited.length, 4); assert.equal(result.pendingCount, 8);
  assert.equal(result.failedCount, 0); assert.equal(f.usage.followAttempts, 4); assert.equal(f.usage.dmAttempts, 4);
  assert.equal(f.checkpoint().state, 'completed');
  const again = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(again.skipped, 4); assert.equal(f.clicked.length, 8, 'uncertain previous actions are not replayed');
  assert.ok(f.logs.some(log => /上次关注待核验/.test(log)), 'skipped fixed-list users have a visible reason');
});
test('现有不可见启动浏览器也走可见launch入口，固定名单不直接复用getAlive', async () => {
  const f = fixture();
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.deepEqual(f.launches, [{ accountId: '1', headless: false }]);
  assert.equal(f.focuses.length, 1); assert.equal(f.authorized[0].kind, 'ui');
  assert.equal(f.events[0].time, f.focuses[0].time, 'local foreground focus does not start a browser cooldown');
  assert.ok(f.statuses.some(status => /可见浏览器/.test(status)));
  assert.ok(f.logs.some(log => /正在打开.*主页/.test(log)));
  assert.ok(f.logs.some(log => /正在填写私信/.test(log)));
  assert.ok(f.logs.some(log => /回执尚未确认/.test(log)));
});
test('本地浏览器聚焦也逐步授权并检查停止，拒绝或聚焦中停止后不会访问主页', async () => {
  const denied = fixture({ authorizeHook: meta => meta.kind !== 'ui' });
  const deniedResult = await denied.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(deniedResult.ok, false); assert.equal(denied.focuses.length, 0); assert.deepEqual(denied.visited, []);
  assert.equal(denied.state.attempts || 0, 0);
  const stopped = fixture({ onFocus: state => { state.stopRequested = true; } });
  const stoppedResult = await stopped.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(stoppedResult.ok, false); assert.equal(stopped.focuses.length, 1); assert.deepEqual(stopped.visited, []);
  assert.equal(stopped.state.attempts || 0, 0); assert.equal(stopped.checkpoint().state, 'paused');
});
test('本地填写后的停止立即阻止发送，不扣发送尝试，且准备不计外部动作', async () => {
  const f = fixture();
  const evaluate = f.page.evaluate;
  f.page.evaluate = async (callback, argument) => {
    const value = await evaluate(callback, argument);
    if (callback === browserActions.fillDirectMessage) f.state.stopRequested = true;
    return value;
  };
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.deepEqual(f.clicked, ['follow']);
  assert.equal(f.usage.dmAttempts || 0, 0); assert.equal(f.state.attempts, 2);
  assert.equal(f.leads()[0].dmState, 'confirmed_failure'); assert.equal(f.checkpoint().state, 'paused');
});
test('本地填写后授权撤销，准备发送也拒绝继续，不会点击发送', async () => {
  const f = fixture({ authorizeHook: (meta, { events }) => events.some(event => event.kind === 'fillDm') ? { ok: false, error: '授权已撤销' } : true });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.match(result.error, /授权已撤销/);
  assert.deepEqual(f.clicked, ['follow']); assert.equal(f.usage.dmAttempts || 0, 0);
  assert.equal(f.leads()[0].dmState, 'confirmed_failure'); assert.equal(f.checkpoint().state, 'paused');
});
test('有可信回执才确认成功计数，写入前已持久化待核验', async () => {
  const f = fixture({ verifier: async () => ({ state: 'confirmed_success', evidence: 'mock matching attempt receipt' }) });
  const r = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(r.dmCount, 1); assert.equal(f.usage.dm, 1); assert.equal(f.leads()[0].dmCount, 1);
  const states = f.saved.filter(s => s.kind === 'dm').map(s => s.lead.dmState);
  assert.deepEqual(states, ['pending_verification', 'confirmed_success']);
});
test('发送时连接异常保留待核验且下次不重发', async () => {
  const f = fixture({ sendThrows: true });
  await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(f.leads()[0].dmState, 'pending_verification');
  await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(f.clicked.filter(x => x === 'dm').length, 1);
});
test('名单生成后新增拒绝联系在访问后仍阻止点击', async () => {
  const f = fixture({ mutateAfterVisit: rows => { rows[0].doNotContact = true; } });
  await f.actions.outreachTask('1', { planId: 'plan' });
  assert.deepEqual(f.clicked, []);
});
test('授权发送前失效停止且没有发送动作', async () => {
  const f = fixture({ revokeAt: 'dm' });
  const r = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(r.ok, false); assert.ok(!f.clicked.includes('dm')); assert.equal(f.checkpoint().state, 'paused');
});
test('连续三个用户私信入口异常暂停，不永久noDm，也不处理第四个', async () => {
  const f = fixture({ count: 4, missingDm: true });
  const r = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(r.ok, false); assert.equal(f.visited.length, 3);
  assert.ok(f.leads().every(l => !l.noDm));
});

test('三个服务端拒绝均落库后再暂停，进度3/4，第三条不退回待核验', async () => {
  const f = fixture({ count: 4, profileRelation: { state: 'following' }, verifier: async () => ({ state: 'confirmed_failure', reason: '消息检查未通过', evidence: 'matched server rejection' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.equal(result.failedCount, 3); assert.equal(result.pendingCount, 0);
  assert.equal(f.state.done, 3); assert.equal(f.visited.length, 3); assert.equal(f.usage.dmAttempts, 3);
  assert.match(result.error, /消息检查未通过/);
  for (const lead of f.leads().slice(0, 3)) {
    assert.equal(lead.dmState, 'confirmed_failure'); assert.equal(lead.dmEvidence, 'matched server rejection');
  }
  assert.equal(f.leads()[3].dmState, undefined);
});

test('已匹配的拒绝回执即使随后页面要求验证码，也保持失败终态', async () => {
  let rejected = false;
  const f = fixture({ verifier: async () => { rejected = true; return { state: 'confirmed_failure', reason: '平台拒绝', evidence: 'matched rejection' }; },
    health: () => rejected ? 'verification' : 'ok' });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.match(result.error, /验证/);
  assert.equal(f.leads()[0].dmState, 'confirmed_failure'); assert.equal(f.leads()[0].dmEvidence, 'matched rejection');
});

test('四位用户明确互关限制只计各自失败，通用拒绝保护不被关闭', async () => {
  const f = fixture({ count: 4, profileRelation: { state: 'following' },
    dmFeedback: { state: 'ready', restriction: { code: 'DM_RECIPIENT_MUTUAL_ONLY', reason: '对方仅允许互关用户私信', evidence: 'matched-chat+platform-recipient-notice' } },
    verifier: async () => ({ state: 'confirmed_failure', reason: '消息检查未通过', evidence: 'matched server rejection' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.failedCount, 4); assert.equal(f.state.done, 4); assert.deepEqual(result.processedLeadIds, ['1', '2', '3', '4']);
  assert(f.leads().every(lead => lead.dmState === 'confirmed_failure' && lead.dmFailedReason.includes('DM_RECIPIENT_MUTUAL_ONLY') && !lead.noDm));
});

test('本次回执账号频繁或当日上限立即暂停，只保存第一位失败且不再访问后续用户', async () => {
  for (const code of ['DM_ACCOUNT_FREQUENT', 'DM_ACCOUNT_DAILY_LIMIT']) {
    const f = fixture({ count: 4, profileRelation: { state: 'following' },
      verifier: async () => ({ state: 'confirmed_failure', failureScope: 'account', failureCode: code, reason: '[' + code + '] 平台限制', evidence: 'matched current request rejection' }) });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, false); assert.equal(result.failedCount, 1); assert.equal(result.pendingCount, 0);
    assert.equal(f.visited.length, 1); assert.deepEqual(f.clicked, ['dm']); assert.equal(f.usage.dmAttempts, 1);
    assert.equal(f.leads()[0].dmState, 'confirmed_failure'); assert.equal(f.leads()[0].dmCount || 0, 0);
    assert.equal(f.leads()[1].dmState, undefined); assert.equal(f.checkpoint().state, 'paused');
    // 分发据此回池：触发账号限制的那位用户不算已处理，后续用户也未处理
    assert.deepEqual(result.processedLeadIds, []); assert.equal(result.pausedLeadId, '1');
  }
});

test('发送后只有DOM账号限制时暂停但保留待核验，不能误判失败释放重发', async () => {
  const f = fixture({ count: 4, profileRelation: { state: 'following' },
    dmFeedback: { state: 'ready', restriction: { failureScope: 'account', code: 'DM_ACCOUNT_DAILY_LIMIT', reason: '今日陌生人私信已达上限', evidence: 'matched-chat+platform-account-notice' } } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.equal(result.pendingCount, 1); assert.equal(result.failedCount, 0);
  assert.equal(f.visited.length, 1); assert.deepEqual(f.clicked, ['dm']);
  assert.equal(f.leads()[0].dmState, 'pending_verification'); assert.equal(f.leads()[0].dmEvidence, '');
  assert.match(f.leads()[0].dmFailedReason, /DM_ACCOUNT_DAILY_LIMIT/);
  assert.equal(f.checkpoint().state, 'paused'); assert.equal(f.leads()[1].dmState, undefined);
});

test('嵌套7180真实响应形状贯穿发送观察、状态保存与暂停，不执行第二位且检查点不沿用AI名单计数', async () => {
  const { makeSendRequest, makeSendResponse, data } = require('./helpers/im-fixture');
  const check = JSON.stringify({ status_code: 7180, tips: '', status_msg: { msg_type: 1,
    msg_content: { tips: '给陌生人发送消息过于频繁，请稍后再发送陌生人消息', template: [] } }, raw_check_code: 2 });
  const f = fixture({ count: 3, profileRelation: { state: 'following' }, initialLead: (lead, i) => { lead.UID = String(700000000000000002n + BigInt(i)); },
    verifier: async ({ receipt }) => receipt.getOutcome(),
    onSend: ({ page, frame }) => {
      const request = { url: () => 'https://imapi.douyin.com/v1/message/send', method: () => 'POST', frame: () => frame,
        headers: () => ({ 'content-type': 'application/x-protobuf' }), postDataBuffer: () => makeSendRequest({ message: '你好' }) };
      page.emit('request', request);
      page.emit('response', { request: () => request, url: request.url, status: () => 200,
        headers: () => ({ 'content-type': 'application/x-protobuf' }),
        body: async () => makeSendResponse({ status: 3, serverMessageId: null, extraSend: data(6, check) }) });
    } });
  Object.assign(f.checkpoint(), { leadIds: ['old-ai-lead'], counts: { yes: 1557, no: 3666 } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.match(result.error, /私信操作频繁/);
  assert.equal(f.visited.length, 1); assert.deepEqual(f.clicked, ['dm']); assert.equal(f.usage.dmAttempts, 1);
  assert.equal(result.failedCount, 1); assert.equal(result.pendingCount, 0); assert.equal(result.dmCount, 0);
  assert.equal(f.leads()[0].dmState, 'confirmed_failure'); assert.match(f.leads()[0].dmFailedReason, /DM_ACCOUNT_FREQUENT/);
  assert.equal(f.leads()[0].noDm, undefined); assert.equal(f.leads()[1].dmState, undefined);
  assert.deepEqual(f.checkpoint().leadIds, ['1', '2', '3']); assert.equal(f.checkpoint().counts.failedCount, 1);
  assert.equal(f.checkpoint().counts.yes, undefined); assert.equal(f.checkpoint().state, 'paused');
  assert.deepEqual(f.checkpoint().processedLeadIds, ['1']); assert.equal(f.checkpoint().currentLeadId, null);
});

test('填写前目标聊天已显示账号限制则暂停，不输入不发送，不创建虚假失败记录', async () => {
  const f = fixture({ count: 3, profileRelation: { state: 'following' },
    domHistory: { state: 'ready', history: { state: 'unknown' }, restriction: { failureScope: 'account', code: 'DM_ACCOUNT_FREQUENT', reason: '操作频繁', evidence: 'matched-chat+platform-account-notice' } } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.equal(f.visited.length, 1); assert.deepEqual(f.clicked, []); assert.deepEqual(f.messages, []);
  assert.equal(f.usage.dmAttempts || 0, 0); assert.equal(f.leads()[0].dmState, undefined);
  assert.equal(f.checkpoint().state, 'paused');
});

test('目标聊天DOM发现旧消息立即跳过，保留旧失败详情且不伪造本次成功次数', async () => {
  const f = fixture({ initialLead: lead => Object.assign(lead, { dmState: 'confirmed_failure', dmOutcome: 'confirmed_failure', dmFailedReason: '旧失败', dmCount: 0 }),
    domHistory: { state: 'ready', history: { state: 'already_sent', complete: false, lastSentAt: null, source: 'browser_chat_dom', evidence: 'verified old outgoing' } } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.failedCount, 0); assert.equal(result.dmCount, 0);
  assert(!f.trace.includes('fillDm')); assert(!f.trace.includes('checkHistory'), 'positive DOM need not wait for absent response');
  assert.equal(f.leads()[0].dmHistorySentObserved.state, 'already_sent'); assert.equal(f.leads()[0].dmCount, 0);
  assert.equal(f.leads()[0].dmFailedReason, '旧失败');
});

test('失败重试取得本次成功回执后清空旧失败，保存成功和计数', async () => {
  const f = fixture({ initialLead: lead => Object.assign(lead, { dmState: 'confirmed_failure', dmOutcome: 'confirmed_failure', dmFailedReason: '旧失败', dmEvidence: 'old rejection', dmAttemptId: 'old', dmCount: 0 }),
    verifier: async () => ({ state: 'confirmed_success', evidence: 'current request accepted' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.dmCount, 1); assert.equal(result.failedCount, 0);
  assert.equal(f.leads()[0].dmState, 'confirmed_success'); assert.equal(f.leads()[0].dmOutcome, 'confirmed_success');
  assert.equal(f.leads()[0].dmFailedReason, ''); assert.equal(f.leads()[0].dmCount, 1);
  assert.notEqual(f.leads()[0].dmAttemptId, 'old');
});

test('回执明确重复发送不累计异常也不冒充发送成功，继续下一用户', async () => {
  const f = fixture({ count: 4, profileRelation: { state: 'following' },
    verifier: async () => ({ state: 'confirmed_failure', reason: '[DM_DUPLICATE_MESSAGE] 平台提示重复消息', evidence: 'matched check_message', failureScope: 'recipient' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.failedCount, 4); assert.equal(f.state.done, 4);
  assert.equal(result.dmCount, 0); assert.equal(f.state.consecutiveErrors, 0);
  assert.equal(f.usage.dmAttempts, 4); assert.equal(f.usage.dm || 0, 0);
});

test('填字期间才加载的DOM旧消息在最终发送前拦截，不点击也不写待核验', async () => {
  const f = fixture({ domHistory: ({ messages }) => messages.length ? { state: 'ready', history: { state: 'already_sent', complete: false, lastSentAt: null, source: 'browser_chat_dom', evidence: 'late verified old outgoing' } } : null });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(f.messages.length, 1);
  assert.equal(f.clicked.includes('dm'), false); assert.equal(f.usage.dmAttempts || 0, 0);
  assert.equal(f.leads()[0].dmState, undefined); assert.equal(f.leads()[0].dmHistorySentObserved.state, 'already_sent');
});
test('验证和目标身份变更会立即停止', async () => {
  const f = fixture({ health: 'verification' });
  const r = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(r.ok, false); assert.deepEqual(f.clicked, []);
  const g = fixture(); g.plan.leads[0].uid = 'changed';
  const q = await g.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(q.ok, false); assert.equal(g.visited.length, 0);
});
test('账户级每日额度提示暂停当前固定名单，不能继续点击或访问下一用户', async () => {
  const f = fixture({ count: 2, health: 'daily_limit' });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.match(result.error, /今日关注或私信次数已达上限/);
  assert.equal(f.visited.length, 1); assert.deepEqual(f.clicked, []);
  assert.equal(f.checkpoint().state, 'paused'); assert.equal(f.state.running, false);
});
test('执行不会因额度恢复而扩大预检查冻结的每用户操作', async () => {
  const f = fixture(); f.plan.leads[0].actions = { follow: false, dm: true };
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.deepEqual(f.clicked, ['dm']); assert.equal(f.visited.length, 1);
  assert.equal(f.usage.followAttempts || 0, 0);
});
test('执行最新额度仅可收窄组合任务，主页预算耗尽立即停止', async () => {
  const f = fixture(); f.plan.leads[0].actions = { follow: true, dm: true }; f.usage.dmAttempts = 20;
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.deepEqual(f.clicked, ['follow']); assert.equal(f.visited.length, 1);
  const g = fixture(); g.usage.profileVisits = 40;
  const stopped = await g.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(stopped.ok, false); assert.equal(g.visited.length, 0); assert.deepEqual(g.clicked, []);
});
test('同一用户连续完成关注私信，仅下一个用户主页前等待一次', async () => {
  const f = fixture({ count: 2, actionIntervalSec: 10, verifier: async () => ({ state: 'confirmed_success', evidence: 'mock receipt for this attempt' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.skipped, 0);
  assert.equal(result.followCount, 2); assert.equal(result.dmCount, 2);
  assert.deepEqual(f.clicked, ['follow', 'dm', 'follow', 'dm']);
  assert.deepEqual(f.events.map(e => `${e.user}:${e.kind}`), ['user1:visit', 'user1:follow', 'user1:openDm', 'user1:fillDm', 'user1:dm', 'user2:visit', 'user2:follow', 'user2:openDm', 'user2:fillDm', 'user2:dm']);
  for (let i = 1; i < f.events.length; i++) {
    if (f.events[i].kind === 'visit') assert.equal(f.events[i].time - f.events[i - 1].time, 10000, 'one user boundary only');
    else assert.equal(f.events[i].time, f.events[i - 1].time, 'same-user controls have no configured delay');
  }
  assert.equal(f.usage.profileVisits, 2); assert.equal(f.usage.followAttempts, 2); assert.equal(f.usage.dmAttempts, 2);
  assert.equal(f.state.attempts, 6);
  assert.equal(f.state.stage, 'user_done'); assert.equal(f.state.currentUserIndex, 2); assert.equal(f.state.totalUsers, 2);
  for (const stage of ['opening_profile', 'following', 'opening_dm', 'filling_dm', 'sending_dm', 'verifying_dm', 'user_done']) assert(f.stages.includes(stage));
});
test('已私信未关注的用户只关注，不打开会话；下一用户仍统一等待后关注私信', async () => {
  const f = fixture({ count: 2, actionIntervalSec: 10,
    initialLead: (lead, index) => { if (!index) { lead.dmCount = 1; lead.dmState = 'confirmed_success'; lead.dmLastAt = '2026-10-07 12:00:00'; } },
    verifier: async () => ({ state: 'confirmed_success', evidence: 'mock receipt for this attempt' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.skipped, 0); assert.equal(result.followCount, 2); assert.equal(result.dmCount, 1);
  assert.deepEqual(f.events.map(e => `${e.user}:${e.kind}`), ['user1:visit', 'user1:follow', 'user2:visit', 'user2:follow', 'user2:openDm', 'user2:fillDm', 'user2:dm']);
  for (let i = 1; i < f.events.length; i++) {
    if (f.events[i].kind === 'visit') assert.equal(f.events[i].time - f.events[i - 1].time, 10000);
    else assert.equal(f.events[i].time, f.events[i - 1].time);
  }
  assert.equal(f.leads()[0].dmCount, 1); assert.equal(f.usage.dmAttempts, 1); assert.equal(f.state.attempts, 5);
});
test('用户切换间隔内可停止，当前用户完成后不会进入下一个主页', async () => {
  const f = fixture({ count: 2, actionIntervalSec: 10, waitHook: ({ state, events }) => { if (events.some(e => e.kind === 'follow')) state.stopRequested = true; } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.match(result.error, /停止/);
  assert.deepEqual(f.events.map(e => e.kind), ['visit', 'follow', 'openDm', 'fillDm', 'dm']);
  assert.equal(f.usage.followAttempts, 1); assert.equal(f.usage.dmAttempts, 1);
  assert.equal(f.checkpoint().state, 'paused'); assert.equal(f.state.running, false);
});
test('旧的操作间隔和定期休息配置不再插入用户内流程', async () => {
  const f = fixture({ count: 2, actionIntervalSec: 2, human: { breakEvery: 2, breakMinSec: 20, breakMaxSec: 20 }, verifier: async () => ({ state: 'confirmed_success', evidence: 'mock receipt' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.skipped, 0); assert.equal(f.visited.length, 2);
  assert.equal(f.events[2].time, f.events[1].time, 'no old rest after visit and follow');
  assert.equal(f.events[3].time, f.events[2].time, 'typing does not add an action or a rest');
  assert.equal(f.events[5].time - f.events[4].time, 2000, 'only configured user boundary');
  assert.equal(f.state.attempts, 6);
});
test('旧的工作时段不再拆开同一用户的关注私信流程', async () => {
  const start = Date.parse('2026-10-08T02:00:00Z');
  const f = fixture({ count: 2, actionIntervalSec: 20,
    human: { workPeriods: [{ start: '10:00', end: '10:01' }, { start: '10:02', end: '10:05' }] },
    verifier: async () => ({ state: 'confirmed_success', evidence: 'mock receipt' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.skipped, 0); assert.equal(f.visited.length, 2);
  assert.ok(f.events.find(e => e.user === 'user1' && e.kind === 'openDm').time < start + 60000);
  assert.equal(f.events.find(e => e.user === 'user1' && e.kind === 'fillDm').time, f.events.find(e => e.user === 'user1' && e.kind === 'openDm').time);
  assert.equal(f.events.find(e => e.user === 'user1' && e.kind === 'dm').time, start);
  assert.ok(f.events.find(e => e.user === 'user2' && e.kind === 'visit').time > f.events.find(e => e.user === 'user1' && e.kind === 'dm').time);
  assert.deepEqual(f.clicked, ['follow', 'dm', 'follow', 'dm']);
});

test('预检查冻结的逐用户消息优先于运行时重新渲染', async () => {
  const f = fixture({ initialLead: lead => { lead.aiDone = false; lead.aiNeed = ''; lead.manualApproved = true; }, mutateAfterVisit: rows => { rows[0].nickname = '运行期间修改'; } });
  f.plan.leads[0].messagePreview = '预检查确认的消息';
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.deepEqual(f.messages, ['预检查确认的消息']);
});

test('未找到私信输入框记录可区分诊断，但不记录任意页面内容、不点击发送', async () => {
  const f = fixture({ editorMissing: true, diagnostic: { code: 'DM_EDITOR_CONTEXT_UNCONFIRMED', visibleEditorCount: 1,
    conversationEditorCount: 0, message: 'private diagnostic payload', url: 'https://private.example/' } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.failedCount, 1); assert.equal(f.usage.dmAttempts || 0, 0);
  assert.match(f.leads()[0].dmFailedReason, /DM_EDITOR_CONTEXT_UNCONFIRMED/);
  assert.equal(f.leads()[0].dmState, 'confirmed_failure');
  assert(f.logs.some(item => item.includes('visibleEditorCount')));
  assert.doesNotMatch(f.logs.join('\n'), /private diagnostic payload|private\.example/);
});

test('私信入口各类未点击原因分别落库，保留关注成功且无私信次数或永久禁发结论', async () => {
  for (const [code, phrase] of [['DM_ENTRY_NOT_FOUND', '没有可识别'], ['DM_ENTRY_AMBIGUOUS', '多个候选'],
    ['DM_ENTRY_CHANGED', '重绘或改变'], ['DM_ENTRY_UNAVAILABLE', '当前不可操作'], ['DM_ENTRY_CLICK_BLOCKED', '浮层遮挡或点击超时']]) {
    const f = fixture({ missingDm: true, diagnostic: { code, visibleControlCount: 7, profileControlCount: 2,
      targetConversationRowCount: -1, message: 'private-diagnostic-body', selector: '#private-selector', uid: 'private-uid' } });
    const result = await f.actions.outreachTask('1', { planId: 'plan' }), lead = f.leads()[0];
    assert.equal(result.followCount, 1); assert.equal(result.failedCount, 1); assert.equal(result.pendingCount, 0);
    assert.equal(lead.followState, 'confirmed_success'); assert.equal(lead.dmState, 'confirmed_failure'); assert.equal(lead.dmOutcome, 'confirmed_failure');
    assert.match(lead.dmFailedReason, new RegExp(code)); assert.match(lead.dmFailedReason, new RegExp(phrase)); assert.match(lead.dmFailedReason, /本次没有发送/);
    assert.equal(lead.dmEvidence, '未执行发送动作'); assert.equal(lead.dmAttemptId, undefined); assert.equal(lead.dmCount || 0, 0);
    assert.equal(f.usage.dmAttempts || 0, 0); assert.equal(f.usage.dm || 0, 0); assert.equal(!!lead.noDm, false); assert.deepEqual(f.clicked, ['follow']);
    assert.equal(f.messages.length, 0);
    const diagnostic = JSON.parse(f.logs.find(item => item.startsWith('私信界面检查：')).slice('私信界面检查：'.length));
    assert.deepEqual(diagnostic, { stage: 'entry', code, visibleControlCount: 7, profileControlCount: 2 });
    assert.doesNotMatch(f.logs.join('\n'), /private-diagnostic-body|private-selector|private-uid/);
  }
  const unknown = fixture({ missingDm: true, diagnostic: { code: 'private-unknown-code' } });
  await unknown.actions.outreachTask('1', { planId: 'plan' });
  assert.match(unknown.leads()[0].dmFailedReason, /DM_ENTRY_UNAVAILABLE/);
  assert.doesNotMatch(unknown.logs.join('\n'), /private-unknown-code|DM_ENTRY_NOT_FOUND/);
});

test('仅消息列表、目标会话未就绪和身份未确认有独立阶段诊断，未发送不计尝试', async () => {
  for (const [code, phrase, paused] of [['DM_MESSAGE_LIST_ONLY', '仅显示消息列表', false],
    // 接收人未确认是用户级：本用户失败、继续下一位，不再整任务暂停（修复指南 6.3）
    ['DM_TARGET_CHAT_NOT_READY', '目标会话尚未就绪', false], ['DM_RECIPIENT_UNCONFIRMED', '会话接收人身份', false]]) {
    const f = fixture({ editorMissing: true, diagnostic: { code, messageListCount: 1, targetConversationRowCount: 0,
      visibleEditorCount: 1, eligibleEditorCount: 1, conversationEditorCount: 0, iframeCount: 0, body: 'private-chat-body' } });
    const result = await f.actions.outreachTask('1', { planId: 'plan' }), lead = f.leads()[0];
    assert.equal(result.ok, !paused); assert.equal(f.checkpoint().state, paused ? 'paused' : 'completed');
    assert.equal(lead.dmState, 'confirmed_failure'); assert.equal(lead.dmOutcome, 'confirmed_failure');
    assert.match(lead.dmFailedReason, new RegExp(code)); assert.match(lead.dmFailedReason, new RegExp(phrase));
    assert.match(lead.dmEvidence, /没有执行发送动作/); assert.equal(lead.dmAttemptId, undefined);
    assert.equal(lead.dmCount || 0, 0); assert.equal(f.usage.dmAttempts || 0, 0); assert.equal(f.usage.dm || 0, 0);
    assert.deepEqual(f.clicked, ['follow']); assert.equal(f.uiActions.some(action => action.phase === 'fill' || action.phase === 'send'), false);
    const diagnostic = JSON.parse(f.logs.find(item => item.startsWith('私信界面检查：')).slice('私信界面检查：'.length));
    assert.equal(diagnostic.stage, 'conversation'); assert.equal(diagnostic.code, code); assert.equal(diagnostic.messageListCount, 1);
    assert.doesNotMatch(f.logs.join('\n'), /private-chat-body/);
  }
});

test('发送准备失败记录发送控件阶段，不混淆为入口不存在', async () => {
  const f = fixture({ sendMissing: true, diagnostic: { code: 'DM_SEND_DISABLED', conversationEditorCount: 1 } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.failedCount, 1); assert.equal(f.leads()[0].dmState, 'confirmed_failure');
  assert.match(f.leads()[0].dmFailedReason, /DM_SEND_DISABLED.*发送控件仍不可用/);
  assert(f.logs.some(item => item.includes('"stage":"send"'))); assert.equal(f.usage.dmAttempts || 0, 0); assert.deepEqual(f.clicked, ['follow']);
});

test('身份依据诊断只允许固定类型枚举，不输出昵称UID头像或任意页面内容', async () => {
  for (const recipientEvidence of ['explicit_uid', 'dom_profile_name', 'unconfirmed', 'private-evidence-value', { type: 'dom_profile_name' }]) {
    const f = fixture({ editorMissing: true, diagnostic: { code: 'DM_TARGET_CHAT_NOT_READY', recipientEvidence, conversationRowEvidence: recipientEvidence, profileIdentityChanged: 1,
      chatNameCount: 1, chatAvatarCount: 1, chatNameMatches: 0, chatAvatarMatches: 1,
      nickname: 'private-nickname', uid: 'private-uid', avatar: 'https://private-avatar.example/asset', profileIdentity: { name: 'private-identity' } } });
    await f.actions.outreachTask('1', { planId: 'plan' });
    const logged = JSON.parse(f.logs.find(item => item.startsWith('私信界面检查：')).slice('私信界面检查：'.length));
    assert.equal(logged.recipientEvidence, ['explicit_uid', 'dom_profile_name'].includes(recipientEvidence) ? recipientEvidence : undefined);
    assert.equal(logged.conversationRowEvidence, ['explicit_uid', 'dom_profile_name', 'unconfirmed'].includes(recipientEvidence) ? recipientEvidence : undefined);
    assert.equal(logged.profileIdentityChanged, 1);
    assert.equal(logged.chatNameCount, 1); assert.equal(logged.chatAvatarCount, 1);
    assert.equal(logged.chatNameMatches, 0); assert.equal(logged.chatAvatarMatches, 1);
    assert.doesNotMatch(f.logs.join('\n'), /private-nickname|private-uid|private-avatar|private-identity|private-evidence-value/);
    assert.equal(f.leads()[0].dmState, 'confirmed_failure'); assert.equal(f.usage.dmAttempts || 0, 0); assert.deepEqual(f.clicked, ['follow']);
  }
});

test('每次适配器UI操作前授权或停止拒绝均阻止该操作，预写待核验不误计发送或关注尝试', async () => {
  for (const phase of ['follow', 'open', 'conversation', 'fill', 'send']) {
    for (const barrier of ['authorization', 'stop']) {
      let denied = false;
      const f = fixture({ count: 2, selectConversation: true,
        beforeAdapterUiAction: (current, { state }) => { if (current === phase) { denied = true; if (barrier === 'stop') state.stopRequested = true; } },
        authorizeHook: () => denied && barrier === 'authorization' ? { ok: false, error: '授权已撤销' } : true });
      const result = await f.actions.outreachTask('1', { planId: 'plan' });
      assert.equal(result.ok, false, phase + '/' + barrier); assert.equal(f.checkpoint().state, 'paused'); assert.equal(f.visited.length, 1);
      assert.equal(f.uiActions.some(action => action.phase === phase), false); assert.equal(f.usage.dmAttempts || 0, 0); assert.equal(f.usage.dm || 0, 0);
      assert.deepEqual(f.clicked, phase === 'follow' ? [] : ['follow']);
      assert.equal(f.leads()[0][phase === 'follow' ? 'followState' : 'dmState'], phase === 'send' ? undefined : 'confirmed_failure', phase + '/' + barrier + ' 点击前账户级中断应回滚预写待核验');
      assert.equal(f.usage.followAttempts || 0, phase === 'follow' ? 0 : 1);
      if (phase === 'send') assert.deepEqual(f.saved.filter(item => item.kind === 'dm').map(item => item.lead.dmState), ['pending_verification', undefined]);
    }
  }
});

test('适配器点击前授权只检查授权停止，已预写pending不会自阻断也不重复计数', async () => {
  const pending = {};
  const f = fixture({ selectConversation: true, beforeAdapterUiAction: (phase, { leads }) => {
    if (phase === 'follow' || phase === 'send') pending[phase] = leads[0][phase === 'follow' ? 'followState' : 'dmState'];
  }, verifier: async () => ({ state: 'confirmed_success', evidence: 'matching synthetic receipt' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.deepEqual(pending, { follow: 'pending_verification', send: 'pending_verification' });
  assert.deepEqual(f.uiActions.map(item => item.phase), ['follow', 'open', 'conversation', 'fill', 'send']);
  for (const item of f.uiActions) assert.deepEqual(item.authorization, { accountId: '1', kind: 'ui', uid: 'user1' });
  assert.equal(result.followCount, 1); assert.equal(result.dmCount, 1); assert.equal(f.usage.followAttempts, 1); assert.equal(f.usage.dmAttempts, 1);
  assert.equal(f.usage.follow, 1); assert.equal(f.usage.dm, 1); assert.equal(f.state.attempts, 3);
});

test('主页未就绪时按状态等待，就绪后立即继续，不再固定停留1.5秒', async () => {
  const f = fixture(), original = f.page.evaluate; let inspected = 0;
  f.page.evaluate = async (fn, arg) => fn === browserActions.readPageHealth && inspected++ < 3 ? 'empty' : original(fn, arg);
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true);
  assert.equal(f.events.find(e => e.kind === 'follow').time - f.events[0].time, 300);
});

test('主页就绪等待中停止，不点击关注或私信', async () => {
  const f = fixture(); let inspected = 0;
  f.page.evaluate = async () => { if (++inspected === 2) f.state.stopRequested = true; return 'empty'; };
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, false); assert.match(result.error, /停止/); assert.deepEqual(f.clicked, []);
});

test('跨账号分发：执行账号可处理其他采集账号的线索', async () => {
  const f = fixture({ crossAccount: true, leadAccountId: '2', planActions: { follow: false, dm: true },
    verifier: async () => ({ state: 'confirmed_success', evidence: 'matching current send receipt' }) });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true);
  assert.equal(result.dmCount, 1);
  assert.deepEqual(f.clicked, ['dm']);
});

test('单账号任务仍拒绝执行其他账号的线索', async () => {
  const f = fixture({ leadAccountId: '2', planActions: { follow: false, dm: true } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 1);
  assert.deepEqual(f.clicked, []);
});

test('错误分级：接收人未确认、会话/输入框变化降为用户级继续下一位；接收人明确不一致仍立即暂停', async () => {
  for (const code of ['DM_RECIPIENT_UNCONFIRMED', 'DM_COMPOSER_CHANGED', 'DM_PREVIOUS_CONVERSATION_UNCONFIRMED', 'DM_RECIPIENT_MISMATCH']) {
    const f = fixture({ count: 2, editorMissing: true, diagnostic: { code } });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    const paused = code === 'DM_RECIPIENT_MISMATCH';
    assert.equal(result.ok, !paused, code);
    assert.equal(f.visited.length, paused ? 1 : 2, code + (paused ? ' 立即暂停' : ' 继续下一位'));
    assert.equal(f.checkpoint().state, paused ? 'paused' : 'completed');
    assert.match(f.leads()[0].dmFailedReason, new RegExp(code));
    assert.equal(f.usage.dmAttempts || 0, 0);
    if (!paused) { assert.equal(result.failedCount, 2); assert.deepEqual(result.processedLeadIds, ['1', '2']); }
  }
});

test('私信强制休息计数按账号持久化：新任务接着上次计数，到点后强制休息并写回', async () => {
  const success = async () => ({ state: 'confirmed_success', evidence: 'matching current send receipt' });
  // 上次（另一批）已连续成功 4 条：本批第 1 条成功即达到默认 5 条，第 2 条前必须休息
  const saved = { value: { '1': { opDay: '2026-10-08', dmSession: { count: 4, pauseUntil: 0, opDay: '2026-10-08' } } } };
  const f = fixture({ count: 2, dmAccountState: saved, profileRelation: { state: 'following' }, verifier: success });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.dmCount, 2);
  assert.ok(f.stages.includes('waiting_dm_session'), '沿用上次计数，第 2 条前强制休息');
  assert.equal(saved.value['1'].dmSession.count, 1, '休息后重新计数并写回');
  assert.ok(saved.value['1'].dmSession.pauseUntil > 0);
  assert.equal(saved.value['1'].opDay, '2026-10-08', '账号条目的其他字段保留');
  // 新任务读入未到期的休息截止时间：第一条私信前就要等
  const until = Date.parse('2026-10-08T02:00:00Z') + 3600 * 1000;
  const pending = { value: { '1': { dmSession: { count: 0, pauseUntil: until, opDay: '2026-10-08' } } } };
  const g = fixture({ dmAccountState: pending, profileRelation: { state: 'following' }, verifier: success });
  await g.actions.outreachTask('1', { planId: 'plan' });
  assert.ok(g.stages.includes('waiting_dm_session'), '上一批设置的休息跨批次生效');
  // 跨运营日：旧计数清零，不会因为昨天的条数立即休息
  const stale = { value: { '1': { dmSession: { count: 4, pauseUntil: 0, opDay: '2026-10-07' } } } };
  const h = fixture({ count: 2, dmAccountState: stale, profileRelation: { state: 'following' }, verifier: success });
  await h.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(h.stages.includes('waiting_dm_session'), false);
  assert.equal(stale.value['1'].dmSession.count, 2);
});

test('入口点击被遮挡：失败原因带说明，遮挡元素写进诊断日志并截断', async () => {
  const blocker = 'DIV|' + 'x'.repeat(200) + '|login-mask';
  const f = fixture({ missingDm: true, diagnostic: { code: 'DM_ENTRY_CLICK_BLOCKED', entryBlocker: blocker } });
  const result = await f.actions.outreachTask('1', { planId: 'plan' });
  assert.equal(result.ok, true); assert.equal(result.failedCount, 1);
  assert.match(f.leads()[0].dmFailedReason, /DM_ENTRY_CLICK_BLOCKED.*浮层遮挡或点击超时/);
  const diagnostic = JSON.parse(f.logs.find(item => item.startsWith('私信界面检查：')).slice('私信界面检查：'.length));
  assert.equal(diagnostic.code, 'DM_ENTRY_CLICK_BLOCKED');
  assert.equal(diagnostic.entryBlocker, blocker.slice(0, 120));
  assert.equal(f.usage.dmAttempts || 0, 0);
});


// 新关注实现（engine 注入 core/follow.js）：只认关注接口响应，结果按原字段落库
for (const [label, outcome, expected] of [
  ['接口确认成功', { state: 'confirmed_success', evidence: 'commit/follow/user status_code=0 follow_status=1' }, { followState: 'confirmed_success', followCount: 1, attempts: 1 }],
  ['私密账号已发出请求', { state: 'requested', reason: '对方为私密账号，已发出关注请求', evidence: 'follow_status=4' }, { followState: 'confirmed_success', followCount: 1, attempts: 1 }],
  ['主页已关注不点击', { state: 'already', reason: '主页按钮显示已关注' }, { followState: undefined, followCount: 0, attempts: 0 }],
  ['找不到按钮未点击', { state: 'not_clicked', reason: '主页没有可点击的关注按钮' }, { followState: 'confirmed_failure', followCount: 0, attempts: 0 }],
  ['点击后无回执', { state: 'pending_verification', reason: '点击后未收到关注接口回执' }, { followState: 'pending_verification', followCount: 0, attempts: 1 }]
]) {
  test('新关注实现：' + label + '，私信照常继续', async () => {
    const calls = [];
    const f = fixture({ followAction: async (page, target) => { calls.push(target); return outcome; },
      verifier: async () => ({ state: 'confirmed_success', evidence: 'matching current send receipt' }) });
    const result = await f.actions.outreachTask('1', { planId: 'plan' });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1); assert.equal(calls[0].secUid, f.leads()[0].uid);
    assert.equal(result.followCount, expected.followCount);
    assert.equal(f.leads()[0].followState, expected.followState);
    assert.equal(f.usage.followAttempts || 0, expected.attempts);
    assert.equal(result.dmCount, 1);
    assert.equal(f.clicked.includes('follow'), false); // 旧适配器的关注点击不再被调用
  });
}
