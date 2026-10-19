'use strict';

// Read the page to locate the current profile / conversation, then let
// Playwright perform the actual browser click and fill. No request is replayed
// and no DOM text or synthetic input event is used as a delivery receipt.
const conversations = new WeakMap();
const diagnostics = new WeakMap();
const { REJECTION_RULES } = require('./dm-rejection');
// A readiness deadline, not an action delay: ready controls continue immediately.
const WAIT_MS = 8000;
const CLICK_MS = 2000;

function remember(page, result) {
  const diagnostic = { code: result.code || (result.state === 'ambiguous' ? 'DM_EDITOR_AMBIGUOUS' : 'DM_EDITOR_NOT_FOUND'),
    ...(result.diagnostic || {}) };
  diagnostics.set(page, diagnostic);
  return false;
}

function getDiagnostic(page) { return { ...(diagnostics.get(page) || {}) }; }

function check(options) { if (typeof options?.checkStopped === 'function') options.checkStopped(); }
async function beforeUiAction(options) {
  check(options);
  if (typeof options?.beforeUiAction === 'function') await options.beforeUiAction();
  check(options);
}

async function conversationStage(session, options, stage) {
  if (session.conversationStage === stage) return;
  session.conversationStage = stage;
  if (typeof options?.onStage === 'function') await options.onStage(stage);
  check(options);
}

function targetUid(lead) {
  const uid = typeof lead?.uid === 'string' ? lead.uid : String(lead?.uid || '');
  if (!uid || uid.length > 256) throw new Error('目标用户标识无效，本次没有操作');
  return uid;
}

function assertTarget(page, lead) {
  const uid = targetUid(lead);
  if (!page || page.isClosed()) throw Object.assign(new Error('账号浏览器已关闭，请重新打开登录'), { code: 'PAGE_CLOSED', actionNotStarted: true });
  let address;
  try { address = new URL(page.url()); } catch (_) { /* invalid address */ }
  if (!address || address.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(address.hostname)
    || address.username || address.password || address.port && address.port !== '443'
    || address.pathname !== '/user/' + encodeURIComponent(uid)) {
    throw Object.assign(new Error('浏览器已离开当前目标用户主页，本次没有操作'), { code: 'TARGET_MISMATCH', actionNotStarted: true });
  }
  return uid;
}

