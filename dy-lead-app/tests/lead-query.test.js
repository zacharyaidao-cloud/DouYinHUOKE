'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterLeads, isCommentUser } = require('../lead-query');
const { normalizeFilters, aiCategory, contactCategory, aiFacetCounts, commentTimeMs } = require('../lead-query');
const AI = require('../ai');
const { aiInputHash } = require('../workflow');

test('本次采集范围与搜索、勾选交叉，不会扩大到历史记录', () => {
  const rows = [{ id: 1, collectionRunId: 'run-1', demand: '库存问题' }, { id: 2, collectionRunId: 'run-2', demand: '库存问题' }, { id: 3, collectionRunId: 'run-1', demand: '其他' }];
  assert.deepEqual(filterLeads(rows, {}, { collectionRunId: 'run-1', q: '库存' }).map(x => x.id), [1]);
  assert.deepEqual(filterLeads(rows, {}, { collectionRunId: 'run-1' }, { leadIds: [2] }), []);
  assert.equal(filterLeads(rows, {}, {}).length, 3);
});

test('note 和 video 共用作品描述筛选，筛选和明确所选范围保持一致', () => {
  const leads = [
    { id: 1, accountId: '1', videoLink: 'https://www.douyin.com/note/7693579483274183025', demand: '需要了解', nickname: '测试图文用户' },
    { id: 2, accountId: '1', videoLink: 'https://www.douyin.com/video/7693378601286309625', demand: '围观', nickname: '测试视频用户' }
  ];
  const videos = {
    '7693579483274183025': { desc: '亚马逊新型库存调查，账户申诉' },
    '7693378601286309625': { desc: '无关业务' }
  };
  assert.deepEqual(filterLeads(leads, videos, { q: '库存调查' }).map(lead => lead.id), [1]);
  assert.equal(filterLeads(leads, videos, { q: '库存调查' })[0].videoDesc, videos['7693579483274183025'].desc);
  assert.deepEqual(filterLeads(leads, videos, { q: '库存调查' }, { leadIds: [2] }), []);
  assert.deepEqual(filterLeads(leads, videos, { q: '库存调查' }, { leadIds: [1] }).map(lead => lead.id), [1]);
  assert.equal(filterLeads(leads, videos, { q: '无关业务' })[0].id, 2);
});

test('外域伪作品链接不能借用本地作品描述，未知作品保留线索已有描述', () => {
  const leads = [
    { id: 1, videoLink: 'https://evil.example/note/123', demand: '', videoDesc: '已存说明' },
    { id: 2, videoLink: 'https://www.douyin.com/note/456', demand: '', videoDesc: '本地备注' }
  ];
  assert.deepEqual(filterLeads(leads, { 123: { desc: '敏感匹配描述' } }, { q: '敏感匹配描述' }), []);
  assert.equal(filterLeads(leads, {}, { q: '本地备注' })[0].id, 2);
});

test('本次采集列表和摘要共用评论用户口径，排除作者、空内容、缓存作者', () => {
  const workId = '7693579483274183025', videos = { [workId]: { authorSecUid: 'known-author' } };
  const common = { collectionRunId: 'current-run', demand: '库存处理问题', videoLink: 'https://www.douyin.com/note/' + workId };
  const leads = [
    { ...common, id: 'reader', uid: 'reader' },
    { ...common, id: 'marked-author', uid: 'marked-author', isAuthor: true },
    { ...common, id: 'cached-author', uid: 'known-author', isAuthor: false },
    { ...common, id: 'empty', uid: 'empty', demand: ' \n ' },
    { ...common, id: 'outside', uid: 'outside', collectionRunId: 'old-run' }
  ];
  const summaryRows = leads.filter(row => row.collectionRunId === 'current-run' && isCommentUser(row, videos));
  const shown = filterLeads(leads, videos, { collectionRunId: 'current-run', q: '库存' });
  assert.deepEqual(shown.map(row => row.id), ['reader']); assert.deepEqual(shown.map(row => row.id), summaryRows.map(row => row.id));
  assert.deepEqual(filterLeads(leads, videos, { collectionRunId: 'current-run' }, { leadIds: ['outside', 'cached-author', 'empty'] }), []);
  assert.equal(filterLeads(leads, videos, {}).length, 5, 'The unscoped archive still preserves every original row');
});

test('缓存作者身份按真实作品ID关联，video/note可互认，未知/外域链接不借用作者', () => {
  const videos = { 123: { authorSecUid: 'author' } };
  assert.equal(isCommentUser({ uid: 'author', demand: '评论', videoLink: 'https://www.douyin.com/video/123' }, videos), false);
  assert.equal(isCommentUser({ uid: 'author', demand: '评论', videoLink: 'https://www.douyin.com/note/123?from=share' }, videos), false);
  assert.equal(isCommentUser({ uid: 'author', demand: '评论', videoLink: 'https://foreign.example/note/123' }, videos), true);
  assert.equal(isCommentUser({ uid: 'author', demand: '评论', videoLink: 'https://www.douyin.com/note/456' }, videos), true);
});

