'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectWorkDetail, workDescription, parseWorkMetadata, workTextFields } = require('../lib/work-metadata');
const id = '7000000000000000002';
const body = detail => ({ status_code: 0, aweme_detail: { aweme_id: id, ...detail } });

test('图文和视频均保留 desc 全文；没有独立实际标题时不由首行制造标题', () => {
  for (const awemeType of [0, 68]) {
    const parsed = parseWorkMetadata(body({ aweme_type: awemeType, desc: '\n 图文标题\n服务说明 #亚马逊 ', images: awemeType === 68 ? [{}] : undefined }), id);
    assert.equal(parsed.desc, '图文标题\n服务说明 #亚马逊');
    assert.equal(parsed.title, ''); assert.equal(parsed.workTitle, '');
    assert.equal(parsed.workContent, '图文标题\n服务说明 #亚马逊');
    assert.equal(parsed.workText, parsed.desc); assert.equal(parsed.descriptionSource, 'api');
  }
});

test('目标详情缺失、空白或无效 desc 不擦掉已经取得的描述', () => {
  const previous = { desc: '历史的真实作品全文', descriptionSource: 'api' };
  for (const desc of [undefined, null, '', '  \n ', 42, { text: '猜测字段' }]) {
    const parsed = parseWorkMetadata(body({ desc, author: { nickname: '新作者' } }), id, previous);
    assert.equal(parsed.desc, previous.desc); assert.equal(parsed.descriptionState, 'available');
    assert.equal(parsed.descriptionSource, 'api'); assert.equal(previous.desc, '历史的真实作品全文');
  }
});

test('明确成功状态及完全一致的作品ID才能解析，拒绝数值精度丢失', () => {
  for (const statusCode of [null, false, '', undefined, 8, 10000]) assert.equal(parseWorkMetadata({ status_code: statusCode, aweme_detail: { aweme_id: id, desc: '不可接收' } }, id), null);
  assert.equal(parseWorkMetadata(body({ aweme_id: '7000000000000000003', desc: '其他作品' }), id), null);
  assert.equal(parseWorkMetadata(body({ aweme_id: Number(id), desc: '失真数字' }), id), null);
  assert.equal(parseWorkMetadata({ ...body({ desc: '字符串状态' }), status_code: '0' }, id).desc, '字符串状态');
});

test('有限详情数组按目标ID选择，post列表需要显式允许，评论内嵌内容不会冒充详情', () => {
  const other = { aweme_id: '7000000000000000003', desc: '相关推荐' }, target = { aweme_id: id, desc: '目标作品' };
  assert.equal(selectWorkDetail({ status_code: 0, aweme_details: [other, target] }, id), target);
  assert.equal(selectWorkDetail({ status_code: 0, aweme_list: [target] }, id), null);
  assert.equal(selectWorkDetail({ status_code: 0, aweme_list: [other, target] }, id, { allowList: true }), target);
  assert.equal(selectWorkDetail({ status_code: 0, comments: [{ aweme_detail: target }] }, id), null);
});

test('不把作者介绍、标签数组、音乐标题或未核实 image_post_info 字段拼为正文', () => {
  const parsed = parseWorkMetadata(body({ title: '未核实的标题', author: { signature: '作者简介' }, music: { title: '背景音乐' }, text_extra: [{ hashtag_name: '标签' }], image_post_info: { title: '未核实图文标题', caption: '猜测正文' } }), id);
  assert.equal(parsed.desc, ''); assert.equal(parsed.title, ''); assert.equal(parsed.descriptionState, 'missing');
  assert.match(parsed.descriptionReason, /未提供作品描述/);
  assert.deepEqual(parsed.workRawText, {}); assert.equal(parsed.workTextState, 'missing');
  assert.equal(parsed.imageCount, ''); assert.equal(parsed.awemeType, '');
});

test('当前页面补充字段明确记录 page 来源，后续有效API正文可覆盖补充结果', () => {
  const pageFields = workDescription({ desc: '页面明确的作品说明' }, {}, { source: 'page' });
  assert.equal(pageFields.descriptionSource, 'page');
  const apiFields = parseWorkMetadata(body({ desc: '接口返回的全文' }), id, pageFields);
  assert.equal(apiFields.desc, '接口返回的全文'); assert.equal(apiFields.descriptionSource, 'api');
});

test('平台明确 desc 为空与完全没有 desc 字段分开记录，均不编造正文', () => {
  const empty = parseWorkMetadata(body({ desc: ' \n ' }), id);
  assert.equal(empty.descriptionState, 'empty'); assert.equal(empty.descriptionSource, 'api');
  const missing = parseWorkMetadata(body({ author: {} }), id);
  assert.equal(missing.descriptionState, 'missing'); assert.equal(missing.descriptionSource, '');
});

