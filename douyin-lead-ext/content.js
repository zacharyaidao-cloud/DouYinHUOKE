/**
 * 抖音获客采集助手 - 内容脚本
 * 职责：
 *  1) 视频页 (/video/{id})：收到采集指令后自动滚动评论区、解析评论用户信息、分批上报
 *  2) 用户主页 (/user/{sec_uid})：收到读取指令后提取 uid、抖音号、个性签名
 *
 * 抖音网页版 DOM 经常改版。本文件把所有选择器集中放在 SELECTORS 配置里，
 * 按顺序依次尝试；每个候选后面都写了注释，改版后只需在这里增补新选择器。
 */
(() => {
  'use strict';
  if (window.__DY_LEAD_EXT_LOADED__) return;
  window.__DY_LEAD_EXT_LOADED__ = true;
  // 诊断标记：在视频页 F12 控制台输入 __DY_LEAD__ 可确认脚本已注入
  window.__DY_LEAD__ = { version: '0.4.0', injectedAt: new Date().toISOString(), path: location.pathname };
  console.log('[dy-lead] 内容脚本已注入', location.pathname, '版本 0.4.0');

  /* ===================== 选择器配置（改版后改这里） ===================== */
  const SELECTORS = {
    // 评论容器（滚动它来加载更多评论）
    commentContainer: [
      'div[data-e2e="comment-list"]',
      'div[data-e2e="scroll-list"]',
      'div[class*="commentList"]',
      'div[class*="CommentList"]',
      'div[class*="comment-list"]'
    ],
    // 单条评论（顶级，不含楼中楼回复）
    commentItem: [
      'div[data-e2e="comment-item"]',
      'div[data-e2e="comment-item-level1"]',
      'div[class*="CommentItem"]',
      'div[class*="commentItem"]',
      'div[class*="comment-item"]'
    ],
    // 楼中楼回复容器（用于排除子评论）
    childComment: [
      'div[data-e2e="child-comment-list"]',
      'div[class*="child-comment"]',
      'div[class*="sub-comment"]',
      'div[class*="reply-item"]'
    ],
    // 评论作者主页链接
    authorLink: 'a[href*="/user/"]',
    // 评论正文（按优先级）
    commentText: [
      'p[data-e2e="comment-level-1"]',
      'span[data-e2e="comment-level-1"]',
      'div[data-e2e="comment-level-1"]',
      'p[class*="commentContent"]',
      'span[class*="commentContent"]',
      'div[class*="CommentContent"]',
      'div[class*="comment-content"]'
    ],
    // 昵称
    nickname: [
      'span[data-e2e="comment-avatar-name"]',
      'a[data-e2e="comment-avatar-name"]',
      'span[class*="username"]',
      'span[class*="UserName"]',
      'div[class*="UserName"]',
      'a[class*="UserName"]'
    ],
    // 属地（IP 标签）
    ipLabel: [
      'span[data-e2e="comment-ip-label"]',
      'span[class*="ipLabel"]',
      'span[class*="IpLabel"]',
      'span[class*="ip-label"]',
      'span[class*="commentIp"]',
      'div[class*="ipLabel"]'
    ],
    // “展开更多评论”按钮
    loadMore: [
      'button[data-e2e="comment-load-more"]',
      'div[data-e2e="comment-load-more"]',
      'span[data-e2e="comment-load-more"]'
    ]
  };

  const TIME_RE = /(\d+秒前|\d+分钟前|\d+小时前|\d+天前|昨天\s*\d+:\d+|前天\s*\d+:\d+|昨天|前天|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?|\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2})/;

  // 常见地区/国家名（用于属地识别，短文本）
  const REGION_RE = /^(IP属地[：:]\s*|IP[：:]\s*|属地[：:]\s*)?(北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆|香港|澳门|台湾|未知|海外|美国|日本|韩国|英国|德国|法国|加拿大|澳大利亚|新加坡|马来西亚|泰国|越南|菲律宾|印度尼西亚|印度|巴西|墨西哥|阿联酋|俄罗斯|意大利|西班牙|荷兰|波兰|瑞典|瑞士|比利时|爱尔兰|新西兰|智利|秘鲁|阿根廷|南非|埃及|土耳其|沙特|柬埔寨|老挝|缅甸|蒙古|哈萨克斯坦|乌兹别克斯坦|吉尔吉斯斯坦|塔吉克斯坦|格鲁吉亚|亚美尼亚|白俄罗斯|乌克兰|立陶宛|拉脱维亚|爱沙尼亚|罗马尼亚|保加利亚|希腊|塞尔维亚|克罗地亚|斯洛伐克|匈牙利|捷克|卢森堡|马耳他|摩洛哥|突尼斯|埃塞俄比亚|肯尼亚|坦桑尼亚|乌干达|赞比亚|津巴布韦|莫桑比克|安哥拉|加纳|尼日利亚|塞内加尔|马达加斯加|斐济|文莱|马尔代夫|不丹|朝鲜|孟加拉国|斯里兰卡|尼泊尔|巴基斯坦|阿富汗|伊朗|伊拉克|以色列|约旦|黎巴嫩|叙利亚|卡塔尔|科威特|巴林|阿曼|也门|约旦|丹麦|挪威|芬兰|冰岛|葡萄牙|奥地利|摩纳哥|塞浦路斯|毛里求斯|塞舌尔|巴拿马|古巴|牙买加|乌拉圭|巴拉圭|玻利维亚|厄瓜多尔|委内瑞拉|哥斯达黎加|洪都拉斯|危地马拉|多米尼加|海地|波多黎各|关岛|苏里南|圭亚那|哥伦比亚|多米尼克|格林纳达|圣基茨|安提瓜|巴巴多斯|巴哈马|特立尼达|百慕大|开曼群岛|库拉索|阿鲁巴|马提尼克|瓜德罗普|法属圭亚那|留尼汪|新喀里多尼亚|塔希提|关岛|塞班|直布罗陀|梵蒂冈|圣马力诺|列支敦士登|安道尔|波黑|黑山|北马其顿|阿尔巴尼亚|科索沃|摩尔多瓦|卢旺达|布隆迪|吉布提|厄立特里亚|索马里|南苏丹|苏丹|利比亚|阿尔及利亚|毛里塔尼亚|马里|尼日尔|乍得|中非|喀麦隆|加蓬|刚果|纳米比亚|博茨瓦纳|莱索托|斯威士兰|马拉维|布基纳法索|贝宁|多哥|科特迪瓦|利比里亚|塞拉利昂|几内亚|几内亚比绍|冈比亚|佛得角|圣多美|赤道几内亚|西撒哈拉|科摩罗|马约特|马绍尔群岛|帕劳|瑙鲁|基里巴斯|图瓦卢|萨摩亚|汤加|瓦努阿图|所罗门群岛|密克罗尼西亚|库克群岛|纽埃|托克劳|皮特凯恩|福克兰|格陵兰|法罗群岛|奥兰|斯瓦尔巴)$/;

  const REGION_BLACKLIST = new Set(['点赞', '回复', '展开', '收起', '更多', '热评', '置顶', '作者', '关注', '已关注', '私信', '分享', '收藏', '举报', '删除', '精选', '相关推荐', '评论', '暂无', '没有更多']);

  /* ===================== 工具函数 ===================== */

  function pick(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) { /* 非法选择器跳过 */ }
    }
    return null;
  }

  function pickAll(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const els = root.querySelectorAll(sel);
        if (els && els.length) return Array.from(els);
      } catch (e) { /* 非法选择器跳过 */ }
    }
    return [];
  }

  function cleanText(s) {
    return (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** 相对时间转成完整时间字符串 */
  function relTimeToStr(text) {
    text = cleanText(text);
    if (!text) return '';
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fmt = d =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    let m = text.match(/^(\d+)秒前$/);
    if (m) { now.setSeconds(now.getSeconds() - Number(m[1])); return fmt(now); }
    m = text.match(/^(\d+)分钟前$/);
    if (m) { now.setMinutes(now.getMinutes() - Number(m[1])); return fmt(now); }
    m = text.match(/^(\d+)小时前$/);
    if (m) { now.setHours(now.getHours() - Number(m[1])); return fmt(now); }
    m = text.match(/^(\d+)天前$/);
    if (m) { now.setDate(now.getDate() - Number(m[1])); return fmt(now); }
    m = text.match(/^昨天\s*(\d+):(\d+)$/);
    if (m) {
      now.setDate(now.getDate() - 1);
      now.setHours(Number(m[1]), Number(m[2]), 0, 0);
      return fmt(now);
    }
    m = text.match(/^前天\s*(\d+):(\d+)$/);
    if (m) {
      now.setDate(now.getDate() - 2);
      now.setHours(Number(m[1]), Number(m[2]), 0, 0);
      return fmt(now);
    }
    if (text === '昨天') { now.setDate(now.getDate() - 1); return fmt(now); }
    if (text === '前天') { now.setDate(now.getDate() - 2); return fmt(now); }

    // 已是绝对时间：2026-10-06 19:59 / 10月6日 19:59 / 2026/10/06
    m = text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4] || 0)}:${pad(m[5] || 0)}:${pad(m[6] || 0)}`;
    m = text.match(/^(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
    if (m) {
      const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), 0);
      return fmt(d);
    }
    return text; // 原样保留
  }

  /** 把 抖音视频 URL 规整成 https://www.douyin.com/video/{id} */
  function normalizeVideoUrl(url) {
    const m = String(url || '').match(/video\/(\d+)/);
    if (m) return `https://www.douyin.com/video/${m[1]}`;
    return null;
  }

  /* ===================== 评论解析 ===================== */

  function extractCommentItem(item, videoUrl, keywords) {
    // 排除楼中楼回复：只要 item 处于子评论容器内就跳过
    for (const sel of SELECTORS.childComment) {
      try {
        if (item.closest(sel)) return null;
      } catch (e) { /* ignore */ }
    }

    // 1) 作者链接与 sec_uid
    let authorLink = null;
    try { authorLink = item.querySelector(SELECTORS.authorLink); } catch (e) { /* ignore */ }
    if (!authorLink) {
      // 有些版本作者名是可点击 span 且链接在父级，兜底找任何 /user/ 链接
      const all = pickAll([SELECTORS.authorLink], item);
      authorLink = all[0] || null;
    }
    if (!authorLink) return null;
    const href = authorLink.getAttribute('href') || '';
    const secUid = (href.match(/\/user\/([A-Za-z0-9_\-]+)/) || [])[1];
    if (!secUid) return null;

    // 2) 昵称：img alt / 链接 title / 专属选择器 / 链接内文本
    let nickname = '';
    try {
      const img = authorLink.querySelector('img');
      if (img && img.alt && !/^https?:/.test(img.alt)) nickname = cleanText(img.alt);
    } catch (e) { /* ignore */ }
    if (!nickname) nickname = cleanText(authorLink.getAttribute('title') || '');
    if (!nickname) {
      const n = pick(SELECTORS.nickname, item);
      if (n) nickname = cleanText(n.textContent);
    }
    if (!nickname) nickname = cleanText(authorLink.textContent);

    // 3) 评论正文
    let text = '';
    const tEl = pick(SELECTORS.commentText, item);
    if (tEl) text = cleanText(tEl.textContent);
    if (!text) {
      // 兜底：所有叶级元素中最长的一段文字（排除昵称/时间/属地/数字类）
      let best = '';
      item.querySelectorAll('p, span, div').forEach(el => {
        if (el.querySelector('p, span, div')) return; // 只取叶节点
        const t = cleanText(el.textContent);
        if (!t || t.length < 2 || t.length > 600) return;
        if (t === nickname) return;
        if (TIME_RE.test(t) && t.length <= 30) return;
        if (REGION_RE.test(t) && t.length <= 10) return;
        if (/^[\d.,万+]+$/.test(t)) return;
        if (t.length > best.length) best = t;
      });
      text = best;
    }

    // 4) 时间与属地：扫描小文本节点
    let timeText = '';
    let region = '';
    const smallTexts = [];
    item.querySelectorAll('span, div, p, time').forEach(el => {
      if (el.querySelector('span, div, p, time')) return;
      const t = cleanText(el.textContent);
      if (t && t.length <= 40) smallTexts.push({ t, el });
    });
    for (const { t } of smallTexts) {
      if (!timeText && TIME_RE.test(t)) timeText = t;
    }
    // 属地：优先带 ip 类名的节点
    let ipEl = pick(SELECTORS.ipLabel, item);
    if (ipEl) region = cleanText(ipEl.textContent).replace(/^IP属地[：:]\s*/, '').replace(/^IP[：:]\s*/, '');
    if (!region) {
      for (const { t } of smallTexts) {
        if (t.length <= 10 && REGION_RE.test(t)) {
          const raw = t.replace(/^(IP属地|IP|属地)[：:]\s*/, '');
          if (!REGION_BLACKLIST.has(raw)) { region = raw; break; }
        }
      }
    }

    // 5) 评论 id（可选）
    let commentId = '';
    const idEl = item.querySelector('a[href*="comment/"]') || item;
    try {
      const allHrefs = [];
      item.querySelectorAll('a[href]').forEach(a => allHrefs.push(a.getAttribute('href')));
      for (const h of allHrefs) {
        const mm = h.match(/comment\/(\d+)/);
        if (mm) { commentId = mm[1]; break; }
      }
    } catch (e) { /* ignore */ }

    if (!text && !nickname) return null; // 空数据不采

    // 6) 关键词匹配（触发词）
    let trigger = '';
    if (Array.isArray(keywords) && keywords.length) {
      for (const kw of keywords) {
        if (kw && text.includes(kw)) { trigger = kw; break; }
      }
    }

    return {
      uid: secUid,                    // sec_uid
      account: '',                    // 抖音号（补全主页信息后填入）
      uidNum: '',                     // 数字 UID（补全主页信息后填入）
      nickname,
      signature: '',                  // 个性签名（补全主页信息后填入）
      homepage: `https://www.douyin.com/user/${secUid}`,
      trigger,
      demand: text,
      time: timeText ? relTimeToStr(timeText) : '',
      timeRaw: timeText,
      region,
      videoLink: videoUrl,
      commentId
    };
  }

  /* ===================== 采集会话 ===================== */

  const session = {
    running: false,
    videoUrl: '',
    keywords: [],
    scrollInterval: 2000,
    maxIdleRounds: 5,
    sentKeys: new Set(),
    apiActive: false,
    debug: {}
  };

  function markSelectorStat(name, ok) {
    session.debug[name] = (session.debug[name] || 0) + (ok ? 1 : 0);
  }

  function send(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* ignore */ }
  }

  function reportProgress(status, extra) {
    send({ type: 'dy-progress', status, ...(extra || {}) });
  }

  async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function dedupeKey(videoUrl, item) {
    // 与后台去重逻辑保持一致：videoLink + uid + 评论内容
    return [videoUrl, item.uid, (item.demand || item.nickname || '').trim()].join('||');
  }

  /* ===================== API 直读（主世界网络监听数据） ===================== */

  const apiSession = { pages: 0, comments: 0, lastTotal: 0, lastHasMore: null, lastCursor: null };
  let apiNewSinceRound = 0;

  function fmtTs(sec) {
    if (!sec) return '';
    const d = new Date(Number(sec) * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function apiCommentToItem(c, videoUrl, keywords) {
    const u = c.user || {};
    const text = c.text || '';
    let trigger = '';
    if (Array.isArray(keywords) && keywords.length) {
      for (const kw of keywords) {
        if (kw && text.includes(kw)) { trigger = kw; break; }
      }
    }
    return {
      uid: u.sec_uid || '',
      account: u.unique_id || '',          // 抖音号：接口直接给，无需打开主页
      uidNum: String(u.uid || ''),
      nickname: u.nickname || '',
      signature: '',                       // 签名接口里没有，需补全主页
      homepage: u.sec_uid ? `https://www.douyin.com/user/${u.sec_uid}` : '',
      trigger,
      demand: text,
      time: fmtTs(c.create_time),          // 精确时间戳
      timeRaw: '',
      region: c.ip_label || '',
      videoLink: videoUrl,
      commentId: String(c.cid || '')
    };
  }

  function resetApiSession() {
    apiSession.pages = 0;
    apiSession.comments = 0;
    apiSession.lastTotal = 0;
    apiSession.lastHasMore = null;
    apiSession.lastCursor = null;
    apiNewSinceRound = 0;
  }

  function handleApiResponse(payload) {
    const data = payload && payload.data;
    if (!data || !Array.isArray(data.comments)) return;
    if (!session.running || !session.videoUrl) return;
    // 只接收当前采集视频的评论响应
    const m = String(payload.url || '').match(/aweme_id=(\d+)/);
    if (m && m[1] && !session.videoUrl.endsWith(`/video/${m[1]}`)) return;

    apiSession.pages++;
    apiSession.lastTotal = data.total || apiSession.lastTotal;
    apiSession.lastHasMore = data.has_more;
    apiSession.lastCursor = data.cursor;

    const fresh = [];
    for (const c of data.comments) {
      if (c.level !== 1) continue; // 只收顶级评论，跳过楼中楼回复
      apiSession.comments++;
      const item = apiCommentToItem(c, session.videoUrl, session.keywords);
      if (!item || !item.uid) continue;
      const key = dedupeKey(session.videoUrl, item);
      if (session.sentKeys.has(key)) continue;
      session.sentKeys.add(key);
      fresh.push(item);
    }

    if (fresh.length) {
      session.apiActive = true;
      apiNewSinceRound += fresh.length;
      console.log(`[dy-lead][api] 捕获评论接口第 ${apiSession.pages} 页：${data.comments.length} 条（新增 ${fresh.length}）cursor=${data.cursor} has_more=${data.has_more} 视频总评论=${data.total}`);
      sendMessageToBg({ type: 'dy-batch', videoLink: session.videoUrl, items: fresh }).then(resp => {
        if (resp) reportProgress('running', { storedTotal: resp.total });
      }).catch(() => {});
    }
  }

  // 接收主世界网络监听脚本转发过来的接口数据
  window.addEventListener('message', e => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__dyLead) return;
    if (d.type === 'comment-response') handleApiResponse(d.payload);
    else if (d.type === 'profile-response') handleProfileResponse(d.payload);
    else if (d.type === 'detail-response') handleDetailResponse(d.payload);
  });

  /* ---------- 主页接口响应（粉丝数/关注数/获赞/作品/性别/省市/认证/签名） ---------- */

  function handleProfileResponse(payload) {
    const data = payload && payload.data;
    const u = data && data.user;
    if (!u || !u.sec_uid) return;
    const info = {
      secUid: u.sec_uid,
      uidNum: String(u.uid || ''),
      account: u.unique_id || '',
      nickname: u.nickname || '',
      signature: u.signature || '',
      followerCount: u.follower_count != null ? u.follower_count : '',
      followingCount: u.following_count != null ? u.following_count : '',
      favoritedCount: u.total_favorited != null ? u.total_favorited : '',
      awemeCount: u.aweme_count != null ? u.aweme_count : '',
      gender: u.gender != null ? u.gender : '',
      province: u.province || '',
      city: u.city || '',
      verify: u.enterprise_verify_reason || u.custom_verify || ''
    };
    console.log('[dy-lead][api] 捕获主页接口:', u.nickname, '粉丝', info.followerCount, '签名', (info.signature || '').slice(0, 15));
    send({ type: 'dy-profile-update', info });
  }

  /* ---------- 视频详情接口响应（视频数据与作者信息） ---------- */

  function handleDetailResponse(payload) {
    const data = payload && payload.data;
    const aw = data && data.aweme_detail;
    if (!aw || !aw.aweme_id) return;
    const stat = aw.statistics || {};
    const author = aw.author || {};
    const info = {
      awemeId: String(aw.aweme_id),
      videoLink: `https://www.douyin.com/video/${aw.aweme_id}`,
      desc: aw.desc || '',
      diggCount: stat.digg_count != null ? stat.digg_count : '',
      commentCount: stat.comment_count != null ? stat.comment_count : '',
      shareCount: stat.share_count != null ? stat.share_count : '',
      collectCount: stat.collect_count != null ? stat.collect_count : '',
      authorUid: String(author.uid || ''),
      authorNickname: author.nickname || '',
      authorFollowerCount: author.follower_count != null ? author.follower_count : ''
    };
    console.log('[dy-lead][api] 捕获视频详情接口:', info.desc ? info.desc.slice(0, 30) : info.awemeId, '点赞', info.diggCount, '评论', info.commentCount);
    send({ type: 'dy-video-detail', info });
  }

  async function clickLoadMore() {
    const btn = pick(SELECTORS.loadMore);
    if (btn && btn.offsetParent !== null) {
      btn.click();
      markSelectorStat('loadMore', true);
      return true;
    }
    // 按文字找“展开更多评论”类按钮
    const candidates = Array.from(document.querySelectorAll('button, div, span')).filter(el =>
      /展开(更多|全部)?评论|查看更多评论|加载更多/.test(cleanText(el.textContent)) &&
      el.textContent.length <= 12 && el.offsetParent !== null
    );
    if (candidates.length) {
      candidates[0].click();
      return true;
    }
    return false;
  }

  /** 向上找真正可滚动的祖先容器并滚动 */
  function findScrollableAndScroll(el) {
    let node = el;
    let hops = 0;
    while (node && node !== document.documentElement && hops < 8) {
      try {
        if (node.scrollHeight > node.clientHeight + 5) {
          const before = node.scrollTop;
          node.scrollTop = node.scrollHeight;
          return node.scrollTop !== before;
        }
      } catch (e) { /* ignore */ }
      node = node.parentElement;
      hops++;
    }
    return false;
  }

  function scrollMore(container) {
    if (container) {
      if (findScrollableAndScroll(container)) return true;
      // 容器本身不可滚，退回整页滚动
      const before = window.scrollY;
      window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
      return window.scrollY !== before;
    }
    const before = window.scrollY;
    window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
    return window.scrollY !== before;
  }

  function checkLoginWall() {
    const bodyText = document.body ? document.body.innerText.slice(0, 8000) : '';
    if (/登录后查看更多|登录后查看评论|扫码登录后查看更多/.test(bodyText)) {
      // 若出现登录弹窗，尝试关闭无关遮罩后仍报错
      return true;
    }
    return false;
  }

  function tryOpenCommentPanel() {
    // 视频页评论可能默认收起，尝试点“评论”入口
    const candidates = Array.from(document.querySelectorAll('div, span, button')).filter(el => {
      const t = cleanText(el.textContent);
      return /^评论\s*\d*$/.test(t) && el.offsetParent !== null;
    });
    if (candidates.length) {
      candidates[candidates.length - 1].click();
      return true;
    }
    return false;
  }

  async function runCollectLoop() {
    let container = null;
    for (const sel of SELECTORS.commentContainer) {
      try {
        const el = document.querySelector(sel);
        if (el) { container = el; break; }
      } catch (e) { /* ignore */ }
    }

    const stats = {
      foundItemSelector: '',
      totalExtracted: 0,
      sent: 0,
      rounds: 0,
      idleRounds: 0
    };

    // 找到当前实际可用的评论项选择器
    let itemSelector = '';
    for (const sel of SELECTORS.commentItem) {
      try {
        if (document.querySelectorAll(sel).length > 0) { itemSelector = sel; break; }
      } catch (e) { /* ignore */ }
    }
    stats.foundItemSelector = itemSelector || '(未找到，尝试兜底)';
    console.log('[dy-lead] 采集循环启动。模式：API直读 + DOM兜底｜评论容器:', container ? '已找到' : '未找到(将整页滚动)', '｜评论项选择器:', stats.foundItemSelector);
    reportProgress('running', { debug: { ...session.debug, stats, api: { ...apiSession } } });

    let openedPanelAttempts = 0;

    while (session.running) {
      if (checkLoginWall()) {
        console.warn('[dy-lead] 检测到登录墙：请先在抖音网页登录');
        reportProgress('error', { error: '检测到登录墙：请先在抖音网页登录账号，再重新开始采集。' });
        session.running = false;
        return;
      }

      // 本轮 API 直读新增数
      const apiNew = apiNewSinceRound;
      apiNewSinceRound = 0;
      stats.totalExtracted += apiNew;

      // 还没看到评论且重试次数内：尝试点击评论面板入口
      const currentItems = itemSelector
        ? Array.from(document.querySelectorAll(itemSelector))
        : [];
      if (currentItems.length === 0 && apiNew === 0 && openedPanelAttempts < 3) {
        if (tryOpenCommentPanel()) openedPanelAttempts++;
        await sleep(1500);
        continue;
      }

      // DOM 兜底解析并上报新增（API 已采集过的会被去重跳过）
      const items = itemSelector
        ? Array.from(document.querySelectorAll(itemSelector))
        : [];
      const fresh = [];
      for (const el of items) {
        const item = extractCommentItem(el, session.videoUrl, session.keywords);
        if (!item) continue;
        const key = dedupeKey(session.videoUrl, item);
        if (session.sentKeys.has(key)) continue;
        session.sentKeys.add(key);
        fresh.push(item);
        stats.totalExtracted++;
      }
      if (fresh.length) {
        stats.sent += fresh.length;
        const resp = await sendMessageToBg({
          type: 'dy-batch',
          videoLink: session.videoUrl,
          items: fresh
        });
        console.log(`[dy-lead] 第 ${stats.rounds + 1} 轮：DOM 评论 ${items.length} 条，新增入库 ${fresh.length} 条｜API 累计 ${apiSession.pages} 页/${apiSession.comments} 条评论（总解析 ${stats.totalExtracted} 条）`);
        reportProgress('running', {
          newThisRound: fresh.length,
          totalExtracted: stats.totalExtracted,
          storedTotal: resp && resp.total ? resp.total : null,
          debug: { ...session.debug, stats, api: { ...apiSession } }
        });
      }

      const anythingNew = fresh.length > 0 || apiNew > 0;
      const beforeCount = items.length;

      // 滚动 / 点“展开更多”
      const scrolled = scrollMore(container);
      const loadedMore = await clickLoadMore().catch(() => false);
      await sleep(session.scrollInterval);

      // 再次统计，判断是否有新评论
      const afterItems = itemSelector
        ? Array.from(document.querySelectorAll(itemSelector))
        : [];
      const noGrowth = afterItems.length <= beforeCount;

      // 判断“没有更多评论”信号（API 优先，DOM 文案兜底）
      let noMore = session.apiActive && apiSession.lastHasMore === 0;
      if (!noMore && container) {
        const txt = cleanText(container.textContent || '');
        if (/暂无更多评论|没有更多评论|已经到底了/.test(txt)) noMore = true;
      }

      stats.rounds++;
      if (!anythingNew && noGrowth) {
        stats.idleRounds++;
        if (!scrolled && !loadedMore) stats.idleRounds = Math.max(stats.idleRounds, session.maxIdleRounds - 1);
        if (stats.idleRounds >= session.maxIdleRounds) {
          const reason = noMore
            ? `没有更多评论（${session.apiActive ? `API 已到最后一页，视频共 ${apiSession.lastTotal} 条` : '已到评论区底部'}）`
            : `连续 ${session.maxIdleRounds} 轮无新评论`;
          console.log('[dy-lead] 采集结束：' + reason, '｜API', apiSession.pages, '页', apiSession.comments, '条｜共解析', stats.totalExtracted, '条');
          reportProgress('done', {
            totalExtracted: stats.totalExtracted,
            reason,
            debug: { ...session.debug, stats, api: { ...apiSession } }
          });
          session.running = false;
          return;
        }
      } else if (anythingNew) {
        stats.idleRounds = 0;
      }
    }
    reportProgress('stopped', { totalExtracted: stats.totalExtracted, debug: { ...session.debug, stats, api: { ...apiSession } } });
  }

  function sendMessageToBg(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, resp => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }

  /* ===================== 用户主页信息提取 ===================== */

  function extractProfileFromGlobals() {
    const data = window._ROUTER_DATA;
    if (data) {
      const loaders = data.loaderData || {};
      for (const key of Object.keys(loaders)) {
        const obj = loaders[key];
        if (obj && (obj.userInfo || (key.includes('/user') && obj.user))) {
          const u = obj.userInfo || obj.user || {};
          if (u && (u.uid || u.sec_uid || u.unique_id)) {
            return {
              uidNum: String(u.uid || ''),
              uniqueId: u.unique_id || '',
              nickname: u.nickname || '',
              signature: u.signature || ''
            };
          }
        }
      }
    }
    return null;
  }

  function extractProfileFromDom() {
    let uidNum = '', uniqueId = '', signature = '', nickname = '';
    const bodyText = document.body ? document.body.innerText : '';

    // 抖音号：xxx 或 uid：xxx
    let m = bodyText.match(/抖音号[：:]\s*([A-Za-z0-9_.\-]{4,40})/);
    if (m) uniqueId = m[1];
    m = bodyText.match(/UID[：:]\s*(\d{5,})/);
    if (m) uidNum = m[1];

    // 个性签名：简介区块
    const sigCandidates = [
      'div[data-e2e="user-desc"]',
      'div[class*="signature"]',
      'div[class*="Signature"]',
      'span[class*="signature"]',
      'p[class*="desc"]',
      'h1[data-e2e="user-title"]'
    ];
    let sigEl = pick(sigCandidates);
    if (!sigEl) {
      // 兜底：找“简介”字样附近的文字
      const labels = Array.from(document.querySelectorAll('div, span, p')).filter(el =>
        /^简介$/.test(cleanText(el.textContent)) && el.offsetParent !== null
      );
      if (labels.length) sigEl = labels[0].parentElement;
    }
    if (sigEl) {
      const t = cleanText(sigEl.textContent).replace(/^简介[：:]\s*/, '');
      if (t.length <= 300) signature = t;
    }

    // 昵称
    const nickCandidates = [
      'h1[data-e2e="user-title"]',
      'span[data-e2e="user-title"]',
      'h1[class*="user-title"]',
      'h2[class*="user-title"]',
      'div[data-e2e="user-info"] h1',
      'div[data-e2e="user-info"] span'
    ];
    let nEl = pick(nickCandidates);
    if (nEl) nickname = cleanText(nEl.textContent);
    if (!nickname) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og) nickname = cleanText(og.content || '');
    }
    return { uidNum, uniqueId, nickname, signature };
  }

  async function readProfilePage() {
    // 等待页面数据
    for (let i = 0; i < 20; i++) {
      const g = extractProfileFromGlobals();
      if (g && (g.uidNum || g.uniqueId)) {
        const d = extractProfileFromDom();
        return { ...d, ...g };
      }
      await sleep(500);
    }
    return extractProfileFromDom();
  }

  /* ===================== 消息入口 ===================== */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'dy-ping') {
      sendResponse({ ok: true, path: location.pathname });
      return;
    }

    if (msg.type === 'dy-collect-start') {
      const url = normalizeVideoUrl(msg.videoUrl || location.href);
      if (!url) {
        sendResponse({ ok: false, error: '不是有效的抖音视频链接' });
        return;
      }
      // 若当前页面不是该视频，跳转过去
      const targetId = (url.match(/video\/(\d+)/) || [])[1];
      const curId = (location.pathname.match(/video\/(\d+)/) || [])[1];
      if (!curId || curId !== targetId) {
        location.href = url; // 跳转后由 background 重新触发
        sendResponse({ ok: true, redirecting: true });
        return;
      }
      session.videoUrl = url;
      session.keywords = Array.isArray(msg.keywords) ? msg.keywords : [];
      session.scrollInterval = Number(msg.scrollInterval) || 2000;
      session.maxIdleRounds = Number(msg.maxIdleRounds) || 5;
      // 已在采集则只更新参数，不重复启动循环
      if (session.running) {
        sendResponse({ ok: true, started: true, already: true });
        return;
      }
      session.sentKeys.clear();
      session.debug = {};
      session.apiActive = false;
      resetApiSession();
      session.running = true;
      console.log('[dy-lead] 收到采集指令：', url, '｜关键词', session.keywords.length, '个｜间隔', session.scrollInterval, 'ms｜API监听已就绪');
      reportProgress('running', { debug: {} });
      runCollectLoop().catch(err => {
        console.error('[dy-lead] 采集循环异常：', err);
        reportProgress('error', { error: String(err && err.message || err) });
        session.running = false;
      });
      sendResponse({ ok: true, started: true });
      return;
    }

    if (msg.type === 'dy-stop') {
      session.running = false;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'dy-profile-read') {
      readProfilePage().then(data => {
        sendResponse({ ok: true, secUid: (location.pathname.match(/\/user\/([A-Za-z0-9_\-]+)/) || [])[1], ...data });
      }).catch(err => sendResponse({ ok: false, error: String(err) }));
      return true; // 异步响应
    }
  });
})();
