'use strict';

// 2026-10-20 真实账号实测：直接打开 /note/<id>（以及部分 /video/<id>）时，第一页评论由服务端
// 内嵌在 self.__pace_f 流式数据里，点“评论”页签后页面不会再请求 /aweme/v1/web/comment/list/。
// 评论条数不满一页时整个作品都不会出现评论接口响应，旧流程会因“未收到评论响应”暂停。
// 内嵌结构为驼峰字段：{ comment: { statusCode, hasMore, total, cursor, comments: [{ cid, text,
// createTime, user: { uid, secUid, nickname, ... } }] } }。
//
// 本函数会被序列化进页面执行：只读取当前作品页已有的数据，不发请求、不执行脚本。
// 返回与评论接口相同的蛇形字段，供采集流程按同一套规则入库。
function readPageComments(expectedWorkId) {
  const empty = reason => ({ ok: false, reason });
  const id = typeof expectedWorkId === 'string' && /^\d{1,24}$/.test(expectedWorkId) ? expectedWorkId : '';
  let current;
  try { current = new URL(location.href); } catch (_) { return empty('bad_url'); }
  const path = current.pathname.match(/^\/(?:video|note)\/(\d{1,24})\/?$/);
  if (!id || !['www.douyin.com', 'douyin.com'].includes(current.hostname) || !path || path[1] !== id) return empty('not_target_page');

  const maximumCharacters = 4 * 1024 * 1024, maximumNodes = 20000, maximumDepth = 14;
  let characters = 0, visited = 0;
  const isBlock = value => value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.comments) && (value.statusCode !== undefined || value.status_code !== undefined)
    && (value.hasMore !== undefined || value.has_more !== undefined);
  const findBlock = root => {
    const pending = [{ value: root, depth: 0 }];
    while (pending.length && visited < maximumNodes) {
      const { value, depth } = pending.pop(); visited++;
      if (!value || typeof value !== 'object' || depth > maximumDepth) continue;
      if (!Array.isArray(value) && isBlock(value.comment)) return value.comment;
      if (isBlock(value)) return value;
      const children = Array.isArray(value) ? value : Object.values(value);
      for (let index = Math.min(children.length, maximumNodes) - 1; index >= 0; index--) pending.push({ value: children[index], depth: depth + 1 });
    }
    return null;
  };
  const readRow = row => {
    const match = row.match(/^[0-9a-f]+:([\[{].*)$/i);
    if (!match || !match[1].includes('comments')) return null;
    try { return findBlock(JSON.parse(match[1])); } catch (_) { return null; }
  };

  let block = null, pending = '';
  for (const script of document.querySelectorAll('script')) {
    const raw = script.textContent || '';
    if (!raw.includes('__pace_f.push') || raw.length > maximumCharacters) continue;
    const wrapper = raw.match(/^\s*(?:self|window)\.__pace_f\.push\(([\s\S]*)\)\s*;?\s*$/);
    if (!wrapper) continue;
    if (characters + raw.length > maximumCharacters) break;
    characters += raw.length;
    let chunk;
    try {
      const argument = JSON.parse(wrapper[1]);
      if (!Array.isArray(argument) || argument.length !== 2 || argument[0] !== 1 || typeof argument[1] !== 'string') continue;
      chunk = argument[1];
    } catch (_) { continue; }
    const rows = (pending + chunk).split('\n');
    pending = rows.pop();
    for (const row of rows) { block = readRow(row.replace(/\r$/, '')); if (block) break; }
    if (block) break;
  }
  if (!block && pending) block = readRow(pending);
  if (!block) return empty('no_embedded_comments');

  const pick = (object, camel, snake) => object[camel] !== undefined ? object[camel] : object[snake];
  const plain = value => value === '$undefined' ? undefined : value;
  const status = plain(pick(block, 'statusCode', 'status_code'));
  if (![0, '0'].includes(status)) return empty('status_not_ok');
  const comments = [];
  for (const raw of block.comments) {
    if (!raw || typeof raw !== 'object') continue;
    const owner = plain(pick(raw, 'awemeId', 'aweme_id'));
    if (owner !== undefined && owner !== null && String(owner) !== id) return empty('foreign_comments');
    const user = raw.user && typeof raw.user === 'object' ? raw.user : {};
    const level = plain(pick(raw, 'level', 'level'));
    comments.push({
      cid: plain(raw.cid),
      text: plain(raw.text),
      create_time: (() => {
        // 接口是秒；内嵌数据若给毫秒则换算成秒，保证“最近 N 天”筛选可用
        const value = Number(plain(pick(raw, 'createTime', 'create_time')));
        return Number.isFinite(value) && value > 0 ? (value > 1e12 ? Math.floor(value / 1000) : value) : undefined;
      })(),
      // 内嵌列表只含一级评论（回复折叠在各自评论下），缺少 level 时按一级处理
      level: level === undefined || level === null ? 1 : level,
      ip_label: plain(pick(raw, 'ipLabel', 'ip_label')),
      digg_count: plain(pick(raw, 'diggCount', 'digg_count')),
      reply_comment_total: plain(pick(raw, 'replyCommentTotal', 'reply_comment_total')),
      label_type: plain(pick(raw, 'labelType', 'label_type')),
      user: {
        uid: plain(user.uid),
        sec_uid: plain(pick(user, 'secUid', 'sec_uid')),
        nickname: plain(user.nickname),
        unique_id: plain(pick(user, 'uniqueId', 'unique_id')),
        signature: plain(user.signature)
      }
    });
  }
  const hasMore = plain(pick(block, 'hasMore', 'has_more'));
  return { ok: true, payload: {
    status_code: 0,
    comments,
    has_more: hasMore === true || hasMore === 1 || hasMore === '1' ? 1 : 0,
    cursor: plain(block.cursor) ?? comments.length,
    total: plain(block.total)
  } };
}

module.exports = { readPageComments };
