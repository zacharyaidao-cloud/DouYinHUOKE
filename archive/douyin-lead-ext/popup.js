/**
 * 抖音获客采集助手 - 弹窗逻辑 v0.2
 */
const $ = id => document.getElementById(id);

const DEFAULT_KEYWORDS = '多少钱,怎么,联系,价格,费用,收费,怎么弄,怎么操作,怎么整,真假,可以吗,激活,恢复,重启,搞,救,多少米,怎么收费,微信,私信,私我,加我,联系我';

let cache = { leads: [], state: {}, settings: {} };
let keepalive = null;
let bgDeadMsg = ''; // 后台无响应时的持久提示

/* ===================== 与后台通信 ===================== */

function bgSend(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) {
          bgDeadMsg = '后台无响应：请到 chrome://extensions 找到本插件，点「重新加载」，再刷新视频页面重试';
          resolve(null);
        } else {
          bgDeadMsg = '';
          resolve(resp);
        }
      });
    } catch (e) {
      bgDeadMsg = '插件已失效：请到 chrome://extensions 移除本插件后重新「加载已解压的扩展程序」';
      resolve(null);
    }
  });
}

function parseKeywords(text) {
  return String(text || '').split(/[,，;；、\n\s]+/).map(s => s.trim()).filter(Boolean);
}

/* ===================== 渲染 ===================== */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStatus(cls, html) {
  const el = $('status');
  el.className = 'status ' + (cls || '');
  el.innerHTML = html;
}

function renderStatus() {
  if (bgDeadMsg) {
    setStatus('err', '❌ ' + esc(bgDeadMsg));
    return;
  }
  const st = cache.state || {};
  const c = st.collect || {};
  const dbg = $('debugInfo');

  if (c.running) {
    setStatus('', `⏳ ${esc(c.status || '采集中…')}` +
      (c.totalExtracted ? `｜已解析 <b>${c.totalExtracted}</b> 条` : '') +
      (c.storedTotal ? `｜已入库 <b>${c.storedTotal}</b> 条` : ''));
  } else if (c.status === 'done' || c.status === 'stopped') {
    setStatus('ok', `✅ ${esc(c.lastError || '采集完成')}` +
      (c.totalExtracted ? `｜共解析 <b>${c.totalExtracted}</b> 条` : '') +
      (c.storedTotal ? `｜已入库 <b>${c.storedTotal}</b> 条` : ''));
  } else if (c.status === 'error' || c.lastError) {
    setStatus('err', `❌ ${esc(c.lastError || c.status || '出错')}`);
  } else {
    setStatus('', '就绪。粘贴视频链接后点击「开始采集」。');
  }

  // 调试信息（API 直读状态 / DOM 选择器命中情况）
  const d = c.debug || {};
  const s = d.stats || {};
  const a = d.api || {};
  const parts = [];
  if (a.pages) {
    parts.push(`API直读：${a.pages} 页 / ${a.comments} 条评论${a.lastTotal ? `（视频共 ${a.lastTotal} 条）` : ''}`);
  } else if (s.foundItemSelector) {
    parts.push(`DOM模式：评论项选择器 ${s.foundItemSelector}`);
  }
  if (s.rounds) parts.push(`已滚动 ${s.rounds} 轮`);
  if (s.idleRounds) parts.push(`停滞 ${s.idleRounds} 轮`);
  if (d.loadMore) parts.push(`展开更多：${d.loadMore} 次`);
  if (parts.length) {
    dbg.classList.remove('hidden');
    dbg.textContent = '调试：' + parts.join('｜');
  } else {
    dbg.classList.add('hidden');
  }
}

function renderEnrich() {
  const p = (cache.state || {}).profile || {};
  const el = $('enrichStatus');
  if (p.running) {
    el.classList.remove('hidden');
    el.className = 'status';
    el.innerHTML = `👤 补全主页资料中 ${p.done}/${p.total}：${esc(p.status || '')}`;
  } else if (p.status === 'done') {
    el.classList.remove('hidden');
    el.className = 'status ok';
    el.textContent = '✅ 主页资料补全完成（粉丝数/关注数/签名/省市/认证）';
  } else if (p.status === 'error') {
    el.classList.remove('hidden');
    el.className = 'status err';
    el.textContent = '❌ ' + (p.lastError || '补全出错');
  } else {
    el.classList.add('hidden');
  }
}

