'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { workIdFromLink } = require('../lib/video-links');
const { createLeadWorkbook } = require('../lib/lead-fields');
const { filterLeads } = require('../lead-query');
const ai = require('../ai');
const XLSX = require('../lib/xlsx.full.min.js');

test('实际 Excel 导出为 video 和 note 线索关联正确作品描述、作者和统计', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.search(/^function exportExcel\(/m);
  const end = source.indexOf('async function handleApi(', start);
  assert(start >= 0 && end > start);
  const videos = {
    '123': { videoLink: 'https://www.douyin.com/video/123', desc: '视频作品全文', authorNickname: '视频作者', commentCount: 20 },
    '456': { videoLink: 'https://www.douyin.com/note/456', desc: '图文标题\n图文正文', authorNickname: '图文作者', commentCount: 29 }
  };
  const leads = [
    { id: 1, videoLink: videos['123'].videoLink + '?from=share', demand: '视频评论' },
    { id: 2, videoLink: videos['456'].videoLink + '?from=share', demand: '图文评论' },
    { id: 3, videoLink: 'https://foreign.example/video/456', demand: '不允许串用其他域链接' }
  ];
  const exportExcel = vm.runInNewContext('(' + source.slice(start, end) + ')', {
    require, path, __dirname: path.join(__dirname, '..'), workIdFromLink, createLeadWorkbook, filterLeads, ai,
    store: { getLeads: () => leads, getVideos: () => videos, getSettings: () => ({}), todayStr: () => '2026-10-08' },
    json: (_res, result) => { throw new Error(JSON.stringify(result)); }
  });
  let output, status;
  exportExcel({ writeHead: code => { status = code; }, end: bytes => { output = bytes; } });
  assert.equal(status, 200); assert(output && typeof output.length === 'number');
  const book = XLSX.read(output, { type: Buffer.isBuffer(output) ? 'buffer' : 'array' });
  assert.deepEqual(book.SheetNames, ['获客线索']);
  const sheet = book.Sheets['获客线索'], range = XLSX.utils.decode_range(sheet['!autofilter'].ref);
  assert.equal(range.s.r, 3); assert.equal(range.e.r, 6);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', range: sheet['!autofilter'].ref });
  const descriptionColumn = rows[0].indexOf('视频描述'), authorColumn = rows[0].indexOf('作者'), commentsColumn = rows[0].indexOf('评论数');
  assert.equal(rows[1][descriptionColumn], videos['123'].desc); assert.equal(rows[1][authorColumn], '视频作者'); assert.equal(rows[1][commentsColumn], 20);
  assert.equal(rows[2][descriptionColumn], videos['456'].desc); assert.equal(rows[2][authorColumn], '图文作者'); assert.equal(rows[2][commentsColumn], 29);
  assert.equal(rows[3][descriptionColumn], ''); assert.equal(rows[3][authorColumn], ''); assert.equal(rows[3][commentsColumn], '');
});
