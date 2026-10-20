const crypto = require('crypto');
const workflow = require('./workflow');
const { TaskStopError } = require('./scheduler');
const { levelOf } = require('./lib/error-levels');
const browserActions = require('./lib/browser-actions');
const defaultBrowserActionAdapter = require('./lib/outreach-browser');
const { navigateCollectionPage: defaultNavigateProfilePage } = require('./lib/collection-browser');
const { createFollowReceiptObserver, createDmReceiptObserver } = require('./lib/action-receipts');
const { observeDmHistory: defaultObserveDmHistory } = require('./lib/dm-history-observer');
const { observeProfileRelation: defaultObserveProfileRelation } = require('./lib/profile-relation-observer');
const FOLLOW_FIELDS = ['followedAt', 'followFailedReason', 'followAttemptAt', 'followAttemptId', 'followAttemptAccountId', 'followState', 'followOutcome', 'followEvidence'];
const DM_ATTEMPT_FIELDS = ['dmFailedReason', 'dmState', 'dmOutcome', 'dmEvidence', 'dmAttemptAt', 'dmAttemptId', 'dmAttemptAccountId', 'dmMessageHash'];
// Only these adapter-owned, pre-click outcomes permit an independent DM.
const RECOVERABLE_FOLLOW_CODES = new Set(['FOLLOW_ALREADY', 'FOLLOW_CONTROL_AMBIGUOUS', 'FOLLOW_CONTROL_UNAVAILABLE', 'FOLLOW_CONTROL_CHANGED']);

async function assertPageHealth(page, accountId, uid) {
  if (page.isClosed()) throw new TaskStopError('账号窗口已关闭，请重新打开并检查登录', 'PAGE_CLOSED');
  const url = new URL(page.url());
  if (!/(^|\.)douyin\.com$/.test(url.hostname)) throw new TaskStopError('账号页面离开抖音，已暂停操作', 'PAGE_REDIRECT');
  if (uid && url.pathname !== `/user/${encodeURIComponent(String(uid))}`) throw new TaskStopError('主页目标与计划用户不一致，已暂停操作', 'TARGET_MISMATCH');
  const health = await page.evaluate(browserActions.readPageHealth);
  if (health === 'verification') throw new TaskStopError('平台要求验证，已暂停，请在账号窗口人工处理', 'PLATFORM_VERIFICATION');
  if (health === 'restricted') throw new TaskStopError('平台提示频繁操作或功能受限，已暂停', 'PLATFORM_RESTRICTED');
  if (health === 'daily_limit') throw new TaskStopError('平台提示今日关注或私信次数已达上限，已暂停，请人工确认后再执行', 'PLATFORM_DAILY_LIMIT');
  if (health === 'login') throw new TaskStopError('账号登录已失效，请重新登录后预检查', 'LOGIN_REQUIRED');
  if (health !== 'ok') throw Object.assign(new Error('页面未正常加载，请检查网络和页面后重试'), { code: 'PAGE_NOT_READY' });
}