// This function is serialized into the page. Keep every dependency local.
function inspectControls({ kind, uid, numericUid, message, profileIdentity, rejectionRules = [] }) {
  const visible = e => {
    if (!e || !e.isConnected || !e.getClientRects().length) return false;
    for (let node = e; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const attr = (e, name) => e && typeof e.getAttribute === 'function' ? e.getAttribute(name) || '' : '';
  const identity = e => ['id', 'class', 'data-e2e', 'data-testid'].map(name => attr(e, name)).join(' ');
  const label = e => [e.textContent || '', attr(e, 'aria-label'), attr(e, 'title')]
    .map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const disabled = e => {
    // Only the observed active SVG variant authorizes a click. Unknown/grey
    // variants remain unavailable; enclosing disabled buttons also apply.
    if (e.matches('svg.e2e-send-msg-btn') && (!e.classList.contains('messageMsgInputpublishBtn') || !e.classList.contains('messageMsgInputpublishRedBtn'))) return true;
    for (let current = e; current && !/^(?:BODY|HTML)$/.test(current.tagName); current = current.parentElement) {
      if (current.disabled || attr(current, 'aria-disabled') === 'true' || current.hasAttribute('disabled')) return true;
    }
    return false;
  };
  // The current Douyin composer uses an SVG itself as the native send control.
  // Its observed e2e marker distinguishes it from the adjacent emoji SVG.
  const isSend = e => e.matches('svg.e2e-send-msg-btn') || label(e).some(value => /^(?:发送|发送消息|发送私信)$/.test(value));
  const clickable = e => visible(e) && !disabled(e);
  const allControls = Array.from(document.querySelectorAll('button,a,[role="button"],svg.e2e-send-msg-btn')).filter(visible);
  const controls = allControls.filter(clickable);
  const recipientInfo = root => {
    // The current StackLayout flow verifies the profile/chat display name.
    // UID attributes in these layers are not an additional recipient gate.
    if (root?.closest('[data-e2e="im-dialog"] [data-stack-layer]')) return { mismatch: false, hasTargetEvidence: false };
    let hasTargetEvidence = false;
    for (let e = root; e && !/^(?:BODY|HTML)$/.test(e.tagName); e = e.parentElement) {
      for (const name of ['data-sec-uid', 'data-sec-user-id', 'data-user-sec-uid', 'data-recipient-sec-uid']) {
        const value = attr(e, name);
        if (value && value !== uid) return { mismatch: true, hasTargetEvidence: false };
        if (value === uid) hasTargetEvidence = true;
      }
      for (const name of ['data-recipient-uid', 'data-recipient-id']) {
        const value = attr(e, name);
        if (value && value !== uid && (!numericUid || value !== numericUid)) return { mismatch: true, hasTargetEvidence: false };
        if (value && (value === uid || numericUid && value === numericUid)) hasTargetEvidence = true;
      }
    }
    return { mismatch: false, hasTargetEvidence };
  };
  const ordinary = (e, profile = true) => {
    for (let current = e; current && !/^(?:BODY|HTML)$/.test(current.tagName); current = current.parentElement) {
      if (/^(?:HEADER|NAV)$/.test(current.tagName) || profile && current.tagName === 'ASIDE' || ['banner', 'navigation'].includes(attr(current, 'role'))) return true;
      if (/(?:recommend|related|suggest|comment|search|message[-_ ]?(?:list|history|bubble|item)|chat[-_ ]?(?:list|history|bubble|item))/i.test(identity(current))) return true;
      if (current !== e && attr(current, 'contenteditable') === 'true') return true;
    }
    return false;
  };
  const pathFor = e => {
    if (!e || !e.isConnected) return '';
    const pieces = [];
    for (let current = e; current && current.nodeType === 1; current = current.parentElement) {
      const parent = current.parentElement;
      const index = parent ? Array.prototype.indexOf.call(parent.children, current) + 1 : 1;
      pieces.unshift(current.tagName.toLowerCase() + ':nth-child(' + index + ')');
      if (!parent) break;
    }
    return pieces.join(' > ');
  };
  const userPath = href => {
    try { const url = new URL(href, location.href); return ['www.douyin.com', 'douyin.com'].includes(url.hostname) && /^\/user\/[^/]+$/.test(url.pathname) ? decodeURIComponent(url.pathname.slice(6)) : ''; }
    catch (_) { return ''; }
  };
  const foreignCard = control => {
    // A plain legacy page is supported only if the control is not attached to
    // another user card. Never climb into the whole page to borrow its controls.
    let depth = 0;
    for (let e = control.parentElement; e && depth++ < 4 && !/^(?:BODY|HTML|MAIN)$/.test(e.tagName); e = e.parentElement) {
      const links = Array.from(e.querySelectorAll('a[href]')).filter(visible).map(link => userPath(attr(link, 'href'))).filter(value => value && value !== 'self');
      if (links.some(value => value !== uid)) return true;
      if (/^(?:SECTION|ARTICLE|LI)$/.test(e.tagName) || attr(e, 'role') === 'listitem') break;
    }
    return false;
  };
  const profileScope = control => {
    for (let e = control.parentElement; e && !/^(?:BODY|HTML|MAIN)$/.test(e.tagName); e = e.parentElement) {
      if (/(?:user[-_ ]?(?:info|detail|header|action)|profile[-_ ]?(?:info|detail|header|action))/i.test(identity(e))) return e;
    }
    return null;
  };
  const infoNodes = Array.from(document.querySelectorAll('[data-e2e="user-info"]')).filter(e => visible(e) && !recipientInfo(e).mismatch);
  const pairedSiblingProfile = (control, info) => {
    const root = info.parentElement;
    if (!root || /^(?:BODY|HTML|MAIN)$/.test(root.tagName) || !root.contains(control) || info.contains(control)) return false;
    for (let group = control.parentElement; group && group !== root; group = group.parentElement) {
      const follows = Array.from(group.querySelectorAll('[data-e2e="user-info-follow-btn"]')).filter(e => visible(e) && !recipientInfo(e).mismatch);
      if (follows.length === 1) return true;
    }
    return false;
  };
  const displayName = e => {
    // The profile renders emoji as Twemoji images; the IM header renders the
    // same emoji as Unicode text. textContent alone silently drops those images
    // (including an entire emoji-only name). Preserve order, emoji and joiners.
    const emojiText = image => {
      const alt = attr(image, 'alt');
      if (!alt || [...alt].length > 64 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(alt)) return null;
      const codepoints = [...alt].filter(char => char !== '\ufe0f').map(char => char.codePointAt(0).toString(16)).join('-');
      const matches = value => {
        try {
          const url = new URL(value, location.href);
          const match = url.pathname.match(/\/twemoji\/72x72\/([0-9a-f-]+)\.png$/i);
          return url.protocol === 'https:' && /(^|\.)byteimg\.com$/.test(url.hostname) && match
            && match[1].toLowerCase().split('-').filter(part => part !== 'fe0f').join('-') === codepoints;
        } catch (_) { return false; }
      };
      return matches(attr(image, 'src')) && (!image.currentSrc || matches(image.currentSrc)) ? alt : null;
    };
    const read = node => {
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      if (!visible(node)) return '';
      if (node.tagName === 'IMG') return emojiText(node);
      if (['SVG', 'CANVAS', 'VIDEO', 'IFRAME'].includes(node.tagName.toUpperCase())) return null;
      let value = '';
      for (const child of node.childNodes) {
        const part = read(child);
        if (part === null) return null; // Unknown image must not become a bare-text match.
        value += part;
      }
      return value;
    };
    return String(e ? read(e) || '' : '').replace(/\s+/g, ' ').trim().normalize('NFC');
  };
  const emptyProfile = reason => ({ value: null, reason, nameCount: 0 });
  const readProfileIdentity = info => {
    const root = info?.parentElement;
    if (!root || /^(?:BODY|HTML|MAIN)$/.test(root.tagName)) return emptyProfile('profile_scope_missing');
    const names = Array.from(info.querySelectorAll('h1')).filter(visible);
    const result = { ...emptyProfile('captured'), nameCount: names.length };
    if (names.length !== 1) result.reason = names.length ? 'profile_name_ambiguous' : 'profile_name_missing';
    else if (!displayName(names[0])) result.reason = 'profile_name_empty';
    else result.value = { name: displayName(names[0]) };
    return result;
  };
  const sameIdentity = (a, b) => !!(a?.name && b?.name && a.name === b.name);
  const capturedProfileIdentity = control => {
    // Entry lookup supports actions inside user-info and its paired sibling
    // group. Identity capture must cover the same two bounded profile layouts.
    const paired = infoNodes.filter(info => info.contains(control) || pairedSiblingProfile(control, info));
    return paired.length === 1 ? readProfileIdentity(paired[0]) : emptyProfile(paired.length ? 'profile_scope_ambiguous' : 'profile_scope_missing');
  };
  const currentProfile = () => infoNodes.length === 1 ? readProfileIdentity(infoNodes[0]) : emptyProfile(infoNodes.length ? 'profile_scope_ambiguous' : 'profile_scope_missing');
  const currentProfileMatches = () => !!profileIdentity && sameIdentity(currentProfile().value, profileIdentity);
  const profileDiagnostic = (snapshot, captured = profileIdentity) => ({
    profileIdentityCaptured: captured ? 1 : 0, profileInfoCount: infoNodes.length,
    profileNameCount: snapshot.nameCount,
    profileIdentityReason: snapshot.reason !== 'captured' ? snapshot.reason : !captured ? 'not_captured'
      : sameIdentity(snapshot.value, captured) ? 'captured' : 'profile_identity_changed'
  });
  const profileControls = (includeDisabled = false) => {
    const safe = (includeDisabled ? allControls : controls).filter(e => !ordinary(e) && !recipientInfo(e).mismatch && !foreignCard(e));
    return safe.filter(control => {
      if (profileScope(control)) return true;
      // Production puts user-info and responsive action groups in sibling
      // branches. Bind the group to that profile root through the observed
      // follow marker; never widen to a page-wide text search or global inbox.
      return infoNodes.some(info => pairedSiblingProfile(control, info));
    });
  };
  if (kind === 'follow' || kind === 'open') {
    const safe = profileControls();
    const match = e => label(e).some(value => kind === 'follow'
      ? /^(?:[+＋]\s*)?(?:关注|回关)$/.test(value)
      : /^(?:私信|发私信|发送私信|发消息|发送消息)$/.test(value));
    const candidates = safe.filter(match);
    const already = kind === 'follow' ? safe.filter(e => label(e).some(value => /^(?:已关注|关注中|互相关注)$/.test(value))) : [];
    if (candidates.length > 1 || already.length > 1 || candidates.length && already.length) return { state: 'ambiguous', count: candidates.length + already.length };
    if (candidates.length === 1) {
      const profile = kind === 'open' ? capturedProfileIdentity(candidates[0]) : null;
      return { state: 'ready', path: pathFor(candidates[0]), ...(profile ? { profileIdentity: profile.value,
        diagnostic: profileDiagnostic(profile, profile.value) } : {}) };
    }
    if (already.length === 1) return { state: 'already', path: pathFor(already[0]) };
    return { state: 'missing', count: 0, code: kind === 'open' && profileControls(true).some(match) ? 'DM_ENTRY_UNAVAILABLE' : undefined,
      diagnostic: { visibleControlCount: allControls.length, profileControlCount: safe.length } };
  }

  // Mounted list/chat stacks may be transformed outside the drawer or covered
  // by another stack. Check the actual target's clipped hit point, not merely
  // the existence of layout rectangles. A list row is its own action anchor.
  const activeStackLayer = (layer, anchor) => {
    const dialog = layer?.closest('[data-e2e="im-dialog"]');
    if (!layer || !dialog || !anchor || !layer.contains(anchor) || !visible(layer) || !visible(dialog) || !visible(anchor)) return false;
    const box = anchor.getBoundingClientRect(), bounds = dialog.getBoundingClientRect();
    const layerBounds = layer.getBoundingClientRect();
    const left = Math.max(0, box.left, bounds.left, layerBounds.left), right = Math.min(innerWidth, box.right, bounds.right, layerBounds.right);
    const top = Math.max(0, box.top, bounds.top, layerBounds.top), bottom = Math.min(innerHeight, box.bottom, bounds.bottom, layerBounds.bottom);
    if (right - left < 2 || bottom - top < 2) return false;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return !!hit && anchor.contains(hit);
  };
  const activeChatLayer = layer => {
    if (!layer) return false;
    const headers = Array.from(layer.querySelectorAll('.StackLayoutStackTitleBartitleBar')).filter(visible);
    return headers.length === 1 && activeStackLayer(layer, headers[0]);
  };
  const messageLists = Array.from(document.querySelectorAll('[data-e2e="message-list"],[data-e2e="conversation-list"],[data-testid="conversation-list"],[role="list"][aria-label="会话列表"],[data-e2e="im-dialog"] [data-stack-layer="list"]')).filter(visible);
  if (kind === 'conversation-row') {
    const rows = new Map();
    const explicitSelector = '[data-recipient-sec-uid],[data-sec-uid],[data-sec-user-id],[data-user-sec-uid],[data-recipient-uid],[data-recipient-id]';
    const rowEvidence = row => {
      const explicit = [row, ...row.querySelectorAll(explicitSelector)].filter(visible).map(recipientInfo);
      const links = Array.from(row.querySelectorAll('a[href]')).filter(visible).map(node => userPath(attr(node, 'href'))).filter(Boolean);
      if (row.matches('a[href]')) links.push(userPath(attr(row, 'href')));
      return { mismatch: explicit.some(value => value.mismatch) || links.some(value => value && value !== uid && (!numericUid || value !== numericUid)),
        hasTargetEvidence: explicit.some(value => value.hasTargetEvidence) || links.some(value => value === uid || numericUid && value === numericUid) };
    };
    for (const list of messageLists) {
      const observedLayer = list.closest('[data-stack-layer="list"]');
      const observedList = observedLayer && observedLayer.closest('[data-e2e="im-dialog"]');
      if (observedList && Array.from(observedList.querySelectorAll('[data-stack-layer="chat"]')).some(activeChatLayer)) continue;
      const candidateRows = new Set(Array.from(list.querySelectorAll(explicitSelector + ',a[href]')).map(node => observedList
        ? node.closest('[data-e2e="conversation-item"]')
        : node.closest('[role="listitem"],[data-e2e="conversation-item"],[data-e2e="conversation-row"]') || node.closest('button,a,[role="button"]')).filter(Boolean));
      if (observedList) for (const row of list.querySelectorAll('[data-e2e="conversation-item"]')) candidateRows.add(row);
      for (const row of candidateRows) {
        if (!list.contains(row) || !clickable(row)) continue;
        // A semantic list nested in another stack cannot borrow its rows.
        if (row.closest('[data-e2e="im-dialog"]') && (!observedList || row.closest('[data-stack-layer]') !== observedLayer || !activeStackLayer(observedLayer, row))) continue;
        const evidence = observedList ? { mismatch: false, hasTargetEvidence: false } : rowEvidence(row);
        if (evidence.mismatch) continue;
        if (evidence.hasTargetEvidence) { rows.set(row, 'explicit_uid'); continue; }
        if (!observedList || !profileIdentity || !currentProfileMatches() || !row.matches('[data-e2e="conversation-item"]')) continue;
        const names = Array.from(row.querySelectorAll('.conversationConversationItemtitle')).filter(visible);
        if (names.length === 1 && sameIdentity({ name: displayName(names[0]) }, profileIdentity)) rows.set(row, 'dom_profile_name');
      }
    }
    const candidates = Array.from(rows.keys());
    const unique = candidates.filter(row => !candidates.some(other => other !== row && other.contains(row)));
    return { state: unique.length === 1 ? 'ready' : unique.length ? 'ambiguous' : 'missing',
      path: unique.length === 1 ? pathFor(unique[0]) : '', code: 'DM_TARGET_CHAT_NOT_READY',
      conversationRowEvidence: unique.length === 1 ? rows.get(unique[0]) : '',
      diagnostic: { ...profileDiagnostic(currentProfile()), messageListCount: messageLists.length, targetConversationRowCount: unique.length,
        conversationRowEvidence: unique.length === 1 ? rows.get(unique[0]) : 'unconfirmed' } };
  }

  const visibleEditors = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"]')).filter(visible);
  const editorNodes = visibleEditors
    .filter(e => visible(e) && !disabled(e) && !e.readOnly && !ordinary(e, false)
      && !/评论|搜索/.test([attr(e, 'placeholder'), attr(e, 'aria-label')].join(' '))
      && (!e.closest('[data-e2e="im-dialog"]') || activeChatLayer(e.closest('[data-stack-layer="chat"]'))));
  const editorScope = (editor, checkRecipient = true) => {
    let fallback = null;
    for (let e = editor.parentElement; e && !/^(?:BODY|HTML|MAIN)$/.test(e.tagName); e = e.parentElement) {
      if (checkRecipient && recipientInfo(e).mismatch) return null;
      // The editor-only imChatEditorContainer is not the composer: its send
      // arrow is a sibling under inputRow. Never expand this to the whole page.
      if (e.classList.contains('messageEditorimChatEditorContainer')) continue;
      if (e.classList.contains('messageMsgInputinputRow') || e.classList.contains('messageMsgInputinputColumn')) return e;
      if (attr(e, 'role') === 'dialog' || e.tagName === 'DIALOG'
        || /(?:im[-_ ]?(?:chat|container)|(?:message|chat)[-_ ]?(?:panel|window|container|composer)|conversation|private[-_ ]?message)/i.test(identity(e))) return e;
      // Most chat clients disable Send until the first input event. Its presence
      // identifies the composer even while the action is not yet available.
      if (!fallback && allControls.some(button => e.contains(button) && isSend(button))) fallback = e;
    }
    return fallback;
  };
  if (kind === 'baseline') return { state: 'baseline', editors: editorNodes.map(editor => ({ editorPath: pathFor(editor), scopePath: pathFor(editorScope(editor, false)) })) };
  const scopedEditors = editorNodes.map(editor => ({ editor, scope: editorScope(editor) })).filter(item => item.scope);
  const observedChatLayer = scope => {
    const layer = scope.closest('[data-stack-layer="chat"]'), dialog = layer?.closest('[data-e2e="im-dialog"]');
    return layer && dialog && activeChatLayer(layer) ? layer : null;
  };
  const observedChatUser = scope => {
    const layer = observedChatLayer(scope);
    if (!layer) return null;
    const users = Array.from(layer.querySelectorAll('.StackLayoutStackTitleBartitleBar .StackLayoutStackChatHeaderinfoContainer .StackLayoutStackChatHeaderuser')).filter(visible);
    return users.length === 1 ? users[0] : null;
  };
  const observedChatIdentity = scope => {
    const result = { chatNameCount: 0, chatNameMatches: 0, matched: false };
    if (!profileIdentity || !currentProfileMatches()) return result;
    const chats = Array.from(document.querySelectorAll('[data-e2e="im-dialog"] [data-stack-layer="chat"]')).filter(activeChatLayer);
    if (chats.length !== 1 || chats[0] !== observedChatLayer(scope)) return result;
    const user = observedChatUser(scope);
    if (!user) return result;
    const names = Array.from(user.querySelectorAll('.StackLayoutStackChatHeadertitle')).filter(visible);
    result.chatNameCount = names.length;
    result.chatNameMatches = names.length === 1 && displayName(names[0]) === profileIdentity.name ? 1 : 0;
    result.matched = !!result.chatNameMatches;
    return result;
  };
  const recipientHeaderInfo = scope => {
    if (scope.closest('[data-e2e="im-dialog"] [data-stack-layer]')) return { mismatch: false, hasTargetEvidence: false };
    // A narrow composer excludes the header; inspect its nearest conversation
    // too, while still restricting the eventual click to the composer itself.
    let headerScope = scope;
    for (let e = scope; e && !/^(?:BODY|HTML|MAIN)$/.test(e.tagName); e = e.parentElement) {
      if (attr(e, 'role') === 'dialog' || e.tagName === 'DIALOG'
        || /(?:im[-_ ]?(?:chat|container)|(?:message|chat)[-_ ]?(?:panel|window|container)|conversation|private[-_ ]?message)/i.test(identity(e))) {
        headerScope = e;
        break;
      }
    }
    const observedUser = observedChatUser(scope);
    if (observedUser) headerScope = observedUser;
    const explicitNodes = observedUser ? [observedUser, ...observedUser.querySelectorAll('[data-recipient-sec-uid],[data-sec-uid],[data-sec-user-id],[data-user-sec-uid],[data-recipient-uid],[data-recipient-id]')].filter(visible) : [];
    const explicit = explicitNodes.map(recipientInfo);
    const links = Array.from(headerScope.querySelectorAll(observedUser ? 'a[href]' : '[data-e2e="chat-header"] a[href],[data-e2e="conversation-header"] a[href],[class*="chat-header"] a[href],[class*="chatHeader"] a[href],[role="heading"] a[href]'))
      .filter(visible).map(e => userPath(attr(e, 'href'))).filter(value => value && value !== 'self');
    return { mismatch: explicit.some(value => value.mismatch) || links.some(value => value !== uid && (!numericUid || value !== numericUid)),
      hasTargetEvidence: explicit.some(value => value.hasTargetEvidence) || links.some(value => value === uid || numericUid && value === numericUid) };
  };
  if (kind === 'chat-observation') {
    const unknown = { state: 'unknown' };
    const layers = Array.from(document.querySelectorAll('[data-e2e="im-dialog"] [data-stack-layer="chat"]')).filter(activeChatLayer);
    if (layers.length !== 1) return { state: 'missing', history: unknown };
    const layer = layers[0], recipient = recipientHeaderInfo(layer);
    if (recipientInfo(layer).mismatch || recipient.mismatch
      || !(recipient.hasTargetEvidence || observedChatIdentity(layer).matched)) return { state: 'missing', history: unknown };
    // Read only the current, verified chat. Conversation-list previews and
    // composers can contain identical text but are not historical messages.
    const lists = Array.from(layer.querySelectorAll('.messageMessageListlist')).filter(visible);
    let outboundCount = 0;
    if (lists.length === 1) for (const bubble of lists[0].querySelectorAll('.messageMessageBoxmessageBox')) {
      if (!visible(bubble)) continue;
      const boxes = bubble.querySelectorAll('.messageMessageBoxcontentBox');
      const columns = bubble.querySelectorAll('.MessageBoxContentcolumnBox');
      const contents = bubble.querySelectorAll('[data-e2e="msg-item-content"]');
      const texts = bubble.querySelectorAll('.MessageItemTextcontainer');
      const sides = bubble.querySelectorAll('.MessageBoxContentSidewrapper');
      const bottoms = bubble.querySelectorAll('.MessageBoxContentBottomwrapper');
      const emptySlot = element => element.childElementCount === 0 && !element.textContent.trim();
      if (boxes.length !== 1 || !boxes[0].classList.contains('messageMessageBoxisFromMe')
        || columns.length !== 1 || !columns[0].classList.contains('MessageBoxContentisFromMe')
        || contents.length !== 1 || texts.length !== 1 || !texts[0].classList.contains('MessageItemTextisFromMe')
        || !boxes[0].contains(columns[0]) || !columns[0].contains(contents[0]) || !contents[0].contains(texts[0])
        || sides.length !== 1 || bottoms.length !== 1 || !emptySlot(sides[0]) || !emptySlot(bottoms[0])) continue;
      // Unknown status decorations are not treated as a completed old bubble.
      if (Array.from(bubble.querySelectorAll('*')).some(node => /(?:fail|error|sending|pending|retry|loading)/i.test(node.getAttribute('class') || '')
        || node.hasAttribute('data-send-state') || node.getAttribute('aria-busy') === 'true')) continue;
      const pure = texts[0].querySelectorAll('.TextMessageTextpureText[data-apm-action="纯文本"]');
      if (pure.length === 1 && pure[0].textContent.trim()) outboundCount++;
    }
    let restriction = null;
    for (const node of layer.querySelectorAll('p,span,div')) {
      if (node.childElementCount || !visible(node) || node.closest('[data-e2e="msg-item-content"],[data-e2e="msg-input"],[contenteditable],textarea')) continue;
      // Platform failures are rendered as their own messageBox row. Keep
      // excluding ordinary message text, but admit the observed tips structure.
      const platformTip = node.classList.contains('MessageBoxTipsMessagetext')
        && node.closest('.MessageBoxTipsMessagecontent')?.closest('.MessageBoxTipsMessagelayout');
      if (node.closest('.messageMessageBoxmessageBox') && !platformTip) continue;
      const text = node.textContent.replace(/\s/g, '').replace(/[。！!]+$/, '');
      const matched = rejectionRules.find(rule => rule.texts.includes(text));
      if (matched) {
        const failureScope = matched.failureScope || 'recipient';
        restriction = { code: matched.code, reason: matched.reason, failureScope, evidence: 'matched-chat+platform-' + failureScope + '-notice' };
        if (failureScope === 'account') break;
      }
    }
    return { state: 'ready', restriction, history: outboundCount ? {
      state: 'already_sent', source: 'browser_chat_dom', complete: false, lastSentAt: null,
      evidence: 'matched-chat+outgoing-markers+empty-status-slots', outboundCount
    } : unknown };
  }
  // A previous user's conversation can remain mounted and visible after opening
  // the next profile. Exclude only explicitly foreign recipient headers before
  // checking editor ambiguity; unknown or duplicate target editors still block.
  const editors = scopedEditors.filter(item => !recipientInfo(item.editor).mismatch && !recipientHeaderInfo(item.scope).mismatch);
  const diagnostic = { ...profileDiagnostic(currentProfile()), visibleEditorCount: visibleEditors.length, eligibleEditorCount: editorNodes.length,
    conversationEditorCount: editors.length, iframeCount: document.querySelectorAll('iframe').length, messageListCount: messageLists.length };
  if (editors.length > 1) return { state: 'ambiguous', code: 'DM_EDITOR_AMBIGUOUS', count: editors.length, diagnostic };
  if (!editors.length) return { state: 'missing', code: scopedEditors.length ? 'DM_RECIPIENT_MISMATCH'
    : messageLists.length ? 'DM_MESSAGE_LIST_ONLY'
    : editorNodes.length ? 'DM_EDITOR_CONTEXT_UNCONFIRMED' : 'DM_EDITOR_NOT_FOUND', count: 0, diagnostic };
  const { editor, scope } = editors[0];
  const explicitTarget = recipientInfo(editor).hasTargetEvidence || recipientHeaderInfo(scope).hasTargetEvidence;
  const profileMatches = currentProfileMatches();
  const chatIdentity = observedChatIdentity(scope);
  for (const key of ['chatNameCount', 'chatNameMatches']) diagnostic[key] = chatIdentity[key];
  const recipientEvidence = explicitTarget ? 'explicit_uid' : profileMatches && chatIdentity.matched ? 'dom_profile_name' : '';
  const result = { state: 'ready', editorPath: pathFor(editor), scopePath: pathFor(scope), diagnostic,
    hasTargetEvidence: !!recipientEvidence, recipientEvidence };
  diagnostic.recipientEvidence = recipientEvidence || 'unconfirmed';
  diagnostic.profileIdentityChanged = profileIdentity && !profileMatches ? 1 : 0;
  if (kind === 'editor') return result;
  const editorText = () => {
    if (editor.tagName === 'TEXTAREA') return editor.value;
    if (attr(editor, 'data-slate-editor') !== 'true') return editor.innerText;
    const lines = Array.from(editor.children);
    if (!lines.length || Array.from(editor.childNodes).some(n => n.nodeType !== 1 && n.textContent.trim())
      || lines.some(line => !line.matches('div.ace-line[data-node="true"]'))) return editor.innerText;
    const values = [];
    for (const line of lines) {
      const leaves = Array.from(line.children);
      if (!leaves.length || Array.from(line.childNodes).some(n => n.nodeType !== 1)
        || leaves.some(leaf => !leaf.matches('span[data-string="true"][data-leaf="true"]') || leaf.children.length)) return editor.innerText;
      values.push(leaves.map((leaf, index) => {
        // Only the observed terminal editor sentinel is structural. Preserve
        // real whitespace, blank lines, emoji joiners and ZWSP in normal leaves.
        if (index === leaves.length - 1 && attr(leaf, 'data-enter') === 'true' && leaf.textContent === '\u200b') return '';
        return leaf.textContent;
      }).join(''));
    }
    return values.join('\n');
  };
  const value = editorText();
  if (String(value || '').replace(/\r\n/g, '\n') !== String(message).replace(/\r\n/g, '\n')) return { state: 'missing', code: 'DM_MESSAGE_CHANGED', count: 0, diagnostic };
  if (kind === 'filled') return result;
  const sendCandidates = controls.filter(e => scope.contains(e) && !ordinary(e, false) && isSend(e));
  // A labelled button may wrap the marked SVG: this is one native control.
  const send = sendCandidates.filter(e => !sendCandidates.some(parent => parent !== e && parent.contains(e)));
  if (send.length !== 1) return { state: send.length ? 'ambiguous' : 'missing',
    code: send.length ? 'DM_SEND_AMBIGUOUS' : allControls.some(e => scope.contains(e) && isSend(e) && disabled(e)) ? 'DM_SEND_DISABLED' : 'DM_SEND_NOT_FOUND',
    count: send.length, diagnostic };
  return { ...result, path: pathFor(send[0]) };
}

async function inspect(page, lead, kind, message, waitMs = WAIT_MS, options = {}) {
  const uid = assertTarget(page, lead);
  const numericUid = /^[1-9]\d{0,31}$/.test(String(lead?.UID || '')) ? String(lead.UID) : '';
  const until = Date.now() + Math.min(Math.max(0, waitMs), WAIT_MS);
  do {
    check(options);
    assertTarget(page, lead);
    const result = await page.evaluate(inspectControls, { kind, uid, numericUid, message, profileIdentity: conversations.get(page)?.profileIdentity || null });
    check(options);
    if (result.state !== 'missing' || Date.now() >= until) return result;
    await page.waitForTimeout(Math.min(100, Math.max(1, until - Date.now())));
  } while (true);
}

async function bindElement(page, selector) {
  return selector ? page.locator(selector).elementHandle({ timeout: 500 }) : null;
}

async function sameElement(page, selector, handle) {
  if (!selector || !handle || page.isClosed()) return false;
  try {
    return await page.locator(selector).evaluate((element, original) => element === original && element.isConnected, handle, { timeout: 500 });
  } catch (_) { return false; }
}

function missing(reason) { return { state: 'missing', reason }; }

async function disposeHandles(handles) {
  for (const handle of new Set(handles.filter(Boolean))) await handle.dispose().catch(() => {});
}

async function invalidateConversationBinding(session) {
  session.conversationReady = false;
  session.filled = false;
  const handles = [session.editor, session.scope];
  for (const key of ['editor', 'scope', 'editorPath', 'scopePath']) delete session[key];
  await disposeHandles(handles);
}

async function clearConversation(page) {
  const session = conversations.get(page);
  conversations.delete(page);
  if (session) await disposeHandles([session.editor, session.scope, ...(session.baseline || []).flatMap(item => [item.editor, item.scope])]);
}

async function reusesPreviousConversation(page, descriptor, session) {
  for (const previous of session.baseline || []) {
    if (await sameElement(page, descriptor.editorPath, previous.editor)
      || await sameElement(page, descriptor.scopePath, previous.scope)) return true;
  }
  return false;
}

async function prepareFollow(page, lead, options = {}) {
  let descriptor = await inspect(page, lead, 'follow', undefined, WAIT_MS, options);
  if (descriptor.state === 'already') return { state: 'already', reason: '目标主页显示已关注，本次没有点击' };
  if (descriptor.state !== 'ready') return missing(descriptor.state === 'ambiguous'
    ? '目标主页有多个关注控件，无法唯一定位，本次没有点击' : '目标主页未找到可操作的关注控件，本次没有点击');
  let handle = await bindElement(page, descriptor.path);
  if (!handle) return missing('目标关注控件已经改变，本次没有点击');
  let invoked = false;
  return {
    state: 'ready',
    async click() {
      try {
        if (invoked) throw Object.assign(new Error('本次关注准备已经使用，禁止重复点击'), { code: 'FOLLOW_PREPARATION_CONSUMED' });
        invoked = true;
        await beforeUiAction(options);
        let ready = false;
        // React can replace the profile's follow node between preparation and
        // clicking. Re-resolve only before the first actual click, on the same
        // verified profile, and require one fresh target control each time.
        for (let attempt = 0; attempt < 3; attempt++) {
          check(options);
          assertTarget(page, lead);
          const current = await inspect(page, lead, 'follow', undefined, 0);
          if (current.state === 'already') throw Object.assign(new Error('目标主页已显示关注关系，本次没有点击'), { code: 'FOLLOW_ALREADY' });
          if (current.state !== 'ready') throw Object.assign(new Error(current.state === 'ambiguous'
            ? '目标主页出现多个关注控件，本次没有点击' : '目标主页关注控件已不可用，本次没有点击'),
          { code: current.state === 'ambiguous' ? 'FOLLOW_CONTROL_AMBIGUOUS' : 'FOLLOW_CONTROL_UNAVAILABLE' });
          if (current.path !== descriptor.path || !await sameElement(page, descriptor.path, handle)) {
            await disposeHandles([handle]);
            descriptor = current;
            handle = await bindElement(page, descriptor.path);
            if (!handle) continue;
          }
          const verified = await inspect(page, lead, 'follow', undefined, 0);
          if (verified.state === 'ready' && verified.path === descriptor.path && await sameElement(page, descriptor.path, handle)) {
            check(options);
            assertTarget(page, lead);
            ready = true;
            break;
          }
        }
        if (!ready) throw Object.assign(new Error('准备后的目标关注控件持续改变，本次没有点击'), { code: 'FOLLOW_CONTROL_CHANGED' });
      } catch (error) {
        error.actionNotStarted = true;
        await disposeHandles([handle]);
        throw error;
      }
      try {
        await handle.click({ timeout: CLICK_MS });
        return true;
      } finally { await disposeHandles([handle]); }
    }
  };
}

async function openDirectMessage(page, lead, options = {}) {
  check(options);
  diagnostics.delete(page);
  await clearConversation(page);
  let descriptor = await inspect(page, lead, 'open', undefined, WAIT_MS, options);
  if (descriptor.state !== 'ready') return remember(page, { ...descriptor, code: descriptor.state === 'ambiguous' ? 'DM_ENTRY_AMBIGUOUS' : descriptor.code || 'DM_ENTRY_NOT_FOUND' });
  let handle = await bindElement(page, descriptor.path);
  const preparedProfileIdentity = descriptor.profileIdentity;
  let clickProfileIdentity = null;
  const previous = await inspect(page, lead, 'baseline', undefined, 0);
  const baseline = [];
  for (const editor of previous.editors || []) baseline.push({ editor: await bindElement(page, editor.editorPath), scope: await bindElement(page, editor.scopePath) });
  try {
    await beforeUiAction(options);
    let ready = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      check(options); assertTarget(page, lead);
      const current = await inspect(page, lead, 'open', undefined, 0, options);
      if (current.state !== 'ready') return remember(page, { ...current, code: current.state === 'ambiguous' ? 'DM_ENTRY_AMBIGUOUS' : 'DM_ENTRY_UNAVAILABLE' });
      if (current.path !== descriptor.path || !await sameElement(page, descriptor.path, handle)) {
        await disposeHandles([handle]); descriptor = current; handle = await bindElement(page, descriptor.path);
      }
      if (!handle) continue;
      const verified = await inspect(page, lead, 'open', undefined, 0, options);
      if (verified.state === 'ready' && verified.path === descriptor.path && await sameElement(page, descriptor.path, handle)) {
        if (preparedProfileIdentity && JSON.stringify(verified.profileIdentity) !== JSON.stringify(preparedProfileIdentity)) return remember(page, { code: 'DM_ENTRY_CHANGED' });
        clickProfileIdentity = verified.profileIdentity;
        ready = true; break;
      }
    }
    if (!ready) return remember(page, { code: 'DM_ENTRY_CHANGED' });
    check(options); assertTarget(page, lead);
    // Click the verified DOM node, not a positional selector which could now
    // resolve to a global inbox button after a responsive React replacement.
    await handle.click({ timeout: CLICK_MS });
    conversations.set(page, { uid: targetUid(lead), opened: true, baseline, conversationSelected: false, profileIdentity: clickProfileIdentity });
    return true;
  }
  catch (error) { await disposeHandles(baseline.flatMap(item => [item.editor, item.scope])); throw error; }
  finally {
    await disposeHandles([handle]);
    if (!conversations.has(page)) await disposeHandles(baseline.flatMap(item => [item.editor, item.scope]));
  }
}

async function selectTargetConversation(page, lead, session, options) {
  if (session.conversationSelected) return false;
  let descriptor = await inspect(page, lead, 'conversation-row', undefined, 0, options);
  session.conversationDiagnostic = descriptor.diagnostic;
  if (descriptor.state !== 'ready') return false;
  let handle = await bindElement(page, descriptor.path);
  if (!handle) return false;
  try {
    await beforeUiAction(options);
    let ready = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      check(options); assertTarget(page, lead);
      const current = await inspect(page, lead, 'conversation-row', undefined, 0, options);
      session.conversationDiagnostic = current.diagnostic;
      if (current.state !== 'ready') return false;
      if (current.path !== descriptor.path || !await sameElement(page, descriptor.path, handle)) {
        await disposeHandles([handle]); descriptor = current; handle = await bindElement(page, descriptor.path);
      }
      if (!handle) continue;
      const verified = await inspect(page, lead, 'conversation-row', undefined, 0, options);
      if (verified.state === 'ready' && verified.path === descriptor.path && await sameElement(page, descriptor.path, handle)) {
        session.conversationDiagnostic = verified.diagnostic;
        ready = true; break;
      }
    }
    if (!ready) return false;
    check(options); assertTarget(page, lead);
    // The page can finish its own list -> chat transition while the row is
    // being bound. A ready target chat needs no extra list click.
    const chat = await inspect(page, lead, 'editor', undefined, 0, options);
    if (chat.state === 'ready' && chat.hasTargetEvidence) return true;
    session.conversationSelected = true; // Never retry an actual row click.
    try { await handle.click({ timeout: CLICK_MS }); }
    catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      // Reinspect within the existing readiness deadline, without clicking
      // again. A different chat still fails the normal nickname comparison.
      return false;
    }
    return true;
  } finally { await disposeHandles([handle]); }
}

