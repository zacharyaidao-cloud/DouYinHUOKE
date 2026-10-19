'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('../lib/xlsx.full.min.js');
const { publicLeadFields, projectLead, createLeadWorkbook } = require('../lib/lead-fields');
const { filterLeads } = require('../lead-query');
const AI = require('../ai');
const { workDescription } = require('../lib/work-metadata');

function readExport(book) {
  const read = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellStyles: true });
  const layout = book.__leadLayout, sheet = read.Sheets[layout.sheetName];
  const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true });
  return {
    read, sheet, layout, allRows,
    rows: allRows.slice(layout.headerRow, layout.leadEndRow + 1),
    works: allRows.slice(layout.workHeaderRow, layout.workEndRow + 1),
    full: layout.fullStartRow == null ? [] : allRows.slice(layout.fullStartRow, layout.fullEndRow + 1)
  };
}

test('统一字段合同将指定 11 个主要字段前置，保留所有原有导出列且无私有 getter', () => {
  const schema = publicLeadFields();
  assert.equal(schema.version, 3);
  assert.deepEqual(schema.groups.map(g => g.id), ['primary', 'basic', 'work', 'comment', 'user']);
  const main = ['编号', '评论时间', 'UID', '用户名称', 'AI判断', 'AI评分', 'AI理由', '触发词', '需求内容', '视频描述', '主页链接'];
  assert.deepEqual(schema.fields.slice(0, 11).map(f => f.label), main);
  assert.deepEqual(schema.fields.filter(f => f.defaultVisible).map(f => f.label), main);
  assert.equal(new Set(schema.fields.map(f => f.key)).size, schema.fields.length);
  assert.equal(new Set(schema.fields.map(f => f.label)).size, schema.fields.length);
  const old = ['编号', '评论时间', 'UID', '用户名称', '触发词', '需求内容', '视频描述', '主页链接', 'uid', '账号', '个性签名', '属地', '获取时间', '视频链接', '关键词候选', '状态', '关注结果', '私信结果', '关注时间', '私信时间', '私信次数', 'AI判断', 'AI评分', 'AI理由', '评论点赞数', '评论回复数', '粉丝数', '关注数', '获赞数', '作品数', '性别', '省份', '城市', '认证', '学校', '年龄', '电商等级', 'IP属地', '直播状态', '认证明细', '点赞数', '评论数', '分享数', '收藏数', '作者', '作者粉丝数', '视频发布时间', '视频时长(秒)', '视频数据获取时间'];
  assert.equal(old.length, 49);
  for (const label of old) assert(schema.fields.some(f => f.label === label), label);
  assert(!JSON.stringify(schema).includes('getter'));
  assert.equal(schema.fields.find(f => f.key === 'demand').sourceGroup, 'comment');
  assert.equal(schema.fields.find(f => f.key === 'nickname').sourceGroup, 'user');
  assert.equal(schema.fields.find(f => f.key === 'videoDesc').sourceGroup, 'work');
  assert.equal(schema.fields.find(f => f.key === 'lastCollectAt').label, '上次采集时间');
  assert.equal(schema.fields.find(f => f.key === 'scanCount').label, '采集次数');
  assert.equal(schema.fields.find(f => f.key === 'scanCount').sourcePathField, '');
  assert.deepEqual(schema.compactColumns.map(column => column.key), ['id', 'nickname', 'time', 'demand', 'videoDesc', 'aiNeed', 'contact']);
  const fieldKeys = new Set(schema.fields.map(f => f.key));
  const compactFields = schema.compactColumns.flatMap(column => column.fields);
  assert.equal(new Set(compactFields).size, compactFields.length);
  for (const column of schema.compactColumns) {
    assert.equal(typeof column.label, 'string');
    assert(column.label.length > 0 && Number.isFinite(column.width) && column.width > 0);
    assert(column.fields.length > 0);
    for (const key of column.fields) assert(fieldKeys.has(key), key);
  }
  assert.deepEqual(schema.compactColumns.find(column => column.key === 'videoDesc').fields, ['videoDesc', 'workTitle', 'workContent', 'workType']);
  assert.deepEqual(schema.compactColumns.find(column => column.key === 'contact').fields, ['followState', 'dmState']);
  const timestamp = schema.fields.find(f => f.key === 'commentTimestamp');
  assert.equal(timestamp.type, 'number');
  assert.equal(timestamp.sourceGroup, 'comment');
  assert.equal(timestamp.sourceField, 'comments[].create_time，Unix秒');
  assert.equal(timestamp.sourcePathField, 'commentSourcePath');
});