test('实际标题、完整图文正文和独立caption分开保存，综合文字只拼实际非重复字段', () => {
  const desc = '详细图文内容\n' + '很长的业务背景、需求条件与案例说明。'.repeat(8000);
  const parsed = parseWorkMetadata(body({ item_title: '真实作品标题', desc, caption: '实际补充文字', aweme_type: 68, images: [{ uri: 'a' }, { uri: 'b' }] }), id);
  assert.equal(parsed.workTitle, '真实作品标题'); assert.equal(parsed.workContent, desc);
  assert.equal(parsed.workText, '真实作品标题\n\n' + desc + '\n\n补充文字：\n实际补充文字');
  assert.deepEqual(parsed.workRawText, { desc, item_title: '真实作品标题', caption: '实际补充文字' });
  assert.equal(parsed.workRawText.desc.length, desc.length); assert.equal(parsed.imageCount, 2); assert.equal(parsed.awemeType, 68);
  assert.deepEqual(workTextFields(parsed), { workTitle: parsed.workTitle, workContent: desc, workText: parsed.workText, workTextState: 'available', workTextSource: 'api' });
});

test('真实标题已经是正文第一行时不重复，caption等于正文或标题时不重复', () => {
  const normalized = workDescription({ itemTitle: '真实标题', desc: '真实标题\n图文正文', caption: '真实标题' });
  assert.equal(normalized.workTitle, '真实标题'); assert.equal(normalized.workText, '真实标题\n图文正文');
  const repeated = workDescription({ item_title: '标题', desc: '正文', caption: '正文' });
  assert.equal(repeated.workText, '标题\n\n正文');
});

test('旧desc和推导title迁移不重复、不冒充真实标题，明确API字段分项优先', () => {
  const legacy = { desc: '旧正文首行\n第二行', title: '旧正文首行', descriptionSource: 'api' };
  const migrated = workDescription(null, legacy, { source: 'history' });
  assert.equal(migrated.workTitle, ''); assert.equal(migrated.title, legacy.title); assert.equal(migrated.workText, legacy.desc);
  const enriched = workDescription({ itemTitle: '页面真实标题', desc: '低优先的页面正文', caption: '页面补充文字' }, migrated, { source: 'page_json' });
  assert.equal(enriched.workTitle, '页面真实标题'); assert.equal(enriched.workContent, legacy.desc);
  assert.equal(enriched.workRawTextSources.desc, 'api'); assert.equal(enriched.workRawTextSources.itemTitle, 'page_json');
  const api = workDescription({ item_title: 'API真实标题', desc: 'API新正文' }, enriched, { source: 'api' });
  assert.equal(api.workTitle, 'API真实标题'); assert.equal(api.workContent, 'API新正文');
  assert.equal(api.workRawText.caption, '页面补充文字');
  assert.equal(api.workTextSource, 'api');
});

test('caption是实际文字字段，缺desc时可作正文，但不会把未知字段对象猜成文字', () => {
  const caption = workDescription({ caption: '平台实际caption全文' });
  assert.equal(caption.workContent, '平台实际caption全文'); assert.equal(caption.workText, caption.workContent);
  const title = workDescription({ itemTitle: '只有平台实际标题' });
  assert.equal(title.workContent, ''); assert.equal(title.workText, '只有平台实际标题'); assert.equal(title.descriptionState, 'available');
  assert.equal(workDescription({ item_title: { text: '不猜对象' }, caption: 42 }).workTextState, 'missing');
});

test('已有缺失状态不被兼容空desc误改成明确空；图片和类型未知不猜0', () => {
  const missing = workDescription(null);
  assert.equal(workDescription(null, missing, { source: 'history' }).workTextState, 'missing');
  assert.equal(missing.imageCount, ''); assert.equal(missing.awemeType, '');
  assert.equal(workDescription({ image_post_info: { images: [] }, aweme_type: 0 }).imageCount, 0);
  assert.equal(workDescription({ image_post_info: { images: [] }, aweme_type: 0 }).awemeType, 0);
  const real = workDescription({ images: [{}, {}], aweme_type: 68, desc: '实际作品' });
  const later = workDescription({ caption: '', images: null }, real, { source: 'page_json' });
  assert.equal(later.imageCount, 2); assert.equal(later.awemeType, 68);
});

test('明确API空字段保持优先，页面可补API未返回的另一文字字段', () => {
  const api = workDescription({ desc: '' }, {}, { source: 'api' });
  const page = workDescription({ desc: 'API明确空正文不能被页面覆写', itemTitle: '页面实际标题' }, api, { source: 'page_json' });
  assert.equal(page.workRawText.desc, ''); assert.equal(page.workContent, '');
  assert.equal(page.workText, '页面实际标题'); assert.equal(page.descriptionState, 'available');
});

test('snake与camel真实标题别名同时出现时按逐字段API优先选取', () => {
  const page = workDescription({ item_title: '页面旧标题', desc: '页面正文' }, {}, { source: 'page_json' });
  const api = workDescription({ itemTitle: 'API实际标题', desc: 'API正文' }, page, { source: 'api' });
  assert.equal(api.workTitle, 'API实际标题'); assert.equal(api.workText, 'API实际标题\n\nAPI正文');
  assert.equal(api.workRawText.item_title, '页面旧标题'); assert.equal(api.workRawText.itemTitle, 'API实际标题');
  assert.equal(workTextFields(api).workTitle, 'API实际标题');
});