function createActions(deps) {
  const checkPageHealth = deps.checkPageHealth || assertPageHealth;
  const { store, taskState, setTask, SLEEP, makeScheduler, launchAccount, saveLeadAction, resolvePlan, checkpoint, getHooks, getSignal } = deps;
  const actionAdapter = deps.browserActionAdapter || defaultBrowserActionAdapter;
  const navigateProfilePage = deps.navigateProfilePage || defaultNavigateProfilePage;
  const observeDmHistory = deps.observeDmHistory || defaultObserveDmHistory;
  const observeProfileRelation = deps.observeProfileRelation || defaultObserveProfileRelation;
  // 任务级/账号级错误升级为停止；用户级（含接收人未确认、会话/输入框变化）只记本用户失败，继续下一位
  const stopClassError = error => error instanceof TaskStopError || levelOf(error) === 'item'
    ? error : new TaskStopError(error.message, error.code);
  const latest = id => store.getLeads().find(l => String(l.id) === String(id));
  const can = (lead, kind, settings, accountId) => workflow.eligibility(latest(lead.id), kind, store.getLeads(), settings, Date.now(), store.getVideos(), accountId ? { accountId } : undefined);
  function quotaAvailable(accountId, kind, settings) {
    return workflow.getQuotas(settings, store.getDailyUsage(accountId))[kind].remaining > 0;
  }
  function bumpAttempt(accountId, kind) {
    const usage = store.getDailyUsage(accountId), field = kind + 'Attempts';
    if (usage[field] === undefined && Number(usage[kind]) > 0) {
      // 额度按运营日（默认 8 点切日）统计，迁移旧计数也必须写同一个桶。
      const daily = store.getDaily(), today = store.opDayStr();
      if (!daily[accountId]) daily[accountId] = {};
      if (!daily[accountId][today]) daily[accountId][today] = { ...usage };
      daily[accountId][today][field] = Number(usage[kind]);
      store.setDaily(daily);
    }
    store.bumpDaily(accountId, field);
  }
  function currentSettings(plan) {
    const settings = store.getSettings();
    if (workflow.settingsFingerprint(settings, plan.actions) !== plan.fingerprint) throw new TaskStopError('业务判断规则或话术已改变，已暂停，请重新预检查', 'PLAN_CHANGED');
    return settings;
  }
  // 私信强制休息（每成功 N 条休息一次）的计数与截止时间按账号存进 dm-account-state，
  // 多账号分发每批新建调度器、或重新启动任务后都接着算；跨运营日计数清零。
  function loadDmSession(accountId) {
    if (typeof store.getDmAccountState !== 'function') return null;
    const entry = (store.getDmAccountState() || {})[String(accountId)];
    const saved = entry && entry.dmSession;
    if (!saved || typeof saved !== 'object') return null;
    const today = typeof store.opDayStr === 'function' ? store.opDayStr() : '';
    return saved.opDay === today ? saved : { count: 0, pauseUntil: saved.pauseUntil };
  }
  function saveDmSession(accountId, scheduler) {
    if (typeof store.getDmAccountState !== 'function' || typeof store.setDmAccountState !== 'function' || typeof scheduler.dmSessionState !== 'function') return;
    const state = store.getDmAccountState() || {}, id = String(accountId);
    state[id] = { ...(state[id] || {}), dmSession: { ...scheduler.dmSessionState(), opDay: typeof store.opDayStr === 'function' ? store.opDayStr() : '' } };
    store.setDmAccountState(state);
  }
  function progress(accountId, lead, message, stage) {
    const name = String(lead && lead.nickname || '当前用户');
    setTask({ status: `${name}：${message}`, currentLead: { id: String(lead && lead.id || ''), nickname: name }, ...(stage ? { stage } : {}) });
    store.log(accountId, `触达步骤：${name}（${message}）`);
  }
  const readinessOptions = (scheduler, accountId, uid) => ({
    checkStopped: () => scheduler.checkStopped(),
    beforeUiAction: async () => {
      // This callback is immediately before an adapter-owned native click.
      // Do not re-run eligibility: follow/send may already be persisted pending.
      try { await scheduler.before({ accountId, kind: 'ui', uid }); }
      catch (error) { error.actionNotStarted = true; throw error; }
    }
  });
  function dmPreparationError(page, fallback, stage = 'conversation', prepared = {}) {
    const diagnostic = typeof actionAdapter.getDiagnostic === 'function' ? actionAdapter.getDiagnostic(page) : {};
    const messages = { DM_ENTRY_NOT_FOUND: '主页没有可识别的目标私信入口；这不代表用户永久禁止私信',
      DM_ENTRY_AMBIGUOUS: '主页存在多个候选私信入口，无法唯一确认目标',
      DM_ENTRY_CHANGED: '目标私信入口在点击前已重绘或改变，未执行入口点击',
      DM_ENTRY_UNAVAILABLE: '目标私信入口当前不可操作，未执行入口点击',
      DM_ENTRY_CLICK_BLOCKED: '私信入口被页面浮层遮挡或点击超时，未打开会话',
      DM_MESSAGE_LIST_ONLY: '目前仅显示消息列表，尚未打开名单用户的会话',
      DM_TARGET_CHAT_NOT_READY: '已打开消息界面，但名单用户的目标会话尚未就绪',
      DM_RECIPIENT_UNCONFIRMED: '网页会话响应未能核验接收人，且主页与当前聊天昵称不一致，不能确认会话接收人身份',
      DM_EDITOR_NOT_FOUND: '私信会话未出现可编辑的消息输入框',
      DM_EDITOR_CONTEXT_UNCONFIRMED: '发现输入框，但未确认它属于当前私信会话',
      DM_EDITOR_AMBIGUOUS: '私信会话存在多个输入框，无法唯一定位',
      DM_RECIPIENT_MISMATCH: '私信会话接收人与名单用户不一致',
      DM_PREVIOUS_CONVERSATION_UNCONFIRMED: '旧私信会话尚未确认切换到当前用户',
      DM_MESSAGE_CHANGED: '输入框未保留本次消息，或内容已经改变',
      DM_COMPOSER_CHANGED: '填写过程中私信会话或输入框发生变化',
      DM_SEND_AMBIGUOUS: '当前目标会话存在多个发送控件，无法唯一定位',
      DM_SEND_DISABLED: '当前目标会话的发送控件仍不可用',
      DM_SEND_NOT_FOUND: '当前目标会话未找到可操作的发送控件' };
    const candidate = prepared.code || diagnostic.code;
    const code = Object.hasOwn(messages, candidate) ? candidate
      : stage === 'entry' ? 'DM_ENTRY_UNAVAILABLE' : stage === 'send' ? 'DM_SEND_UNAVAILABLE' : 'DM_EDITOR_UNAVAILABLE';
    // Only adapter-owned codes, aggregate counts and an identity-evidence enum.
    // Never log names, selectors, IDs, avatar URLs, messages or response bodies.
    const counts = {};
    for (const key of ['visibleControlCount', 'profileControlCount', 'messageListCount', 'targetConversationRowCount', 'visibleEditorCount', 'eligibleEditorCount', 'conversationEditorCount', 'iframeCount', 'profileIdentityCaptured', 'profileInfoCount', 'profileNameCount', 'profileAvatarCount', 'profileAvatarMarkerCount', 'chatNameCount', 'chatAvatarCount']) {
      if (Number.isInteger(diagnostic[key]) && diagnostic[key] >= 0) counts[key] = diagnostic[key];
    }
    if (['protocol', 'explicit_uid', 'dom_profile_name'].includes(diagnostic.recipientEvidence)) counts.recipientEvidence = diagnostic.recipientEvidence;
    if (['confirmed', 'conflict', 'none'].includes(diagnostic.recipientProtocol)) counts.recipientProtocol = diagnostic.recipientProtocol;
    // 入口点击被遮挡时的遮挡元素（适配器只给 "tag|class前60字符|data-e2e"，不含用户文本），截断后写日志便于定位浮层
    if (typeof diagnostic.entryBlocker === 'string') counts.entryBlocker = diagnostic.entryBlocker.slice(0, 120);
    if (['explicit_uid', 'dom_profile_name', 'unconfirmed'].includes(diagnostic.conversationRowEvidence)) counts.conversationRowEvidence = diagnostic.conversationRowEvidence;
    if ([0, 1].includes(diagnostic.profileIdentityChanged)) counts.profileIdentityChanged = diagnostic.profileIdentityChanged;
    for (const key of ['chatNameMatches', 'chatAvatarMatches']) if ([0, 1].includes(diagnostic[key])) counts[key] = diagnostic[key];
    if (['captured', 'not_captured', 'profile_scope_missing', 'profile_scope_ambiguous', 'profile_name_missing', 'profile_name_ambiguous', 'profile_name_empty', 'profile_avatar_missing', 'profile_avatar_ambiguous', 'profile_avatar_invalid', 'profile_avatar_mismatch', 'profile_identity_changed'].includes(diagnostic.profileIdentityReason)) counts.profileIdentityReason = diagnostic.profileIdentityReason;
    return Object.assign(new Error(`[${code}] ${messages[code] || fallback}，本次没有发送`), { code, diagnostic: counts, stage, actionNotStarted: true });
  }
  function logDmPreparation(accountId, error) {
    store.log(accountId, `私信界面检查：${JSON.stringify({ stage: error.stage, code: error.code, ...error.diagnostic })}`);
  }
  function actionEligibility(lead, kind, accountId, settings) {
    const eligible = can(lead, kind, settings, accountId);
    if (!eligible.ok) return eligible;
    return quotaAvailable(accountId, kind, settings) ? eligible : { ok: false, reason: `今日${kind === 'follow' ? '关注' : '私信'}尝试额度已用完` };
  }
  function skipAction(accountId, lead, kind, reason) {
    progress(accountId, lead, `${kind === 'follow' ? '关注' : '私信'}已跳过：${reason}`);
    return { skipped: true, reason };
  }
  function saveObservation(accountId, lead, kind, observation) {
    // Unknown website history is intentionally silent (the user's first-send
    // policy). Observations never create an action success or consume a quota.
    if (!observation || observation.state === 'unknown') return;
    deps.saveContactObservation(lead.id, kind, { ...observation, accountId: String(accountId),
      checkedAt: store.nowStr(), checkedAtMs: Date.now() });
  }
  function settledAttempt(lead, kind, attemptId) {
    if (!attemptId) return null;
    const current = latest(lead.id);
    if (!current || current.uid !== lead.uid || current[kind + 'AttemptId'] !== attemptId) throw new TaskStopError('操作记录已改变，停止覆盖旧回执', 'ACTION_ATTEMPT_CHANGED');
    const state = current[kind + 'State'];
    const manual = (Array.isArray(current.verificationHistory) ? current.verificationHistory : []).some(row => row.kind === kind && row.attemptId === attemptId
      && row.outcome === (state === 'confirmed_success' ? 'success' : 'failed'));
    if (state !== 'confirmed_success' && !(state === 'confirmed_failure' && (manual || current[kind + 'Evidence']))) return null;
    return { state, evidence: current[kind + 'Evidence'] || '同次操作已有人工核验结论',
      reason: manual ? '本次操作已人工核验，保留现有结论' : current[kind + 'FailedReason'] || '', alreadySettled: true };
  }
  function saveFollowResult(lead, result, settings, attemptId) {
    const settled = settledAttempt(lead, 'follow', attemptId);
    if (settled) return settled;
    lead.followState = result.state; lead.followOutcome = result.state;
    lead.followEvidence = result.evidence || ''; lead.followFailedReason = result.reason || '';
    if (result.state === 'confirmed_success') { lead.followedAt = store.nowStr(); store.bumpDaily(lead.followAttemptAccountId || lead.accountId, 'follow'); }
    saveLeadAction(lead, 'follow', settings);
    return result;
  }
  async function showAccountBrowser(page, accountId, scheduler) {
    return scheduler.prepare({ accountId, kind: 'ui' }, async () => {
      scheduler.checkStopped();
      if (typeof page.bringToFront === 'function') await page.bringToFront();
      scheduler.checkStopped();
    });
  }
  async function visit(accountId, lead, page, scheduler) {
    let relation;
    try { return await scheduler.run({ accountId, kind: 'visit', uid: lead.uid }, async () => {
      const settings = store.getSettings();
      const profileQuota = workflow.getQuotas(settings, store.getDailyUsage(accountId)).profile;
      if (!profileQuota.remaining) throw new TaskStopError(`今日主页访问尝试已达上限（${profileQuota.limit}），已暂停`, 'PROFILE_QUOTA');
      progress(accountId, lead, '正在打开名单中的用户主页', 'opening_profile');
      store.bumpDaily(accountId, 'profileVisits');
      relation = observeProfileRelation({ page, targetSecUid: String(lead.uid), targetNumericUid: lead.UID, signal: getSignal() });
      await navigateProfilePage(page, lead.homepage, {
        signal: getSignal(),
        checkStopped: () => scheduler.checkStopped(),
        authorize: meta => scheduler.before({ ...meta, accountId, kind: 'profile_redirect', uid: lead.uid })
      });
      for (let attempt = 0; ; attempt++) {
        scheduler.checkStopped();
        try { await checkPageHealth(page, accountId, lead.uid); break; }
        catch (error) {
          // DOMContentLoaded may precede the passive account response. Wait
          // for explicit readiness, but never retry a confirmed logout,
          // verification request, platform restriction or manual stop.
          if (!['PAGE_NOT_READY', 'LOGIN_PENDING', 'LOGIN_UNCONFIRMED'].includes(error.code) || attempt >= 79) throw error;
        }
        await SLEEP(100);
      }
      progress(accountId, lead, '用户主页已加载，开始检查本次操作');
      const observed = await relation.wait({ timeoutMs: deps.historyTimeoutMs ?? 1500 });
      scheduler.checkStopped();
      await checkPageHealth(page, accountId, lead.uid);
      saveObservation(accountId, lead, 'follow', observed);
      return observed;
    }); } finally { if (relation) relation.dispose(); }
  }
  async function followOne(accountId, lead, page, scheduler, plan, relation) {
    const prepared = await scheduler.prepare({ accountId, kind: 'ui', uid: lead.uid }, async () => {
      const settings = currentSettings(plan), eligible = actionEligibility(lead, 'follow', accountId, settings);
      if (!eligible.ok) return skipAction(accountId, lead, 'follow', eligible.reason);
      await checkPageHealth(page, accountId, lead.uid);
      if (relation?.state === 'following') return skipAction(accountId, lead, 'follow', '本次主页响应确认当前账号已关注，继续处理私信');
      progress(accountId, lead, '正在定位目标用户的关注入口', 'following');
      return actionAdapter.prepareFollow(page, latest(lead.id), readinessOptions(scheduler, accountId, lead.uid));
    });
    if (prepared.skipped) return prepared;
    if (prepared.state === 'already') {
      saveObservation(accountId, lead, 'follow', { state: 'following', source: 'profile_control', evidence: '目标主页控件明确显示已关注或互相关注' });
      return skipAction(accountId, lead, 'follow', '当前主页已显示关注关系，本次未点击，继续处理私信');
    }
    if (prepared.state !== 'ready') {
      const settings = currentSettings(plan), reason = prepared.reason || '没有找到唯一可用的目标关注控件，本次未点击';
      saveFollowResult(latest(lead.id), { state: 'confirmed_failure', reason, evidence: '未执行关注点击' }, settings);
      progress(accountId, lead, `关注未执行：${reason}`);
      return { state: 'confirmed_failure', anomaly: true };
    }
    return scheduler.run({ accountId, kind: 'follow', uid: lead.uid }, async () => {
      const settings = currentSettings(plan);
      let eligible = actionEligibility(lead, 'follow', accountId, settings);
      if (!eligible.ok) return skipAction(accountId, lead, 'follow', eligible.reason);
      await checkPageHealth(page, accountId, lead.uid);
      await scheduler.before({ accountId, kind: 'follow', uid: lead.uid });
      eligible = actionEligibility(lead, 'follow', accountId, settings);
      if (!eligible.ok) return skipAction(accountId, lead, 'follow', eligible.reason);
      lead = latest(lead.id);
      const previousFollow = Object.fromEntries(FOLLOW_FIELDS.map(field => [field, lead[field]]));
      lead.followAttemptId = crypto.randomUUID();
      const attemptId = lead.followAttemptId;
      lead.followAttemptAt = store.nowStr(); lead.followAttemptAccountId = String(accountId);
      lead.followState = 'pending_verification'; lead.followOutcome = 'pending_verification';
      lead.followFailedReason = '关注操作准备执行，等待状态核验';
      saveLeadAction(lead, 'follow', settings);
      const receipt = createFollowReceiptObserver({ page, targetUid: String(lead.uid), targetSecUid: String(lead.uid), targetNumericUid: lead.UID, signal: getSignal(), timeoutMs: deps.receiptTimeoutMs });
      let clickStarted = false, attemptCounted = false, notClickedConfirmed = false, adapterClickError;
      try {
        progress(accountId, lead, '正在点击关注并等待本次回执');
        receipt.arm();
        clickStarted = true;
        let clicked;
        try { clicked = await prepared.click(); }
        catch (error) { adapterClickError = error; throw error; }
        let result;
        if (clicked) {
          bumpAttempt(accountId, 'follow'); attemptCounted = true;
          result = await receipt.wait();
        }
        else {
          notClickedConfirmed = true;
          receipt.dispose();
          result = { state: 'confirmed_failure', evidence: '关注适配器确认没有点击', reason: '关注控件不可用，本次没有点击，未占用关注尝试额度' };
        }
        scheduler.checkStopped();
        result = saveFollowResult(lead, result, settings, attemptId);
        if (result.state === 'confirmed_success') saveObservation(accountId, lead, 'follow', { state: 'following', source: result.alreadySettled ? 'existing_verification' : 'follow_receipt', evidence: result.evidence });
        progress(accountId, lead, result.alreadySettled ? `关注保留已有核验结果：${result.state === 'confirmed_success' ? '成功' : '失败'}`
          : result.state === 'confirmed_success' ? '关注已确认成功' : result.state === 'pending_verification' ? '关注已点击，回执尚未确认，保留待核验并继续本用户私信' : `关注未执行：${result.reason}`);
        await checkPageHealth(page, accountId, lead.uid);
        return { state: result.state, success: result.state === 'confirmed_success', anomaly: result.state === 'confirmed_failure' };
      } catch (error) {
        lead = latest(lead.id);
        if (error.actionNotStarted === true) notClickedConfirmed = true;
        if (clickStarted && !notClickedConfirmed && !attemptCounted) bumpAttempt(accountId, 'follow');
        const recoverable = error === adapterClickError && !(error instanceof TaskStopError) && error.actionNotStarted === true && RECOVERABLE_FOLLOW_CODES.has(error.code);
        let preservedResult;
        if (recoverable && error.code === 'FOLLOW_ALREADY') {
          // Undo this preparation only. A concurrent confirmed result belongs
          // to its own evidence and must never be replaced by the snapshot.
          if (!lead) throw new TaskStopError('操作记录已改变，停止覆盖旧回执', 'ACTION_ATTEMPT_CHANGED');
          preservedResult = settledAttempt(lead, 'follow', attemptId);
          if (!preservedResult) {
            Object.assign(lead, previousFollow);
            saveLeadAction(lead, 'follow', settings);
          }
        } else if (lead && lead.followState !== 'confirmed_success') {
          const state = clickStarted && !notClickedConfirmed ? 'pending_verification' : 'confirmed_failure';
          saveFollowResult(lead, { state, reason: recoverable ? `[${error.code}] ${error.message}` : error.message, evidence: state === 'confirmed_failure' ? '没有执行关注点击' : '' }, settings, attemptId);
        }
        if (recoverable) {
          receipt.dispose();
          // A local follow-control failure says nothing about login, target
          // identity or authorization. Recheck all three before continuing.
          await scheduler.prepare({ accountId, kind: 'ui', uid: lead.uid }, async () => {
            currentSettings(plan);
            await checkPageHealth(page, accountId, lead.uid);
            scheduler.checkStopped();
          });
          if (preservedResult) {
            progress(accountId, lead, `关注保留已有核验结果：${preservedResult.state === 'confirmed_success' ? '成功' : '失败'}`);
            return { ...preservedResult, success: preservedResult.state === 'confirmed_success', anomaly: preservedResult.state === 'confirmed_failure', skipped: true };
          }
          if (error.code === 'FOLLOW_ALREADY') return skipAction(accountId, lead, 'follow', '主页已显示关注关系，本次未点击，保留原有关注记录');
          progress(accountId, lead, `关注未执行：[${error.code}] ${error.message}`);
          // Scheduler uses skipped to avoid counting a physical action. The
          // explicit failure state still counts and displays the failed follow.
          return { state: 'confirmed_failure', anomaly: true, skipped: true };
        }
        throw error;
      } finally { receipt.dispose(); }
    });
  }
  function saveDmResult(lead, result, settings, attemptId) {
    const settled = settledAttempt(lead, 'dm', attemptId);
    if (settled) return settled;
    lead.dmState = result.state; lead.dmOutcome = result.state;
    lead.dmFailedReason = result.state === 'confirmed_success' ? '' : result.reason;
    lead.dmEvidence = result.evidence || '';
    if (result.state === 'confirmed_success') {
      const history = workflow.historyOf(lead, store.getLeads(), settings);
      lead.dmCount = Math.max(0, ...history.map(x => Number(x.dmCount) || 0)) + 1;
      lead.dmLastAt = store.nowStr(); lead.dmSentAt = lead.dmLastAt;
      store.bumpDaily(lead.dmAttemptAccountId || lead.accountId, 'dm');
    }
    saveLeadAction(lead, 'dm', settings);
    return result;
  }
  async function dmOne(accountId, lead, page, scheduler, plan) {
    // Profile responses can fill a missing numeric UID during the visit. Use
    // the fresh same-target record for both history and current-send matching.
    // 多账号分发是跨账号名单：执行账号与采集账号本来就不同，不能按 accountId
    // 拒绝；单账号任务仍要求线索属于当前账号。
    const crossAccount = plan && plan.crossAccount === true;
    const freshLead = latest(lead.id);
    if (!freshLead || String(freshLead.uid) !== String(lead.uid)
        || (!crossAccount && String(freshLead.accountId) !== String(accountId))) throw new TaskStopError('目标线索身份已改变，请重新预检查', 'PLAN_IDENTITY_CHANGED');
    lead = freshLead;
    let settings = currentSettings(plan), clickedSend = false, markedPending = false, notSentConfirmed = false, clickStarted = false, attemptCounted = false, activeAttemptId = '', previousDm;
    const receipt = createDmReceiptObserver({ page, targetUid: String(lead.uid), targetSecUid: String(lead.uid), targetNumericUid: lead.UID, signal: getSignal() });
    // Subscribe before opening the chat: the page may fetch history while its
    // drawer is mounting. No private API request is generated by this observer.
    const history = observeDmHistory({ page, targetSecUid: String(lead.uid), targetNumericUid: lead.UID, signal: getSignal() });
    // 会话接收人的协议核验：只把网页自身 IM 历史流量的归属结论（confirmed/conflict/none）交给适配器，
    // 适配器优先用它确认接收人，昵称比对作为后备。观察器在发送前冻结，冻结后的流量不再计入。
    const dmOptions = () => ({ ...readinessOptions(scheduler, accountId, lead.uid),
      ...(typeof history.getRecipientEvidence === 'function' ? { recipientProtocol: () => history.getRecipientEvidence() } : {}) });
    let recordedHistory = '';
    const recordHistory = observation => {
      if (!observation || observation.state === 'unknown') return;
      const fingerprint = JSON.stringify(observation);
      if (fingerprint === recordedHistory) return;
      saveObservation(accountId, lead, 'dm', observation);
      recordedHistory = fingerprint;
    };
    const refreshHistory = () => {
      scheduler.checkStopped();
      if (typeof history.getSnapshot === 'function') recordHistory(history.getSnapshot());
    };
    const readVisibleHistory = async () => {
      const observation = typeof actionAdapter.readDirectMessageHistory === 'function'
        ? await actionAdapter.readDirectMessageHistory(page, latest(lead.id), dmOptions()) : null;
      scheduler.checkStopped();
      if (observation?.history?.state === 'already_sent' && history.getSnapshot?.().state !== 'already_sent') recordHistory(observation.history);
      return observation;
    };
    const refuseRecipient = restriction => {
      if (restriction.failureScope === 'account') throw new TaskStopError(`[${restriction.code}] ${restriction.reason}`, restriction.code === 'DM_ACCOUNT_DAILY_LIMIT' ? 'PLATFORM_DAILY_LIMIT' : 'PLATFORM_RESTRICTED');
      const result = { state: 'confirmed_failure', reason: `[${restriction.code}] ${restriction.reason}`, evidence: restriction.evidence };
      saveDmResult(latest(lead.id), result, settings);
      progress(accountId, lead, `本用户无法继续私信：${result.reason}`);
      return { ...result, anomaly: false, skipped: true };
    };
    const events = receipt.events;
    try {
      const opened = await scheduler.run({ accountId, kind: 'ui', uid: lead.uid }, async () => {
        settings = currentSettings(plan);
        let eligible = actionEligibility(lead, 'dm', accountId, settings);
        if (!eligible.ok) return skipAction(accountId, lead, 'dm', eligible.reason);
        await checkPageHealth(page, accountId, lead.uid);
        await scheduler.before({ accountId, kind: 'ui', uid: lead.uid });
        eligible = actionEligibility(lead, 'dm', accountId, settings);
        if (!eligible.ok) return skipAction(accountId, lead, 'dm', eligible.reason);
        progress(accountId, lead, '正在打开该用户的私信会话', 'opening_dm');
        const clicked = await actionAdapter.openDirectMessage(page, latest(lead.id), dmOptions());
        if (!clicked) {
          lead = latest(lead.id);
          const error = dmPreparationError(page, '目标私信入口尚不可用', 'entry');
          logDmPreparation(accountId, error);
          const reason = error.message;
          saveDmResult(lead, { state: 'confirmed_failure', reason, evidence: '未执行发送动作' }, settings);
          progress(accountId, lead, reason);
        }
        return { clicked, anomaly: !clicked };
      });
      if (opened.skipped) return { skipped: true };
      if (!opened.clicked) return { state: 'confirmed_failure', anomaly: true };
      const conversationReady = await scheduler.prepare({ accountId, kind: 'ui', uid: lead.uid }, async () => {
        currentSettings(plan);
        await checkPageHealth(page, accountId, lead.uid);
        progress(accountId, lead, '正在进入并核对目标用户的聊天', 'opening_dm');
        return actionAdapter.ensureDirectMessageConversation(page, latest(lead.id), {
          ...dmOptions(),
          onStage: stage => {
            if (stage === 'selecting_conversation') progress(accountId, lead, '正在消息列表中查找并进入目标对话', 'selecting_conversation');
            if (stage === 'conversation_ready') progress(accountId, lead, '目标对话已确认，正在检查已有联系记录', 'checking_dm_history');
          }
        });
      });
      if (!conversationReady) {
        const error = dmPreparationError(page, '目标用户的聊天未就绪');
        logDmPreparation(accountId, error); throw error;
      }
      refreshHistory();
      const chatObservation = await readVisibleHistory();
      // The rendered outgoing bubble is positive history only. Empty chats,
      // failed bubbles and unknown markup never prove there was no prior send.
      const earlyHistoryEligibility = actionEligibility(lead, 'dm', accountId, settings);
      if (!earlyHistoryEligibility.ok) return skipAction(accountId, lead, 'dm', earlyHistoryEligibility.reason);
      if (chatObservation?.restriction) return refuseRecipient(chatObservation.restriction);
      const observedHistory = await history.wait({ timeoutMs: deps.historyTimeoutMs ?? 1500, keepAlive: true });
      scheduler.checkStopped();
      settings = currentSettings(plan);
      await checkPageHealth(page, accountId, lead.uid);
      recordHistory(observedHistory);
      refreshHistory();
      const loadedChat = await readVisibleHistory();
      const historyEligibility = actionEligibility(lead, 'dm', accountId, settings);
      if (!historyEligibility.ok) return skipAction(accountId, lead, 'dm', historyEligibility.reason);
      if (loadedChat?.restriction) return refuseRecipient(loadedChat.restriction);
      const frozenLead = plan.leads.find(row => String(row.id) === String(lead.id));
      const message = String(typeof frozenLead?.messagePreview === 'string' ? frozenLead.messagePreview
        : deps.applyTemplate(typeof plan.dmTemplate === 'string' ? plan.dmTemplate : settings.dm.template, latest(lead.id)) || '').trim();
      if (!message) throw new Error('私信话术为空，本次没有发送');
      const filled = await scheduler.prepare({ accountId, kind: 'ui', uid: lead.uid }, async () => {
        settings = currentSettings(plan);
        const eligible = actionEligibility(lead, 'dm', accountId, settings);
        if (!eligible.ok) return skipAction(accountId, lead, 'dm', eligible.reason);
        await checkPageHealth(page, accountId, lead.uid);
        progress(accountId, lead, '正在填写私信内容并检查目标会话', 'filling_dm');
        return actionAdapter.fillDirectMessage(page, latest(lead.id), message, dmOptions());
      });
      if (filled && filled.skipped) return filled;
      if (!filled) {
        const error = dmPreparationError(page, '无法唯一确定消息输入框');
        logDmPreparation(accountId, error);
        throw error;
      }
      const prepared = await scheduler.prepare({ accountId, kind: 'ui', uid: lead.uid }, async () => {
        settings = currentSettings(plan);
        refreshHistory();
        const eligible = actionEligibility(lead, 'dm', accountId, settings);
        if (!eligible.ok) return skipAction(accountId, lead, 'dm', eligible.reason);
        await checkPageHealth(page, accountId, lead.uid);
        return actionAdapter.prepareSend(page, latest(lead.id), message, dmOptions());
      });
      if (prepared.skipped) return prepared;
      if (prepared.state !== 'ready') {
        const error = dmPreparationError(page, '当前目标会话未找到唯一可用的发送控件', 'send', prepared);
        logDmPreparation(accountId, error);
        const reason = error.message;
        if (stopClassError(error) instanceof TaskStopError) throw error;
        saveDmResult(latest(lead.id), { state: 'confirmed_failure', reason, evidence: '没有执行发送点击' }, settings);
        progress(accountId, lead, `私信未执行：${reason}`);
        return { state: 'confirmed_failure', anomaly: true };
      }
      return await scheduler.run({ accountId, kind: 'dm', uid: lead.uid }, async () => {
        settings = currentSettings(plan);
        refreshHistory();
        let eligible = actionEligibility(lead, 'dm', accountId, settings);
        if (!eligible.ok) return skipAction(accountId, lead, 'dm', eligible.reason);
        await checkPageHealth(page, accountId, lead.uid);
        await scheduler.before({ accountId, kind: 'dm', uid: lead.uid });
        refreshHistory();
        const finalChat = await readVisibleHistory();
        eligible = actionEligibility(lead, 'dm', accountId, settings);
        if (!eligible.ok) return skipAction(accountId, lead, 'dm', eligible.reason);
        if (finalChat?.restriction) return refuseRecipient(finalChat.restriction);
        // Freeze before marking/clicking this send. A response caused by this
        // attempt must never be saved as historical evidence for a prior send.
        history.dispose();
        lead = latest(lead.id);
        previousDm = Object.fromEntries(DM_ATTEMPT_FIELDS.map(field => [field, lead[field]]));
        lead.dmAttemptId = crypto.randomUUID(); lead.dmAttemptAt = store.nowStr(); lead.dmAttemptAccountId = String(accountId);
        activeAttemptId = lead.dmAttemptId;
        lead.dmMessageHash = crypto.createHash('sha256').update(message).digest('hex');
        // 在发送前原子保存待核验；即使进程在点击期间崩溃，也不会自动再次发送。
        saveDmResult(lead, { state: 'pending_verification', reason: '发送已准备，等待本次操作回执或人工核验' }, settings);
        markedPending = true;
        progress(accountId, lead, '正在点击发送并检查本次发送结果', 'sending_dm');
        receipt.arm({ message, attemptId: lead.dmAttemptId });
        clickStarted = true;
        clickedSend = await prepared.click();
        if (!clickedSend) {
          notSentConfirmed = true;
          const result = saveDmResult(lead, { state: 'confirmed_failure', reason: '未找到明确的发送控件，本次未执行发送', evidence: '发送控件检查返回未点击' }, settings, activeAttemptId);
          if (result.alreadySettled) progress(accountId, lead, `私信保留已有核验结果：${result.state === 'confirmed_success' ? '成功' : '失败'}`);
          return { ...result, anomaly: result.state === 'confirmed_failure' };
        }
        bumpAttempt(accountId, 'dm'); attemptCounted = true;
        scheduler.checkStopped();
        progress(accountId, lead, '发送已点击，正在核验本次发送回执', 'verifying_dm');
        // Finish immediately when the current target's response arrives. The
        // bounded readiness wait prevents an immediate next navigation from
        // interrupting an in-flight send; it is never evidence of delivery.
        await receipt.waitForReceipt({ timeoutMs: deps.receiptTimeoutMs || 30000 });
        scheduler.checkStopped();
        // 只有本次目标同步业务回执可确认平台已接受；DOM/HTTP状态不足以确认。
        let result = workflow.validateDmOutcome(await getHooks().dmVerifier({ page, lead, message, attemptId: lead.dmAttemptId, events, receipt, signal: getSignal(), settings }));
        let recipientRestriction = result.failureScope === 'recipient';
        let accountRestriction = result.failureScope === 'account' ? { code: result.failureCode, reason: result.reason } : null;
        if (result.state !== 'confirmed_success' && !accountRestriction && typeof prepared.readFeedback === 'function') {
          // A generic server rejection stays an anomaly. Only the observed,
          // target-scoped recipient notice can make it a per-user refusal.
          const feedback = await prepared.readFeedback().catch(() => null);
          if (feedback?.state === 'ready' && feedback.restriction?.failureScope === 'account') {
            accountRestriction = feedback.restriction;
            // A visible account limit pauses the batch, but cannot settle an
            // unconfirmed click. Preserve pending rather than allowing a retry.
            result.reason = `[${accountRestriction.code}] ${accountRestriction.reason}`;
            if (result.state === 'confirmed_failure') result.evidence += ';' + accountRestriction.evidence;
          } else if (result.state === 'confirmed_failure' && feedback?.state === 'ready' && feedback.restriction && !recipientRestriction) {
            recipientRestriction = true;
            result.reason = `[${feedback.restriction.code}] ${feedback.restriction.reason}`;
            result.evidence += ';' + feedback.restriction.evidence;
          }
        }
        result = saveDmResult(lead, result, settings, activeAttemptId);
        scheduler.checkStopped();
        if (result.state === 'confirmed_success' && typeof scheduler.afterDmSent === 'function') { scheduler.afterDmSent(); saveDmSession(accountId, scheduler); }
        store.log(accountId, `私信结果：${lead.nickname} → ${result.state}（${result.reason || '已确认'}）`);
        progress(accountId, lead, result.alreadySettled ? `私信保留已有核验结果：${result.state === 'confirmed_success' ? '成功' : '失败'}`
          : result.state === 'confirmed_success' ? '平台已确认接受本次私信' : result.state === 'pending_verification' ? '私信已点击，回执尚未确认，禁止自动重发' : `私信确认失败：${result.reason}`);
        if (!accountRestriction && result.state !== 'confirmed_success') await checkPageHealth(page, accountId, lead.uid);
        return { ...result, anomaly: result.state === 'confirmed_failure' && !recipientRestriction,
          ...(accountRestriction ? { pauseCode: accountRestriction.code === 'DM_ACCOUNT_DAILY_LIMIT' ? 'PLATFORM_DAILY_LIMIT' : 'PLATFORM_RESTRICTED', pauseReason: accountRestriction.reason } : {}) };
      });
    } catch (e) {
      lead = latest(lead.id);
      if (e.actionNotStarted === true) notSentConfirmed = true;
      if (clickStarted && !notSentConfirmed && !attemptCounted) bumpAttempt(accountId, 'dm');
      const accountPauseBeforeSend = (!clickStarted || notSentConfirmed) && (markedPending || /^PLATFORM_/.test(e.code || '')) && /^(?:LOGIN_|AUTH_|PLATFORM_|PAGE_CLOSED$|TASK_STOPPED$)/.test(e.code || '');
      if (accountPauseBeforeSend && markedPending && lead?.dmAttemptId === activeAttemptId && lead.dmState === 'pending_verification') {
        Object.assign(lead, previousDm);
        saveLeadAction(lead, 'dm', settings);
      }
      if (lead && lead.dmState !== 'confirmed_success' && !accountPauseBeforeSend) {
        // 点击与回执之间的异常无法证明发送失败，保留待核验以防重复。
        const state = markedPending && clickStarted && !notSentConfirmed ? 'pending_verification' : 'confirmed_failure';
        saveDmResult(lead, { state, reason: e.message, evidence: state === 'confirmed_failure' ? '没有执行发送动作' : '' }, settings, markedPending ? activeAttemptId : undefined);
      }
      throw e;
    } finally {
      receipt.dispose();
      history.dispose();
      if (clickedSend && typeof receipt.getDiagnostics === 'function') {
        // Candidate transport metadata is for diagnosis only. It is never
        // passed to the verifier as recipient-matched delivery evidence.
        try {
          if (typeof receipt.getReceiptSummary === 'function') store.log(accountId, `本次私信协议核验：${JSON.stringify(receipt.getReceiptSummary())}`);
          store.log(accountId, `私信网络观察（仅诊断，不代表发送成功）：${JSON.stringify(receipt.getDiagnostics())}`);
        } catch (_) { /* diagnostic logging must not change a recorded outcome */ }
      }
    }
  }
  async function runTask(accountId, kind, options = {}) {
    if (taskState.running) return { ok: false, error: '已有任务在运行' };
    let plan;
    try { plan = resolvePlan(accountId, kind, options, store.getSettings()); }
    catch (e) { setTask({ status: e.message }); return { ok: false, error: e.message }; }
    if (!plan.leadIds.length) return { ok: false, error: '当前预检查没有可执行线索' };
    setTask({ kind, accountId, running: true, status: '准备执行预检查固定名单', stage: 'opening_profile', currentLead: null, currentUserIndex: 0, totalUsers: plan.leadIds.length, done: 0, total: plan.leadIds.length, errors: [] });
    const doneIds = [], result = { ok: true, followCount: 0, dmCount: 0, pendingCount: 0, failedCount: 0, skipped: 0 };
    const outcomeCounts = () => ({ followCount: result.followCount, dmCount: result.dmCount,
      pendingCount: result.pendingCount, failedCount: result.failedCount, skipped: result.skipped });
    let userErrors = 0, pausedLeadId = '';
    checkpoint({ id: crypto.randomUUID(), kind, accountId: String(accountId), planId: plan.id, leadIds: [...plan.leadIds],
      counts: outcomeCounts(), processedLeadIds: [], currentLeadId: null, state: 'running', stopReason: '' });
    try {
      const scheduler = makeScheduler(store.getSettings(), { errorBoundary: 'user' });
      if (typeof scheduler.restoreDmSession === 'function') scheduler.restoreDmSession(loadDmSession(accountId));
      setTask({ status: '正在打开该账号的可见浏览器窗口' });
      const alive = await launchAccount(accountId, { headless: false, checkStopped: () => scheduler.checkStopped() });
      const { page } = alive;
      await showAccountBrowser(page, accountId, scheduler);
      const markSkipped = (leadId, reason) => {
        result.skipped++; doneIds.push(String(leadId)); checkpoint({ counts: outcomeCounts(), processedLeadIds: [...doneIds], currentLeadId: null });
        setTask({ done: doneIds.length, status: `名单用户已跳过：${reason}` });
        store.log(accountId, `触达名单跳过：${String(leadId)}（${reason}）`);
      };
      for (const leadId of plan.leadIds) {
        scheduler.checkStopped();
        let settings = currentSettings(plan), lead = latest(leadId);
        if (!lead || (plan.crossAccount !== true && String(lead.accountId) !== String(accountId))) { markSkipped(leadId, '线索已不存在或账号不匹配'); continue; }
        // 分发分配锁：已分配给他号且未消费的用户，任何账号都不得接触（防双触）
        let blockedByAllocation = false;
        try {
          if (typeof store.getAllocations === 'function' && lead && lead.uid) {
            const entry = store.getAllocations()[workflow.contactKey(lead, settings)];
            blockedByAllocation = !!entry && entry.consumed !== true && !workflow.allocationExpired(entry)
              && String(entry.accountId) !== String(accountId);
          }
        } catch (e) { /* 分配锁读取失败按放行处理，执行时仍有 pending 与历史规则兜底 */ }
        if (blockedByAllocation) { markSkipped(leadId, '该用户已分配给其他账号执行'); continue; }
        const plannedLead = plan.leads.find(row => String(row.id) === String(leadId));
        if (!plannedLead || String(plannedLead.uid) !== String(lead.uid)) throw new TaskStopError('固定名单中的用户身份已变化，请重新预检查', 'PLAN_IDENTITY_CHANGED');
        const frozenActions = plannedLead.actions || plan.actions;
        const followEligibility = actionEligibility(lead, 'follow', accountId, settings), dmEligibility = actionEligibility(lead, 'dm', accountId, settings);
        const doFollow = plan.actions.follow && frozenActions.follow && followEligibility.ok;
        const doDm = plan.actions.dm && frozenActions.dm && dmEligibility.ok;
        if (!doFollow && !doDm) {
          const reasons = [];
          if (plan.actions.follow && frozenActions.follow) reasons.push(`关注：${followEligibility.reason || '未启用'}`);
          if (plan.actions.dm && frozenActions.dm) reasons.push(`私信：${dmEligibility.reason || '未启用'}`);
          markSkipped(leadId, reasons.join('；') || '本用户没有冻结的可执行操作'); continue;
        }
        checkpoint({ currentLeadId: String(leadId), state: 'running' });
        setTask({ status: `处理 ${doneIds.length + 1}/${plan.leadIds.length}：${lead.nickname}`, currentUserIndex: doneIds.length + 1,
          currentLead: { id: String(lead.id), nickname: String(lead.nickname || '当前用户') },
          currentUserOutcome: null,
          detail: '同一次主页访问：检查关系并按需关注 → 进入目标对话 → 检查历史与重复规则 → 填写 → 发送核验；仅切换下一用户时等待' });
        let anomaly = false, lastAnomalyReason = '', countedFollowPending = false, countedDmPending = false;
        let acted = false; const userReport = [];
        try {
          const relation = await visit(accountId, lead, page, scheduler);
          if (doFollow) {
            const r = await followOne(accountId, lead, page, scheduler, plan, relation);
            if (!r.skipped) acted = true;
            userReport.push(`关注：${r.skipped ? '已关注，无需点击' : r.state === 'confirmed_success' ? '未关注 → 已关注' : r.state === 'pending_verification' ? '已点击，待核验' : '未关注（失败）'}`);
            if (r.success) result.followCount++;
            if (r.state === 'pending_verification') { result.pendingCount++; countedFollowPending = true; }
            else if (r.state === 'confirmed_failure') result.failedCount++;
            else if (r.skipped) result.skipped++;
            if (r.anomaly) { anomaly = true; lastAnomalyReason = r.reason || '关注操作异常'; }
          }
          if (doDm) {
            const r = await dmOne(accountId, lead, page, scheduler, plan);
            if (!r.skipped) acted = true;
            const dmReport = r.skipped ? (r.reason || '已私信，无需发送') : r.state === 'confirmed_success' ? '发送成功'
              : r.state === 'pending_verification' ? '已点击，待核验' : r.pauseCode === 'PLATFORM_DAILY_LIMIT' ? '达到今日上限'
                : r.pauseCode === 'PLATFORM_RESTRICTED' ? '操作频繁' : '发送失败';
            userReport.push(`私信：${dmReport}`);
            setTask({ currentUserOutcome: userReport.join(' · ') });
            if (r.state === 'confirmed_success') result.dmCount++;
            else if (r.state === 'pending_verification') { result.pendingCount++; countedDmPending = true; }
            else if (r.state === 'confirmed_failure') result.failedCount++;
            else result.skipped++;
            if (r.anomaly) { anomaly = true; lastAnomalyReason = r.reason || '私信操作异常'; }
            if (r.pauseCode) {
              pausedLeadId = String(leadId);
              doneIds.push(String(leadId));
              checkpoint({ counts: outcomeCounts(), processedLeadIds: [...doneIds], currentLeadId: null });
              setTask({ done: doneIds.length, stage: 'user_done' });
              throw new TaskStopError(r.pauseReason, r.pauseCode);
            }
          }
          setTask({ currentUserOutcome: userReport.join(' · ') });
        } catch (e) {
          e = stopClassError(e);
          if (e instanceof TaskStopError) throw e;
          const current = latest(leadId);
          const pendingFollow = doFollow && !countedFollowPending && current && current.followState === 'pending_verification';
          const pendingDm = doDm && !countedDmPending && current && current.dmState === 'pending_verification';
          if (pendingFollow || pendingDm) result.pendingCount += Number(!!pendingFollow) + Number(!!pendingDm);
          else result.failedCount++;
          anomaly = true;
          lastAnomalyReason = e.message;
          taskState.errors.push({ leadId: String(leadId), error: e.message });
          store.log(accountId, `线索处理异常：${lead.nickname}（${e.message}）`);
        }
        doneIds.push(String(leadId));
        checkpoint({ counts: outcomeCounts(), processedLeadIds: [...doneIds], currentLeadId: null });
        setTask({ done: doneIds.length, stage: 'user_done' });
        // 该用户本次没有任何实际动作（运行期确认已关注且已私信）时，不等待用户间隔
        if (acted) scheduler.scheduleBoundary('user');
        userErrors = anomaly ? userErrors + 1 : 0;
        if (userErrors >= Math.max(1, Number(settings.human.maxConsecutiveErrors) || 3)) throw new TaskStopError(`连续 ${userErrors} 个用户处理异常，已保存本次结果并暂停。最近原因：${lastAnomalyReason}`, 'CONSECUTIVE_ERRORS');
      }
      checkpoint({ counts: outcomeCounts(), state: 'completed', currentLeadId: null });
      setTask({ running: false, status: `任务完成：关注 ${result.followCount}｜私信确认成功 ${result.dmCount}｜待核验 ${result.pendingCount}｜失败 ${result.failedCount}｜跳过 ${result.skipped}` });
    } catch (e) {
      result.ok = false; result.error = e.message;
      result.errorCode = (e && e.code) || '';
      checkpoint({ counts: outcomeCounts(), state: e instanceof TaskStopError ? 'paused' : 'error', stopReason: e.message });
      setTask({ running: false, status: `任务已暂停：${e.message}` });
    }
    result.count = kind === 'follow' ? result.followCount : result.dmCount;
    // 供多账号分发判断哪些用户已处理：触发账号级频繁/上限的那位用户本次并未完成，
    // 不算已处理（由分发回池交给其他账号；若已不可再发，执行时由资格检查跳过）。
    result.processedLeadIds = doneIds.filter(id => id !== pausedLeadId);
    if (pausedLeadId) result.pausedLeadId = pausedLeadId;
    return result;
  }
  async function openLeadProfile(accountId, leadId) {
    if (taskState.running) return { ok: false, error: '已有任务在运行，请先停止任务' };
    const lead = latest(leadId);
    if (!lead || String(lead.accountId) !== String(accountId) || !workflow.safeHomepage(lead)) return { ok: false, error: '线索不存在、账号不匹配或主页链接无效' };
    setTask({ kind: 'profile', running: true, accountId, status: '正在打开用户主页并被动回填资料', done: 0, total: 1, errors: [] });
    try {
      const scheduler = makeScheduler(store.getSettings());
      const alive = await launchAccount(accountId, { headless: false, checkStopped: () => scheduler.checkStopped() });
      await showAccountBrowser(alive.page, accountId, scheduler);
      await visit(accountId, lead, alive.page, scheduler);
      setTask({ running: false, done: 1, status: '用户主页已打开；已返回的资料已回填，缺失资料不额外访问' });
      return { ok: true, lead: latest(leadId) };
    } catch (e) { setTask({ running: false, status: e.message }); return { ok: false, error: e.message }; }
  }
  return {
    followTask: (accountId, options) => runTask(accountId, 'follow', options),
    dmTask: (accountId, options) => runTask(accountId, 'dm', options),
    outreachTask: (accountId, options) => runTask(accountId, 'outreach', options),
    openLeadProfile, assertPageHealth
  };
}
module.exports = { createActions, assertPageHealth };
