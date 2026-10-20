'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SEARCH_PATH, parseSearchBody } = require('../lib/search-works');

const work = id => ({ type: 1, aweme_info: { aweme_id: id, desc: 'desc ' + id, author: { nickname: 'n', sec_uid: 'S' + id }, statistics: { comment_count: 3 }, aweme_type: 0 } });

test('综合首页 stream 接口与翻页 single 接口都被识别', () => {
  assert.ok(SEARCH_PATH.test('/aweme/v1/web/general/search/stream/'));
  assert.ok(SEARCH_PATH.test('/aweme/v1/web/general/search/single/'));
  assert.ok(SEARCH_PATH.test('/aweme/v1/web/search/item/'));
});

test('流式多段 JSON（含分块长度行）合并解析并去重', () => {
  const a = JSON.stringify({ status_code: 0, data: [work('1'), work('2')], has_more: 1, cursor: 10 });
  const b = JSON.stringify({ status_code: 0, data: [work('2'), work('3')], has_more: 0 });
  const parsed = parseSearchBody(`605c\r\n${a}\r\n1f\r\n${b}\r\n0\r\n\r\n`);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.works.map(w => w.awemeId), ['1', '2', '3']);
  assert.equal(parsed.hasMore, false);
});

test('普通单个 JSON、字符串内含括号与 BOM 都能解析', () => {
  const text = JSON.stringify({ status_code: 0, data: [{ aweme_info: { aweme_id: '9', desc: '含 } 与 { 和 " 的描述', author: {}, statistics: {} } }], has_more: 1 });
  assert.equal(parseSearchBody(text).works.length, 1);
  assert.equal(parseSearchBody('﻿' + text).works.length, 1);
});

test('非 JSON 正文返回失败而不是抛错', () => {
  assert.equal(parseSearchBody('<html></html>').ok, false);
  assert.equal(parseSearchBody('').ok, false);
});