async function ensureDirectMessageConversation(page, lead, options = {}) {
  check(options);
  assertTarget(page, lead);
  const session = conversations.get(page);
  if (!session?.opened || session.uid !== targetUid(lead)) return false;
  if (session.conversationReady) {
    const current = await inspect(page, lead, 'editor', undefined, 0, options);
    if (conversations.get(page) !== session || current.state !== 'ready' || !current.hasTargetEvidence
      || current.editorPath !== session.editorPath || current.scopePath !== session.scopePath
      || !await sameElement(page, session.editorPath, session.editor) || !await sameElement(page, session.scopePath, session.scope)) {
      await invalidateConversationBinding(session);
      return remember(page, { ...current, code: current.code || 'DM_COMPOSER_CHANGED' });
    }
    return true;
  }
  const absoluteUntil = Date.now() + WAIT_MS * 2;
  let until = absoluteUntil - WAIT_MS;
  let descriptor, reused;
  do {
    descriptor = await inspect(page, lead, 'editor', undefined, 0, options);
    if (descriptor.state !== 'ready' || !descriptor.hasTargetEvidence) {
      await conversationStage(session, options, 'selecting_conversation');
      if (await selectTargetConversation(page, lead, session, options)) {
        // Selecting a late-mounted list row starts a separate chat readiness
        // phase, bounded by the overall deadline; never repeat a real row click.
        until = Math.min(absoluteUntil, Date.now() + WAIT_MS);
        continue;
      }
    }
    descriptor.diagnostic = { ...(descriptor.diagnostic || {}), ...(session.conversationDiagnostic || {}) };
    if (descriptor.state === 'ambiguous') return remember(page, descriptor);
    reused = descriptor.state === 'ready' && await reusesPreviousConversation(page, descriptor, session);
    if (descriptor.state === 'ready' && descriptor.hasTargetEvidence) break;
    if (Date.now() >= until) return remember(page, descriptor.state === 'ready'
      ? { ...descriptor, code: reused ? 'DM_PREVIOUS_CONVERSATION_UNCONFIRMED' : 'DM_RECIPIENT_UNCONFIRMED' }
      : descriptor.code === 'DM_EDITOR_NOT_FOUND' ? { ...descriptor, code: 'DM_TARGET_CHAT_NOT_READY' } : descriptor);
    await page.waitForTimeout(100);
  } while (true);
  if (descriptor.state !== 'ready') return false;
  const editor = await bindElement(page, descriptor.editorPath);
  const scope = await bindElement(page, descriptor.scopePath);
  if (!editor || !scope) { await disposeHandles([editor, scope]); return false; }
  try {
    const current = await inspect(page, lead, 'editor', undefined, 0, options);
    if (conversations.get(page) !== session || current.state !== 'ready' || !current.hasTargetEvidence
      || current.editorPath !== descriptor.editorPath || current.scopePath !== descriptor.scopePath
      || !await sameElement(page, descriptor.editorPath, editor) || !await sameElement(page, descriptor.scopePath, scope)) {
      await disposeHandles([editor, scope]);
      return remember(page, { ...current, code: current.code || 'DM_COMPOSER_CHANGED' });
    }
  } catch (error) { await disposeHandles([editor, scope]); throw error; }
  await disposeHandles([session.editor, session.scope]);
  Object.assign(session, { conversationReady: true, filled: false, editor, scope,
    editorPath: descriptor.editorPath, scopePath: descriptor.scopePath, reusedConversation: reused });
  diagnostics.set(page, { ...(session.conversationDiagnostic || {}), ...(descriptor.diagnostic || {}), recipientEvidence: descriptor.recipientEvidence });
  await conversationStage(session, options, 'conversation_ready');
  return true;
}

