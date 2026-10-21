'use strict';
const crypto = require('node:crypto');
const { TaskStopError } = require('./scheduler');
const signals = require('./lib/dm-account-signals');
const { levelOf } = require('./lib/error-levels');
const workflow = require('./workflow');

const realSleep = ms => new Promise(r => setTimeout(r, ms));

// 批次失败的处理（错误分级见 lib/error-levels.js）：
//   账号级（登录/平台验证/窗口关闭等）→ 本次分发内不再使用该账号；
//   授权失效（AUTH_*）→ 所有账号都无法执行，整体暂停；
//   其余（接收人级、连续用户异常 CONSECUTIVE_ERRORS、无法归类）→ 只让本批未处理用户回池，该账号本轮跳过、下轮继续。
// 防空转：同一账号连续这么多批“一个用户都没处理成”才按账号异常处理。
const SOFT_FAILURE_LIMIT = 2;
const MAX_CYCLES = 30;

/**
 * 多账号私信分发器：
 * 联系人池 → 按经验剩余/健康/同视频错峰分配 → 每账号分批(复用 outreachTask) → 轮转执行。
 * 频繁 → 冷却(逐次翻倍)+排队尾，剩余用户回池；今日上限 → 当日停用(明日8点恢复)，剩余用户回池；
 * 所有可用账号都在冷却 → 等最早冷却结束再继续；全部今日停用/异常 → 整体停止。
 * now/sleep 可注入（测试用），默认真实时钟。
 */
