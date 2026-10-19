'use strict';

// One public field contract drives the client table, search projection and XLSX.
// JSON records remain intact; projection joins the central work record at read time.
const { workIdFromLink } = require('./video-links');
const { workTextFields } = require('./work-metadata');
const GROUPS = [
  { id: 'primary', label: '主要字段' }, { id: 'basic', label: '基础信息' },
  { id: 'work', label: '视频/图文' }, { id: 'comment', label: '评论信息' }, { id: 'user', label: '用户信息' }
];
const STATUS = { new: '未处理', followed: '已关注', dm_sent: '已私信', followed_dm: '已关注+已私信', replied: '已回复', no_dm: '无法私信', skipped: '跳过', pending_verification: '待核验', dm_pending: '私信待核验', follow_pending: '关注待核验', dm_failed: '私信确认失败', follow_failed: '关注确认失败', failed: '确认失败', do_not_contact: '不再联系' };
const OUTCOMES = { confirmed_success: '确认成功', confirmed_failure: '确认失败', pending_verification: '待核验' };
const TEXT_STATES = { available: '已获取', empty: '作品无文字', missing: '未获取' };
const value = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
const own = (record, key) => value(record && record[key]);
const pathOnly = raw => {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  // Provenance exposes endpoint paths, never cookies or signed query parameters.
  try { const u = new URL(raw, 'https://www.douyin.com'); return u.pathname.startsWith('/') ? u.pathname : ''; } catch (_) { return ''; }
};
const field = (key, label, group, type = 'text', width = 150, getter, sourceField = '本机生成', sourcePathField = '') => ({ key, label, group, sourceGroup: group, type, width, defaultVisible: group === 'primary', sourceField, sourcePathField, getter: getter || (ctx => own(ctx.lead, key)) });
const main = (key, label, sourceGroup, type, width, getter, sourceField, sourcePathField) => ({ ...field(key, label, 'primary', type, width, getter, sourceField, sourcePathField), sourceGroup });
const user = (key, label, type = 'text', width = 150, getter, sourceField) => field(key, label, 'user', type, width, getter, sourceField || 'user.' + key, 'userSourcePath');
const work = (key, label, type = 'text', width = 150, getter, sourceField) => field(key, label, 'work', type, width, getter || (ctx => own(ctx.work, key)), sourceField || 'aweme_detail.' + key, 'workSourcePath');
const comment = (key, label, type = 'text', width = 150, getter, sourceField) => field(key, label, 'comment', type, width, getter, sourceField || 'comments[].' + key, 'commentSourcePath');