test('新AI分类共用完整有效性规则，缺失结果待判断，旧版/变化/无效结果归需重判', () => {
  const settings = { ai: { prompt: '当前规则' } }, videos = { 123: { desc: '业务说明' } };
  const current = need => {
    const lead = { demand: '测试服务需求', time: '2026-10-09 10:00:00', videoLink: 'https://www.douyin.com/video/123', aiDone: true, aiNeed: need, aiReason: '完整有效依据', aiPromptVersion: AI.getRuleSet(settings).version };
    lead.aiInputHash = aiInputHash(lead, videos); return lead;
  };
  const yes = current('是'), no = current('否');
  const rows = [{ id: 1, demand: '待判断评论' }, { ...yes, id: 2 }, { ...no, id: 3 }, { ...yes, id: 4, aiPromptVersion: 'old' },
    { ...yes, id: 5, demand: '评论已经变化' }, { ...yes, id: 6, aiReason: '' }, { id: 7, demand: '旧评论', aiNeed: '待确认' }, { id: 8, demand: '历史评论', aiScore: 60 }];
  assert.deepEqual(rows.map(lead => aiCategory(lead, videos, { settings })), ['ai_todo', 'ai_yes', 'ai_no', 'ai_stale', 'ai_stale', 'ai_stale', 'ai_stale', 'ai_stale']);
  assert.deepEqual(filterLeads(rows, videos, { f: 'ai_yes' }, { settings }).map(lead => lead.id), [2]);
  assert.deepEqual(filterLeads(rows, videos, { f: 'ai_no' }, { settings }).map(lead => lead.id), [3]);
  assert.deepEqual(filterLeads(rows, videos, { f: 'ai_todo' }, { settings }).map(lead => lead.id), [1]);
  assert.equal(filterLeads(rows, { 123: { desc: '作品描述变化' } }, { f: 'ai_yes' }, { settings }).length, 0);
  assert.deepEqual(filterLeads(rows, videos, { f: 'ai' }).map(lead => lead.id), [2, 4, 5, 6], 'legacy AI filter retains its historical contract');
});

test('评论近1/3/7天边界固定，未知/无效/未来时间排除，优先原始Unix秒证据', () => {
  const now = Date.parse('2026-10-10T00:00:00+08:00');
  const rows = [
    { id: 'now', time: '2026-10-10 00:00:00' }, { id: 'day', time: '2026-10-09 00:00:00' },
    { id: 'before-day', time: '2026-10-08 23:59:59.999' }, { id: 'three', time: '2026-10-07 00:00:00' },
    { id: 'week', time: '2026-10-03 00:00:00' }, { id: 'old', time: '2026-10-02 23:59:59' },
    { id: 'empty', time: '' }, { id: 'invalid', time: '2026-02-30 10:00:00' }, { id: 'future', time: '2026-10-10 00:00:01' },
    { id: 'raw', commentTimestamp: now / 1000 - 3600, time: '2020-01-01 00:00:00' },
    { id: 'invalid-raw', commentTimestamp: -1, time: '2026-10-09 12:00:00' }
  ];
  const ids = days => filterLeads(rows, {}, { commentDays: days }, { now }).map(lead => lead.id);
  assert.deepEqual(ids(1), ['now', 'day', 'raw']);
  assert.deepEqual(ids('3'), ['now', 'day', 'before-day', 'three', 'raw']);
  assert.deepEqual(ids(7), ['now', 'day', 'before-day', 'three', 'week', 'raw']);
  assert.equal(ids(0).length, rows.length);
  assert.equal(commentTimeMs('2026-10-09 00:00:00'), commentTimeMs('2026-10-08T16:00:00Z'));
  for (const days of [2, 'bad', [], true]) assert.throws(() => normalizeFilters({ commentDays: days }), /评论时间/);
});

test('触达分类优先阻止状态，待核验不能被历史成功计数当成已发送', () => {
  const rows = [{ id: 1 }, { id: 2, followedAt: 'known' }, { id: 3, dmCount: 1 },
    { id: 4, dmCount: 2, dmState: 'pending_verification' }, { id: 5, dmCount: 2, followState: 'confirmed_failure' },
    { id: 6, doNotContact: true, dmState: 'pending_verification' }, { id: 7, replied: true, dmCount: 1 },
    { id: 8, noDm: true, noDmConfirmed: true }, { id: 9, noDm: true }];
  assert.deepEqual(rows.map(contactCategory), ['new', 'followed', 'sent', 'pending', 'failed', 'blocked', 'replied', 'blocked', 'new']);
  assert.deepEqual(filterLeads(rows, {}, { contact: 'sent' }).map(lead => lead.id), [3]);
  assert.deepEqual(filterLeads(rows, {}, { contact: 'pending' }).map(lead => lead.id), [4]);
  assert.throws(() => normalizeFilters({ contact: 'unknown' }), /触达状态/);
});

