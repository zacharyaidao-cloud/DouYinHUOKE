'use strict';

// Serialized browser callback: reads only the current work's already-present
// structured data or explicitly marked description. No request is initiated.
function readPageWorkMetadata(expectedWorkId) {
  const missing = () => ({ desc: '', descriptionState: 'missing', descriptionSource: '' });
  const id = typeof expectedWorkId === 'string' && /^\d{1,24}$/.test(expectedWorkId) ? expectedWorkId : '';
  let current;
  try { current = new URL(location.href); } catch (_) { return missing(); }
  const currentPath = current.pathname.match(/^\/(?:video|note)\/(\d{1,24})\/?$/);
  if (!id || current.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(current.hostname) || current.username || current.password || (current.port && current.port !== '443') || !currentPath || currentPath[1] !== id) return missing();

  const maximumCharacters = 2 * 1024 * 1024, maximumNodes = 10000, maximumDepth = 12;
  let characters = 0, visitedNodes = 0, explicitEmpty = null, mediaOnly = null;
  const workId = value => typeof value === 'string' && /^\d{1,24}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  const targetFields = value => {
    const workRawText = {};
    for (const key of ['desc', 'item_title', 'itemTitle', 'caption']) if (typeof value[key] === 'string') workRawText[key] = value[key];
    const texts = Object.values(workRawText), available = texts.some(value => value.trim());
    const images = Array.isArray(value.images) ? value.images : value.image_post_info && Array.isArray(value.image_post_info.images) ? value.image_post_info.images : null;
    const awemeType = value.aweme_type ?? value.awemeType;
    return { desc: typeof value.desc === 'string' ? value.desc.trim() : '', workRawText,
      descriptionState: available ? 'available' : texts.length ? 'empty' : 'missing', descriptionSource: 'page_json',
      ...(images ? { imageCount: images.length } : {}),
      ...(typeof awemeType === 'number' && Number.isSafeInteger(awemeType) && awemeType >= 0 ? { awemeType } : {}) };
  };
  const findDescription = root => {
    const pending = [{ value: root, depth: 0 }];
    while (pending.length && visitedNodes < maximumNodes) {
      const { value, depth } = pending.pop(); visitedNodes++;
      if (!value || typeof value !== 'object' || depth > maximumDepth) continue;
      const rawId = workId(value.aweme_id), normalizedId = workId(value.awemeId);
      const identifiersAgree = !rawId || !normalizedId || rawId === normalizedId;
      const normalizedWork = !Array.isArray(value) && normalizedId === id
        && typeof value.awemeType === 'number' && Number.isSafeInteger(value.awemeType)
        && (Array.isArray(value.images) || value.video && typeof value.video === 'object' && !Array.isArray(value.video));
      if (!Array.isArray(value) && identifiersAgree && (rawId === id || normalizedWork)) {
        const fields = targetFields(value);
        if (fields.descriptionState === 'available') return fields;
        if (fields.descriptionState === 'empty' && !explicitEmpty) explicitEmpty = fields;
        if ((fields.imageCount !== undefined || fields.awemeType !== undefined) && !mediaOnly) mediaOnly = fields;
      }
      if (depth >= maximumDepth) continue;
      const children = Array.isArray(value) ? value : Object.values(value);
      for (let index = Math.min(children.length, maximumNodes) - 1; index >= 0; index--) pending.push({ value: children[index], depth: depth + 1 });
    }
    return null;
  };

  // Current desktop note pages stream normalized work data in literal JSON
  // arguments to __pace_f.push. Decode those arguments and RSC JSON rows only;
  // never execute a script, inspect globals, or initiate another request.
  // Prefer the work stream before the large app-only RENDER_DATA state so an
  // unrelated application object cannot consume the traversal budget first.
  let pacePending = '', inspectedScripts = 0;
  const readPaceRow = row => {
    const match = row.match(/^[0-9a-f]+:([\[{].*)$/i);
    if (!match) return null;
    try { return findDescription(JSON.parse(match[1])); } catch (_) { return null; }
  };
  for (const script of document.querySelectorAll('script')) {
    if (++inspectedScripts > 1000 || visitedNodes >= maximumNodes) break;
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
    if (pacePending.length + chunk.length > maximumCharacters) break;
    const rows = (pacePending + chunk).split('\n');
    pacePending = rows.pop();
    for (const row of rows) {
      if (visitedNodes >= maximumNodes) break;
      const description = readPaceRow(row.replace(/\r$/, ''));
      if (description) return description;
    }
  }
  // Parse a final row without a newline only once after all chunks. Repeated
  // parsing of a long incomplete row at every chunk would waste the bound.
  if (pacePending && visitedNodes < maximumNodes) {
    const description = readPaceRow(pacePending);
    if (description) return description;
  }
  for (const script of document.querySelectorAll('script#RENDER_DATA,script#__NEXT_DATA__,script[type="application/json"]')) {
    const raw = script.textContent || '';
    if (!raw.trim() || raw.length > maximumCharacters || characters + raw.length > maximumCharacters || visitedNodes >= maximumNodes) continue;
    characters += raw.length;
    let data;
    try { data = JSON.parse(raw); }
    catch (_) {
      if (script.id !== 'RENDER_DATA') continue;
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded.length > maximumCharacters) continue;
        data = JSON.parse(decoded);
      } catch (_) { continue; }
    }
    const description = findDescription(data);
    if (description) return description;
  }
  if (explicitEmpty) return explicitEmpty;

  const visible = element => {
    if (!element || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
  };
  const excluded = '[data-e2e*="comment"],[data-e2e*="recommend"],[class*="comment"],[class*="Comment"],[class*="recommend"],[class*="Recommend"],[contenteditable="true"],input,textarea';
  const descriptions = new Set();
  for (const element of document.querySelectorAll('[data-e2e="video-desc"],[data-e2e="video-description"],[data-e2e="note-desc"]')) {
    if (!visible(element) || element.closest(excluded)) continue;
    let belongsToOtherWork = false;
    for (let parent = element; parent && parent !== document.body; parent = parent.parentElement) {
      for (const attribute of ['data-aweme-id', 'data-video-id', 'data-item-id']) {
        const value = parent.getAttribute(attribute);
        if (value && value !== id) belongsToOtherWork = true;
      }
    }
    if (belongsToOtherWork) continue;
    const desc = (element.textContent || '').trim();
    if (desc && desc.length <= maximumCharacters) descriptions.add(desc);
  }
  if (descriptions.size === 1) {
    const desc = descriptions.values().next().value;
    return { desc, workRawText: { desc }, descriptionState: 'available', descriptionSource: 'page_description', ...(mediaOnly && mediaOnly.imageCount !== undefined ? { imageCount: mediaOnly.imageCount } : {}), ...(mediaOnly && mediaOnly.awemeType !== undefined ? { awemeType: mediaOnly.awemeType } : {}) };
  }

  const matchesWorkUrl = raw => {
    try {
      const url = new URL(raw, current.href), work = url.pathname.match(/^\/(?:video|note)\/(\d{1,24})\/?$/);
      return url.protocol === 'https:' && ['www.douyin.com', 'douyin.com'].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443') && !!work && work[1] === id;
    } catch (_) { return false; }
  };
  const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute('content');
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  const description = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
  const desc = description.trim();
  const generic = /^(?:抖音(?:短视频|精选)?|douyin|tiktok)(?:[，,。.!！\s—-]*记录美好生活)?$/i.test(desc) || /帮助用户.*记录美好生活.*短视频平台/.test(desc);
  if (desc && desc.length <= maximumCharacters && !generic && (ogUrl ? matchesWorkUrl(ogUrl) : canonical && matchesWorkUrl(canonical))) return { desc, workRawText: { desc }, descriptionState: 'available', descriptionSource: 'page_meta', ...(mediaOnly && mediaOnly.imageCount !== undefined ? { imageCount: mediaOnly.imageCount } : {}), ...(mediaOnly && mediaOnly.awemeType !== undefined ? { awemeType: mediaOnly.awemeType } : {}) };
  return mediaOnly || missing();
}

module.exports = { readPageWorkMetadata };
