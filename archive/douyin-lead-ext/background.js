/**
 * 抖音获客采集助手 - 后台 Service Worker
 * 职责：线索存储/去重、采集与主页补全的任务调度、与弹窗通信
 */

const KEYS = {
  leads: 'dy_leads',
  state: 'dy_state',
  settings: 'dy_settings'
};

const DEFAULT_SETTINGS = {
  keywords: [],
  topic: '',
  scrollInterval: 2000,
  maxIdleRounds: 5
};

function nowStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function getLeads() {
  const obj = await chrome.storage.local.get(KEYS.leads);
  return Array.isArray(obj[KEYS.leads]) ? obj[KEYS.leads] : [];
}

async function setLeads(leads) {
  await chrome.storage.local.set({ [KEYS.leads]: leads });
}

async function getState() {
  const obj = await chrome.storage.local.get(KEYS.state);
  return obj[KEYS.state] || {};
}

async function setState(patch) {
  const s = await getState();
  const merged = { ...s };
  for (const k of Object.keys(patch)) {
    merged[k] = { ...(merged[k] || {}), ...(patch[k] || {}) };
  }
  await chrome.storage.local.set({ [KEYS.state]: merged });
}

async function getSettings() {
  const obj = await chrome.storage.local.get(KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(obj[KEYS.settings] || {}) };
}

async function setSettings(patch) {
  const s = await getSettings();
  await chrome.storage.local.set({ [KEYS.settings]: { ...s, ...patch } });
}

function normalizeVideoUrl(url) {
  const m = String(url || '').match(/video\/(\d+)/);
  if (m) return { url: `https://www.douyin.com/video/${m[1]}`, id: m[1] };
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ===================== 采集调度 ===================== */

async function sendToTab(tabId, msg, retries = 5, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, msg);
      if (resp) return resp;
    } catch (e) { /* 内容脚本尚未就绪，稍后重试 */ }
    await sleep(delayMs);
  }
  return null;
}

let currentKickListener = null;

