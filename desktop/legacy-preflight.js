/** 只读本机旧服务探测。新版采用随机端口，也不能绕过旧版同数据写入保护。 */
async function identifyLegacyService(port, fetcher = fetch) {
  const base = 'http://127.0.0.1:' + port;
  try {
    const response = await fetcher(base + '/health', { redirect: 'error', signal: AbortSignal.timeout(1200) });
    if (response.ok) {
      const payload = await response.json();
      if (payload?.app === 'dy-lead-app') return { port, version: String(payload.version || '旧版') };
    }
  } catch { /* 老版本没有健康接口，继续识别其界面 */ }
  try {
    const response = await fetcher(base + '/', { redirect: 'error', signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const html = await response.text();
    if (html.length < 256000 && /<title>\s*抖音获客软件\s*<\/title>/i.test(html) && /id=["']login-layer["']/i.test(html)) {
      return { port, version: '旧版' };
    }
  } catch { /* 端口空闲或属于其他软件 */ }
  return null;
}
async function assertNoLegacyService({ oldPort, fetcher = fetch } = {}) {
  const ports = [...new Set([17888, Number(oldPort)].filter(port => Number.isInteger(port) && port > 0 && port <= 65535))];
  const running = (await Promise.all(ports.map(port => identifyLegacyService(port, fetcher)))).find(Boolean);
  if (running) throw new Error('检测到另一份获客软件后台正在运行（端口 ' + running.port + '，版本 ' + running.version + '）。请先停止原版任务并退出原版及其后台服务，再启动独立客户端。退出登录或关闭浏览器页面不能结束旧版 node.exe 后台；可关闭原启动终端，或在任务管理器按安装目录核对并结束对应后台，也可重启电脑后直接运行新版。本次尚未启动任务或写入业务数据。');
}
module.exports = { assertNoLegacyService, identifyLegacyService };
