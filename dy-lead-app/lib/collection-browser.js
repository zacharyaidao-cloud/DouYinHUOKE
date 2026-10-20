'use strict';
const { normalizeVideoLink } = require('./video-links');
const { TaskStopError } = require('../scheduler');
const { COMMENTS, bindPageFunction } = require('./selectors');

// Browser callbacks stay outside the Node obfuscation boundary. Only explicit
// arguments and browser globals may be used in these functions. Locating rules
// arrive from selectors.js (COMMENTS) as the second, inlined argument.
function openComments(options, selectors) {
  // This callback is serialized independently by Playwright. Keep its helpers
  // inside the function, and return only state flags, never page/account data.
  const visible = element => {
    if (!element || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
  };
  const rx = list => new RegExp(list.map(source => '(?:' + source + ')').join('|'));
  const listSelector = selectors.list.join(',');
  const markerSelector = selectors.item.join(',');
  const excluded = selectors.entryExcluded.join(',');
  const tabLabel = rx(selectors.tabLabel);
  let region = Array.from(document.querySelectorAll(listSelector)).find(visible);
  if (!region) {
    for (const marker of document.querySelectorAll(markerSelector)) {
      if (!visible(marker)) continue;
      const list = marker.closest(selectors.itemScope.join(','));
      if (list && list !== document.body && list !== document.documentElement && visible(list)) { region = list; break; }
    }
  }
  if (!region) {
    for (const tab of document.querySelectorAll(selectors.tab.join(','))) {
      if (!visible(tab) || !tabLabel.test((tab.textContent || '').trim())) continue;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel && visible(panel) && panel.getAttribute('role') === 'tabpanel') { region = panel; break; }
    }
  }
  if (region) return { state: 'ready', hasRegion: true, clicked: false };

  const labelIsComment = label => tabLabel.test((label || '').trim());
  const related = rx(selectors.relatedTabText), rejected = rx(selectors.entryRejectLabel);
  const candidates = [];
  for (const element of document.querySelectorAll(selectors.entryCandidates.join(','))) {
    if (!visible(element) || element.closest(excluded) || element.closest(listSelector)) continue;
    const text = (element.textContent || '').trim(), aria = element.getAttribute('aria-label') || '', title = element.getAttribute('title') || '';
    const marker = element.getAttribute('data-e2e') || '';
    const icon = selectors.entryIconMarker.includes(marker);
    const roleTab = element.getAttribute('role') === 'tab' && labelIsComment(text);
    const labelled = labelIsComment(aria) || labelIsComment(title);
    const exactText = labelIsComment(text);
    if (!roleTab && !labelled && !icon && !exactText) continue;
    let relatedTab = !!element.closest(selectors.tabContainer.join(','));
    if (exactText && !relatedTab) {
      let parent = element.parentElement;
      for (let hops = 0; parent && parent !== document.body && hops < 3; hops++, parent = parent.parentElement) {
        if ((parent.textContent || '').length <= 600 && related.test(parent.textContent || '')) { relatedTab = true; break; }
      }
    }
    const interactive = element.closest(selectors.entryInteractive.join(','));
    if (!roleTab && !labelled && !icon && !(exactText && (interactive || relatedTab))) continue;
    let target = interactive || element;
    if (!interactive && typeof target.click !== 'function' && icon && element.parentElement) {
      const parent = element.parentElement;
      if (parent.querySelectorAll('svg').length === 1 && /^\s*(?:\d+(?:\.\d+)?[万亿+]?)?\s*$/.test(parent.textContent || '')) target = parent;
    }
    if (!visible(target) || target.closest(excluded) || typeof target.click !== 'function') continue;
    if (rejected.test((target.getAttribute('aria-label') || '') + (target.getAttribute('title') || '') + (target.textContent || ''))) continue;
    candidates.push({ target, priority: roleTab ? 4 : relatedTab && exactText ? 3 : labelled ? 2 : 1 });
  }
  candidates.sort((a, b) => b.priority - a.priority);
  if (!candidates.length) return { state: 'missing', hasRegion: false, clicked: false };
  if (options && options.probe === true) return { state: 'available', hasRegion: false, clicked: false };
  candidates[0].target.click();
  return { state: 'opened', hasRegion: false, clicked: true };
}