test('读取时统一关联作品全文，不改原 JSON，来源路径不泄露签名或参数', () => {
  const lead = { id: 2, videoLink: 'https://www.douyin.com/note/456?from=share', demand: '需要帮忙', nickname: '示例', unknownOldField: '旧字段保留', commentTimestamp: 1791421200, commentSourcePath: 'https://www.douyin.com/aweme/v1/web/comment/list/?msToken=private' };
  const videos = { '456': { ...workDescription({ item_title: '真实图文标题', desc: '图文内容很长\n第二行全文' }), workSourcePath: '/note/456?secret=private', commentCount: 0 } };
  const previous = JSON.stringify({ lead, videos });
  const projected = projectLead(lead, videos);
  assert.equal(projected.videoDesc, videos['456'].workText);
  assert.equal(projected.fieldValues.videoDesc, projected.videoDesc);
  assert.equal(projected.unknownOldField, '旧字段保留');
  assert.equal(projected.fieldValues.commentCount, 0);
  assert.equal(projected.fieldValues.commentTimestamp, lead.commentTimestamp);
  assert.equal(projected.fieldValues.commentSourcePath, '/aweme/v1/web/comment/list/');
  assert.equal(projected.fieldValues.workSourcePath, '/note/456');
  assert.equal(projected.fieldValues.profileSourcePath, '');
  assert.equal(JSON.stringify({ lead, videos }), previous);
});

test('作品标题、正文与补充文案同时用于检索、AI和字段展示', () => {
  const lead = { id: 1, videoLink: 'https://www.douyin.com/note/123', demand: '求解', nickname: '用户' };
  const videos = { '123': workDescription({ item_title: '独立的真实标题', desc: '正文：库存调查资料', caption: '补充文案：申诉证据' }) };
  for (const q of ['真实标题', '库存调查', '申诉证据']) assert.equal(filterLeads([lead], videos, { q }).length, 1);
  assert.equal(AI.leadInput(lead, videos).videoDescription, videos['123'].workText);
  assert.equal(projectLead(lead, videos).fieldValues.videoDesc, videos['123'].workText);
});

test('实际 XLSX 读回与 registry 同序，超长全文分段可精确还原且不成为公式', () => {
  const long = '标题\n' + '图片说明😀'.repeat(7000) + '\n最后的证据不能丢失';
  const signature = '客户签名'.repeat(9000);
  const lead = { id: 9, videoLink: 'https://www.douyin.com/note/789', demand: '=SUM(1,2)', signature };
  const videos = { '789': { desc: long, videoLink: lead.videoLink, imageCount: 1 } };
  const book = createLeadWorkbook(XLSX, [lead], videos);
  const { read, rows, full, sheet, layout } = readExport(book);
  assert.deepEqual(read.SheetNames, ['获客线索']);
  assert.deepEqual(rows[0].slice(0, layout.fields.length), publicLeadFields().fields.map(f => f.label));
  for (const [kind, id, key, expected] of [['线索', '9', 'videoDesc', long], ['线索', '9', 'signature', signature], ['作品', '789', 'workContent', long]]) {
    const parts = full.filter(r => r[0] === kind && r[1] === id && r[2] === key).sort((a, b) => a[4] - b[4]);
    assert(parts.length > 1); assert(parts.every(r => r[7].length <= 30000));
    assert.equal(parts.map(r => r[7]).join(''), expected);
    assert.equal(parts[0][5], parts.length);
  }
  const descColumn = rows[0].indexOf('视频描述');
  assert.match(rows[1][descColumn], /完整文本/);
  const demand = sheet[XLSX.utils.encode_cell({ r: layout.leadStartRow, c: rows[0].indexOf('需求内容') })];
  assert.equal(demand.t, 's'); assert.equal(demand.f, undefined); assert.equal(demand.v, '=SUM(1,2)');
  const preview = sheet[XLSX.utils.encode_cell({ r: layout.leadStartRow, c: descColumn })];
  const matching = full.map((r, i) => ({ r, i })).filter(({ r }) => r[0] === '线索' && r[1] === '9' && r[2] === 'videoDesc');
  const first = layout.fullStartRow + matching[0].i + 1, last = layout.fullStartRow + matching[matching.length - 1].i + 1;
  assert(preview.v.includes('第 ' + first + ' 至 ' + last + ' 行'));
  assert.equal(preview.l.Target, "#'获客线索'!A" + first);
  assert.equal(full[matching[0].i][4], 1);
});