const LEAD_FIELDS = [
  main('id', '编号', 'basic', 'number', 100),
  main('time', '评论时间', 'comment', 'date', 190, null, 'comments[].create_time', 'commentSourcePath'),
  main('UID', 'UID', 'user', 'text', 200, ctx => own(ctx.lead, 'UID'), 'comments[].user.uid / profile.user.uid', 'userSourcePath'),
  main('nickname', '用户名称', 'user', 'text', 180, null, 'comments[].user.nickname / profile.user.nickname', 'userSourcePath'),
  main('aiNeed', 'AI判断', 'basic', 'ai', 120, null, 'DeepSeek JSON.need → aiNeed，只允许是/否；是表示业务相关、可考虑联系'), main('aiScore', 'AI评分', 'basic', 'number', 110, null, '旧版 JSON.score 历史兼容字段；新判断置空，旧评分重判前归档 aiScoreHistory，不参与执行许可'),
  main('aiReason', 'AI理由', 'basic', 'longtext', 200, null, 'DeepSeek JSON.reason → aiReason；新判断1至30字符，旧版长理由保留全文'), main('trigger', '触发词', 'basic', 'text', 160),
  main('demand', '需求内容', 'comment', 'longtext', 360, null, 'comments[].text', 'commentSourcePath'),
  main('videoDesc', '视频描述', 'work', 'longtext', 420, ctx => ctx.text.workText, '真实标题＋完整正文＋不同 caption（去重）', 'workSourcePath'),
  main('homepage', '主页链接', 'user', 'url', 250, null, 'comments[].user.sec_uid 生成公开主页链接', 'userSourcePath'),

  field('accountId', '执行账号ID', 'basic', 'text', 180), field('businessId', '业务编号', 'basic', 'text', 160),
  field('fetchTime', '获取时间', 'basic', 'date', 190),
  field('intent', '关键词候选', 'basic', 'text', 130, ctx => ctx.lead.intent ? '是' : '否'),
  field('status', '状态', 'basic', 'status', 150, ctx => STATUS[ctx.lead.status] || own(ctx.lead, 'status')),
  field('followState', '关注结果', 'basic', 'status', 160, ctx => OUTCOMES[ctx.lead.followState] || own(ctx.lead, 'followState')),
  field('dmState', '私信结果', 'basic', 'status', 160, ctx => OUTCOMES[ctx.lead.dmState] || own(ctx.lead, 'dmState')),
  field('followedAt', '关注时间', 'basic', 'date', 190), field('dmLastAt', '私信时间', 'basic', 'date', 190),
  field('dmCount', '私信次数', 'basic', 'number', 120, ctx => ctx.lead.dmCount || 0),
  field('aiJudgedAt', 'AI判断时间', 'basic', 'date', 190), field('aiPromptVersion', 'AI规则版本', 'basic', 'text', 230),

  work('workId', '作品ID', 'text', 220, ctx => ctx.workId, 'aweme_id / awemeId'),
  work('videoLink', '视频链接', 'url', 260, ctx => own(ctx.lead, 'videoLink') || own(ctx.work, 'videoLink'), '公开 video/note 作品链接'),
  work('workType', '作品类型', 'text', 120, ctx => [68, '68'].includes(ctx.work.awemeType) || ctx.work.workType === 'note' || ctx.work.type === 'note' || /\/note\//.test(String(ctx.lead.videoLink || ctx.work.videoLink || '')) ? '图文' : ctx.workId ? '视频' : '', '实际 aweme_type=68 / 公开作品路径 /note/；否则有效 video 路径'),
  work('awemeType', '平台作品类型', 'number', 140, null, 'aweme_type / awemeType'),
  work('workTitle', '作品标题', 'longtext', 300, ctx => ctx.text.workTitle, 'item_title / itemTitle'),
  work('workContent', '作品正文', 'longtext', 420, ctx => ctx.text.workContent, 'desc（缺失时 caption）'),
  work('caption', '作品补充文案', 'longtext', 320, ctx => own(ctx.work.workRawText, 'caption'), 'caption'),
  work('workTextState', '描述获取状态', 'status', 150, ctx => TEXT_STATES[ctx.text.workTextState] || ctx.text.workTextState, '由真实文字字段是否返回推导'),
  work('workTextSource', '描述数据来源', 'text', 170, ctx => ctx.text.workTextSource, 'api / page_json / page_dom / history'),
  work('descriptionReason', '描述说明', 'longtext', 300, null, '本机识别说明'),
  work('workTextChars', '作品文字数', 'number', 130, ctx => Array.from(ctx.text.workText).length, '综合作品全文字符数'),
  work('imageCount', '图片数量', 'number', 120, null, 'images.length / image_post_info.images.length'),
  work('diggCountWork', '点赞数', 'number', 120, ctx => own(ctx.work, 'diggCount'), 'statistics.digg_count'),
  work('commentCount', '评论数', 'number', 120, null, 'statistics.comment_count'),
  work('shareCount', '分享数', 'number', 120, null, 'statistics.share_count'),
  work('collectCount', '收藏数', 'number', 120, null, 'statistics.collect_count'),
  work('authorNickname', '作者', 'text', 180, null, 'author.nickname'),
  work('authorFollowerCount', '作者粉丝数', 'number', 140, null, 'author.follower_count'),
  work('createTime', '视频发布时间', 'date', 190, null, 'create_time'),
  work('durationSec', '视频时长(秒)', 'number', 150, null, 'duration 毫秒换算秒'),
  work('capturedAt', '视频数据获取时间', 'date', 190, null, '本机接收有效作品响应时间'),
  { ...work('lastCollectAt', '上次采集时间', 'date', 190, null, '本机作品采集记录 lastCollectAt'), sourcePathField: '' },
  { ...work('scanCount', '采集次数', 'number', 120, null, '本机作品采集记录 scanCount'), sourcePathField: '' },
  work('workSourcePath', '作品响应路径', 'text', 350, ctx => pathOnly(ctx.work.workSourcePath), '实际响应 pathname / 当前作品 pathname'),
  work('workCapturedAt', '作品来源记录时间', 'date', 190, ctx => own(ctx.work, 'workCapturedAt') || own(ctx.work, 'descriptionCapturedAt') || own(ctx.work, 'capturedAt'), '本机接收有效作品来源时间'),

  comment('commentId', '评论ID', 'text', 220, null, 'comments[].cid'),
  comment('commentTimestamp', '评论时间戳（秒）', 'number', 180, null, 'comments[].create_time，Unix秒'),
  comment('commentLevel', '评论等级', 'number', 130, null, 'comments[].level'),
  comment('region', '属地', 'text', 140, null, 'comments[].ip_label'),
  comment('diggCount', '评论点赞数', 'number', 140, null, 'comments[].digg_count'),
  comment('replyCount', '评论回复数', 'number', 140, null, 'comments[].reply_comment_total'),
  comment('commentSourcePath', '评论响应路径', 'text', 350, ctx => pathOnly(ctx.lead.commentSourcePath), '实际响应 pathname'),
  comment('commentCapturedAt', '评论来源记录时间', 'date', 190, null, '本机接收评论响应时间'),

  user('uid', 'uid', 'text', 260, null, 'comments[].user.sec_uid / profile.user.sec_uid'),
  user('account', '账号', 'text', 180, null, 'user.unique_id'),
  user('signature', '个性签名', 'longtext', 330, null, 'user.signature'),
  user('followerCount', '粉丝数', 'number', 120, null, 'user.follower_count'),
  user('followingCount', '关注数', 'number', 120, null, 'user.following_count'),
  user('favoritedCount', '获赞数', 'number', 120, null, 'user.total_favorited'),
  user('awemeCount', '作品数', 'number', 120, null, 'user.aweme_count'),
  user('gender', '性别', 'text', 100, ctx => [1, '1'].includes(ctx.lead.gender) ? '男' : [2, '2'].includes(ctx.lead.gender) ? '女' : '', 'user.gender'),
  user('province', '省份', 'text', 140, null, 'user.province'), user('city', '城市', 'text', 140, null, 'user.city'),
  user('verify', '认证', 'text', 230, null, 'user.enterprise_verify_reason / user.custom_verify'),
  user('school', '学校', 'text', 210, null, 'user.school_name'), user('age', '年龄', 'number', 100, null, 'user.user_age'),
  user('commerceLevel', '电商等级', 'number', 130, null, 'user.commerce_user_level'),
  user('ipLocation', 'IP属地', 'text', 140, null, 'user.ip_location'), user('liveStatus', '直播状态', 'text', 140, null, 'user.live_status'),
  user('certInfo', '认证明细', 'longtext', 320, null, 'user.account_cert_info.name'),
  user('userSourcePath', '用户资料响应路径', 'text', 350, ctx => pathOnly(ctx.lead.userSourcePath), '最近实际返回 comments[].user 或 profile.user 的响应 pathname；逐字段来源在 userFieldSources'),
  user('userCapturedAt', '用户资料来源时间', 'date', 190, null, '本机最近接收 comments[].user 或 profile.user 时间'),
  user('profileSourcePath', '主页补充响应路径', 'text', 350, ctx => pathOnly(ctx.lead.profileSourcePath), '实际主页资料响应 pathname'),
  user('profileCapturedAt', '主页补充时间', 'date', 190, null, '本机接收主页资料时间')
];

function publicLeadFields() {
  return { version: 3, groups: GROUPS.map(g => ({ ...g })), fields: LEAD_FIELDS.map(({ getter, ...f }) => ({ ...f })), compactColumns: [
    { key: 'id', label: '编号', className: 'lead-check-cell', width: 66, fields: ['id'] },
    { key: 'nickname', label: '用户', className: 'col-nick', width: 124, fields: ['nickname', 'homepage'] },
    { key: 'time', label: '评论时间', className: 'lead-date', width: 124, fields: ['time'] },
    { key: 'demand', label: '用户评论', className: 'lead-comment', width: 270, fields: ['demand'] },
    { key: 'videoDesc', label: '作品标题 / 内容', className: 'lead-work', width: 260, fields: ['videoDesc', 'workTitle', 'workContent', 'workType'] },
    { key: 'aiNeed', label: 'AI 判断 / 理由', className: 'lead-ai', width: 156, fields: ['aiNeed', 'aiReason'] },
    { key: 'contact', label: '联系结果', className: 'lead-contact', width: 124, fields: ['followState', 'dmState'] }
  ] };
}

function workContext(lead = {}, videos = {}) {
  const workId = workIdFromLink(lead.videoLink);
  const record = workId && videos[workId];
  const data = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  let text = workTextFields(data);
  if (!text.workText && text.workTextState !== 'empty') {
    text = workTextFields({
      workTitle: lead.workTitle, workContent: lead.workContent || lead.videoDescription || lead.videoDesc,
      workText: lead.workText, descriptionSource: lead.workTextSource || 'history'
    });
  }
  return { lead, workId, work: data, text };
}

function projectLead(lead, videos = {}) {
  const ctx = workContext(lead, videos), fieldValues = {};
  for (const f of LEAD_FIELDS) fieldValues[f.key] = value(f.getter(ctx));
  return { ...lead, ...ctx.text, videoDesc: ctx.text.workText, commentSourcePath: fieldValues.commentSourcePath, userSourcePath: fieldValues.userSourcePath, profileSourcePath: fieldValues.profileSourcePath, fieldValues };
}

function projectWork(record = {}, id = '') {
  const workId = String(record.awemeId || id || workIdFromLink(record.videoLink) || '');
  return { ...record, awemeId: workId, ...workTextFields(record), workSourcePath: pathOnly(record.workSourcePath), workSourcePaths: Array.isArray(record.workSourcePaths) ? record.workSourcePaths.map(pathOnly).filter(Boolean) : [] };
}

const encodeTextPart = text => JSON.stringify(text).replace(/_x([0-9a-fA-F]{4})_/g, '\\u005fx$1_');
function splitText(text, maxChars = 30000, maxLineFeeds = 250) {
  const parts = []; let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    let lineFeeds = 0;
    for (let i = start; i < end; i++) {
      if (text[i] === '\n' && ++lineFeeds > maxLineFeeds) { end = i > start && text[i - 1] === '\r' ? i - 1 : i; break; }
    }
    // An additional JSON column preserves CRLF and literal escapes exactly;
    // even its escaped representation must fit in an Excel cell.
    while (encodeTextPart(text.slice(start, end)).length > 32767) end = start + Math.max(1, Math.floor((end - start) * 0.8));
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    parts.push(text.slice(start, end)); start = end;
  }
  return parts;
}

