'use strict';

/**
 * 搜索页浏览器动作。本文件随 lib/ 原样发布、不参与根目录混淆，
 * 保证 page.evaluate 序列化后的函数自包含（不含混淆作用域引用）。
 * 定位优先使用平台稳定的 data-e2e 标识，再退回占位文案匹配。
 */

function findSearchInputRect() {
  let input = document.querySelector('input[data-e2e="searchbar-input"]');
  if (!input || input.offsetParent === null) {
    input = Array.from(document.querySelectorAll('input')).find(el => el.offsetParent !== null && /搜索你感兴趣的内容|搜索/.test(el.getAttribute('placeholder') || '')) || null;
  }
  if (!input) return null;
  const r = input.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function openSearchEntry() {
  const button = document.querySelector('button[data-e2e="searchbar-button"]');
  if (button && button.offsetParent !== null) { button.click(); return true; }
  const span = Array.from(document.querySelectorAll('span')).find(e => (e.textContent || '').trim() === '搜索' && e.offsetParent !== null);
  if (span) { span.click(); return true; }
  return false;
}

function clickSearchButton() {
  const button = document.querySelector('button[data-e2e="searchbar-button"]');
  if (button && button.offsetParent !== null) { button.click(); return true; }
  return false;
}

/**
 * 点击搜索结果页的范围页签（视频 / 图文）。只在结果区的页签里找，
 * 排除顶部导航与侧栏，避免点到同名的全站入口。返回是否点击及命中方式。
 */
function clickSearchTab(label) {
  const visible = e => e && e.offsetParent !== null && e.getClientRects().length > 0;
  const outsideNav = e => !e.closest('header,nav,aside,[role="navigation"],[role="banner"]');
  const exact = e => (e.textContent || '').replace(/\s+/g, '').trim() === label;
  const roleTabs = Array.from(document.querySelectorAll('[role="tab"]')).filter(e => visible(e) && outsideNav(e) && exact(e));
  if (roleTabs.length === 1) {
    if (roleTabs[0].getAttribute('aria-selected') === 'true') return { clicked: false, already: true, method: 'role-tab' };
    roleTabs[0].click();
    return { clicked: true, method: 'role-tab' };
  }
  const candidates = Array.from(document.querySelectorAll('div,span,a')).filter(e => visible(e) && outsideNav(e) && exact(e)
    && !Array.from(e.children).some(child => exact(child)));
  if (!candidates.length) return { clicked: false, method: 'none' };
  candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  candidates[0].click();
  return { clicked: true, method: 'text', count: candidates.length };
}

/**
 * 滚动搜索结果流：新版结果页把滚动放在内部路由容器（如 route-scroll-container），
 * 窗口本身不可滚。优先滚可滚动量最大的容器，回退滚窗口。
 */
function scrollSearchFeed(step) {
  const amount = Number(step) || 1400;
  const candidates = [];
  for (const el of document.querySelectorAll('div,main,section,ul')) {
    if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 200) candidates.push(el);
  }
  candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  const feed = candidates[0];
  if (feed) {
    const before = feed.scrollTop;
    feed.scrollTop = before + amount;
    return { container: String(feed.className).slice(0, 60), scrolled: feed.scrollTop - before };
  }
  const before = window.scrollY;
  window.scrollBy(0, amount);
  return { container: 'window', scrolled: window.scrollY - before };
}

module.exports = { findSearchInputRect, openSearchEntry, clickSearchButton, clickSearchTab, scrollSearchFeed };