test('AI 超长作品明确标记裁剪、保留标题和尾部，省略中间变更仍改变输入依据', () => {
  const lead = { id: 1, videoLink: 'https://www.douyin.com/note/321', demand: '需要服务' };
  const middle = '中间内容'.repeat(7000), title = '独立真实标题', end = '末尾：申诉关键证据';
  const video = workDescription({ item_title: title, desc: '正文开头\n' + middle + '\n' + end });
  const videos = { '321': video };
  const input = AI.leadInput(lead, videos);
  assert.equal(input.workContext.truncated, true);
  assert.equal(input.workContext.originalChars, video.workText.length);
  assert(input.videoDescription.length <= input.workContext.maxChars);
  assert(input.workContext.includedChars < input.workContext.originalChars);
  assert(input.videoDescription.startsWith(title)); assert(input.videoDescription.endsWith(end));
  assert.match(input.videoDescription, /明确省略中间部分/);
  const changed = workDescription({ item_title: title, desc: video.workContent.slice(0, 14000) + '仅修改被省略部分' + video.workContent.slice(14000) });
  assert.notEqual(AI.leadInput(lead, { '321': changed }).workContext.sourceHash, input.workContext.sourceHash);
  assert.equal(videos['321'].workText, video.workText);
});

test('正文字符数未超上限但有大量换行时，Excel 仍分段并保留 CRLF 与 Unicode 全文', () => {
  const text = Array.from({ length: 900 }, (_, i) => '第' + i + '段😀\r\n').join('') + '结尾';
  assert(text.length < 32767);
  const book = createLeadWorkbook(XLSX, [{ id: 10, videoLink: 'https://www.douyin.com/note/789' }], { '789': { desc: text } });
  const { full, rows } = readExport(book);
  const parts = full.filter(r => r[0] === '线索' && r[2] === 'videoDesc').sort((a, b) => a[4] - b[4]);
  assert(parts.length > 1);
  assert(parts.every(r => (r[7].match(/\n/g) || []).length <= 250));
  assert(parts.every(r => r[8].length <= 32767));
  assert.equal(parts.map(r => JSON.parse(r[8])).join(''), text);
  const preview = rows[1][rows[0].indexOf('视频描述')];
  assert((preview.match(/\n/g) || []).length <= 253);
});

test('Excel 全文 JSON 还原保留反斜杠、控制字符和字面 OOXML 转义，不超过单元格上限', () => {
  const content = '_x000D_\\\u0001😀\r\n'.repeat(10000) + '完整结束';
  const book = createLeadWorkbook(XLSX, [{ id: 2, videoLink: 'https://www.douyin.com/note/789' }], { '789': { desc: content } });
  const { full } = readExport(book);
  const parts = full.filter(r => r[0] === '线索' && r[2] === 'videoDesc').sort((a, b) => a[4] - b[4]);
  assert(parts.every(r => r[8].length <= 32767));
  const restored = parts.map(r => JSON.parse(r[8])).join('');
  assert.equal(restored.length, content.length);
  assert.equal(require('node:crypto').createHash('sha256').update(restored).digest('hex'), require('node:crypto').createHash('sha256').update(content).digest('hex'));
});