async function scrollComments(_, selectors) {
  // Response parsing can finish just before the page appends its next batch.
  // Allow one layout frame, with a bounded fallback for background windows.
  await new Promise(resolve => {
    let frame = 0, timer = null, settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      resolve();
    };
    frame = requestAnimationFrame(finish);
    timer = setTimeout(finish, 50);
  });
  // A generic scroll-list may contain recommendations. It becomes eligible
  // only when it contains an actual visible comment marker.
  const visible = element => {
    if (!element || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
  };
  const tabLabel = new RegExp(selectors.tabLabel.map(source => '(?:' + source + ')').join('|'));
  let region = Array.from(document.querySelectorAll(selectors.list.join(','))).find(visible);
  if (!region) {
    for (const marker of document.querySelectorAll(selectors.item.join(','))) {
      if (!visible(marker)) continue;
      const list = marker.closest(selectors.itemScope.join(','));
      if (list && list !== document.body && list !== document.documentElement && visible(list)) { region = list; break; }
    }
  }
  if (!region) {
    for (const tab of document.querySelectorAll(selectors.tab.join(','))) {
      if (!visible(tab) || !tabLabel.test((tab.textContent || '').trim())) continue;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel && visible(panel) && panel.getAttribute('role') === 'tabpanel') { region = panel; break; }
    }
  }
  if (!region) return { state: 'not_ready', moved: false, hasRegion: false };
  const recommend = selectors.recommend.join(',');
  let node = region;
  for (let hops = 0; node && node !== document.body && node !== document.documentElement && hops < 8; hops++, node = node.parentElement) {
    if (!visible(node)) break;
    const unrelated = Array.from(node.querySelectorAll(recommend)).some(element => visible(element) && !region.contains(element));
    if (unrelated) break;
    const style = getComputedStyle(node);
    if (!/^(?:auto|scroll|overlay)$/.test(style.overflowY) || node.clientHeight <= 0 || node.scrollHeight <= node.clientHeight + 5) continue;
    const before = node.scrollTop, end = Math.max(0, node.scrollHeight - node.clientHeight);
    // The page requests its next cursor when this comment list reaches its
    // current end. Small fixed steps otherwise wait for a response before
    // they ever reach that trigger, especially for long/image comments.
    node.scrollTo({ top: end, behavior: 'instant' });
    const moved = node.scrollTop > before + 0.5;
    return { state: moved ? 'scrolled' : 'at_end', moved, hasRegion: true };
  }
  return { state: 'not_ready', moved: false, hasRegion: true };
}

function trustedNavigation(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && ['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname);
  } catch (_) { return false; }
}