function renderTable() {
  const leads = cache.leads || [];
  $('totalBadge').textContent = `${leads.length} 条`;
  const body = $('leadBody');
  const tip = $('emptyTip');
  body.innerHTML = '';
  const rows = leads.slice(-40).reverse();
  tip.classList.toggle('hidden', rows.length > 0);
  for (const l of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td title="${esc(l.nickname)}">${esc(l.nickname)}${l.trigger ? '<br><span style="color:#fe2c55;font-size:11px">✔' + esc(l.trigger) + '</span>' : ''}</td>` +
      `<td title="${esc(l.demand)}">${esc(l.demand)}</td>` +
      `<td>${esc(l.time)}</td>` +
      `<td>${esc(l.region)}</td>` +
      `<td>${esc(l.account || (l.profileFailed ? '—' : ''))}</td>`;
    body.appendChild(tr);
  }
}

function renderButtons() {
  const st = cache.state || {};
  const collecting = st.collect && st.collect.running;
  const enriching = st.profile && st.profile.running;
  $('btnStart').disabled = collecting || enriching;
  $('btnStop').disabled = !collecting;
  $('btnEnrich').disabled = collecting || enriching || !(cache.leads || []).length;
  $('btnExport').disabled = !(cache.leads || []).length;
  $('btnCsv').disabled = !(cache.leads || []).length;
  $('btnClear').disabled = collecting || enriching || !(cache.leads || []).length;
}

async function refresh() {
  const r = await bgSend({ type: 'dy-get-data' });
  if (r) {
    cache = { leads: r.leads || [], state: r.state || {}, settings: r.settings || {} };
    if (r.version) $('footerVer').textContent = 'v' + r.version;
  }
  renderStatus();
  renderEnrich();
  renderTable();
  renderButtons();
}

/* ===================== 环境自检 ===================== */

async function onDiag() {
  const lines = [];
  let manifest = null;
  try { manifest = chrome.runtime.getManifest(); } catch (e) { /* ignore */ }
  lines.push(`① 插件加载：${manifest ? '✅ 已加载（v' + manifest.version + '）' : '❌ 未加载，去 chrome://extensions 重新加载'}`);

  // ② 后台连通
  const t0 = Date.now();
  const r = await bgSend({ type: 'dy-ping-bg' });
  lines.push(r ? `② 后台服务：✅ 正常（${Date.now() - t0}ms，v${r.version}）` : `② 后台服务：❌ ${esc(bgDeadMsg)}`);

  // ③ 当前标签页与内容脚本
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      lines.push('③ 当前标签页：未找到');
    } else {
      const url = tab.url || '';
      lines.push(`③ 当前标签页：${url ? esc(url.slice(0, 80)) : '(读取不到 URL)'}`);
      if (/douyin\.com\/video\/\d+/.test(url)) {
        let pr = null;
        try {
          pr = await chrome.tabs.sendMessage(tab.id, { type: 'dy-ping' });
        } catch (e) { /* 未注入 */ }
        lines.push(pr && pr.ok
          ? `④ 页面脚本：✅ 已注入（路径 ${pr.path}）。可以点「开始采集」`
          : '④ 页面脚本：❌ 未注入 → 按 F5 刷新该视频页面后重试（插件刚安装时旧页面不会自动注入）');
      } else {
        lines.push('④ 页面脚本：⏭ 当前页不是抖音视频页，点「开始采集」会自动跳转');
      }
    }
  } catch (e) {
    lines.push('③/④ 标签页检测失败：' + esc(e.message));
  }

  // ⑤ 线索库
  const d = await bgSend({ type: 'dy-get-data' });
  lines.push(d ? `⑤ 线索库：${(d.leads || []).length} 条` : '⑤ 线索库：读取失败（后台无响应）');
  lines.push('');
  lines.push('提示：若以上全部正常仍不采集，请打开视频页按 F12，');
  lines.push('把控制台里带 [dy-lead] 的日志截图发给我。');

  const el = $('diag');
  el.textContent = lines.join('\n');
  el.classList.remove('hidden');
}

/* ===================== 导出 ===================== */

const EXCEL_HEADERS = ['ID', 'uid', '关键词', '账号', 'UID', '用户名称', '个性签名', '主页链接', '触发词', '需求内容', '时间', '属地', '视频链接', '获取时间', '粉丝数', '关注数', '获赞数', '作品数', '性别', '省份', '城市', '认证'];

function genderText(g) {
  if (g === 1 || g === '1') return '男';
  if (g === 2 || g === '2') return '女';
  return '';
}

function leadToRow(l) {
  return [
    l.id, l.uid, l.keyword || '', l.account, l.UID, l.nickname, l.signature,
    l.homepage, l.trigger, l.demand, l.time, l.region, l.videoLink, l.fetchTime,
    l.followerCount != null ? l.followerCount : '',
    l.followingCount != null ? l.followingCount : '',
    l.favoritedCount != null ? l.favoritedCount : '',
    l.awemeCount != null ? l.awemeCount : '',
    genderText(l.gender), l.province || '', l.city || '', l.verify || ''
  ];
}

function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function exportExcel() {
  if (typeof XLSX === 'undefined') {
    setStatus('err', '❌ Excel 库加载失败：请到 chrome://extensions 点本插件的「重新加载」后再试');
    return;
  }
  const wb = XLSX.utils.book_new();

  // Sheet 1: 线索（14 基础列 + 8 扩展列）
  const rows = (cache.leads || []).map(leadToRow);
  const aoa = [EXCEL_HEADERS, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 8 }, { wch: 48 }, { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 20 },
    { wch: 20 }, { wch: 48 }, { wch: 10 }, { wch: 40 }, { wch: 20 }, { wch: 8 },
    { wch: 44 }, { wch: 20 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 },
    { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 18 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Users');

  // Sheet 2: 视频数据（采集过的视频）
  const vd = (cache.state && cache.state.videoDetails) || {};
  const vdList = Object.values(vd);
  if (vdList.length) {
    const vdHeaders = ['视频链接', '视频描述', '点赞数', '评论数', '分享数', '收藏数', '作者', '作者粉丝数', '获取时间'];
    const vdRows = vdList.map(v => [
      v.videoLink || '', v.desc || '', v.diggCount, v.commentCount, v.shareCount, v.collectCount,
      v.authorNickname || '', v.authorFollowerCount, v.capturedAt || ''
    ]);
    const ws2 = XLSX.utils.aoa_to_sheet([vdHeaders, ...vdRows]);
    ws2['!cols'] = [{ wch: 44 }, { wch: 50 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 20 }, { wch: 10 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws2, '视频数据');
  }

  XLSX.writeFile(wb, `行业作品意向匹配-${todayStr()}.xlsx`);
  setStatus('ok', `✅ 已导出 ${rows.length} 条线索${vdList.length ? ` + ${vdList.length} 条视频数据` : ''}到 Excel`);
}

function exportCsv() {
  const csvLine = arr => arr.map(v => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
  const lines = [csvLine(EXCEL_HEADERS)];
  for (const l of cache.leads || []) lines.push(csvLine(leadToRow(l)));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `行业作品意向匹配-${todayStr()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus('ok', `✅ 已导出 ${(cache.leads || []).length} 条线索到 CSV`);
}

/* ===================== 事件 ===================== */

async function onStart() {
  const videoUrl = $('videoUrl').value.trim();
  if (!/video\/\d+/.test(videoUrl)) {
    setStatus('err', '❌ 请粘贴正确的抖音视频链接（需包含 /video/数字ID）');
    return;
  }
  setStatus('', '正在启动采集…');

  const keywords = parseKeywords($('keywords').value);
  const topic = $('topic').value.trim();
  const scrollInterval = Number($('scrollInterval').value) || 2;
  const maxIdleRounds = Number($('maxIdleRounds').value) || 5;

  await bgSend({ type: 'dy-save-settings', keywords, topic, scrollInterval, maxIdleRounds });
  const r = await bgSend({
    type: 'dy-start',
    videoUrl, keywords, topic, scrollInterval, maxIdleRounds
  });
  if (!r) {
    setStatus('err', '❌ ' + esc(bgDeadMsg || '后台无响应'));
  } else if (!r.ok) {
    setStatus('err', '❌ ' + esc(r.error || '启动失败'));
  } else {
    setStatus('', '✅ 已启动！将自动打开/定位到视频页并开始滚动采集。<br>提示：若页面无反应，点「🔧 自检」查看页面脚本状态。');
  }
  refresh();
}

async function onStop() {
  await bgSend({ type: 'dy-stop' });
  refresh();
}

async function onEnrich() {
  await bgSend({ type: 'dy-enrich-start' });
  refresh();
}

async function onClear() {
  if (!confirm('确定清空全部线索数据？此操作不可恢复。')) return;
  await bgSend({ type: 'dy-clear' });
  refresh();
}

/* ===================== 初始化 ===================== */

async function init() {
  // 保持后台 Service Worker 存活（补全主页信息时需要）
  try {
    keepalive = chrome.runtime.connect({ name: 'popup-keepalive' });
    keepalive.onDisconnect.addListener(() => {
      try { keepalive = chrome.runtime.connect({ name: 'popup-keepalive' }); } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  $('btnStart').addEventListener('click', onStart);
  $('btnStop').addEventListener('click', onStop);
  $('btnDiag').addEventListener('click', onDiag);
  $('btnEnrich').addEventListener('click', onEnrich);
  $('btnExport').addEventListener('click', exportExcel);
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnClear').addEventListener('click', onClear);

  // 从后台恢复上次设置
  const r = await bgSend({ type: 'dy-get-data' });
  if (r && r.settings) {
    const s = r.settings;
    $('keywords').value = (s.keywords && s.keywords.length) ? s.keywords.join(', ') : DEFAULT_KEYWORDS;
    $('topic').value = s.topic || '';
    $('scrollInterval').value = (Number(s.scrollInterval) || 2) * 1;
    $('maxIdleRounds').value = Number(s.maxIdleRounds) || 5;
  } else {
    $('keywords').value = DEFAULT_KEYWORDS;
    $('scrollInterval').value = 2;
    $('maxIdleRounds').value = 5;
  }

  try { $('footerVer').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* ignore */ }

  refresh();
  setInterval(refresh, 1000);
}

document.addEventListener('DOMContentLoaded', init);