test('联系筛选纳入网页已发历史；关注成功/已关注跨账号共享，待核验/失败按执行账号隔离', () => {
  const rows = [
    { id: 1, accountId: '1', dmHistorySentObserved: { state: 'already_sent', accountId: '1', lastSentAt: null } },
    { id: 2, accountId: '1', followObserved: { state: 'following', accountId: '1' } },
    { id: 3, accountId: '1', followObserved: { state: 'following', accountId: '2' } },
    { id: 4, accountId: '1', followedAt: '旧复制记录', followAttemptAccountId: '2', followState: 'pending_verification', status: 'follow_pending' },
    { id: 5, accountId: '1', dmHistoryObserved: { state: 'already_sent' }, dmState: 'pending_verification' },
    { id: 6, accountId: '1', dmHistoryObserved: { state: 'unknown' } },
    { id: 7, accountId: '1', followAttemptAccountId: '2', followState: 'confirmed_failure', dmHistoryObserved: { state: 'already_sent' } }
  ];
  assert.deepEqual(rows.map(contactCategory), ['sent', 'followed', 'followed', 'followed', 'pending', 'new', 'sent']);
  assert.deepEqual(filterLeads(rows, {}, { contact: 'sent' }).map(row => row.id), [1, 7]);
  assert.deepEqual(filterLeads(rows, {}, { contact: 'followed' }).map(row => row.id), [2, 3, 4]);
  assert.deepEqual(filterLeads(rows, {}, { f: 'undm' }).map(row => row.id), [2, 3, 4, 6]);
  assert.deepEqual(filterLeads(rows, {}, { f: 'unfollowed' }).map(row => row.id), [1, 5, 6, 7]);
  assert.deepEqual(filterLeads(rows, {}, { f: 'pending' }).map(row => row.id), [5]);
  assert.equal(rows[0].dmCount, undefined, '显示为已有私信历史不伪造软件成功次数');
});

test('AI分类计数忽略f但保留时间、触达、搜索、本次采集及明确ID范围', () => {
  const now = Date.parse('2026-10-10T00:00:00+08:00'), common = { demand: '服务问题', time: '2026-10-09 12:00:00', collectionRunId: 'run-a' };
  const rows = [{ ...common, id: 1 }, { ...common, id: 2, aiNeed: '是' }, { ...common, id: 3, collectionRunId: 'run-b' },
    { ...common, id: 4, time: '2026-09-01 12:00:00' }, { ...common, id: 5, doNotContact: true }, { ...common, id: 6, demand: '其他' }];
  const filters = { f: 'ai_yes', commentDays: 1, contact: 'new', collectionRunId: 'run-a', q: '服务' };
  assert.deepEqual(aiFacetCounts(rows, {}, filters, { now }), { all: 2, ai_todo: 1, ai_yes: 0, ai_no: 0, ai_stale: 1, ai_excluded: 0 });
  assert.deepEqual(aiFacetCounts(rows, {}, filters, { now, leadIds: [] }), { all: 0, ai_todo: 0, ai_yes: 0, ai_no: 0, ai_stale: 0, ai_excluded: 0 });
  assert.equal(filterLeads(rows, {}, filters, { now }).length, 0);
  assert.equal(normalizeFilters({ trigger: '1' }).f, 'trigger');
  assert.throws(() => normalizeFilters({ f: 'invalid' }), /筛选模式/);
});

test('作者和空评论独立归不参与判断，筛选计数守恒并保留历史结果', () => {
  const videos={123:{authorSecUid:'author'}},rows=[
    {id:1,demand:'普通评论'},
    {id:2,demand:'作者评论',isAuthor:true},
    {id:3,demand:'作者历史评论',uid:'author',videoLink:'https://www.douyin.com/note/123',aiDone:true,aiNeed:'是',aiReason:'历史结果'},
    {id:4,demand:' \n ',aiNeed:'否'},
    {id:5,demand:'旧结果评论',aiNeed:'是'}
  ],before=structuredClone(rows);
  assert.deepEqual(filterLeads(rows,videos,{f:'ai_todo'}).map(row=>row.id),[1]);
  assert.deepEqual(filterLeads(rows,videos,{f:'ai_stale'}).map(row=>row.id),[5]);
  assert.deepEqual(filterLeads(rows,videos,{f:'ai_excluded'}).map(row=>row.id),[2,3,4]);
  assert.deepEqual(filterLeads(rows,videos,{f:'ai_excluded'},{leadIds:[1,3]}).map(row=>row.id),[3]);
  assert.deepEqual(aiFacetCounts(rows,videos),{all:5,ai_todo:1,ai_yes:0,ai_no:0,ai_stale:1,ai_excluded:3});
  assert.deepEqual(rows,before);
});
