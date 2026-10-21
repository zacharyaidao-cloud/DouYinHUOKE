'use strict';

// Link parsing is deliberately independent of browsers, network requests and
// customer data. Short-link navigation must be supplied by the task engine so
// it can apply the same authorization, stop and scheduling checks as collection.
const WORK_HOSTS = new Set(['www.douyin.com', 'douyin.com']);

function invalidLink(position, reason = '') {
  const error = new Error(`${position}链接无效：${reason || '请粘贴抖音作品的 video / note 完整链接，或包含 v.douyin.com 短链接的分享文本'}`);
  error.code = 'INVALID_VIDEO_LINK';
  return error;
}

function normalizeVideoLink(raw, position = '') {
  let address;
  try { address = new URL(String(raw || '').trim()); }
  catch (_) { throw invalidLink(position); }
  if (address.protocol !== 'https:' || address.username || address.password || (address.port && address.port !== '443')) {
    throw invalidLink(position, '只支持无账号密码的 HTTPS 抖音作品链接');
  }
  if (WORK_HOSTS.has(address.hostname)) {
    const work = address.pathname.match(/^\/(video|note)\/(\d{1,24})\/?$/);
    if (!work) throw invalidLink(position, '请使用作品详情链接；用户主页、直播间和搜索地址不能加入采集队列');
    return { id: work[2], type: work[1], url: `https://www.douyin.com/${work[1]}/${work[2]}` };
  }
  if (address.hostname === 'v.douyin.com') {
    const token = address.pathname.match(/^\/([A-Za-z0-9_-]{1,128})\/?$/);
    if (!token) throw invalidLink(position, '短分享链接格式不正确');
    return { id: null, type: 'short', url: `https://v.douyin.com/${token[1]}/` };
  }
  throw invalidLink(position, '只接受 douyin.com 或 v.douyin.com 的作品链接');
}

function mergeLinks(items) {
  const result = [], seen = new Map();
  for (const item of items) {
    const key = item.id ? 'work:' + item.id : 'short:' + item.url;
    const previous = seen.get(key);
    if (previous) {
      previous.force = previous.force || item.force;
      if (item.forceAt && (!previous.forceAt || item.forceAt > previous.forceAt)) previous.forceAt = item.forceAt;
      // An explicit note URL preserves the image-work route when the same work
      // is also supplied through a generic video/share address.
      if (item.type === 'note') { previous.type = 'note'; previous.url = item.url; }
    } else {
      const copy = { ...item, force: !!item.force };
      seen.set(key, copy); result.push(copy);
    }
  }
  return result;
}

function parseVideoLinks(input) {
  const groups = Array.isArray(input) ? input : [input];
  const parsed = [];
  groups.forEach((group, index) => {
    let raw, force = false, forceAt = 0;
    if (typeof group === 'string' || (group == null && !Array.isArray(input))) raw = String(group || '');
    else if (group && typeof group.url === 'string') {
      raw = group.url; force = !!group.force;
      // 勾选“强制重采”的时间：本轮强制重采以它为界，之后已采完整的作品再次开始时不重复强制采集
      const at = Number(group.forceAt);
      forceAt = force && Number.isFinite(at) && at > 0 ? at : 0;
    }
    else throw invalidLink(`第 ${index + 1} 组`, '输入格式不正确');
    if (!raw.trim()) return;
    // Accept common escaped Markdown copied from a message. A textarea can
    // contain one complete share message or several messages, including their
    // captions and line breaks; no caption is sent to the platform.
    const text = raw.replace(/\\([:\/.])/g, '$1');
    const matches = [...text.matchAll(/https?:\/\/[^\s<>"'，。；、）【】,;]+/gi)];
    if (!matches.length) throw invalidLink(`第 ${index + 1} 组`, '未找到作品链接，请把完整分享文本一起粘贴');
    for (const match of matches) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      const position = groups.length > 1 ? `第 ${index + 1} 组第 ${line} 行` : `第 ${line} 行`;
      const candidate = match[0].replace(/[.,;:!?)\]}]+$/g, '');
      parsed.push({ ...normalizeVideoLink(candidate, position), force, ...(forceAt ? { forceAt } : {}) });
    }
  });
  return mergeLinks(parsed);
}

async function resolveVideoLinks(input, resolveShort) {
  const parsed = parseVideoLinks(input), resolved = [];
  for (let index = 0; index < parsed.length; index++) {
    const item = parsed[index];
    if (item.type !== 'short') { resolved.push(item); continue; }
    if (typeof resolveShort !== 'function') {
      throw invalidLink(`第 ${index + 1} 个`, '短分享链接需要先在已登录的账号浏览器展开');
    }
    // Propagate task-stop, authorization and navigation failures unchanged.
    const redirect = await resolveShort(item.url, { ...item });
    const finalUrl = typeof redirect === 'string' ? redirect : redirect && (redirect.url || redirect.href);
    let work;
    try { work = normalizeVideoLink(finalUrl); }
    catch (_) { throw invalidLink(`第 ${index + 1} 个`, '短分享链接没有跳转到有效的作品页面，请在账号浏览器打开并复制最终 video / note 地址'); }
    if (work.type === 'short') throw invalidLink(`第 ${index + 1} 个`, '短分享链接尚未展开，请在账号浏览器打开并复制最终作品地址');
    resolved.push({ ...work, force: item.force });
  }
  return mergeLinks(resolved);
}

function workIdFromLink(raw) {
  try { return normalizeVideoLink(raw).id || ''; }
  catch (_) { return ''; }
}

module.exports = { normalizeVideoLink, parseVideoLinks, resolveVideoLinks, workIdFromLink };