function landingWork(raw) {
  try {
    const work = normalizeVideoLink(raw);
    if (work.type !== 'short') return { ...work, needsCanonicalNavigation: false };
  } catch (_) { /* legacy share landing pages are normalized below */ }
  if (trustedNavigation(raw)) {
    const url = new URL(raw);
    const legacy = ['www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname)
      && url.pathname.match(/^\/share\/(video|note)\/(\d{1,24})\/?$/);
    const modalId = ['www.douyin.com', 'douyin.com'].includes(url.hostname) && url.pathname === '/'
      && String(url.searchParams.get('modal_id') || '').match(/^\d{1,24}$/);
    if (legacy || modalId) {
      const type = legacy ? legacy[1] : 'video', id = legacy ? legacy[2] : modalId[0];
      return { id, type, url: `https://www.douyin.com/${type}/${id}`, needsCanonicalNavigation: true };
    }
  }
  const error = new Error('分享链接未跳转到有效作品，请在账号浏览器复制最终 video / note 地址后重试');
  error.code = 'INVALID_VIDEO_LINK'; throw error;
}

async function navigateCollectionPage(page, url, { authorize, checkStopped, signal }) {
  if (!trustedNavigation(url)) throw new Error('作品链接不在允许的抖音 HTTPS 域名内');
  checkStopped();
  if (signal && signal.aborted) throw new TaskStopError();
  // Playwright routes deliberately skip the requests following an HTTP
  // redirect. An independent Chromium Fetch session pauses every Document
  // before transport, including each redirect request. Response interception
  // prevents the browser from automatically following an unchecked Location.
  // https://playwright.dev/docs/api/class-page#page-route
  // https://chromedevtools.github.io/devtools-protocol/tot/Fetch/
  const session = await page.context().newCDPSession(page);
  let blocked = null, navigationCount = 0, disposing = false, nextRedirect = null;
  const pendingIds = new Set(), handlers = new Set();
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);
  let mainFrameId, stopPromise, rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  // An abort may arrive during CDP setup, before any operation races it.
  // Keep that rejection handled, while every race still receives the error.
  aborted.catch(() => {});
  const interruptible = operation => signal ? Promise.race([operation, aborted]) : operation;
  const stopLoading = () => {
    if (!stopPromise) stopPromise = Promise.resolve().then(() => session.send('Page.stopLoading')).catch(() => {});
    return stopPromise;
  };
  const reject = () => new TaskStopError('分享链接跳转异常，已停止访问', 'PAGE_REDIRECT');
  const fail = requestId => session.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {});
  const check = () => {
    if (disposing) throw blocked || new TaskStopError();
    checkStopped();
    if (signal && signal.aborted) throw blocked || new TaskStopError();
  };
  const onAbort = () => {
    if (disposing) return;
    // Preserve the caller's stop error instead of exposing net::ERR_ABORTED
    // (or waiting for the whole navigation timeout on an unresponsive page).
    if (!blocked) {
      try { checkStopped(); } catch (error) { blocked = error; }
      blocked = blocked || new TaskStopError();
    }
    rejectAbort(blocked);
    stopLoading();
  };
  const authorizeNavigation = async () => {
    check();
    const result = await interruptible(authorize({ kind: 'video_redirect' }));
    if (result === false || result && (result.ok === false || result.valid === false)) {
      throw new TaskStopError(result && result.error || '授权无效，已暂停任务', 'AUTH_REQUIRED');
    }
    check();
  };
  const handlePaused = async event => {
    const responseStage = event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
    try {
      if (disposing || blocked) throw blocked || new TaskStopError();
      if (event.frameId !== mainFrameId || event.resourceType !== 'Document') {
        await session.send('Fetch.continueRequest', { requestId: event.requestId }); return;
      }
      check();
      if (!trustedNavigation(event.request.url) || event.request.method !== 'GET') throw reject();
      if (!responseStage) {
        if (++navigationCount > 10) throw reject();
        await authorizeNavigation();
        await session.send('Fetch.continueRequest', { requestId: event.requestId }); return;
      }
      if (redirectStatuses.has(event.responseStatusCode)) {
        const locations = (event.responseHeaders || []).filter(header => header.name.toLowerCase() === 'location');
        if (locations.length !== 1 || /[\r\n\0]/.test(locations[0].value) || navigationCount >= 10) throw reject();
        let destination;
        try { destination = new URL(locations[0].value, event.request.url).href; }
        catch (_) { throw reject(); }
        if (!trustedNavigation(destination)) throw reject();
        await authorizeNavigation();
        // Cancel the automatic redirect and navigate explicitly on the same
        // page. This makes the next request a fresh navigation, so existing
        // Playwright routes still work. Preserve in-memory session headers;
        // never inspect or log Cookie values. GET-only navigation needs no
        // POST/body replay and the final page still receives its own response.
        nextRedirect = destination;
        const headers = (event.responseHeaders || []).filter(header => !/^(?:location|refresh|content-length|content-encoding|transfer-encoding|content-type|cache-control|pragma|expires)$/i.test(header.name));
        headers.push({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
        headers.push({ name: 'Cache-Control', value: 'no-store' });
        await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: headers, body: '' }); return;
      }
      await session.send('Fetch.continueRequest', { requestId: event.requestId });
    } catch (error) {
      blocked = blocked || error;
      await fail(event.requestId);
      await stopLoading();
    } finally { pendingIds.delete(event.requestId); }
  };
  const onPaused = event => {
    pendingIds.add(event.requestId);
    const promise = handlePaused(event);
    handlers.add(promise);
    // Do not create an unobserved rejecting promise via .finally().
    promise.then(() => handlers.delete(promise), () => handlers.delete(promise));
  };
  session.on('Fetch.requestPaused', onPaused);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal && signal.aborted) onAbort();
    check();
    const tree = await interruptible(session.send('Page.getFrameTree'));
    mainFrameId = tree.frameTree.frame.id;
    check();
    await interruptible(session.send('Fetch.enable', { patterns: [
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }
    ] }));
    let destination = url;
    while (destination) {
      check(); nextRedirect = null;
      const response = await interruptible(page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 60000 }));
      if (blocked) throw blocked;
      check();
      if (!nextRedirect) return response;
      destination = nextRedirect;
    }
  } catch (error) { throw blocked || error; }
  finally {
    // Fetch.disable alone automatically releases paused requests. Fail them
    // first, including events arriving during disposal, then detach only this
    // temporary session without changing Playwright's routing session.
    disposing = true;
    if (signal) signal.removeEventListener('abort', onAbort);
    if (blocked || pendingIds.size) await stopLoading();
    await Promise.allSettled([...pendingIds].map(fail));
    while (handlers.size) await Promise.allSettled([...handlers]);
    await session.send('Fetch.disable').catch(() => {});
    session.off('Fetch.requestPaused', onPaused);
    await session.detach().catch(() => {});
  }
}

module.exports = {
  openComments: bindPageFunction(openComments, COMMENTS, 'openComments'),
  scrollComments: bindPageFunction(scrollComments, COMMENTS, 'scrollComments'),
  trustedNavigation, landingWork, navigateCollectionPage
};