function createDmDistribution({ store, taskState, setTask, failTask, checkpoint, createPlan, runOutreach, getSignal, closeAccount = null, now = Date.now, sleep = realSleep }) {
  /* ---------- 账号状态 ---------- */
  function cleanAccountState(raw, opDay, now) {
    const out = {};
    for (const [id, entry] of Object.entries(raw || {})) {
      if (!entry || typeof entry !== 'object') continue;
      const next = { ...entry };
      if (next.opDay !== opDay) { next.opDay = opDay; next.frequentCountToday = 0; next.frequentStreak = 0; next.dmAtFrequent = null; next.frequentUntil = null; next.disabledUntil = null; }
      if (next.disabledUntil && Number(next.disabledUntil) <= now) next.disabledUntil = null;
      if (next.frequentUntil && Number(next.frequentUntil) <= now) next.frequentUntil = null;
      out[id] = next;
    }
    return out;
  }
  function readState(opDay, now) {
    const cleaned = cleanAccountState(store.getDmAccountState(), opDay, now);
    store.setDmAccountState(cleaned);
    return cleaned;
  }
  // 分发持有的是开始时读入的状态；runTask 在批次中会写入 dmSession（强制休息计数），保存时不能覆盖
  function saveState(state) {
    const disk = store.getDmAccountState() || {};
    const merged = { ...disk };
    for (const [id, entry] of Object.entries(state)) {
      merged[id] = { ...entry };
      if (disk[id] && disk[id].dmSession) merged[id].dmSession = disk[id].dmSession;
    }
    store.setDmAccountState(merged);
  }
  function estimateCap(entry) {
    const history = Array.isArray(entry && entry.capHistory) ? entry.capHistory : [];
    if (history.length) {
      const samples = history.slice(-3).map(h => Number(h && h.sentAtCap) || 0).filter(v => v > 0);
      if (samples.length) return { value: Math.min(...samples), source: 'cap' };
    }
    return { value: 0, source: 'none' };
  }
  function blocked(state, accountId, now) {
    const entry = state[String(accountId)] || {};
    if (entry.disabledUntil && Number(entry.disabledUntil) > now) return { blocked: true, kind: 'daily_limit', until: Number(entry.disabledUntil) };
    if (entry.frequentUntil && Number(entry.frequentUntil) > now) return { blocked: true, kind: 'frequent', until: Number(entry.frequentUntil) };
    return { blocked: false };
  }
  function markFrequent(state, accountId, settings, opDay, now) {
    const entry = state[String(accountId)] || (state[String(accountId)] = {});
    const sentToday = Math.max(0, Number(store.getDailyUsage(accountId).dm) || 0);
    // 连续频繁：上次频繁后一条都没发出去就又频繁（= 冷却到点试发仍被拒）。期间发出过私信说明已恢复，阶梯从头算。
    // 阶梯：30 分钟 → 1 小时 → 2 小时（cooldownFor：基准 × 2^n，封顶 2 小时）；连续试发 maxFrequentRetriesPerDay（默认 3）次仍频繁 → 今日停用。
    // 平台的“当日额度”与“频繁”回执相同（2026-10-21 实测），所以连续多次仍频繁按今日上限处理。
    const consecutive = entry.opDay === opDay && Number(entry.frequentStreak) > 0 && entry.dmAtFrequent != null && sentToday <= Number(entry.dmAtFrequent);
    entry.opDay = opDay;
    entry.frequentCountToday = (Number(entry.frequentCountToday) || 0) + 1;
    entry.frequentStreak = consecutive ? Number(entry.frequentStreak) + 1 : 1;
    entry.dmAtFrequent = sentToday;
    const retries = entry.frequentStreak - 1; // 冷却到点后试发仍频繁的次数
    const maxRetries = Math.max(0, Number(settings.dm.maxFrequentRetriesPerDay ?? 3));
    if (retries >= maxRetries) {
      entry.frequentUntil = null;
      entry.disabledUntil = store.nextResetMs();
      entry.lastStopReason = `频繁后试发 ${retries} 次仍频繁，按今日上限停用`;
    } else {
      entry.frequentUntil = now + signals.cooldownFor(settings.dm.frequentCooldownSec, retries) * 1000;
      entry.lastStopReason = '平台提示操作频繁';
    }
  }
  function markDailyLimit(state, accountId, settings, opDay) {
    const entry = state[String(accountId)] || (state[String(accountId)] = {});
    entry.opDay = opDay;
    const sent = Math.max(0, Number(store.getDailyUsage(accountId).dm) || 0);
    const history = Array.isArray(entry.capHistory) ? entry.capHistory : [];
    if (!history.some(h => h.date === opDay)) history.push({ date: opDay, sentAtCap: sent });
    entry.capHistory = history.slice(-30);
    const samples = entry.capHistory.slice(-3).map(h => Number(h && h.sentAtCap) || 0).filter(v => v > 0);
    if (samples.length) entry.estimatedDailyCap = Math.min(...samples);
    entry.disabledUntil = store.nextResetMs();
    entry.lastStopReason = '平台提示今日私信已达上限';
    entry.frequentCountToday = 0;
  }

  /* ---------- 候选与分配 ---------- */
  function candidates(settings, options) {
    const all = store.getLeads();
    const videos = store.getVideos();
    const nowMs = now();
    const history = workflow.historyIndex(all, settings);
    let rows = all;
    if (options.leadIds) {
      const ids = new Set(options.leadIds.map(String));
      rows = rows.filter(l => ids.has(String(l.id)));
    } else if (options.filters && Object.keys(options.filters).length) {
      rows = require('./lead-query').filterLeads(rows, videos, options.filters, { settings, now: nowMs });
    }
    // 分发执行「关注 + 私信」：关注或私信任一符合条件即可入池，逐条记录需要哪些动作。
    const excluded = new Map();
    const bump = (reason, count = 1) => excluded.set(reason, (excluded.get(reason) || 0) + count);
    const selected = [];
    const needs = new Map();
    for (const lead of rows) {
      if (String(lead.businessId || settings.outreach.businessId || 'default') !== workflow.businessId(settings)) { bump('不属于当前业务'); continue; }
      const followEligibility = workflow.eligibility(lead, 'follow', history, settings, nowMs, videos);
      const dmEligibility = workflow.eligibility(lead, 'dm', history, settings, nowMs, videos);
      if (!followEligibility.ok && !dmEligibility.ok) { bump(dmEligibility.reason || followEligibility.reason || '不符合联系条件'); continue; }
      // 分配锁只在“本轮运行内”有意义，且由 runTask 的 blockedByAllocation 在真正执行时兜底防双触。
      // 候选筛选阶段绝不按残留锁排除：只要还没关注/私信成功（锁未消费），就该重新进入候选，
      // 否则上一轮中断/停止遗留的锁会把用户永久排除（表现为“已分配给其他账号执行 N 条”）。
      selected.push(lead);
      needs.set(String(lead.id), { follow: followEligibility.ok, dm: dmEligibility.ok });
    }
    const unique = workflow.uniqueContacts(selected, settings);
    if (unique.length < selected.length) bump('同一用户重复评论', selected.length - unique.length);
    unique.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    return { rows: unique, needs, excluded: [...excluded.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })), sourceRows: rows.length, duplicateRows: selected.length - unique.length };
  }

  /** 账号今日剩余额度（按已执行用量；不含本次分发已预留未执行的用户） */
  function accountCapacity(accountId, settings, state) {
    const u = store.getDailyUsage(accountId);
    const quota = workflow.getQuotas(settings, u);
    const cap = estimateCap(state[accountId]);
    const dmLimit = Math.max(0, Number(settings.dm.dailyLimit) || 0);
    const capRemaining = settings.dm.adaptiveCap !== false && cap.value > 0 ? Math.max(0, cap.value - Math.max(0, Number(u.dm) || 0)) : Infinity;
    return {
      follow: Math.max(0, Number(quota.follow.remaining) || 0),
      dm: Math.min(dmLimit - Math.max(Number(u.dm) || 0, Number(u.dmAttempts) || 0), capRemaining),
      profile: Math.max(0, Number(quota.profile.remaining) || 0)
    };
  }

  /**
   * @param reserved 各账号已分到但尚未执行的用户（accountId → leads）。重新分配时先扣除，
   *   否则已执行用量里还没有它们，会把同一份额度再分一次而超额。
   */
  function allocateLeads(pool, unassigned, settings, state, opDay, needs, reserved = {}) {
    const blocks = {};
    const usage = {};
    const needOf = lead => (needs && needs.get(String(lead.id))) || { follow: false, dm: true };
    for (const item of pool) {
      const accountId = String(item.accountId);
      const u = usage[accountId] = { ...accountCapacity(accountId, settings, state), perVideo: {} };
      for (const lead of reserved[accountId] || []) {
        const need = needOf(lead);
        const videoKey = String(lead.videoLink || '');
        u.profile--;
        if (need.follow) u.follow--;
        if (need.dm) u.dm--;
        u.perVideo[videoKey] = (u.perVideo[videoKey] || 0) + 1;
      }
      blocks[accountId] = [];
    }
    const leftovers = [];
    const sameVideoLimit = Math.max(1, Number(settings.dm.sameVideoPerBatch) || 2);
    for (const lead of unassigned) {
      const videoKey = String(lead.videoLink || '');
      const need = needOf(lead);
      let best = null, fallback = null;
      for (const item of pool) {
        const accountId = String(item.accountId);
        if (blocked(state, accountId, now()).blocked) continue;
        const u = usage[accountId];
        if (u.profile <= 0) continue;
        if (need.follow && u.follow <= 0) continue;
        if (need.dm && u.dm <= 0) continue;
        const sameVideo = u.perVideo[videoKey] || 0;
        const score = { remaining: u.profile, sameVideo };
        const better = other => !other || score.remaining > other.score.remaining || score.remaining === other.score.remaining && score.sameVideo < other.score.sameVideo;
        if (better(fallback)) fallback = { accountId, score };
        if (sameVideo >= sameVideoLimit) continue;
        if (better(best)) best = { accountId, score };
      }
      // 同视频错峰是软约束：所有账号都到该视频上限时回退分配，保证名单能跑完
      const chosen = best || fallback;
      if (!chosen) { leftovers.push(lead); continue; }
      blocks[chosen.accountId].push(lead);
      usage[chosen.accountId].profile--;
      if (need.follow) usage[chosen.accountId].follow--;
      if (need.dm) usage[chosen.accountId].dm--;
      usage[chosen.accountId].perVideo[videoKey] = (usage[chosen.accountId].perVideo[videoKey] || 0) + 1;
    }
    return { blocks, leftovers };
  }

  function proxyGroup(accounts) {
    const groups = new Map();
    for (const acc of accounts) {
      const host = (() => { try { const p = String(acc.proxy || '').trim(); return p ? new URL(p).host || p : '无代理'; } catch (e) { return p ? p : '无代理'; } })();
      if (!groups.has(host)) groups.set(host, []);
      groups.get(host).push(acc.name || String(acc.id));
    }
    return [...groups.values()].filter(list => list.length > 1);
  }

  /* ---------- 主流程 ---------- */
  async function dmDistributionTask(input) {
    if (taskState.running) return failTask('已有任务在运行');
    const settings = store.getSettings();
    const accounts = store.getAccounts();
    const poolInput = Array.isArray(input && input.poolAccounts) ? input.poolAccounts : [];
    const pool = poolInput.map(item => {
      const accountId = String(typeof item === 'string' ? item : item && item.accountId);
      if (!accounts.some(a => String(a.id) === accountId)) throw new Error('私信账户池中存在无效账号，请刷新后重新选择');
      return { accountId, template: typeof item === 'object' && typeof item.template === 'string' && item.template.trim() ? item.template : '' };
    }).filter((item, index, list) => list.findIndex(x => x.accountId === item.accountId) === index);
    if (!pool.length) return failTask('请至少选择一个私信账户');
    if (pool.some(item => settings.dm.adaptiveCap === undefined)) { /* noop */ }
    const sameIpGroups = proxyGroup(pool.map(item => accounts.find(a => String(a.id) === item.accountId)).filter(Boolean));

    const runId = crypto.randomUUID();
    // 停止序号在整个分发生命周期内有效。批次内部的 setTask({running:true})
    // 会重置 stopRequested，但不能回退这个序号。
    const startEpoch = Number(taskState.stopEpoch) || 0;
    const stopped = () => (Number(taskState.stopEpoch) || 0) !== startEpoch;
    const unhealthy = new Set();
    const softFailures = new Map();
    const opDay = store.opDayStr();
    const state = readState(opDay, now());
    const summary = {
      runId, status: 'running', totalCandidates: 0, perAccount: {}, unassigned: 0,
      done: 0, success: 0, followCount: 0, pending: 0, failed: 0, skipped: 0, stopReason: '', sameIpWarning: sameIpGroups
    };
    const publish = patch => { Object.assign(summary, patch); setTask({ kind: 'dm_distribution', distributionSummary: { ...summary } }); };
    const accountName = accountId => (accounts.find(a => String(a.id) === String(accountId)) || {}).name || String(accountId);
    // 待执行用户只存在两处：unassigned（池子，等待分配）与 blocks[账号]（已分配、已加锁、未执行）。
    // 用户离开这两处只能是本批已处理；其余情况一律回到 unassigned，不允许静默丢失。
    let unassigned = [];
    const blocks = {};
    for (const item of pool) {
      blocks[item.accountId] = [];
      summary.perAccount[item.accountId] = { name: accountName(item.accountId), count: 0, success: 0 };
    }
    const remainingCount = () => unassigned.length + Object.values(blocks).reduce((sum, list) => sum + list.length, 0);
    setTask({ kind: 'dm_distribution', distributionActive: true, running: true, accountId: String(pool[0].accountId), stage: 'allocating',
      status: '正在生成多账号分发方案', done: 0, total: 0, detail: '', errors: [], distributionSummary: { ...summary } });
    try {
      // 新一轮分发开始：清除上一次未完成的分配锁。
      // 引擎单任务串行，锁只在本次运行内有效；上一轮中断/停止残留的锁会把用户误判为
      // “已分配给其他账号执行”而永久排除，必须在候选筛选之前清掉。
      const allocations = store.getAllocations();
      for (const key of Object.keys(allocations)) {
        if (!allocations[key] || allocations[key].consumed !== true) delete allocations[key];
      }
      store.setAllocations(allocations);
      const lockKey = lead => workflow.contactKey(lead, settings);

      const candidateResult = candidates(settings, input || {});
      unassigned = candidateResult.rows;
      const needs = candidateResult.needs;
      summary.excluded = candidateResult.excluded;
      summary.totalCandidates = unassigned.length;
      // 池子里的用户分配给可用账号：各账号已预留未执行的用户先扣额度，新分配追加到其后（不覆盖）
      const allocateNow = () => {
        if (!unassigned.length) return;
        const usable = pool.filter(item => !unhealthy.has(String(item.accountId)));
        const next = allocateLeads(usable, unassigned, settings, state, opDay, needs, blocks);
        const expiresAt = now() + workflow.ALLOCATION_TTL_MS;
        for (const [accountId, leads] of Object.entries(next.blocks)) {
          for (const lead of leads) {
            allocations[lockKey(lead)] = { accountId, kind: 'outreach', plannedAt: store.nowStr(), expiresAt, consumed: false };
          }
          blocks[accountId].push(...leads);
          summary.perAccount[accountId].count += leads.length;
        }
        store.setAllocations(allocations);
        unassigned = next.leftovers;
      };
      // 用户回池：删除分配锁，放回 unassigned，等下次分配给其他可用账号
      const returnToPool = (accountId, leads) => {
        if (!leads.length) return;
        for (const lead of leads) delete allocations[lockKey(lead)];
        store.setAllocations(allocations);
        unassigned.push(...leads);
        summary.perAccount[accountId].count -= leads.length;
      };
      // 账号冷却/今日停用/异常：它手里剩余的预留用户也全部回池
      const reclaimAccount = accountId => {
        const rest = blocks[accountId].splice(0);
        returnToPool(accountId, rest);
        return rest.length;
      };
      // 没有账号能执行时：仍有账号只是频繁冷却（且今日还有余量）→ 返回最早恢复时间；否则 0
      const cooldownResumeAt = () => {
        const t = now();
        let earliest = 0;
        for (const item of pool) {
          const accountId = String(item.accountId);
          if (unhealthy.has(accountId)) continue;
          const blk = blocked(state, accountId, t);
          if (!blk.blocked || blk.kind !== 'frequent') continue;
          const cap = accountCapacity(accountId, settings, state);
          if (cap.profile <= 0 || (cap.dm <= 0 && cap.follow <= 0)) continue;
          if (!earliest || blk.until < earliest) earliest = blk.until;
        }
        return earliest;
      };
      const waitForCooldown = async until => {
        const remaining = remainingCount();
        while (now() < until) {
          const sec = Math.ceil((until - now()) / 1000);
          const clock = sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
          setTask({ stage: 'waiting_cooldown', status: `所有可用账号处于频繁冷却，${clock}后继续（剩余 ${remaining} 人），可随时停止`, waitingUntil: new Date(until).toISOString() });
          if (stopped()) throw new TaskStopError('已手动停止，剩余用户保留待分配');
          await sleep(Math.min(1000, until - now()));
        }
        setTask({ waitingUntil: null });
      };

      allocateNow();
      summary.unassigned = unassigned.length;
      publish({ perAccount: summary.perAccount, unassigned: summary.unassigned });
      checkpoint({ id: runId, kind: 'dm_distribution', accountId: String(pool[0].accountId), state: 'running', stopReason: '', distributionSummary: { ...summary } });

      // 切到另一个账号前关闭上一个账号的浏览器，避免多账号时窗口堆积（dm.closeBrowserBetweenAccounts，默认开）
      const closeBetween = settings.dm.closeBrowserBetweenAccounts !== false && typeof closeAccount === 'function';
      let openAccountId = '';
      const closePrevious = async nextAccountId => {
        if (!closeBetween || !openAccountId || openAccountId === nextAccountId) return;
        const previous = openAccountId;
        openAccountId = '';
        try { await closeAccount(previous); store.log(previous, '私信分发：切换账号，已关闭本账号浏览器'); }
        catch (error) { store.log(previous, `私信分发：关闭本账号浏览器失败（${error.message}），继续执行`); }
      };

      // 轮转执行：每账号每轮一批；未处理用户回池再分配；全部账号今日停用/异常即结束
      let cycles = 0, cycleCapReached = false;
      while (remainingCount() > 0) {
        if (stopped()) throw new TaskStopError();
        if (cycles >= MAX_CYCLES) { cycleCapReached = true; break; }
        cycles++;
        let progressed = false;
        for (const item of pool) {
          if (stopped()) throw new TaskStopError();
          const accountId = String(item.accountId);
          if (unhealthy.has(accountId)) continue; // 本 run 内已判定不可用，不再重试
          const blk = blocked(state, accountId, now());
          if (blk.blocked) continue; // 频繁冷却/今日停用：本轮跳过，下轮再看
          const list = blocks[accountId];
          if (!list.length) continue;
          await closePrevious(accountId);
          // 账号切换间隔（首个账号不等待）
          if (progressed) {
            const base = Math.max(0, Number(settings.dm.accountSwitchIntervalSec ?? 0));
            const gap = Math.round(base * (1 + (Math.random() * 0.6 - 0.3)) * 1000);
            setTask({ stage: 'waiting_account', status: `账号切换间隔，剩余 ${Math.ceil(gap / 1000)} 秒，可随时停止`, waitingUntil: new Date(now() + gap).toISOString() });
            const until = now() + gap;
            while (now() < until) { if (stopped()) throw new TaskStopError(); await sleep(Math.min(1000, until - now())); }
          }
          const batch = list.splice(0, Math.max(1, Number(settings.dm.batchPerAccount) || 5));
          // 分发全程由 distributionActive 占用任务槽（server.js 的 engineBusy 已读它）。
          // 批次由 runTask 自己置位 running，这里必须先释放，否则 runTask 的守卫会拒绝本批。
          setTask({ running: false, stage: 'running_batch', status: `账号 ${accountName(accountId)} 正在执行一批 ${batch.length} 人`, done: summary.done, total: summary.totalCandidates, currentLead: null });
          let result, plannedIds = null;
          try {
            const plan = createPlan(accountId, 'outreach', { follow: true, dm: true, leadIds: batch.map(l => String(l.id)), crossAccount: true, dmTemplate: item.template, owner: 'distribution' });
            plannedIds = Array.isArray(plan.leadIds) ? new Set(plan.leadIds.map(String)) : null;
            // 预检查已把本批全部排除（已联系过等）：无需打开浏览器
            if (plannedIds && !plannedIds.size) result = { ok: true, processedLeadIds: [] };
            else {
              openAccountId = accountId;
              result = await runOutreach(accountId, { planId: plan.id, follow: true, dm: true });
            }
          } catch (error) {
            if (error instanceof TaskStopError) throw error;
            result = { ok: false, error: error.message, errorCode: error.code || '' };
          }
          result = result || { ok: false, error: '未知异常' };
          // 本批拆成三类：预检查排除（按跳过计）、已处理、未处理（回池）。
          // 已处理以 runTask 返回的 processedLeadIds 为准；没有该字段时按 ok 整批已处理 / 失败整批未处理。
          const planned = plannedIds ? batch.filter(l => plannedIds.has(String(l.id))) : batch;
          const excludedByPlan = plannedIds ? batch.filter(l => !plannedIds.has(String(l.id))) : [];
          const processedIds = Array.isArray(result.processedLeadIds) ? new Set(result.processedLeadIds.map(String))
            : new Set(result.ok ? planned.map(l => String(l.id)) : []);
          const processed = planned.filter(l => processedIds.has(String(l.id)));
          const unprocessed = planned.filter(l => !processedIds.has(String(l.id)));
          for (const lead of [...processed, ...excludedByPlan]) {
            const entry = allocations[lockKey(lead)];
            if (entry) entry.consumed = true;
          }
          store.setAllocations(allocations);
          returnToPool(accountId, unprocessed);
          // 不论本批是否中途停止，已发生的关注/私信都计入汇总
          const skippedNow = (Number(result.skipped) || 0) + excludedByPlan.length;
          summary.done += processed.length + excludedByPlan.length;
          summary.success += Number(result.dmCount) || 0;
          summary.followCount = (Number(summary.followCount) || 0) + (Number(result.followCount) || 0);
          summary.pending += Number(result.pendingCount) || 0;
          summary.failed += Number(result.failedCount) || 0;
          summary.skipped += skippedNow;
          summary.perAccount[accountId].success += Number(result.dmCount) || 0;
          const tally = `关注 ${Number(result.followCount) || 0}｜私信成功 ${Number(result.dmCount) || 0}｜待核验 ${Number(result.pendingCount) || 0}｜失败 ${Number(result.failedCount) || 0}｜跳过 ${skippedNow}`;
          // 用户停止优先于任何信号归类：不能把“已手动停止”误记为账号频繁/上限/异常
          if (stopped() || taskState.stopRequested) throw new TaskStopError('已手动停止，剩余用户保留待分配');
          const signal = result.ok === false ? signals.classifyAccountSignal(result.errorCode, result.error) : null;
          if (result.ok) {
            softFailures.delete(accountId);
            store.log(accountId, `分发执行：本批 ${batch.length} 人完成（${tally}）`);
          } else if (signal === 'daily_limit') {
            markDailyLimit(state, accountId, settings, opDay);
            saveState(state);
            const rest = reclaimAccount(accountId);
            store.log(accountId, `私信分发：平台提示今日私信已达上限，本账号今日停用；本批已处理 ${processed.length} 人（${tally}），未处理 ${unprocessed.length} 人及剩余 ${rest} 人回池`);
          } else if (signal === 'frequent') {
            markFrequent(state, accountId, settings, opDay, now());
            saveState(state);
            const rest = reclaimAccount(accountId);
            store.log(accountId, `私信分发：平台提示操作频繁，本账号进入冷却并排到队尾；本批已处理 ${processed.length} 人（${tally}），未处理 ${unprocessed.length} 人及剩余 ${rest} 人回池`);
          } else {
            const reason = result.error || '未知异常';
            const code = String(result.errorCode || '');
            // 软件授权失效：换哪个账号都无法执行，整体暂停（未处理用户已回池，保留待分配）
            if (/^AUTH_/.test(code)) throw new TaskStopError(reason, code);
            // 本批处理了用户就说明账号还能用；连续多批一个都没处理成才累计
            const strikes = processed.length ? 0 : (softFailures.get(accountId) || 0) + 1;
            softFailures.set(accountId, strikes);
            if (levelOf(code) === 'account' || strikes >= SOFT_FAILURE_LIMIT) {
              // 登录/平台验证/窗口关闭等账号级异常，或连续多批没处理成任何用户：本次分发内不再使用，剩余用户回池交给其他账号
              unhealthy.add(accountId);
              state[accountId] = { ...(state[accountId] || {}), opDay, lastStopReason: reason };
              saveState(state);
              const rest = reclaimAccount(accountId);
              store.log(accountId, `私信分发：本账号异常暂停（${reason}），本次分发内不再使用；未处理 ${unprocessed.length} 人及剩余 ${rest} 人回池`);
            } else {
              // 接收人级/连续用户异常/无法归类：不作废账号，只让本批未处理用户回池，下轮继续使用该账号
              store.log(accountId, `私信分发：本批中断（${reason}），已处理 ${processed.length} 人（${tally}），未处理 ${unprocessed.length} 人回池，本账号下轮继续`);
            }
          }
          progressed = true;
          publish({ done: summary.done, success: summary.success, followCount: summary.followCount, pending: summary.pending, failed: summary.failed, skipped: summary.skipped, perAccount: summary.perAccount, unassigned: unassigned.length });
          checkpoint({ state: 'running', distributionSummary: { ...summary }, stopReason: '' });
        }
        // 一轮结束：所有可用号都发过一批 → 统一休息 roundRestSec（默认 5 分钟）再开始下一轮；单号即每批后休息
        const roundRestMs = Math.max(0, Number(settings.dm.roundRestSec ?? 300)) * 1000;
        if (progressed && roundRestMs && remainingCount() > 0) {
          await closePrevious('');
          const until = now() + roundRestMs;
          store.log(String(pool[0].accountId), `私信分发：本轮各账号已发完一批，统一休息 ${Math.round(roundRestMs / 60000)} 分钟后开始下一轮，剩余 ${remainingCount()} 人`);
          while (now() < until) {
            const sec = Math.ceil((until - now()) / 1000);
            setTask({ stage: 'waiting_round', status: `本轮已完成，休息 ${sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒'}后开始下一轮（剩余 ${remainingCount()} 人），可随时停止`, waitingUntil: new Date(until).toISOString() });
            if (stopped()) throw new TaskStopError('已手动停止，剩余用户保留待分配');
            await sleep(Math.min(1000, until - now()));
          }
          setTask({ waitingUntil: null });
        }
        // 没有任何账号能执行时，若仍有账号只是频繁冷却则等它恢复，否则结束
        if (!progressed) {
          const resumeAt = cooldownResumeAt();
          if (!resumeAt) break;
          await closePrevious('');
          store.log(String(pool[0].accountId), `私信分发：所有可用账号处于频繁冷却，等待至 ${new Date(resumeAt).toLocaleTimeString('zh-CN', { hour12: false })} 后继续，剩余 ${remainingCount()} 人`);
          await waitForCooldown(resumeAt);
        }
        // 回池用户合并分配给仍可用的账号（不覆盖各账号尚未执行的预留）
        allocateNow();
        summary.unassigned = unassigned.length;
        publish({ perAccount: summary.perAccount, unassigned: summary.unassigned });
      }
      // 结束时仍预留在账号手里未执行的用户（如达到轮数上限）一律回池并释放锁
      for (const item of pool) reclaimAccount(String(item.accountId));
      summary.unassigned = unassigned.length;
      if (cycleCapReached && unassigned.length) {
        summary.stopReason = `已达到单次分发 ${MAX_CYCLES} 轮上限，剩余 ${unassigned.length} 人未执行，请重新启动分发继续`;
        store.log(String(pool[0].accountId), '私信分发：' + summary.stopReason);
      } else if (unassigned.length) {
        summary.stopReason = '本轮无可用私信账号或额度不足，剩余用户待明日8点后继续';
      }
      summary.status = 'completed';
      const remaining = unassigned.length;
      publish({ completedAt: store.nowStr() });
      checkpoint({ state: 'completed', stopReason: summary.stopReason, distributionSummary: { ...summary } });
      setTask({ kind: 'dm_distribution', distributionActive: false, running: false, stage: 'distribution_done', waitingUntil: null,
        status: summary.stopReason || `分发结束：覆盖 ${summary.done} 人｜关注 ${summary.followCount}｜私信成功 ${summary.success}｜待核验 ${summary.pending}｜失败 ${summary.failed}｜待分配 ${remaining}`,
        detail: sameIpGroups.length ? '警告：以下账号共用同一 IP，建议一账号一代理：' + sameIpGroups.map(g => g.join('/')).join('；') : '' });
      return { ok: true, runId, ...summary };
    } catch (error) {
      const stoppedTask = error instanceof TaskStopError || taskState.stopRequested;
      summary.status = stoppedTask ? 'paused' : 'error';
      summary.stopReason = error.message;
      // 停止/异常时尚未执行的用户（池子 + 各账号预留）都计入待分配，不能显示为已完成
      summary.unassigned = remainingCount();
      publish({ completedAt: store.nowStr() });
      checkpoint({ state: stoppedTask ? 'paused' : 'error', stopReason: error.message, distributionSummary: { ...summary } });
      setTask({ kind: 'dm_distribution', distributionActive: false, running: false, waitingUntil: null, status: '私信分发已暂停：' + error.message });
      return { ok: false, runId, error: error.message, ...summary };
    } finally {
      // 兜底：任何路径都必须释放分发任务槽，否则后续任务会被误判为“已有任务在运行”。
      setTask({ distributionActive: false });
    }
  }

  /** 分配预览：不写锁、不执行 */
  function dmDistributionPreview(input) {
    const settings = store.getSettings();
    const accounts = store.getAccounts();
    const poolInput = Array.isArray(input && input.poolAccounts) ? input.poolAccounts : [];
    const pool = poolInput.map(item => {
      const accountId = String(typeof item === 'string' ? item : item && item.accountId);
      if (!accounts.some(a => String(a.id) === accountId)) throw new Error('私信账户池中存在无效账号，请刷新后重新选择');
      return { accountId, template: '' };
    }).filter((item, index, list) => list.findIndex(x => x.accountId === item.accountId) === index);
    if (!pool.length) throw new Error('请至少选择一个私信账户');
    const opDay = store.opDayStr();
    const state = readState(opDay, now());
    const { rows, needs, excluded, sourceRows, duplicateRows } = candidates(settings, input || {});
    const { blocks, leftovers } = allocateLeads(pool, rows, settings, state, opDay, needs);
    const perAccount = pool.map(item => {
      const accountId = String(item.accountId);
      const usage = store.getDailyUsage(accountId);
      const cap = estimateCap(state[accountId]);
      const blk = blocked(state, accountId, now());
      return {
        accountId,
        name: (accounts.find(a => String(a.id) === accountId) || {}).name || accountId,
        count: (blocks[accountId] || []).length,
        todaySent: Number(usage.dm) || 0,
        estimatedCap: cap.value,
        capSource: cap.source,
        blocked: blk.blocked ? blk.kind : ''
      };
    });
    return { ok: true, totalCandidates: rows.length, sourceRows, duplicateRows, exclusions: excluded,
      scope: input.leadIds ? { mode: 'selected', count: input.leadIds.length } : { mode: 'filters', filters: input.filters || {} },
      perAccount, unassigned: leftovers.length, sameIpWarning: proxyGroup(pool.map(item => accounts.find(a => String(a.id) === item.accountId)).filter(Boolean)) };
  }

  return { dmDistributionTask, dmDistributionPreview };
}

module.exports = { createDmDistribution };
