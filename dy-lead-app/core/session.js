'use strict';
/**
 * 核心流程 · 账号会话
 *
 * 一个账号 = 一个持久化浏览器资料目录（登录一次长期有效）。
 * 原则：页面元素只用来“做动作”（输入、点击、滚动）；结果与状态一律以平台自己的接口响应为准。
 *
 * 会话维护三件事：
 *   1. 响应总线：把页面收到的抖音接口响应解析成有类型的事件（search / comments / profileSelf …）。
 *   2. 登录状态：以最近一次 /user/profile/self/ 成功响应为准（status_code=0 且带 sec_uid），
 *      不在每次跳转后重读 DOM —— 旧流程因此在搜索页频繁误判“未取得登录证据”。
 *   3. 验证状态：出现验证码弹层时进入 waiting_verification，由人工在窗口里完成，程序只等待。
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { resolveBrowserRuntime } = require('../lib/browser-runtime');
const { parseSearchBody } = require('../lib/search-works');
const { readPageHealth } = require('../lib/browser-actions');

const API = {
  search: /^\/aweme\/v1\/web\/(?:general\/)?search\/(?:stream|single|item)\/$/,
  comments: /^\/aweme\/v1\/web\/comment\/list\/$/,
  profileSelf: /^\/aweme\/v1\/web\/user\/profile\/self\/$/,
  profileOther: /^\/aweme\/v1\/web\/user\/profile\/other\/$/,
  detail: /^\/aweme\/v1\/web\/aweme\/detail\/$/
};

class Session {
  constructor({ profileDir, trace, proxy }) {
    this.profileDir = profileDir;
    this.trace = trace;
    this.proxy = proxy;
    this.listeners = new Set();
    this.login = { state: 'unknown', at: 0 };
  }

  async open() {
    const runtime = resolveBrowserRuntime({ appDir: path.join(__dirname, '..') });
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath: runtime.executablePath, headless: false, viewport: { width: 1280, height: 860 },
      args: ['--window-size=1280,900'], timeout: 45000, ...(this.proxy ? { proxy: this.proxy } : {})
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.on('response', response => this.onResponse(response).catch(() => {}));
    // 关注类请求单独记录（只记路径、方法与字段名，不记取值），用于核对关注动作实际调用的接口
    this.page.on('request', request => {
      let url; try { url = new URL(request.url()); } catch (_) { return; }
      if (!/(^|\.)douyin\.com$/.test(url.hostname) || !/follow/i.test(url.pathname) || /\/(?:following|follower)\/list/.test(url.pathname)) return;
      const body = request.postData() || '';
      const fields = body.includes('=') ? body.split('&').map(pair => pair.split('=')[0]) : body ? ['(非表单正文)'] : [];
      const keys = [...url.searchParams.keys()], dup = keys.filter((key, index) => keys.indexOf(key) !== index);
      const bodyParams = body.includes('=') ? new URLSearchParams(body) : null;
      this.trace.step('net.follow_request', { contentType: request.headers()['content-type'] || '', duplicateQueryKeys: [...new Set(dup)], bodyUserIdDigits: bodyParams && bodyParams.get('user_id') ? bodyParams.get('user_id').length : 0, bodyUserIdTail: bodyParams && bodyParams.get('user_id') ? bodyParams.get('user_id').slice(-4) : '', method: request.method(), path: url.pathname, queryKeys: [...url.searchParams.keys()].filter(key => !/^(?:a_bogus|msToken|verifyFp|fp|webid|uifid)$/.test(key)).slice(0, 12), bodyFields: fields.slice(0, 12) });
    });
    this.trace.step('session.open', { browser: runtime.source, profileDir: this.profileDir });
    return this;
  }

  /**
   * 挂接到软件已经打开的账号页面（engine.launchAccount 返回的 page），不另开浏览器。
   * 用完必须 detach()，否则监听会留在账号页面上。
   */
  static attach(page, trace) {
    const session = new Session({ profileDir: '', trace });
    session.page = page;
    session.context = null;
    session.responseHandler = response => session.onResponse(response).catch(() => {});
    page.on('response', session.responseHandler);
    session.login = { state: 'authenticated', at: Date.now() }; // 软件侧已按自身流程确认登录
    return session;
  }

  detach() {
    if (this.page && this.responseHandler) this.page.off('response', this.responseHandler);
    this.listeners.clear();
  }

  async close() { await this.context?.close().catch(() => {}); }

  /** 订阅解析后的接口事件；返回取消函数。 */
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async onResponse(response) {
    let url;
    try { url = new URL(response.url()); } catch (_) { return; }
    if (!/(^|\.)douyin\.com$/.test(url.hostname)) return;
    const status = response.status();
    let event = null;
    if (API.search.test(url.pathname)) {
      const parsed = parseSearchBody(await response.text().catch(() => ''));
      event = { type: 'search', status, keyword: url.searchParams.get('keyword') || '', offset: Number(url.searchParams.get('offset') || 0), ...parsed };
      this.trace.response('search', { offset: event.offset, works: parsed.works.length, hasMore: parsed.hasMore, cursor: parsed.cursor, ok: parsed.ok });
    } else if (API.comments.test(url.pathname)) {
      const json = await response.json().catch(() => null);
      event = { type: 'comments', status, source: 'api', awemeId: url.searchParams.get('aweme_id') || '', requestCursor: Number(url.searchParams.get('cursor') || 0),
        insertIds: url.searchParams.has('insert_ids'), body: json };
      this.trace.response('comment/list', { awemeId: event.awemeId, requestCursor: event.requestCursor, status_code: json?.status_code,
        comments: Array.isArray(json?.comments) ? json.comments.length : json?.comments === null ? null : 'invalid', has_more: json?.has_more, cursor: json?.cursor, total: json?.total });
    } else if (API.profileSelf.test(url.pathname)) {
      const json = await response.json().catch(() => null);
      if (json && json.status_code === 0 && json.user && json.user.sec_uid) {
        this.login = { state: 'authenticated', at: Date.now(), nickname: json.user.nickname || '' };
        this.trace.response('profile/self', { login: 'authenticated' });
      }
      event = { type: 'profileSelf', status, body: json };
    } else if (/follow/i.test(url.pathname) && !/\/(?:following|follower)\/list/.test(url.pathname)) {
      const json = await response.json().catch(() => null);
      this.trace.response('follow-api', { path: url.pathname, status, status_code: json?.status_code, follow_status: json?.follow_status, status_msg: json?.status_msg });
    } else if (API.profileOther.test(url.pathname)) {
      event = { type: 'profileOther', status, body: await response.json().catch(() => null) };
    }
    if (event) for (const listener of [...this.listeners]) listener(event);
  }

  /** 页面是否正在要求安全验证（验证码弹层）。 */
  async verificationShown() {
    return await this.page.evaluate(readPageHealth).catch(() => 'unknown') === 'verification';
  }

  /**
   * 遇到验证时由人工在窗口里完成，程序只等待：连续 3 次检查都不再显示验证弹层才算完成。
   * 超时返回 false，调用方据此暂停任务（属于账号级事件，不能自动重试或绕过）。
   */
  async waitForHumanVerification(timeoutMs = 15 * 60 * 1000) {
    this.trace.step('verification.wait', { message: '平台要求安全验证，请在账号窗口人工完成' });
    console.log('>>> 平台要求安全验证：请在弹出的 Chrome 窗口里完成滑块/点选验证，程序会自动继续');
    const until = Date.now() + timeoutMs;
    let clearChecks = 0;
    while (Date.now() < until) {
      await this.page.waitForTimeout(3000);
      clearChecks = await this.verificationShown() ? 0 : clearChecks + 1;
      if (clearChecks >= 3) { this.trace.step('verification.cleared'); return true; }
    }
    this.trace.step('verification.timeout');
    return false;
  }

  /** 登录确认：打开首页，等待 profile/self 成功响应；未登录则等人工扫码。 */
  async ensureLogin(timeoutMs = 15 * 60 * 1000) {
    const fresh = () => this.login.state === 'authenticated' && Date.now() - this.login.at < 10 * 60 * 1000;
    if (fresh()) return true;
    await this.page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const until = Date.now() + timeoutMs;
    let prompted = false;
    while (Date.now() < until) {
      if (fresh()) { this.trace.step('login.confirmed', { by: 'profile/self 响应' }); return true; }
      if (!prompted && Date.now() > until - timeoutMs + 15000) {
        prompted = true;
        console.log('>>> 未检测到登录：请在弹出的 Chrome 窗口里点“登录”并用手机扫码');
        this.trace.step('login.waiting_scan');
      }
      await this.page.waitForTimeout(2000);
    }
    this.trace.step('login.timeout');
    return false;
  }
}

module.exports = { Session, API };
