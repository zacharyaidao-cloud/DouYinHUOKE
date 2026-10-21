'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordKeywordRun, summarizeKeywords } = require('../lib/keyword-stats');

const NOW = 1_800_000_000;
const work = (id, daysAgo, comments = 30) => ({ awemeId: id, createTime: NOW - daysAgo * 86400, commentCount: comments });

test('记录一次搜索：上次作品数、近一周数、通过筛选数、新增数，累计作品去重', () => {
  let stats = recordKeywordRun({}, ' 亚马逊扫号 ', { works: [work('1', 1), work('2', 3), work('3', 20)], kept: [work('1', 1), work('2', 3)], added: 2, pages: 5,
    workType: 'video', publishedWithinDays: 30, minComments: 20, at: '2026-10-21 10:00:00', nowSec: NOW });
  stats = recordKeywordRun(stats, '亚马逊扫号', { works: [work('2', 3), work('4', 40)], kept: [], added: 0, pages: 2, at: '2026-10-21 11:00:00', nowSec: NOW });
  const entry = stats['亚马逊扫号'];
  assert.equal(entry.searchCount, 2);
  assert.equal(entry.lastSearchAt, '2026-10-21 11:00:00');
  assert.deepEqual(entry.lastRun, { at: '2026-10-21 11:00:00', workType: '', pages: 2, publishedWithinDays: 0, minComments: 0, total: 2, withinWeek: 1, kept: 0, added: 0, stopReason: '' });
  assert.deepEqual(entry.awemeIds.sort(), ['1', '2', '3', '4']);
});

test('汇总：按作品关联评论、AI 有需求（含去重人数）、关键词命中、已私信；作者评论不计', () => {
  const stats = recordKeywordRun({}, '亚马逊申诉', { works: [work('11', 1), work('12', 2)], kept: [work('11', 1), work('12', 2)], added: 2, at: '2026-10-21 09:00:00', nowSec: NOW });
  const leads = [
    { id: 1, uid: 'a', videoLink: 'https://www.douyin.com/video/11', aiNeed: '是', intent: true, dmState: 'confirmed_success' },
    { id: 2, uid: 'a', videoLink: 'https://www.douyin.com/video/11', aiNeed: '是' },
    { id: 3, uid: 'b', videoLink: 'https://www.douyin.com/note/12?from=x', aiNeed: '否', intent: true, excluded: true },
    { id: 4, uid: 'author', videoLink: 'https://www.douyin.com/video/11', aiNeed: '是', isAuthor: true },
    { id: 5, uid: 'c', videoLink: 'https://www.douyin.com/video/99', aiNeed: '是' }
  ];
  const videos = { 11: { collectionState: 'complete' }, 12: { lastCollectAt: '2026-10-21 09:30:00' } };
  const [row] = summarizeKeywords(stats, leads, videos);
  assert.equal(row.keyword, '亚马逊申诉');
  assert.equal(row.worksFound, 2); assert.equal(row.worksCollected, 2);
  assert.equal(row.comments, 3);
  assert.equal(row.aiDemand, 2); assert.equal(row.aiDemandUsers, 1);
  assert.equal(row.keywordDemand, 1);
  assert.equal(row.contacted, 1);
  assert.equal(row.lastTotal, 2); assert.equal(row.lastWithinWeek, 2);
});

test('同一作品被两个词搜到，两个词都算；按上次搜索时间倒序', () => {
  let stats = recordKeywordRun({}, 'A', { works: [work('7', 1)], at: '2026-10-21 08:00:00', nowSec: NOW });
  stats = recordKeywordRun(stats, 'B', { works: [work('7', 1)], at: '2026-10-21 12:00:00', nowSec: NOW });
  const rows = summarizeKeywords(stats, [{ uid: 'u', videoLink: 'https://www.douyin.com/video/7', aiNeed: '是' }], {});
  assert.deepEqual(rows.map(row => [row.keyword, row.aiDemand]), [['B', 1], ['A', 1]]);
});

test('空关键词不记录；损坏的存储按空处理', () => {
  assert.deepEqual(recordKeywordRun(null, '  ', { works: [work('1', 1)] }), {});
  assert.deepEqual(summarizeKeywords([], [], {}), []);
});

test('统计上线前的老关键词：从搜索结果列表补出累计作品与需求评论', () => {
  const results = [{ awemeId: '31', keyword: '老词', foundAt: '2026-10-19 09:00:00' }, { awemeId: '32', keyword: '老词', foundAt: '2026-10-20 09:00:00' }, { awemeId: '33', keyword: '新词' }];
  const stats = recordKeywordRun({}, '新词', { works: [{ awemeId: '34' }], at: '2026-10-21 09:00:00' });
  const rows = summarizeKeywords(stats, [{ uid: 'x', videoLink: 'https://www.douyin.com/video/32', aiNeed: '是' }], {}, results);
  const old = rows.find(row => row.keyword === '老词'), fresh = rows.find(row => row.keyword === '新词');
  assert.equal(old.fromHistory, true); assert.equal(old.worksFound, 2); assert.equal(old.aiDemand, 1); assert.equal(old.lastSearchAt, '2026-10-20 09:00:00');
  assert.equal(fresh.fromHistory, false); assert.equal(fresh.worksFound, 2); assert.equal(fresh.searchCount, 1);
});
