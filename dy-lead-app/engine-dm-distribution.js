'use strict';
const crypto = require('node:crypto');
const { TaskStopError } = require('./scheduler');
const signals = require('./lib/dm-account-signals');
const workflow = require('./workflow');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 多账号私信分发器：
 * 联系人池 → 按经验剩余/健康/同视频错峰分配 → 每账号分批(复用 outreachTask) → 轮转执行。
 * 频繁 → 冷却(逐次翻倍)+排队尾；今日上限 → 当日停用(明日8点恢复)；全部不可用 → 整体停止。
 */
function createDmDistribution({ store, taskState, setTask, failTask, checkpoint, createPlan, runOutreach, getSignal }) {
  /* ---------- 账号状态 ---------- */
  function cleanAccountState(raw, opDay, now) {
    const out = {};
    for (const [id, entry] of Object.entries(raw || {})) {
      if (!entry || typeof entry !== 'object') continue;
      const next = { ...entry };
      if (next.opDay !== opDay) { next.opDay = opDay; next.frequentCountToday = 0; next.frequentUntil = null; }
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
    entry.opDay = opDay;
    entry.frequentCountToday = (Number(entry.frequentCountToday) || 0) + 1;
    entry.frequentUntil = now + signals.cooldownFor(settings.dm.frequentCooldownSec, entry.frequentCountToday - 1) * 1000;
    entry.lastStopReason = '平台提示操作频繁';
    if (entry.frequentCountToday > Math.max(0, Number(settings.dm.maxFrequentRetriesPerDay) || 2)) {
      entry.disabledUntil = store.nextResetMs();
      entry.lastStopReason = '频繁次数超限，今日停用';
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
    const now = Date.now();
    const history = workflow.historyIndex(all, settings);
    let rows = all;
    if (options.leadIds) {
      const ids = new Set(options.leadIds.map(String));
      rows = rows.filter(l => ids.has(String(l.id)));
    } else if (options.filters && Object.keys(options.filters).length) {
      rows = require('./lead-query').filterLeads(rows, videos, options.filters, { settings, now });
    }
    const allocations = store.getAllocations();
    // 分发只执行私信。19 条里只有 5 条能发时，必须能说清另外 14 条为什么被排除，
    // 否则界面只会显示“可联系候选 5 人”，看起来像丢数据。
    const excluded = new Map();
    const bump = (reason, count = 1) => excluded.set(reason, (excluded.get(reason) || 0) + count);
    const selected = [];
    for (const lead of rows) {
      if (String(lead.businessId || settings.outreach.businessId || 'default') !== workflow.businessId(settings)) { bump('不属于当前业务'); continue; }
      const eligibility = workflow.eligibility(lead, 'dm', history, settings, now, videos);
      if (!eligibility.ok) { bump(eligibility.reason || '不符合私信条件'); continue; }
      const entry = allocations[workflow.contactKey(lead, settings)];
      // 过期分配锁不再生效；否则一次中断会让这些用户被永久排除。
      if (entry && entry.consumed !== true && !workflow.allocationExpired(entry, now) && String(entry.accountId)) { bump('已分配给其他账号执行'); continue; }
      selected.push(lead);
    }
    const unique = workflow.uniqueContacts(selected, settings);
    if (unique.length < selected.length) bump('同一用户重复评论', selected.length - unique.length);
    unique.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    return { rows: unique, excluded: [...excluded.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })), sourceRows: rows.length, duplicateRows: selected.length - unique.length };
  }

  function allocateLeads(pool, unassigned, settings, state, opDay) {
    const blocks = {};
    const usage = {};
    for (const item of pool) {
      const accountId = String(item.accountId);
      const u = store.getDailyUsage(accountId);
      const cap = estimateCap(state[accountId]);
      const setLimit = Math.max(0, Number(settings.dm.dailyLimit) || 0);
      const capRemaining = settings.dm.adaptiveCap !== false && cap.value > 0 ? Math.max(0, cap.value - Math.max(0, Number(u.dm) || 0)) : Infinity;
      usage[accountId] = { remaining: Math.min(setLimit - Math.max(Number(u.dm) || 0, Number(u.dmAttempts) || 0), capRemaining), perVideo: {} };
      blocks[accountId] = [];
    }
    const leftovers = [];
    const sameVideoLimit = Math.max(1, Number(settings.dm.sameVideoPerBatch) || 2);
    for (const lead of unassigned) {
      const videoKey = String(lead.videoLink || '');
      let best = null, fallback = null;
      for (const item of pool) {
        const accountId = String(item.accountId);
        if (blocked(state, accountId, Date.now()).blocked) continue;
        const u = usage[accountId];
        if (u.remaining <= 0) continue;
        const sameVideo = u.perVideo[videoKey] || 0;
        const score = { remaining: u.remaining, sameVideo };
        const better = other => !other || score.remaining > other.score.remaining || score.remaining === other.score.remaining && score.sameVideo < other.score.sameVideo;
        if (better(fallback)) fallback = { accountId, score };
        if (sameVideo >= sameVideoLimit) continue;
        if (better(best)) best = { accountId, score };
      }
      // 同视频错峰是软约束：所有账号都到该视频上限时回退分配，保证名单能跑完
      const chosen = best || fallback;
      if (!chosen) { leftovers.push(lead); continue; }
      blocks[chosen.accountId].push(lead);
      usage[chosen.accountId].remaining--;
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
    const opDay = store.opDayStr();
    const now = Date.now();
    const state = readState(opDay, now);
    const summary = {
      runId, status: 'running', totalCandidates: 0, perAccount: {}, unassigned: 0,
      done: 0, success: 0, pending: 0, failed: 0, skipped: 0, stopReason: '', sameIpWarning: sameIpGroups
    };
    const publish = patch => { Object.assign(summary, patch); setTask({ kind: 'dm_distribution', distributionSummary: { ...summary } }); };
    setTask({ kind: 'dm_distribution', distributionActive: true, running: true, accountId: String(pool[0].accountId), stage: 'allocating',
      status: '正在生成多账号分发方案', done: 0, total: 0, detail: '', errors: [], distributionSummary: { ...summary } });
    try {
      const candidateResult = candidates(settings, input || {});
      let unassigned = candidateResult.rows;
      summary.excluded = candidateResult.excluded;
      summary.totalCandidates = unassigned.length;
      const allocations = store.getAllocations();
      // 清理过期/已完成的历史分配，避免一次中断让用户被永久排除。
      for (const [key, entry] of Object.entries(allocations)) {
        if (!entry || entry.consumed === true || workflow.allocationExpired(entry, now)) delete allocations[key];
      }
      const allocateNow = () => {
        const { blocks, leftovers } = allocateLeads(pool, unassigned, settings, state, opDay);
        const expiresAt = Date.now() + workflow.ALLOCATION_TTL_MS;
        for (const [accountId, leads] of Object.entries(blocks)) {
          for (const lead of leads) {
            allocations[workflow.contactKey(lead, settings)] = { accountId, kind: 'dm', plannedAt: store.nowStr(), expiresAt, consumed: false };
          }
        }
        store.setAllocations(allocations);
        return { blocks, leftovers };
      };
      let { blocks, leftovers } = allocateNow();
      unassigned = leftovers;
      summary.unassigned = leftovers.length;
      for (const item of pool) summary.perAccount[item.accountId] = { name: (accounts.find(a => String(a.id) === item.accountId) || {}).name || item.accountId, count: (blocks[item.accountId] || []).length, success: 0 };
      publish({ perAccount: summary.perAccount, unassigned: summary.unassigned });
      checkpoint({ id: runId, kind: 'dm_distribution', accountId: String(pool[0].accountId), state: 'running', stopReason: '', distributionSummary: { ...summary } });

      // 轮转执行：每账号每轮一批；失败块回池；无进展或全部停用即结束
      let cycles = 0;
      while ((unassigned.length > 0 || Object.values(blocks).some(list => list.length)) && cycles < 30) {
        if (stopped()) throw new TaskStopError();
        cycles++;
        let progressed = false;
        for (const item of pool) {
          if (stopped()) throw new TaskStopError();
          const accountId = String(item.accountId);
          if (unhealthy.has(accountId)) continue; // 本 run 内已判定不可用，不再重试
          const blk = blocked(state, accountId, Date.now());
          if (blk.blocked) continue; // 频繁冷却/今日停用：本轮跳过，下轮再看
          const list = blocks[accountId] || [];
          if (!list.length) continue;
          // 账号切换间隔（首个账号不等待）
          if (progressed) {
            const base = Math.max(10, Number(settings.dm.accountSwitchIntervalSec) || 90);
            const gap = Math.round(base * (1 + (Math.random() * 0.6 - 0.3)) * 1000);
            setTask({ stage: 'waiting_account', status: `账号切换间隔，剩余 ${Math.ceil(gap / 1000)} 秒，可随时停止`, waitingUntil: new Date(Date.now() + gap).toISOString() });
            const until = Date.now() + gap;
            while (Date.now() < until) { if (stopped()) throw new TaskStopError(); await sleep(Math.min(1000, until - Date.now())); }
          }
          const batch = list.splice(0, Math.max(1, Number(settings.dm.batchPerAccount) || 5));
          setTask({ stage: 'running_batch', status: `账号 ${(accounts.find(a => String(a.id) === accountId) || {}).name || accountId} 正在执行一批 ${batch.length} 人`, done: summary.done, total: summary.totalCandidates, currentLead: null });
          let result;
          try {
            const plan = createPlan(accountId, 'outreach', { follow: false, dm: true, leadIds: batch.map(l => String(l.id)), crossAccount: true, dmTemplate: item.template, owner: 'distribution' });
            result = await runOutreach(accountId, { planId: plan.id, follow: false, dm: true });
          } catch (error) {
            if (error instanceof TaskStopError) throw error;
            result = { ok: false, error: error.message, errorCode: error.code || '' };
          }
          const signal = result && result.ok === false ? signals.classifyAccountSignal(result.errorCode, result.error) : null;
          // 用户停止优先于任何信号归类：不能把“已手动停止”误记为账号频繁/上限/异常
          if (stopped() || taskState.stopRequested) throw new TaskStopError('已手动停止，剩余用户保留待分配');
          if (result && result.ok) {
            for (const lead of batch) {
              const entry = allocations[workflow.contactKey(lead, settings)];
              if (entry) entry.consumed = true;
            }
            store.setAllocations(allocations);
            summary.done += batch.length;
            summary.success += Number(result.dmCount) || 0;
            summary.pending += Number(result.pendingCount) || 0;
            summary.failed += Number(result.failedCount) || 0;
            summary.skipped += Number(result.skipped) || 0;
            if (summary.perAccount[accountId]) summary.perAccount[accountId].success += Number(result.dmCount) || 0;
            store.log(accountId, `私信分发：本批 ${batch.length} 人完成（成功 ${result.dmCount}｜待核验 ${result.pendingCount}｜失败 ${result.failedCount}｜跳过 ${result.skipped}）`);
          } else if (signal === 'daily_limit') {
            markDailyLimit(state, accountId, settings, opDay);
            store.setDmAccountState(state);
            for (const lead of batch) delete allocations[workflow.contactKey(lead, settings)];
            store.setAllocations(allocations);
            unassigned.push(...batch);
            store.log(accountId, '私信分发：平台提示今日私信已达上限，本账号今日停用，剩余用户回池');
          } else if (signal === 'frequent') {
            markFrequent(state, accountId, settings, opDay, Date.now());
            store.setDmAccountState(state);
            for (const lead of batch) delete allocations[workflow.contactKey(lead, settings)];
            store.setAllocations(allocations);
            unassigned.push(...batch);
            store.log(accountId, '私信分发：平台提示操作频繁，本账号进入冷却并排到队尾，剩余用户回池');
          } else {
            // 登录/页面/其他异常：判定本账号本次不可用，剩余用户回池交给其他账号
            unhealthy.add(accountId);
            state[String(accountId)] = { ...(state[String(accountId)] || {}), opDay, lastStopReason: (result && result.error) || '未知异常' };
            store.setDmAccountState(state);
            for (const lead of batch) delete allocations[workflow.contactKey(lead, settings)];
            store.setAllocations(allocations);
            unassigned.push(...batch);
            store.log(accountId, '私信分发：本账号异常暂停（' + ((result && result.error) || '未知') + '），本次分发内不再使用，剩余用户回池');
          }
          progressed = true;
          publish({ done: summary.done, success: summary.success, pending: summary.pending, failed: summary.failed, skipped: summary.skipped, perAccount: summary.perAccount, unassigned: unassigned.length });
          checkpoint({ state: 'running', distributionSummary: { ...summary }, stopReason: '' });
        }
        // 一轮结束：重分配回池用户；本轮无任何执行进展则停止（防空转）
        if (!progressed) break;
        if (unassigned.length) {
          const next = allocateNow();
          blocks = next.blocks; unassigned = next.leftovers;
          summary.unassigned = unassigned.length;
          for (const item of pool) {
            if (!summary.perAccount[item.accountId]) summary.perAccount[item.accountId] = { name: (accounts.find(a => String(a.id) === item.accountId) || {}).name || item.accountId, count: 0, success: 0 };
            summary.perAccount[item.accountId].count += (next.blocks[item.accountId] || []).length;
          }
          publish({ perAccount: summary.perAccount, unassigned: summary.unassigned });
        }
      }
      if (unassigned.length) {
        summary.stopReason = '本轮无可用私信账号或额度不足，剩余用户待明日8点后继续';
      }
      summary.status = 'completed';
      const remaining = unassigned.length;
      publish({ completedAt: store.nowStr() });
      checkpoint({ state: 'completed', stopReason: summary.stopReason, distributionSummary: { ...summary } });
      setTask({ kind: 'dm_distribution', distributionActive: false, running: false, stage: 'distribution_done',
        status: summary.stopReason || `私信分发结束：覆盖 ${summary.done} 人｜确认成功 ${summary.success}｜待核验 ${summary.pending}｜失败 ${summary.failed}｜待分配 ${remaining}`,
        detail: sameIpGroups.length ? '警告：以下账号共用同一 IP，建议一账号一代理：' + sameIpGroups.map(g => g.join('/')).join('；') : '' });
      return { ok: true, runId, ...summary };
    } catch (error) {
      const stoppedTask = error instanceof TaskStopError || taskState.stopRequested;
      summary.status = stoppedTask ? 'paused' : 'error';
      summary.stopReason = error.message;
      publish({ completedAt: store.nowStr() });
      checkpoint({ state: stoppedTask ? 'paused' : 'error', stopReason: error.message, distributionSummary: { ...summary } });
      setTask({ kind: 'dm_distribution', distributionActive: false, running: false, status: '私信分发已暂停：' + error.message });
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
    const state = readState(opDay, Date.now());
    const { rows, excluded, sourceRows, duplicateRows } = candidates(settings, input || {});
    const { blocks, leftovers } = allocateLeads(pool, rows, settings, state, opDay);
    const perAccount = pool.map(item => {
      const accountId = String(item.accountId);
      const usage = store.getDailyUsage(accountId);
      const cap = estimateCap(state[accountId]);
      const blk = blocked(state, accountId, Date.now());
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