async function startCollect({ videoUrl, keywords, topic, scrollInterval, maxIdleRounds }) {
  const norm = normalizeVideoUrl(videoUrl);
  if (!norm) return { ok: false, error: '不是有效的抖音视频链接（需要包含 /video/数字ID）' };
  console.log('[dy-lead][bg] 收到启动请求：', norm.url);

  await setSettings({
    keywords: (keywords || []).map(k => String(k).trim()).filter(Boolean),
    topic: String(topic || '').trim(),
    scrollInterval: Number(scrollInterval) || 2000,
    maxIdleRounds: Number(maxIdleRounds) || 5
  });

  // 目标标签页选择：
  // 1) 当前活动标签页若是抖音页面 → 直接复用（弹窗不关闭，能实时看进度）
  // 2) 已有该视频的标签页 → 复用
  // 3) 都没有 → 新建
  let tab = null;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.id != null && (activeTab.url || '').startsWith('https://www.douyin.com/')) {
      tab = activeTab;
      console.log('[dy-lead][bg] 复用当前活动标签页', tab.id, tab.url);
    }
  } catch (e) { /* ignore */ }

  if (!tab) {
    const existing = await chrome.tabs.query({ url: 'https://www.douyin.com/video/*' });
    tab = existing.find(t => (t.url || '').includes(`/video/${norm.id}`)) || null;
    if (tab) console.log('[dy-lead][bg] 复用已有视频标签页', tab.id);
  }

  if (!tab) {
    tab = await chrome.tabs.create({ url: norm.url, active: true });
    console.log('[dy-lead][bg] 新建标签页', tab.id);
  } else if (!(tab.url || '').includes(`/video/${norm.id}`)) {
    // 活动页是抖音但非目标视频：导航过去（页面会刷新，弹窗保持打开）
    await chrome.tabs.update(tab.id, { url: norm.url });
    console.log('[dy-lead][bg] 当前页导航到视频', norm.url);
  } else {
    console.log('[dy-lead][bg] 目标页已在位，不导航不刷新');
  }

  await setState({
    collect: {
      running: true, tabId: tab.id, videoUrl: norm.url, status: '等待页面加载…',
      totalExtracted: 0, storedTotal: 0, lastError: '', kicks: 0
    }
  });

  // 页面加载完成后把采集指令发给内容脚本；失败则自动刷新页面重试（最多 3 次）
  const kickOff = async (tabId, url, info) => {
    if (tabId !== tab.id) return;
    if (info && info.status && info.status !== 'complete') return;
    if (!(url || '').includes(`/video/${norm.id}`)) return;
    const st = await getState();
    if (!st.collect || !st.collect.running) return;
    const kicks = (st.collect.kicks || 0) + 1;
    await setState({ collect: { kicks, status: `启动采集（第 ${kicks} 次尝试）…` } });
    console.log(`[dy-lead][bg] kickOff 第 ${kicks} 次 → tab ${tabId}`);
    await sleep(800);
    const settings = await getSettings();
    const resp = await sendToTab(tabId, {
      type: 'dy-collect-start',
      videoUrl: norm.url,
      keywords: settings.keywords,
      scrollInterval: settings.scrollInterval,
      maxIdleRounds: settings.maxIdleRounds
    });
    if (!resp) {
      console.warn('[dy-lead][bg] 页面脚本无响应（可能未注入），kicks =', kicks);
      if (kicks < 3) {
        await setState({ collect: { status: '页面脚本未就绪，自动刷新页面重试…' } });
        await sleep(500);
        try { await chrome.tabs.reload(tabId); } catch (e) { /* ignore */ }
      } else {
        await setState({
          collect: { running: false, status: 'error', lastError: '无法与视频页通信。请手动 F5 刷新视频页面后重新点击「开始采集」' }
        });
      }
    } else {
      console.log('[dy-lead][bg] 采集指令已送达页面脚本');
    }
  };

  // 每次启动只保留一个监听器，避免重复触发
  if (currentKickListener) {
    try { chrome.tabs.onUpdated.removeListener(currentKickListener); } catch (e) { /* ignore */ }
  }
  currentKickListener = kickOff;
  chrome.tabs.onUpdated.addListener(currentKickListener);

  // 页面已加载完成（复用标签页）→ 直接触发
  if (tab.status === 'complete' && (tab.url || '').includes(`/video/${norm.id}`)) {
    setTimeout(() => kickOff(tab.id, tab.url, { status: 'complete' }), 600);
  }

  return { ok: true, tabId: tab.id };
}

async function stopCollect() {
  console.log('[dy-lead][bg] 停止采集');
  const st = await getState();
  const tabId = st.collect && st.collect.tabId;
  if (tabId != null) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'dy-stop' }); } catch (e) { /* ignore */ }
  }
  await setState({ collect: { running: false, status: '已停止' } });
  return { ok: true };
}

/* ===================== 线索入库 ===================== */

async function ingestBatch(videoLink, items) {
  const leads = await getLeads();
  const seen = new Set(leads.map(l => dedupeKey(l)));
  let maxId = leads.reduce((m, l) => Math.max(m, Number(l.id) || 0), 0);
  const t = nowStr();
  const settings = await getSettings();
  const topic = settings.topic || '';
  let added = 0;

  for (const it of items) {
    const lead = {
      id: 0,
      uid: it.uid || '',
      keyword: topic || it.trigger || '',
      account: it.account || '',
      UID: it.uidNum || '',
      nickname: it.nickname || '',
      signature: it.signature || '',
      homepage: it.homepage || '',
      trigger: it.trigger || '',
      demand: it.demand || '',
      time: it.time || '',
      region: it.region || '',
      videoLink: videoLink || it.videoLink || '',
      fetchTime: t
    };
    lead.id = ++maxId;
    const key = dedupeKey(lead);
    if (seen.has(key)) continue;
    seen.add(key);
    leads.push(lead);
    added++;
  }

  if (added) await setLeads(leads);
  console.log(`[dy-lead][bg] 入库：本轮 ${items.length} 条，新增 ${added} 条，总线索 ${leads.length} 条`);
  return { ok: true, added, total: leads.length };
}

