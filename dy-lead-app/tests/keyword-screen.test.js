'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const K = require('../lib/keyword-screen');
const AI = require('../ai');
const W = require('../workflow');
const { filterLeads } = require('../lead-query');

test('关键词统一全半角与大小写，去除空词和重复词并保留自定义短词', () => {
  assert.deepEqual(K.normalizeKeywords({ intent: [' ＡＳＩＮ ', 'asin', ' ', '', '申诉', '申诉', 3, '搞'], exclude: [' AD ', 'ad', ''] }), { intent: ['asin', '申诉', '搞'], exclude: ['ad'] });
  assert.deepEqual(K.normalizeKeywords(null), { intent: [], exclude: [] });
  assert.equal(K.matchIntent('重复创建ＡＳＩＮ', { intent: ['Asin'] }).kw, 'asin');
});
test('按最具体短语显示触发词，同词表换序不会改变结果', () => {
  const intent = ['价格', '价格是多少', '多少'];
  assert.equal(K.matchIntent('价格是多少？', { intent }).kw, '价格是多少');
  assert.deepEqual(K.matchIntent('价格是多少？', { intent }), K.matchIntent('价格是多少？', { intent: intent.toReversed() }));
  assert.equal(K.keywordSignature({ intent }), K.keywordSignature({ intent: intent.toReversed() }));
});
test('新默认补全具体事故、短求助和价格联络表达', () => {
  for (const text of ['协议三', '协议3', '关联呢', '视频审核失败的呢', '法人不视频，能提现吗', '受限商品封店，能整不', '多钱处理', '我需要', '我也是今天收到的，13天内视频验证', '私我一下，帮我看下', '我的店铺点进去显示不存在', '什么时候不用先付款，就相信你们不是在搞诈骗']) {
    assert.equal(K.matchIntent(text, K.DEFAULT_KEYWORDS).hit, true, text);
  }
});
test('默认不再因单字怎么搞救命中无关评论，也不把服务商和案例硬排除', () => {
  for (const text of ['怎么拍照做图', '这人搞笑', '救命这首歌太好听', '[赞][玫瑰]']) assert.equal(K.matchIntent(text, K.DEFAULT_KEYWORDS).hit, false, text);
  for (const text of ['找服务商被骗了，我的店铺还能申诉吗', '有成功案例吗，怎么联系']) assert.equal(K.matchIntent(text, K.DEFAULT_KEYWORDS).excluded, false, text);
  assert.deepEqual(K.DEFAULT_KEYWORDS.exclude, []);
});
test('只有精确旧默认词表迁移，自定义添加修改和排除词保留', () => {
  assert.equal(K.isLegacyDefaultKeywords({ intent: [...K.LEGACY_DEFAULT_INTENT], exclude: [] }), true);
  for (const words of [
    { intent: [...K.LEGACY_DEFAULT_INTENT, '客户自定义'], exclude: [] },
    { intent: [...K.LEGACY_DEFAULT_INTENT].reverse(), exclude: [] },
    { intent: [...K.LEGACY_DEFAULT_INTENT], exclude: ['客户排除'] },
    { intent: ['申诉'], exclude: [] }
  ]) assert.equal(K.isLegacyDefaultKeywords(words), false);
});
test('历史重算只改变粗筛字段，保留完整AI、账号和联系历史且不修改输入', () => {
  const lead = { id: 1, demand: '协议三怎么处理', trigger: '', intent: false, excluded: false, uid: 'fixture', accountId: 'fixture-account', aiDone: true, aiNeed: '否', aiReason: '历史判断', aiPromptVersion: 'fixture-version', aiInputHash: 'fixture-hash', followedAt: 'fixture-time', dmCount: 1, dmState: 'confirmed_success', doNotContact: true };
  const before = structuredClone(lead), result = K.reclassifyLeads([lead], K.DEFAULT_KEYWORDS);
  assert.equal(result.changed, 1); assert.deepEqual(lead, before);
  assert.deepEqual(result.leads[0], { ...before, trigger: '怎么处理', intent: true, excluded: false });
  assert.equal(K.reclassifyLeads(result.leads, K.DEFAULT_KEYWORDS).changed, 0);
});
test('命中排除仅改变粗筛，有效AI是仍优先，关键词不能覆盖AI否或授予发送许可', () => {
  const settings = { ai: { prompt: '按业务相关性判断' }, follow: { enabled: true }, dm: { enabled: true }, outreach: { businessId: 'default' } };
  const lead = { id: 1, demand: '被服务商骗了，能申诉吗', uid: 'fixture', aiNeed: '是', aiReason: '描述问题并询问能否申诉', aiDone: true };
  lead.aiPromptVersion = AI.getRuleSet(settings).version; lead.aiInputHash = W.aiInputHash(lead);
  const screened = K.reclassifyLeads([lead], { intent: ['申诉'], exclude: ['服务商'] }).leads[0];
  assert.equal(screened.excluded, true); assert.equal(screened.intent, false);
  assert.equal(W.intentEligibility(screened, settings).ok, true);
  assert.equal(W.intentEligibility({ ...screened, aiNeed: '否', intent: true, trigger: '申诉' }, settings).ok, false);
  assert.equal(W.intentEligibility({ ...screened, aiNeed: '', aiDone: false, intent: true, trigger: '申诉' }, settings).ok, false);
});
test('无触发词评论仍在全部筛选和AI待判范围，关键词筛选只缩小用户明确选择的范围', () => {
  const leads = [{ id: 1, demand: '我跟你一样', trigger: '', intent: false, aiDone: false, isAuthor: false }, { id: 2, demand: '怎么处理', trigger: '怎么处理', intent: true, aiDone: false, isAuthor: false }];
  const pending = filterLeads(leads, {}, { f: 'all' }).filter(lead => !lead.isAuthor && lead.demand.trim() && !lead.aiDone);
  assert.deepEqual(pending.map(lead => lead.id), [1, 2]);
  assert.deepEqual(filterLeads(leads, {}, { f: 'trigger' }).map(lead => lead.id), [2]);
});
test('采集引擎兼容包装实际复用纯关键词规则，不保留旧的单字匹配实现', () => {
  const source = fs.readFileSync(path.join(__dirname, '../engine.js'), 'utf8');
  const start = source.indexOf('function matchIntent('), end = source.indexOf('function applyTemplate(', start);
  assert(start >= 0 && end > start);
  const context = vm.createContext({ screenKeywords: K.matchIntent });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.matchIntent('协议三', K.DEFAULT_KEYWORDS).hit, true);
  assert.equal(context.matchIntent('这人搞笑', K.DEFAULT_KEYWORDS).hit, false);
});
