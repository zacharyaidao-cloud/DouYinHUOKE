'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { contactCategory } = require('../lead-query');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const context = {
  esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
};
function readFunction(name, nextName) {
  const start = source.indexOf('function ' + name + '(');
  const next = new RegExp('\\n(?:async )?function ' + nextName + '\\(').exec(source.slice(start + 1));
  assert.ok(start >= 0 && next);
  const end = start + 1 + next.index;
  return vm.runInNewContext('(' + source.slice(start, end).trim() + ')', context);
}
const contactCell = readFunction('compactLeadCell', 'showLeadDetail');
const buttons = readFunction('leadOperationButtons', 'handleLeadClick');

test('重试成功的当前回执优先于残留失败标签，列表和筛选同步恢复', () => {
  const lead = { id: 1, accountId: '1', dmState: 'confirmed_success', dmOutcome: 'confirmed_failure', status: 'dm_failed', dmCount: 1 };
  assert.equal(contactCategory(lead), 'sent');
  assert.match(contactCell(lead, 'contact'), /私信已确认/);
  assert.doesNotMatch(contactCell(lead, 'contact'), /最近私信失败/);
  assert.equal(require('../lead-query').filterLeads([lead], {}, { s: 'dm_failed' }).length, 0);
  const oldFailure = { ...lead, dmState: 'confirmed_failure', dmHistorySentObserved: { state: 'already_sent' } };
  assert.match(contactCell(oldFailure, 'contact'), /历史已私信 · 最近私信失败/);
  assert.equal(contactCategory(oldFailure), 'failed', 'old history cannot change a genuine new rejection');
});

test('紧凑联系栏区分网页历史与软件发送回执，不把未知显示为从未私信', () => {
  const lead = { id: 1, accountId: '1' };
  assert.match(contactCell(lead, 'contact'), /暂无私信记录/);
  assert.doesNotMatch(contactCell(lead, 'contact'), /未私信|待核验|未知/);
  lead.dmHistorySentObserved = { state: 'already_sent' };
  assert.match(contactCell(lead, 'contact'), /历史已私信/);
  assert.doesNotMatch(contactCell(lead, 'contact'), /私信已确认/);
  lead.dmCount = 1; lead.dmState = 'confirmed_success';
  assert.match(contactCell(lead, 'contact'), /私信已确认/);
  lead.dmState = 'pending_verification';
  assert.match(contactCell(lead, 'contact'), /私信待核验/);
  assert.doesNotMatch(contactCell(lead, 'contact'), /历史已私信|私信已确认/);
  lead.dmState = 'confirmed_failure';
  assert.match(contactCell(lead, 'contact'), /最近私信失败/);
});

test('关注栏区分历史与网页观察，其他执行账号的旧复制锁不显示核验按钮', () => {
  const lead = { id: 1, accountId: '2', followedAt: '历史时间', followAttemptAccountId: '1', followState: 'pending_verification' };
  assert.doesNotMatch(contactCell(lead, 'contact'), /关注待核验|曾确认关注/);
  assert.doesNotMatch(buttons(lead), /follow-success|follow-failed/);
  lead.followAttemptAccountId = '2';
  assert.match(contactCell(lead, 'contact'), /关注待核验/);
  assert.match(buttons(lead), /follow-success/);
  lead.followState = 'confirmed_success';
  assert.match(contactCell(lead, 'contact'), /曾确认关注/);
  lead.followObserved = { state: 'following', accountId: '2' };
  assert.match(contactCell(lead, 'contact'), /主页已关注/);
  assert.equal((contactCell(lead, 'contact').match(/<span /g) || []).length, 2, '联系栏仍只有两行');
});

test('联系筛选与紧凑文案使用一致的历史和执行账号含义', () => {
  for (const [lead, category, label] of [
    [{ id: 1, accountId: '1', dmHistoryObserved: { state: 'already_sent' } }, 'sent', '历史已私信'],
    [{ id: 2, accountId: '1', followObserved: { state: 'following', accountId: '1' } }, 'followed', '主页已关注'],
    [{ id: 3, accountId: '1', followAttemptAccountId: '2', followState: 'pending_verification', status: 'follow_pending' }, 'new', '暂无关注记录'],
    [{ id: 4, accountId: '1', dmHistorySentObserved: { state: 'already_sent' }, dmState: 'pending_verification' }, 'pending', '私信待核验']
  ]) {
    assert.equal(contactCategory(lead), category);
    assert.ok(contactCell(lead, 'contact').includes(label));
  }
});

test('选择目标会话和检查私信历史保持打开私信步骤，未知阶段不假回主页', () => {
  const elements = Object.fromEntries(['act-stage-flow', 'act-user-summary'].map(id => [id, { innerHTML: '', textContent: '', classList: { toggle() {} } }]));
  const localContext = { state: null, $: id => elements[id] };
  const start = source.indexOf('function renderActionStages()'), end = source.indexOf("\n$('btn-collection-leads')", start);
  assert.ok(start >= 0 && end > start);
  const render = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', localContext);
  for (const stage of ['opening_dm', 'selecting_conversation', 'checking_dm_history']) {
    localContext.state = { task: { kind: 'outreach', stage, currentLead: { id: 1 } } }; render();
    const active = elements['act-stage-flow'].innerHTML.match(/<div class="action-stage active" aria-current="step">([\s\S]*?)<\/div>/g);
    assert.equal(active.length, 1); assert.match(active[0], /<span>3<\/span><strong>打开私信/);
  }
  localContext.state.task.stage = 'unknown_future_stage'; render();
  assert.doesNotMatch(elements['act-stage-flow'].innerHTML, /aria-current/);
});