function createLeadWorkbook(XLSX, leads, videos = {}) {
  const book = XLSX.utils.book_new(), sheetName = '获客线索';
  const entries = Object.entries(videos), allWorkFields = LEAD_FIELDS.filter(f => f.sourceGroup === 'work');
  // Worksheet column widths are shared by every section. Put the work's full
  // description in the same wide J column as the lead table's description.
  const workFirst = ['workId', 'createTime', 'authorNickname', 'workType', 'scanCount', 'imageCount', 'workTextState', 'lastCollectAt', 'videoLink', 'videoDesc', 'capturedAt'];
  const workFields = [...workFirst.map(key => allWorkFields.find(f => f.key === key)).filter(Boolean), ...allWorkFields.filter(f => !workFirst.includes(f.key))];
  // Layout indices are zero-based. All sections share one worksheet, but the
  // filter range belongs only to the lead table. No spacer row becomes a lead.
  const headerRow = 3, leadStartRow = headerRow + 1, leadEndRow = headerRow + leads.length;
  const workTitleRow = leadEndRow + 3, workHeaderRow = workTitleRow + 2;
  const workStartRow = workHeaderRow + 1, workEndRow = workHeaderRow + entries.length;
  const fullTitleRow = workEndRow + 3, fullHeaderRow = fullTitleRow + 2, fullStartRow = fullHeaderRow + 1;
  const fullRows = [], fullHeaders = ['记录类型', '记录编号', '字段key', '字段名称', '分段序号', '分段总数', '原文字符数', '完整内容分段', '完整内容JSON'];
  const identifierKeys = new Set(['id', 'accountId', 'businessId', 'UID', 'uid', 'workId', 'commentId']);
  const safeCell = (raw, kind, id, f) => {
    let cell = value(raw);
    if (identifierKeys.has(f.key) && cell !== '') cell = String(cell);
    if (typeof cell !== 'string' || cell.length <= 32767 && (cell.match(/\n/g) || []).length <= 253) return cell;
    const parts = splitText(cell), first = fullStartRow + fullRows.length + 1, originalChars = Array.from(cell).length;
    parts.forEach((part, index) => fullRows.push([kind, String(id == null ? '' : id), f.key, f.label, index + 1, parts.length, originalChars, part, encodeTextPart(part)]));
    let preview = cell.slice(0, 1000);
    if (/[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
    return {
      t: 's',
      v: preview.replace(/\r?\n/g, ' ⏎ ') + '\n【全文超过 Excel 单元格容量，完整内容见本表下方“完整文本”第 ' + first + ' 至 ' + (first + parts.length - 1) + ' 行，按分段序号拼接】',
      l: { Target: "#'" + sheetName + "'!A" + first, Tooltip: '跳转到本字段的完整文本分段' }
    };
  };
  const rows = [], merges = [], groupColumns = [];
  const caption = (row, text) => {
    rows[row] = [text];
    merges.push({ s: { r: row, c: 0 }, e: { r: row, c: 10 } });
  };
  caption(0, '华贸获客 · 线索与作品资料');
  caption(1, '线索 ' + leads.length + ' 条｜作品 ' + entries.length + ' 条。一行一条评论线索，按作品 ID 关联；空白表示未返回或尚未采集。作品资料与超长完整文本保留在本表下方。');
  rows[2] = [];
  for (const group of GROUPS) {
    const indices = LEAD_FIELDS.map((f, i) => f.group === group.id ? i : -1).filter(i => i >= 0);
    if (!indices.length) continue;
    const startCol = indices[0], endCol = indices[indices.length - 1];
    rows[2][startCol] = group.label;
    if (startCol < endCol) merges.push({ s: { r: 2, c: startCol }, e: { r: 2, c: endCol } });
    groupColumns.push({ id: group.id, label: group.label, startCol, endCol });
  }
  rows[headerRow] = LEAD_FIELDS.map(f => f.label);
  leads.forEach((lead, index) => {
    const projection = projectLead(lead, videos);
    rows[leadStartRow + index] = LEAD_FIELDS.map(f => safeCell(projection.fieldValues[f.key], '线索', lead.id, f));
  });
  caption(workTitleRow, '作品资料（' + entries.length + ' 条）');
  caption(workTitleRow + 1, '本次导出范围内的作品资料；空白不等于0。');
  rows[workHeaderRow] = workFields.map(f => f.label);
  entries.forEach(([id, original], index) => {
    const record = projectWork(original, id);
    // Historical work records may have no canonical link: preserve their own ID.
    const ctx = { lead: { videoLink: record.videoLink || '' }, work: record, workId: record.awemeId, text: workTextFields(record) };
    rows[workStartRow + index] = workFields.map(f => safeCell(f.getter(ctx), '作品', record.awemeId, f));
  });
  if (fullRows.length) {
    caption(fullTitleRow, '完整文本（' + fullRows.length + ' 段）');
    caption(fullTitleRow + 1, '按记录类型、记录编号、字段 key 和分段序号定位。完整内容分段供阅读；精确还原须逐段 JSON.parse“完整内容JSON”后按序拼接，以保留换行、转义与 Unicode。');
    rows[fullHeaderRow] = fullHeaders;
    fullRows.forEach((row, index) => { rows[fullStartRow + index] = row; });
  }
  if (rows.length > 1048576 || LEAD_FIELDS.length > 16384) throw new Error('导出数据超过 Excel 单张工作表容量，请分批导出');
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = LEAD_FIELDS.map(f => ({ wpx: f.width, ...(f.group !== 'primary' ? { level: 1 } : {}) }));
  const headerRows = new Set([headerRow, workHeaderRow]), titleRows = new Set([0, workTitleRow]);
  if (fullRows.length) { headerRows.add(fullHeaderRow); titleRows.add(fullTitleRow); }
  sheet['!rows'] = rows.map((row, index) => ({ hpt: headerRows.has(index) ? 30 : titleRows.has(index) ? 28 : index >= leadStartRow && index <= leadEndRow ? 52 : 24 }));
  sheet['!merges'] = merges;
  // SheetJS expands a header-only autoFilter through the worksheet end. With
  // zero leads omit filtering so the separate work section is never included.
  if (leads.length) sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: headerRow, c: 0 }, e: { r: leadEndRow, c: LEAD_FIELDS.length - 1 } }) };
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  // Internal metadata is consumed by the offline formatting layer. SheetJS
  // does not serialize this application-only layout property into the file.
  const metadata = fields => fields.map(({ getter, ...f }) => ({ ...f }));
  book.__leadLayout = {
    sheetName, groupRow: 2, headerRow, leadStartRow, leadEndRow,
    workTitleRow, workHeaderRow, workStartRow, workEndRow,
    fullTitleRow: fullRows.length ? fullTitleRow : null,
    fullHeaderRow: fullRows.length ? fullHeaderRow : null,
    fullStartRow: fullRows.length ? fullStartRow : null,
    fullEndRow: fullRows.length ? fullStartRow + fullRows.length - 1 : null,
    leadsCount: leads.length, worksCount: entries.length, fullPartsCount: fullRows.length,
    fields: metadata(LEAD_FIELDS), workFields: metadata(workFields), groupColumns
  };
  return book;
}

module.exports = { LEAD_FIELDS, publicLeadFields, workContext, projectLead, projectWork, createLeadWorkbook, splitText };