async function fillDirectMessage(page, lead, message, options = {}) {
  check(options);
  assertTarget(page, lead);
  if (typeof message !== 'string' || !message.trim()) return false;
  if (!await ensureDirectMessageConversation(page, lead, options)) return false;
  const session = conversations.get(page);
  if (!session?.conversationReady || session.uid !== targetUid(lead)) return false;
  const { editor, scope, editorPath, scopePath } = session;
  session.filled = false;
  try {
    await beforeUiAction(options);
    assertTarget(page, lead);
    const current = await inspect(page, lead, 'editor', undefined, 0, options);
    if (conversations.get(page) !== session || current.state !== 'ready' || !current.hasTargetEvidence || current.editorPath !== editorPath || current.scopePath !== scopePath
      || !await sameElement(page, editorPath, editor) || !await sameElement(page, scopePath, scope)) {
      await invalidateConversationBinding(session); return remember(page, { ...current, code: current.code || 'DM_RECIPIENT_UNCONFIRMED' });
    }
    await editor.fill(message, { timeout: CLICK_MS });
    check(options);
    const verified = await inspect(page, lead, 'filled', message, 0);
    if (conversations.get(page) !== session || verified.state !== 'ready' || verified.editorPath !== editorPath || verified.scopePath !== scopePath
      || !verified.hasTargetEvidence || !await sameElement(page, editorPath, editor) || !await sameElement(page, scopePath, scope)) {
      await invalidateConversationBinding(session); return remember(page, { ...verified, code: verified.code || 'DM_COMPOSER_CHANGED' });
    }
  } catch (error) { await invalidateConversationBinding(session); throw error; }
  session.filled = true;
  return true;
}

