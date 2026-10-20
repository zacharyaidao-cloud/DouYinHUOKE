'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readPageComments } = require('../lib/page-comments');

// 用最小页面替身执行序列化的页面函数：只提供 location 与 script 文本。
function run(href, chunks, id) {
  const scripts = chunks.map(chunk => ({ textContent: `self.__pace_f.push(${JSON.stringify([1, chunk])})` }));
  const context = vm.createContext({ location: { href }, document: { querySelectorAll: () => scripts }, URL });
  return vm.runInContext(`(${readPageComments.toString()})(${JSON.stringify(id)})`, context);
}
const block = (comments, extra = {}) => ({ comment: { statusCode: 0, hasMore: false, total: comments.length, cursor: 20, comments, ...extra } });
const comment = (cid, text, createTime) => ({ cid, text, createTime, ipLabel: '广东', diggCount: 1, user: { uid: '11' + cid, secUid: 'MS4w' + cid, nickname: '用户' + cid } });

test('内嵌第一页评论被读成接口同款蛇形字段', () => {
  const row = 'a:' + JSON.stringify(['$', 'div', null, block([comment('1', '账号停用了怎么办', 1792462252), comment('2', '求助', '1792462300')])]);
  const result = run('https://www.douyin.com/note/7698590910216550843', ['0:["x"]\n' + row + '\n'], '7698590910216550843');
  assert.equal(result.ok, true);
  assert.equal(result.payload.has_more, 0);
  assert.equal(result.payload.comments.length, 2);
  const first = result.payload.comments[0];
  assert.deepEqual([first.cid, first.text, first.create_time, first.level, first.ip_label, first.user.sec_uid, first.user.nickname],
    ['1', '账号停用了怎么办', 1792462252, 1, '广东', 'MS4w1', '用户1']);
});

test('跨分块的内嵌行、毫秒时间与 $undefined 占位都能处理', () => {
  const row = 'b:' + JSON.stringify(block([comment('3', '视频认证没过', 1792462252000)], { hasMore: true, total: '$undefined' }));
  const result = run('https://www.douyin.com/video/123', [row.slice(0, 40), row.slice(40) + '\n'], '123');
  assert.equal(result.ok, true);
  assert.equal(result.payload.has_more, 1);
  assert.equal(result.payload.total, undefined);
  assert.equal(result.payload.comments[0].create_time, 1792462252);
});

test('不是目标作品页或评论属于别的作品时拒绝', () => {
  const row = 'c:' + JSON.stringify(block([{ ...comment('4', 'x', 1), awemeId: '999' }]));
  assert.equal(run('https://www.douyin.com/note/123', [row + '\n'], '123').ok, false);
  assert.equal(run('https://www.douyin.com/note/555', [row + '\n'], '123').reason, 'not_target_page');
  assert.equal(run('https://www.douyin.com/note/123', ['0:["nothing"]\n'], '123').reason, 'no_embedded_comments');
});