function dedupeKey(l) {
  return [l.videoLink, l.uid, (l.demand || l.nickname || '').trim()].join('||');
}

/* ===================== 主页信息补全 ===================== */

async function enrichProfiles() {
  const st = await getState();
  if (st.collect && st.collect.running) {
    await setState({ profile: { running: false, status: 'error', lastError: '请先停止采集再补全主页信息' } });
    return { ok: false, error: '采集进行中，请先停止' };
  }
  const leads = await getLeads();
  // 补全目标：还没成功读取主页资料的线索（粉丝数/关注数/签名/省市等）
  const targets = leads.filter(l => l.homepage && !l.profileDone && !l.profileFailed);
  await setState({ profile: { running: true, done: 0, total: targets.length, status: '开始补全…', lastError: '' } });

  for (let i = 0; i < targets.length; i++) {
    const st2 = await getState();
    if (!st2.profile || !st2.profile.running) break;

    const lead = targets[i];
    await setState({ profile: { done: i, total: targets.length, status: `(${i + 1}/${targets.length}) ${lead.nickname || lead.uid}` } });

    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: lead.homepage, active: false });
      await waitForTabComplete(tab.id, 15000);

      // 等待网络拦截自动把主页数据写回（主世界钩子 → 内容脚本 → 后台）
      let gotViaHook = false;
      for (let w = 0; w < 10; w++) {
        await sleep(1000);
        const fresh = await getLeads();
        const cur = fresh.find(x => x.id === lead.id);
        if (cur && cur.profileDone) { gotViaHook = true; break; }
      }

      if (!gotViaHook) {
        // 兜底：直接让内容脚本从页面 DOM/全局数据里提取
        const resp = await sendToTab(tab.id, { type: 'dy-profile-read' }, 3, 1000);
        const fresh = await getLeads();
        const cur = fresh.find(x => x.id === lead.id) || lead;
        if (resp && resp.ok) {
          if (resp.uidNum) cur.UID = String(resp.uidNum);
          if (resp.uniqueId) cur.account = String(resp.uniqueId);
          if (resp.signature) cur.signature = resp.signature;
          if (resp.nickname && !cur.nickname) cur.nickname = resp.nickname;
          cur.profileDone = true;
        } else {
          cur.profileFailed = true; // 失败不再重试，避免卡死
        }
        await setLeads(fresh);
      }
    } catch (e) {
      const fresh = await getLeads();
      const cur = fresh.find(x => x.id === lead.id);
      if (cur) { cur.profileFailed = true; await setLeads(fresh); }
    } finally {
      if (tab) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* ignore */ } }
    }
    await sleep(1200 + Math.random() * 1800);
  }

  await setState({ profile: { running: false, done: targets.length, total: targets.length, status: '补全完成' } });
  return { ok: true };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