async function prepareSend(page, lead, message, options = {}) {
  check(options);
  assertTarget(page, lead);
  const session = conversations.get(page);
  if (!session?.editor || !session.filled || session.uid !== targetUid(lead)) return missing('尚未在当前目标会话填写消息，本次没有发送');
  const descriptor = await inspect(page, lead, 'send', message, WAIT_MS, options);
  if (descriptor.state !== 'ready') {
    remember(page, descriptor);
    return { ...missing(descriptor.state === 'ambiguous'
      ? '当前会话有多个发送控件，无法唯一定位，本次没有发送' : descriptor.code === 'DM_SEND_DISABLED'
        ? '当前会话发送按钮仍不可用，本次没有发送' : '当前会话未找到可操作的发送控件或消息已改变，本次没有发送'), code: descriptor.code };
  }
  if (!descriptor.hasTargetEvidence) { remember(page, { ...descriptor, code: 'DM_RECIPIENT_UNCONFIRMED' }); return missing('尚未确认会话接收人为当前目标用户，本次没有发送'); }
  diagnostics.set(page, { ...(session.conversationDiagnostic || {}), ...(descriptor.diagnostic || {}), recipientEvidence: descriptor.recipientEvidence });
  if (descriptor.editorPath !== session.editorPath || descriptor.scopePath !== session.scopePath
    || !await sameElement(page, descriptor.editorPath, session.editor) || !await sameElement(page, descriptor.scopePath, session.scope)) {
    return missing('当前目标会话已改变，本次没有发送');
  }
  const send = await bindElement(page, descriptor.path);
  if (!send) return missing('目标发送控件已经改变，本次没有发送');
  let invoked = false;
  return {
    state: 'ready',
    // click() disposes its editor handles. The captured identity still permits
    // a read-only, freshly verified feedback check after a matched rejection.
    readFeedback: () => readChatObservation(page, lead, session.profileIdentity, options),
    async click() {
      try {
        if (invoked) throw Object.assign(new Error('本次发送准备已经使用，禁止重复点击'), { code: 'DM_SEND_PREPARATION_CONSUMED' });
        invoked = true;
        await beforeUiAction(options);
        assertTarget(page, lead);
        const current = await inspect(page, lead, 'send', message, 0);
        if (conversations.get(page) !== session || !session.conversationReady || !session.filled || current.state !== 'ready' || current.path !== descriptor.path
          || !current.hasTargetEvidence
          || current.editorPath !== session.editorPath || current.scopePath !== session.scopePath
          || !await sameElement(page, descriptor.path, send) || !await sameElement(page, session.editorPath, session.editor)
          || !await sameElement(page, session.scopePath, session.scope)) {
          throw new Error('准备后的目标会话、消息或发送控件已改变，本次没有发送');
        }
      } catch (error) {
        if (error.code !== 'DM_SEND_PREPARATION_CONSUMED') error.actionNotStarted = true;
        await send.dispose().catch(() => {});
        throw error;
      }
      try {
        await send.click({ timeout: CLICK_MS });
        await clearConversation(page);
        return true;
      } finally {
        for (const handle of [send, session.editor, session.scope]) await handle.dispose().catch(() => {});
      }
    }
  };
}

async function readChatObservation(page, lead, profileIdentity, options = {}) {
  check(options);
  const uid = assertTarget(page, lead);
  const numericUid = /^[1-9]\d{0,31}$/.test(String(lead?.UID || '')) ? String(lead.UID) : '';
  const result = await page.evaluate(inspectControls, { kind: 'chat-observation', uid, numericUid, profileIdentity, rejectionRules: REJECTION_RULES });
  check(options);
  assertTarget(page, lead);
  return result;
}

async function readDirectMessageHistory(page, lead, options = {}) {
  const session = conversations.get(page);
  if (!session?.conversationReady || session.uid !== targetUid(lead)) return { state: 'unknown' };
  const result = await readChatObservation(page, lead, session.profileIdentity, options);
  if (conversations.get(page) !== session || result.state !== 'ready') return { state: 'unknown' };
  return result;
}

module.exports = { prepareFollow, openDirectMessage, ensureDirectMessageConversation, fillDirectMessage, prepareSend, readDirectMessageHistory, getDiagnostic };
