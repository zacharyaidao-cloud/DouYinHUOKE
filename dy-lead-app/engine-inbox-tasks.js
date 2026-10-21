'use strict';
/**
 * 私信归集任务：逐个账号打开私信页，被动读取会话与消息（只读，不点会话、不发送），
 * 合并到 inbox.json，并把“我们私信过的线索回复了”标记为已回复。
 *
 * 账号窗口已打开：在该窗口里新开一个标签页读取后关掉，不打扰正在看的页面；
 * 没打开：后台启动该账号浏览器，读完关闭。内嵌浏览器窗口正开着时跳过（请关闭后再检查）。
 */
const { TaskStopError } = require('./scheduler');
const { scanInbox } = require('./core/inbox');
const { mergeScan, linkLeadReplies } = require('./lib/inbox-store');

function createInboxTasks({ store, taskState, setTask, failTask, authorize, getAlive, launchAccount, closeAccount, refreshLeadStatus = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), gapMs = () => 5000 + Math.round(Math.random() * 5000), scanOptions = {} }) {
  const checkStopped = () => { if (taskState.stopRequested) throw new TaskStopError('已手动停止'); };

  async function scanOne(accountId) {
    await authorize({ accountId, kind: 'inbox' });
    checkStopped();
    let alive = getAlive(accountId), page = null, tempPage = null, launched = false;
    try {
      if (alive && alive.page && !alive.page.isClosed()) {
        if (alive.embedded || !alive.context || typeof alive.context.newPage !== 'function') {
          return { accountId, ok: false, reason: '账号的内嵌浏览器窗口正在使用，请关闭该账号窗口后再检查私信', code: 'INBOX_WINDOW_BUSY' };
        }
        tempPage = await alive.context.newPage();
        page = tempPage;
      } else {
        alive = await launchAccount(accountId, { headless: true, checkStopped });
        launched = true;
        page = alive.page;
      }
      const scan = await scanInbox(page, { ...scanOptions, checkStopped, trace: { step: (name, data) => { if (name === 'inbox.done') store.log(accountId, '私信归集：' + JSON.stringify(data)); } } });
      if (!scan.ok) return { accountId, ok: false, reason: scan.reason, code: scan.code };
      const merged = mergeScan(store.getInbox(), { accountId, scan });
      store.setInbox(merged.inbox);
      const leads = store.getLeads();
      const marked = linkLeadReplies(leads, merged.inbox);
      if (marked) { for (const lead of leads) if (lead.replied) refreshLeadStatus(lead); store.setLeads(leads); }
      const peerConversations = scan.conversations.filter(c => c.messages.some(m => m.senderUid !== scan.selfUid && m.kind !== 'system')).length;
      store.log(accountId, `私信归集：读到 ${scan.conversations.length} 个会话（对方发过消息 ${peerConversations} 个），${merged.firstScan ? '首次扫描已建立基线' : `新消息 ${merged.newPeerMessages.length} 条`}，新标记已回复线索 ${marked} 个`);
      return { accountId, ok: true, conversations: scan.conversations.length, peerConversations, newMessages: merged.newPeerMessages.length, firstScan: merged.firstScan, repliedLeads: marked };
    } finally {
      if (tempPage) await tempPage.close().catch(() => {});
      if (launched) await closeAccount(accountId).catch(() => {});
    }
  }

  async function inboxTask(accountIds) {
    if (taskState.running) return failTask('已有任务在运行');
    const ids = [...new Set((Array.isArray(accountIds) ? accountIds : [accountIds]).map(String).filter(Boolean))];
    if (!ids.length) return failTask('请先选择要检查私信的账号');
    setTask({ kind: 'inbox', running: true, stopRequested: false, stage: 'inbox', status: `正在检查 ${ids.length} 个账号的私信`, done: 0, total: ids.length, errors: [], inboxSummary: null });
    const results = [];
    try {
      for (let index = 0; index < ids.length; index++) {
        checkStopped();
        const accountId = ids[index];
        setTask({ status: `正在读取账号 ${accountId} 的私信（${index + 1}/${ids.length}），只读不发送`, done: index });
        let result;
        try { result = await scanOne(accountId); }
        catch (error) {
          if (error instanceof TaskStopError && (error.code === 'TASK_STOPPED' || error.code === 'AUTH_REQUIRED' || taskState.stopRequested)) throw error;
          result = { accountId, ok: false, reason: error.message || '读取失败', code: error.code || '' };
        }
        results.push(result);
        setTask({ done: index + 1, inboxSummary: results });
        if (index < ids.length - 1) { const gap = gapMs(); const until = Date.now() + gap; while (Date.now() < until) { checkStopped(); await sleep(Math.min(500, until - Date.now())); } }
      }
      const ok = results.filter(r => r.ok);
      const status = `私信检查完成：${ok.length}/${results.length} 个账号，新消息 ${ok.reduce((n, r) => n + r.newMessages, 0)} 条，新标记已回复线索 ${ok.reduce((n, r) => n + r.repliedLeads, 0)} 个`
        + (results.length > ok.length ? `；未完成 ${results.length - ok.length} 个（${results.filter(r => !r.ok).map(r => r.reason).join('；')}）` : '');
      setTask({ running: false, stage: 'inbox_done', status, inboxSummary: results });
      return { ok: true, results, status };
    } catch (error) {
      setTask({ running: false, stage: 'inbox_stopped', status: '私信检查已停止：' + error.message, inboxSummary: results });
      return { ok: false, error: error.message, results };
    }
  }

  return { inboxTask, scanOne };
}

module.exports = { createInboxTasks };
