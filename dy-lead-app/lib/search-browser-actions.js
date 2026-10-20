'use strict';

/**
 * 搜索页浏览器动作。本文件随 lib/ 原样发布、不参与根目录混淆，
 * 保证 page.evaluate 序列化后的函数自包含（不含混淆作用域引用）。
 * 定位规则全部来自 lib/selectors.js 的 SEARCH，由 bindPageFunction 作为第二个参数内联传入；
 * 页面函数内只能使用参数与浏览器全局对象。
 */
const { SEARCH, bindPageFunction } = require('./selectors');

function findSearchInputRect(_, selectors) {
  const rx = list => new RegExp(list.map(source => '(?:' + source + ')').join('|'));
  let input = null;
  for (const selector of selectors.input) {
    input = document.querySelector(selector);
    if (input && input.offsetParent !== null) break;
    input = null;
  }
  if (!input) {
    const placeholder = rx(selectors.inputPlaceholderText);
    input = Array.from(document.querySelectorAll(selectors.inputByPlaceholder.join(','))).find(el => el.offsetParent !== null && placeholder.test(el.getAttribute('placeholder') || '')) || null;
  }
  if (!input) return null;
  const r = input.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function openSearchEntry(_, selectors) {
  for (const selector of selectors.submitButton) {
    const button = document.querySelector(selector);
    if (button && button.offsetParent !== null) { button.click(); return true; }
  }
  const text = new RegExp(selectors.entryText.map(source => '(?:' + source + ')').join('|'));
  const span = Array.from(document.querySelectorAll(selectors.entryByText.join(','))).find(e => text.test((e.textContent || '').trim()) && e.offsetParent !== null);
  if (span) { span.click(); return true; }
  return false;
}

function clickSearchButton(_, selectors) {
  for (const selector of selectors.submitButton) {
    const button = document.querySelector(selector);
    if (button && button.offsetParent !== null) { button.click(); return true; }
  }
  return false;
}

/** 结果页是否已渲染出指定文字的范围页签（只读，等待页签区出现用）。 */
function hasSearchTab(label, selectors) {
  return Array.from(document.querySelectorAll(selectors.tab.concat(selectors.tabByText).join(',')))
    .some(e => e.offsetParent !== null && (e.textContent || '').replace(/\s+/g, '') === label);
}

/**
 * 点击搜索结果页的范围页签（视频 / 图文）。只在结果区的页签里找，
 * 排除顶部导航与侧栏，避免点到同名的全站入口。返回是否点击及命中方式。
 */
function clickSearchTab(label, selectors) {
  const visible = e => e && e.offsetParent !== null && e.getClientRects().length > 0;
  const nav = selectors.outsideResults.join(',');
  const outsideNav = e => !e.closest(nav);
  const exact = e => (e.textContent || '').replace(/\s+/g, '').trim() === label;
  const roleTabs = Array.from(document.querySelectorAll(selectors.tab.join(','))).filter(e => visible(e) && outsideNav(e) && exact(e));
  if (roleTabs.length === 1) {
    if (roleTabs[0].getAttribute('aria-selected') === 'true') return { clicked: false, already: true, method: 'role-tab' };
    roleTabs[0].click();
    return { clicked: true, method: 'role-tab' };
  }
  const candidates = Array.from(document.querySelectorAll(selectors.tabByText.join(','))).filter(e => visible(e) && outsideNav(e) && exact(e)
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
function scrollSearchFeed(step, selectors) {
  const amount = Number(step) || 1400;
  const candidates = [];
  for (const el of document.querySelectorAll(selectors.feedContainer.join(','))) {
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

module.exports = Object.fromEntries(Object.entries({ findSearchInputRect, openSearchEntry, clickSearchButton, hasSearchTab, clickSearchTab, scrollSearchFeed })
  .map(([name, pageFunction]) => [name, bindPageFunction(pageFunction, SEARCH, name)]));