/* ===================== 消息路由 ===================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  (async () => {
    switch (msg.type) {
      case 'dy-start':
        sendResponse(await startCollect(msg));
        break;

      case 'dy-stop':
        sendResponse(await stopCollect());
        break;

      case 'dy-save-settings': {
        await setSettings({
          keywords: (msg.keywords || []).map(k => String(k).trim()).filter(Boolean),
          topic: String(msg.topic || '').trim(),
          scrollInterval: Number(msg.scrollInterval) || 2000,
          maxIdleRounds: Number(msg.maxIdleRounds) || 5
        });
        sendResponse({ ok: true });
        break;
      }

      case 'dy-batch': {
        const r = await ingestBatch(msg.videoLink, msg.items);
        sendResponse(r);
        break;
      }

      case 'dy-progress': {
        const st = await getState();
        if (msg.status === 'done' || msg.status === 'error') {
          console.log(`[dy-lead][bg] 采集${msg.status === 'done' ? '完成' : '出错'}：`, msg.reason || msg.error || '', '共解析', msg.totalExtracted, '条');
        }
        const patch = {
          collect: {
            running: st.collect ? st.collect.running : true,
            status: msg.status || '',
            totalExtracted: msg.totalExtracted != null ? msg.totalExtracted : (st.collect && st.collect.totalExtracted) || 0,
            storedTotal: msg.storedTotal != null ? msg.storedTotal : (st.collect && st.collect.storedTotal) || 0,
            lastError: msg.error || msg.reason || '',
            debug: msg.debug || (st.collect && st.collect.debug) || null
          }
        };
        if (msg.status === 'done' || msg.status === 'stopped' || msg.status === 'error') patch.collect.running = false;
        await setState(patch);
        sendResponse({ ok: true });
        break;
      }

      case 'dy-enrich-start': {
        sendResponse({ ok: true, started: true });
        enrichProfiles().catch(async err => {
          await setState({ profile: { running: false, status: 'error', lastError: String(err && err.message || err) } });
        });
        break;
      }

      case 'dy-enrich-stop': {
        await setState({ profile: { running: false, status: '已停止' } });
        sendResponse({ ok: true });
        break;
      }

      case 'dy-profile-update': {
        const info = msg.info || {};
        if (!info.secUid) { sendResponse({ ok: false }); break; }
        const leads = await getLeads();
        const target = `https://www.douyin.com/user/${info.secUid}`;
        const hits = leads.filter(l => l.homepage === target);
        for (const l of hits) {
          if (info.uidNum) l.UID = info.uidNum;
          if (info.account) l.account = info.account;
          if (info.nickname && !l.nickname) l.nickname = info.nickname;
          if (info.signature) l.signature = info.signature;
          l.followerCount = info.followerCount;
          l.followingCount = info.followingCount;
          l.favoritedCount = info.favoritedCount;
          l.awemeCount = info.awemeCount;
          l.gender = info.gender;
          l.province = info.province;
          l.city = info.city;
          l.verify = info.verify;
          l.profileDone = true;
        }
        if (hits.length) await setLeads(leads);
        console.log('[dy-lead][bg] 主页数据更新：', hits.length, '条线索，', (info.nickname || info.secUid.slice(0, 12)));
        sendResponse({ ok: true, updated: hits.length });
        break;
      }

      case 'dy-video-detail': {
        const info = msg.info || {};
        if (!info.awemeId) { sendResponse({ ok: false }); break; }
        const st = await getState();
        const vd = st.videoDetails || {};
        vd[info.awemeId] = { ...info, capturedAt: nowStr() };
        await setState({ videoDetails: vd });
        console.log('[dy-lead][bg] 视频详情入库：', info.awemeId, '点赞', info.diggCount, '评论', info.commentCount);
        sendResponse({ ok: true });
        break;
      }

      case 'dy-clear': {
        await setLeads([]);
        await setState({ videoDetails: {} });
        sendResponse({ ok: true });
        break;
      }

      case 'dy-ping-bg': {
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version, ts: Date.now() });
        break;
      }

      case 'dy-get-data': {
        const [leads, state, settings] = await Promise.all([getLeads(), getState(), getSettings()]);
        sendResponse({ ok: true, leads, state, settings, version: chrome.runtime.getManifest().version });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown type' });
    }
  })();
  return true; // 异步响应
});

// 采集标签页被关闭时自动复位状态
chrome.tabs.onRemoved.addListener(async tabId => {
  const st = await getState();
  if (st.collect && st.collect.running && st.collect.tabId === tabId) {
    console.log('[dy-lead][bg] 视频标签页被关闭，采集复位');
    await setState({ collect: { running: false, status: 'stopped', lastError: '视频标签页已关闭' } });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[dy-lead][bg] 插件已安装/更新，版本', chrome.runtime.getManifest().version);
});
