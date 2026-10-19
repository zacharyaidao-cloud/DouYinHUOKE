'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVideoLink, parseVideoLinks, resolveVideoLinks } = require('../lib/video-links');

test('完整 video 和 note 保留路径类型，19 位 ID 不经过数字转换', () => {
  assert.deepEqual(parseVideoLinks('https://www.douyin.com/video/7693378601286309625\nhttps://www.douyin.com/note/7693579483274183025'), [
    { id: '7693378601286309625', type: 'video', url: 'https://www.douyin.com/video/7693378601286309625', force: false },
    { id: '7693579483274183025', type: 'note', url: 'https://www.douyin.com/note/7693579483274183025', force: false }
  ]);
  assert.deepEqual(normalizeVideoLink('https://douyin.com/note/123/?source=share#comments'), { id: '123', type: 'note', url: 'https://www.douyin.com/note/123' });
});

test('一次粘贴六条完整分享文本，短链含下划线或连字符均正确提取', () => {
  const tokens = ['nv6Xa42irsA', '9geqTtg02RQ', 'u_tnBxCWQIo', 'eSklkomrflY', 'W8CfAa00OCw', 'O2q-o7Gduqw'];
  const text = tokens.map((token, index) => `${index + 1}.23 复制打开抖音，看看【测试作者的${index % 2 ? '图文' : ''}作品】测试描述 #话题 https://v.douyin.com/${token}/ 07/13 :1pm ytR:/ u@f.bN`).join('\n');
  assert.deepEqual(parseVideoLinks(text), tokens.map(token => ({ id: null, type: 'short', url: `https://v.douyin.com/${token}/`, force: false })));
});

test('允许分享说明换行、Markdown 和中文标点，但不保留跟踪查询参数', () => {
  assert.deepEqual(parseVideoLinks('2.38 复制打开抖音\n作品说明\n[作品](https\\://www\\.douyin.com/note/123/?from=share)。\nhttps://v.douyin.com/a_b-C/?from=copy，结束'), [
    { id: '123', type: 'note', url: 'https://www.douyin.com/note/123', force: false },
    { id: null, type: 'short', url: 'https://v.douyin.com/a_b-C/', force: false }
  ]);
});

test('同作品按 ID 去重，保留 note 和任一行的强制重采选择', () => {
  const links = parseVideoLinks([{ url: 'https://www.douyin.com/video/123', force: false }, { url: 'https://www.douyin.com/note/123', force: true }, { url: 'https://www.douyin.com/note/456' }]);
  assert.deepEqual(links, [
    { id: '123', type: 'note', url: 'https://www.douyin.com/note/123', force: true },
    { id: '456', type: 'note', url: 'https://www.douyin.com/note/456', force: false }
  ]);
  assert.equal(parseVideoLinks('https://v.douyin.com/abc/?x=1\nhttps://v.douyin.com/abc/').length, 1);
});

test('不静默丢弃无效非空输入组，并指出错误所在行', () => {
  assert.deepEqual(parseVideoLinks(['', '   ']), []);
  assert.throws(() => parseVideoLinks([{ url: 'https://www.douyin.com/video/123' }, { url: '错误链接' }]), /第 2 组.*未找到/);
  assert.throws(() => parseVideoLinks('https://www.douyin.com/video/123\nhttps://evil.example/video/456'), /第 2 行/);
  assert.throws(() => parseVideoLinks([{ id: '123' }]), /第 1 组.*输入格式/);
  assert.throws(() => parseVideoLinks([null]), /第 1 组.*输入格式/);
  assert.deepEqual(parseVideoLinks('https://www.douyin.com/video/123,https://www.douyin.com/note/456;https://v.douyin.com/abc/').map(item => item.type), ['video', 'note', 'short']);
});

test('拒绝外域、相似域、用户密码、非 HTTPS、非标准端口及非作品地址', () => {
  const rejected = [
    'http://www.douyin.com/video/123', 'https://www.douyin.com.evil.example/video/123',
    'https://www.douyin.com@evil.example/video/123', 'https://fake:password@www.douyin.com/video/123',
    'https://www.douyin.com:444/video/123', 'https://127.0.0.1/video/123',
    'https://www.douyin.com/user/123', 'https://www.douyin.com/live/123',
    'https://www.douyin.com/video/123/unexpected', 'https://v.douyin.com/abc/unexpected',
    'https://www.douyin.com/video/123%2F456', 'https://www.douyin.com/video/not-a-number'
  ];
  for (const url of rejected) assert.throws(() => normalizeVideoLink(url), { code: 'INVALID_VIDEO_LINK' }, url);
});

test('短链顺序展开一次，之后与直接 note 按 ID 去重并合并强制选择', async () => {
  const calls = [];
  const links = await resolveVideoLinks([
    { url: 'https://v.douyin.com/video-token/\nhttps://v.douyin.com/note-token/', force: true },
    { url: 'https://v.douyin.com/note-token/' },
    { url: 'https://www.douyin.com/note/456', force: false }
  ], async (url, item) => {
    calls.push({ url, force: item.force });
    return { url: url.includes('note-token') ? 'https://www.douyin.com/note/456?from=share' : 'https://www.douyin.com/video/123' };
  });
  assert.deepEqual(calls, [{ url: 'https://v.douyin.com/video-token/', force: true }, { url: 'https://v.douyin.com/note-token/', force: true }]);
  assert.deepEqual(links, [
    { id: '123', type: 'video', url: 'https://www.douyin.com/video/123', force: true },
    { id: '456', type: 'note', url: 'https://www.douyin.com/note/456', force: true }
  ]);
});

test('完整作品解析无需浏览器或网络，短链展开不得接受外域或仍为短链', async () => {
  await assert.rejects(resolveVideoLinks('https://v.douyin.com/test/'), /已登录的账号浏览器/);
  for (const target of ['https://evil.example/video/123', 'http://www.douyin.com/video/123', 'https://v.douyin.com/again/', null]) {
    await assert.rejects(resolveVideoLinks('https://v.douyin.com/test/', async () => target), /第 1 个.*短分享链接/);
  }
  let called = false;
  const direct = await resolveVideoLinks('https://www.douyin.com/note/123', async () => { called = true; });
  assert.equal(called, false); assert.equal(direct[0].type, 'note');
});

test('停止和授权异常原样传播，不会继续展开下一个短链', async () => {
  const stopped = Object.assign(new Error('测试用户停止'), { code: 'TASK_STOPPED' });
  let calls = 0;
  await assert.rejects(resolveVideoLinks('https://v.douyin.com/a/\nhttps://v.douyin.com/b/', async () => { calls++; throw stopped; }), error => error === stopped);
  assert.equal(calls, 1);
});
