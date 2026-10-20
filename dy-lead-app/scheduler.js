/* 可停止调度器：仅评论翻页、作品切换、用户切换三处控制节奏。 */
class TaskStopError extends Error {
  constructor(message = '已手动停止', code = 'TASK_STOPPED') { super(message); this.code = code; }
}

function bounded(value, fallback, min = 0, max = 86400) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

class ActionScheduler {
  constructor({ settings, stopped, authorize, sleep, update = () => {}, now = Date.now, random = Math.random, errorBoundary = 'action', dmSession = null }) {
    this.settings = settings; this.stopped = stopped; this.authorize = authorize;
    this.sleep = sleep; this.update = update; this.now = now; this.random = random;
    // 独立截止时间，避免翻页、作品和用户间隔互相叠加。
    // 旧 workPeriods/break/nextAt 配置不再影响任务。
    this.boundaries = { collect: 0, user: 0, scroll: 0 };
    this.actions = 0; this.consecutiveErrors = 0;
    this.aiAttempts = 0; this.aiConsecutiveErrors = 0;
    // 私信会话级冷却：每成功发送 N 条后强制休息随机 Pmin~Pmax 秒
    this.dmSessionCount = 0;
    this.dmSessionPauseUntil = 0;
    this.restoreDmSession(dmSession);
    this.errorBoundary = errorBoundary;
  }
  checkStopped() { if (this.stopped()) throw new TaskStopError(); }
  dmSessionPause() {
    const pause = this.settings.dm && this.settings.dm.sessionPause || {};
    return {
      count: bounded(pause.count, 5, 1, 200),
      minMs: bounded(pause.pauseMinSec, 60, 5, 86400) * 1000,
      maxMs: Math.max(bounded(pause.pauseMinSec, 60, 5, 86400), bounded(pause.pauseMaxSec, 300, 5, 86400)) * 1000
    };
  }
  // 强制休息的计数与截止时间按账号持久化（每批新建调度器也能接着算），见 engine-actions runTask
  restoreDmSession(saved) {
    if (!saved || typeof saved !== 'object') return;
    this.dmSessionCount = Math.max(0, Math.floor(Number(saved.count) || 0));
    this.dmSessionPauseUntil = Math.max(0, Number(saved.pauseUntil) || 0);
  }
  dmSessionState() { return { count: this.dmSessionCount, pauseUntil: this.dmSessionPauseUntil }; }
  afterDmSent() {
    const pause = this.dmSessionPause();
    this.dmSessionCount++;
    if (this.dmSessionCount >= pause.count) {
      this.dmSessionCount = 0;
      const delay = Math.round(pause.minMs + this.random() * (pause.maxMs - pause.minMs));
      this.dmSessionPauseUntil = this.now() + delay;
      this.update({ status: `已连续私信 ${pause.count} 条，强制休息 ${Math.round(delay / 1000)} 秒，可随时停止`, waitingUntil: new Date(this.dmSessionPauseUntil).toISOString() });
    }
  }
  async waitUntil(when, boundary) {
    const labels = {
      collect: { stage: 'waiting_work', waitingReason: 'work', label: '下一作品间隔' },
      user: { stage: 'waiting_user', waitingReason: 'user', label: '下一用户间隔' },
      scroll: { stage: 'waiting_comments', waitingReason: 'comments', label: '评论翻页间隔' },
      dm_session: { stage: 'waiting_dm_session', waitingReason: 'dm_session', label: '私信会话强制休息' }
    };
    const display = labels[boundary];
    try {
      while (this.now() < when) {
        this.checkStopped();
        const remaining = Math.ceil((when - this.now()) / 1000);
        this.update({ stage: display.stage, waitingReason: display.waitingReason,
          status: `${display.label}，剩余 ${remaining} 秒，可随时停止`, waitingUntil: new Date(when).toISOString() });
        await this.sleep(Math.min(1000, Math.max(1, when - this.now())));
      }
      this.checkStopped();
    } finally { this.update({ waitingUntil: null, waitingReason: '' }); }
  }
  between(min, max) {
    const low = bounded(min, 0), high = Math.max(low, bounded(max, low));
    return Math.round((low + this.random() * (high - low)) * 1000);
  }
  interval(kind) {
    const s = this.settings, c = s.collect || {}, action = s.action || {};
    if (kind === 'collect') {
      const base = bounded(c.linkIntervalSec, 10), ratio = bounded(c.linkIntervalJitter, 0.2, 0, 1);
      return this.between(base * (1 - ratio), base * (1 + ratio));
    }
    if (kind === 'scroll') {
      const base = bounded(c.scrollIntervalSec, 3), ratio = bounded(c.scrollJitter, 0.4, 0, 1);
      return this.between(base * (1 - ratio), base * (1 + ratio));
    }
    if (kind === 'user') {
      const base = bounded(action.userIntervalSec, 10), ratio = bounded(action.userIntervalJitter, 0.4, 0, 1);
      return this.between(base * (1 - ratio), base * (1 + ratio));
    }
    return 0;
  }
  scheduleBoundary(kind) {
    if (!Object.hasOwn(this.boundaries, kind)) throw new Error('未知节奏边界：' + kind);
    this.boundaries[kind] = this.now() + this.interval(kind);
    return this.boundaries[kind];
  }
  async before(meta) {
    this.checkStopped();
    const boundary = meta.kind === 'video' ? 'collect' : meta.kind === 'visit' ? 'user'
      : meta.kind === 'scroll' && meta.operation !== 'open_comments' ? 'scroll' : null;
    if (boundary) await this.waitUntil(this.boundaries[boundary], boundary);
    // 私信会话级强制休息：任何即将执行的私信动作都必须先等冷却结束
    if (meta.kind === 'dm' && this.dmSessionPauseUntil > this.now()) {
      await this.waitUntil(this.dmSessionPauseUntil, 'dm_session');
      this.update({ status: '私信会话强制休息结束，继续执行', waitingUntil: null, waitingReason: '' });
    }
    this.checkStopped();
    const result = await this.authorize(meta);
    if (result === false || result && (result.ok === false || result.valid === false)) throw new TaskStopError(result && result.error || '授权无效，已暂停任务', 'AUTH_REQUIRED');
    this.checkStopped();
    this.update({ waitingUntil: null, waitingReason: '' });
  }
  async prepare(meta, operation) {
    // 本地准备立即进行；授权与停止检查始终保留。
    this.checkStopped();
    const result = await this.authorize(meta);
    if (result === false || result && (result.ok === false || result.valid === false)) throw new TaskStopError(result && result.error || '授权无效，已暂停任务', 'AUTH_REQUIRED');
    this.checkStopped();
    this.update({ waitingUntil: null, waitingReason: '' });
    const value = await operation();
    this.checkStopped();
    return value;
  }
  complete(kind, { error = false, attempted = true, deferAiBoundary = false } = {}) {
    if (kind === 'ai') {
      this.aiAttempts++;
      this.aiConsecutiveErrors = error ? this.aiConsecutiveErrors + 1 : 0;
      this.update({ aiAttempts: this.aiAttempts, aiConsecutiveErrors: this.aiConsecutiveErrors });
      if (!deferAiBoundary && this.aiConsecutiveErrors >= bounded(this.settings.ai && this.settings.ai.maxConsecutiveErrors, 3, 1, 100)) {
        throw new TaskStopError(`AI 连续 ${this.aiConsecutiveErrors} 次异常，已暂停，请检查模型回执或接口状态后重试`, 'AI_CONSECUTIVE_ERRORS');
      }
      return;
    }
    if (attempted && ['video', 'scroll', 'open_comments', 'visit', 'follow', 'dm'].includes(kind)) this.actions++;
    if (error) this.consecutiveErrors++;
    else if (attempted && ['follow', 'dm'].includes(kind)) this.consecutiveErrors = 0;
    if (attempted && kind === 'scroll') this.scheduleBoundary('scroll');
    const h = this.settings.human || {};
    this.update({ attempts: this.actions, consecutiveErrors: this.consecutiveErrors });
    // Outreach owns a per-user boundary: persist/count the current result
    // before pausing. Collection retains the per-action circuit breaker.
    if (this.errorBoundary !== 'user' && this.consecutiveErrors >= bounded(h.maxConsecutiveErrors, 3, 1, 100)) throw new TaskStopError(`连续 ${this.consecutiveErrors} 次异常，已暂停，请检查账号和页面后重新预检查`, 'CONSECUTIVE_ERRORS');
  }
  async run(meta, operation, options) {
    await this.before(meta, options);
    let failed = false, attempted = true, cancelled = false, operationError = null;
    try {
      const result = await operation();
      failed = !!(result && result.anomaly); attempted = !(result && result.skipped);
      return result;
    } catch (e) {
      operationError = e;
      cancelled = e instanceof TaskStopError; failed = !cancelled; attempted = e.actionNotStarted !== true;
      throw e;
    } finally {
      if (!cancelled) {
        // The caller may defer only a recoverable AI failure while a bounded
        // lower-budget strategy remains. Count the error; never reset it here.
        const deferAiBoundary = meta.kind === 'ai' && failed && typeof options?.deferAiFailure === 'function' && options.deferAiFailure(operationError) === true;
        try { this.complete(meta.operation === 'open_comments' ? 'open_comments' : meta.kind, { error: failed, attempted, deferAiBoundary }); }
        catch (error) { if (operationError && error.code === 'AI_CONSECUTIVE_ERRORS') error.cause = operationError; throw error; }
      }
    }
  }
  async waitAiRetry(delayMs, check = () => {}, retryReason = 'AI 接口暂时异常') {
    const end = this.now() + Math.min(30000, Math.max(0, Number(delayMs) || 0));
    while (this.now() < end) {
      this.checkStopped(); check();
      const remaining = end - this.now();
      this.update({ status: `${retryReason}，${Math.ceil(remaining / 1000)} 秒后重试，可随时停止`, waitingUntil: new Date(end).toISOString() });
      await this.sleep(Math.min(250, remaining));
    }
    this.checkStopped(); check();
    this.update({ waitingUntil: null, waitingReason: '' });
  }
}

module.exports = { ActionScheduler, TaskStopError, bounded };