test('单页分组筛选仅覆盖线索，独立作品区域保留无评论作品及真实采集记录', () => {
  const link = 'https://www.douyin.com/note/7000000000000000001';
  const videos = {
    '7000000000000000001': { videoLink: link, desc: '有关联作品', lastCollectAt: '2026-10-08 12:00:00', scanCount: 3 },
    '7000000000000000002': { videoLink: 'https://www.douyin.com/video/7000000000000000002', desc: '无评论作品', scanCount: 0 }
  };
  const leads = [{ id: 1, videoLink: link, UID: '同一用户', demand: '第一条评论' }, { id: 2, videoLink: link, demand: '同一用户另一条评论', UID: '同一用户' }];
  const before = JSON.stringify({ leads, videos });
  const { read, sheet, layout, rows, works, allRows } = readExport(createLeadWorkbook(XLSX, leads, videos));
  assert.deepEqual(read.SheetNames, ['获客线索']);
  assert.equal(layout.headerRow, 3); assert.equal(layout.groupRow, 2); assert.equal(layout.leadStartRow, 4);
  assert.equal(rows.length, 3); assert.equal(works.length, 3);
  assert.deepEqual(layout.workFields.slice(0, 11).map(f => f.key), ['workId', 'createTime', 'authorNickname', 'workType', 'scanCount', 'imageCount', 'workTextState', 'lastCollectAt', 'videoLink', 'videoDesc', 'capturedAt']);
  assert.equal(new Set(layout.workFields.map(f => f.key)).size, layout.workFields.length);
  assert.deepEqual(layout.groupColumns.map(g => g.id), ['primary', 'basic', 'work', 'comment', 'user']);
  for (const group of layout.groupColumns) {
    assert.equal(allRows[layout.groupRow][group.startCol], group.label);
    assert(sheet['!merges'].some(m => m.s.r === layout.groupRow && m.s.c === group.startCol && m.e.c === group.endCol));
  }
  const filter = XLSX.utils.decode_range(sheet['!autofilter'].ref);
  assert.equal(filter.s.r, layout.headerRow); assert.equal(filter.e.r, layout.leadEndRow);
  assert(filter.e.r < layout.workTitleRow);
  const workHeader = works[0], workIdCol = workHeader.indexOf('作品ID');
  assert.deepEqual(works.slice(1).map(r => r[workIdCol]), Object.keys(videos));
  assert.equal(works[1][workHeader.indexOf('采集次数')], 3);
  assert.equal(works[1][workHeader.indexOf('上次采集时间')], videos['7000000000000000001'].lastCollectAt);
  assert.equal(works[2][workHeader.indexOf('采集次数')], 0);
  assert.equal(works[2][workHeader.indexOf('上次采集时间')], '');
  assert.equal(rows[1][rows[0].indexOf('采集次数')], 3);
  assert.equal(layout.fullStartRow, null);
  assert.equal(JSON.stringify({ leads, videos }), before);
});

test('空线索导出保留唯一表头和作品，空工作表不会把说明或作品当作线索筛选', () => {
  for (const videos of [{}, { '123': { desc: '没有线索的作品', scanCount: 0 } }]) {
    const { read, sheet, rows, works, layout } = readExport(createLeadWorkbook(XLSX, [], videos));
    assert.deepEqual(read.SheetNames, ['获客线索']);
    assert.equal(rows.length, 1); assert.equal(works.length, Object.keys(videos).length + 1);
    assert.equal(layout.leadEndRow, layout.headerRow);
    assert.equal(sheet['!autofilter'], undefined);
    assert.equal(new Set(rows[0]).size, rows[0].length);
  }
});

test('长编号与前导零标识实际 XLSX 保持文本，公式样式用户内容仅是文字', () => {
  const id = '007690000000000000001', uid = '001790000000000000001', commentId = '009790000000000000001';
  const lead = { id, UID: uid, uid: 'MS4wLjABAAAA-001', accountId: '00001', businessId: '001', commentId, nickname: '+SUM(1,2)', demand: '=HYPERLINK("https://example.invalid","text")', aiReason: '@SUM(1,2)', videoLink: 'https://www.douyin.com/note/7000000000000000001' };
  const { sheet, layout, rows } = readExport(createLeadWorkbook(XLSX, [lead], { '7000000000000000001': { desc: '-2+3' } }));
  const expected = { id, UID: uid, uid: lead.uid, accountId: '00001', businessId: '001', commentId, workId: '7000000000000000001', nickname: lead.nickname, demand: lead.demand, aiReason: lead.aiReason, videoDesc: '-2+3' };
  for (const [key, text] of Object.entries(expected)) {
    const col = layout.fields.findIndex(f => f.key === key), cell = sheet[XLSX.utils.encode_cell({ r: layout.leadStartRow, c: col })];
    assert.equal(cell.t, 's', key); assert.equal(cell.f, undefined, key); assert.equal(cell.v, text, key);
    assert.equal(rows[1][col], text, key);
  }
});
