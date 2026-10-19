'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const state = { csrf: '', username: '', users: [], page: 'accounts', requestId: 0, busy: false, dialog: null, returnFocus: null, menu: null };
  const actionNames = { create: '开通账户', 'user.create': '开通账户', update: '调整账户', 'user.update': '调整账户', unbind: '更换绑定电脑', 'user.unbind': '更换绑定电脑', 'reset-password': '重置客户密码', reset_password: '重置客户密码', 'user.reset_password': '重置客户密码', delete: '删除账户', 'user.delete': '删除账户', login: '管理员登录', logout: '退出登录', 'auth.login': '管理员登录', 'auth.logout': '退出登录' };
  const resultNames = { success: '已完成', failed: '操作未完成', failure: '操作未完成', rate_limited: '请求过于频繁', capacity: '暂时无法登录', denied: '未通过验证' };
  function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; }
  function showError(element, message) { element.textContent = message || ''; element.hidden = !message; }
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
  function currentDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  function addDays(date, count) { const value = new Date(date + 'T12:00:00+08:00'); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10); }
  function dayDifference(date) { return Math.round((Date.parse(date + 'T00:00:00+08:00') - Date.parse(currentDate() + 'T00:00:00+08:00')) / 86400000); }
  function status(user) { if (user.enabled === false) return 'disabled'; if (user.expired || dayDifference(user.expiresAt) < 0) return 'expired'; return dayDifference(user.expiresAt) <= 7 ? 'expiring' : 'active'; }
  function setBusy(busy) { state.busy = busy; $('dialog-submit').disabled = busy; $('dialog-cancel').disabled = busy; $('dialog-close').disabled = busy; for (const button of document.querySelectorAll('[data-account-action], #create-button, #refresh-button, #logout-button')) button.disabled = busy; }
  function clearSession(message) {
    state.csrf = ''; state.username = ''; state.users = []; state.requestId++; state.dialog = null; closeMenu();
    if ($('account-dialog').open) $('account-dialog').close(); $('dialog-fields').replaceChildren(); $('login-password').value = '';
    $('account-table-body').replaceChildren(); $('audit-list').replaceChildren(); $('account-search').value = ''; $('account-filter').value = 'all';
    $('operation-result-text').textContent = ''; $('operation-result').hidden = true; $('admin-name').textContent = '管理员'; $('toast').hidden = true; $('toast').textContent = ''; clearTimeout(toast.timer);
    $('app-view').hidden = true; $('login-view').hidden = false;
    showError($('login-error'), message || ''); $('login-password').focus();
  }
  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (path !== 'login') headers['X-CSRF-Token'] = state.csrf; }
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('api/' + path, { method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      const result = await response.json().catch(() => ({ ok: false, error: '服务器返回异常，请稍后重试。' }));
      if (response.status === 401 && path !== 'login' && path !== 'me') { clearSession('登录已过期，请重新输入管理员密码。'); throw new Error('登录已过期，请重新登录。'); }
      if (!response.ok || result.ok !== true) throw new Error(result.error || '操作未完成，请稍后重试。');
      return result;
    } catch (error) { if (error.name === 'AbortError') throw new Error('请求超时，请检查网络后重试。'); if (error instanceof TypeError) throw new Error('暂时无法连接管理系统，请检查网络后重试。'); throw error; }
    finally { clearTimeout(timeout); }
  }
  async function openApp(result) {
    state.csrf = result.csrfToken || ''; state.username = result.username || 'admin'; $('admin-name').textContent = state.username;
    $('login-password').value = ''; $('login-password').type = 'password'; $('login-show-password').textContent = '显示'; $('login-show-password').setAttribute('aria-pressed', 'false');
    $('login-view').hidden = true; $('app-view').hidden = false; showError($('login-error'), ''); setPage('accounts'); await loadUsers();
  }
  async function loadUsers() {
    const requestId = ++state.requestId; $('refresh-button').disabled = true; showError($('accounts-error'), '');
    try { const result = await api('users'); if (requestId !== state.requestId || !state.csrf) return; state.users = Array.isArray(result.users) ? result.users : []; renderUsers(); }
    catch (error) { if (requestId === state.requestId && state.csrf) showError($('accounts-error'), error.message); }
    finally { if (requestId === state.requestId) $('refresh-button').disabled = false; }
  }
  function renderUsers() {
    const counts = { total: state.users.length, active: 0, expiring: 0, unavailable: 0 };
    for (const user of state.users) { const value = status(user); if (['active', 'expiring'].includes(value)) counts.active++; if (value === 'expiring') counts.expiring++; if (['disabled', 'expired'].includes(value)) counts.unavailable++; }
    for (const key of Object.keys(counts)) $('stat-' + key).textContent = counts[key];
    $('account-count').textContent = state.users.length;
    const search = $('account-search').value.trim().toLocaleLowerCase(); const filter = $('account-filter').value;
    const filtered = state.users.filter(user => (!search || [user.username, user.note || '', user.mac || ''].some(value => String(value).toLocaleLowerCase().includes(search))) && (filter === 'all' || filter === 'active' && ['active', 'expiring'].includes(status(user)) || status(user) === filter));
    $('account-table-body').replaceChildren(); closeMenu();
    for (const user of filtered) {
      const row = node('tr'); row.dataset.username = user.username; const nameCell = node('td'); const nameWrap = node('div', 'account-name');
      nameWrap.append(node('span', 'account-avatar', Array.from(String(user.username))[0]?.toUpperCase() || '客'));
      const nameText = node('div'); nameText.append(node('strong', '', user.username), node('small', '', user.createdAt ? '创建于 ' + String(user.createdAt).slice(0, 10) : '客户使用账户')); nameWrap.append(nameText); nameCell.append(nameWrap); row.append(nameCell);
      const value = status(user); const statusCell = node('td'); statusCell.append(node('span', 'badge ' + value, { active: '可用', expiring: '即将到期', disabled: '已停用', expired: '已到期' }[value])); row.append(statusCell);
      const expiryCell = node('td', 'expiry-cell'); expiryCell.append(node('strong', '', user.expiresAt || '—')); const days = dayDifference(user.expiresAt); expiryCell.append(node('small', days >= 0 && days <= 7 ? 'soon' : '', Number.isFinite(days) ? days < 0 ? '已到期 ' + Math.abs(days) + ' 天' : days === 0 ? '今天到期' : '剩余 ' + days + ' 天' : '日期待确认')); row.append(expiryCell);
      const computerCell = node('td', 'computer-cell'); if (user.mac) { computerCell.append(node('code', 'mac-address', user.mac), node('small', '', '已绑定 1 台电脑'), macCopyButton(user)); } else computerCell.append(node('span', 'unbound', '未绑定电脑'), node('small', '', '等待首次登录客户端')); row.append(computerCell);
      const noteCell = node('td', 'note-cell', user.note || '—'); noteCell.title = user.note || ''; row.append(noteCell);
      const actionCell = node('td'); const actions = node('div', 'row-actions');
      actions.append(actionButton('详情', 'details', user), actionButton('续期 / 编辑', 'edit', user), actionButton(user.enabled === false ? '启用' : '停用', user.enabled === false ? 'enable' : 'disable', user));
      const more = node('button', 'more-button', '更多操作'); more.type = 'button'; more.setAttribute('aria-label', user.username + ' 的更多操作'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); more.dataset.accountAction = 'more'; more.addEventListener('click', event => { event.stopPropagation(); if (state.menu?.anchor === more) closeMenu(); else openMenu(user, more); }); actions.append(more); actionCell.append(actions); row.append(actionCell);
      ['客户账户', '授权状态', '到期日期', 'MAC 地址 / 绑定电脑', '备注', '操作'].forEach((label, index) => { row.children[index].dataset.label = label; }); $('account-table-body').append(row);
    }
    $('accounts-empty').hidden = filtered.length !== 0;
    $('empty-title').textContent = state.users.length ? '没有找到匹配的账户' : '还没有客户账户';
    $('empty-description').textContent = state.users.length ? '试试其他搜索内容，或将账户状态改为“全部状态”。' : '点击右上角“开通账户”，创建第一个客户的软件使用权限。';
    $('filtered-count').textContent = filtered.length === state.users.length ? '' : '找到 ' + filtered.length + ' 个账户';
    $('table-footer-count').textContent = '显示 ' + filtered.length + ' 个账户，共 ' + state.users.length + ' 个';
  }
  function macCopyButton(user) {
    const button = node('button', 'copy-mac', '复制 MAC'); button.type = 'button'; button.setAttribute('aria-label', '复制 ' + user.username + ' 的 MAC 地址');
    button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(String(user.mac)); if (state.csrf) toast('MAC 地址已复制。'); } catch { if (!state.csrf) return; if (!state.dialog) openDialog('details', user, button); const input = $('field-mac'); if (input) { input.focus(); input.select(); } toast('请选中完整 MAC 地址后手动复制。'); } }); return button;
  }
  function addDetails(user) {
    const details = node('dl', 'account-details');
    const add = (label, text, className = '') => { const item = node('div', 'detail-item'); item.append(node('dt', '', label), node('dd', className, text)); details.append(item); };
    add('授权状态', { active: '可用', expiring: '即将到期', disabled: '已停用', expired: '已到期' }[status(user)]); add('授权到期日期', user.expiresAt || '日期待确认'); add('创建日期', user.createdAt ? formatTime(user.createdAt) : '未记录');
    $('dialog-fields').append(details);
    const mac = field('field-mac', '完整 MAC 地址', 'text', user.mac || '未绑定电脑', { required: false, help: user.mac ? '此地址是该授权账户当前绑定的电脑标识。' : '客户首次登录独立客户端时自动绑定电脑。' }); mac.readOnly = true; mac.className = 'mac-detail'; if (user.mac) mac.parentElement.append(macCopyButton(user));
    const note = field('field-detail-note', '客户备注', 'textarea', user.note || '暂无备注', { required: false }); note.readOnly = true;
  }
  function actionButton(label, action, user) { const button = node('button', 'row-action', label); button.type = 'button'; button.dataset.accountAction = action; button.addEventListener('click', () => openDialog(action, user, button)); return button; }
  function closeMenu() { if (!state.menu) return; state.menu.anchor.setAttribute('aria-expanded', 'false'); state.menu.element.remove(); state.menu = null; }
  function openMenu(user, anchor) {
    closeMenu(); const menu = node('div', 'more-menu'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', user.username + ' 的账户操作');
    for (const [action, label] of [['unbind', '更换电脑'], ['reset-password', '重置客户密码'], ['delete', '删除账户']]) {
      if (action === 'delete') menu.append(node('hr')); const button = node('button', action === 'delete' ? 'danger-text' : '', label); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.dataset.accountAction = action;
      button.addEventListener('click', () => { closeMenu(); openDialog(action, user, anchor); }); menu.append(button);
    }
    document.body.append(menu); state.menu = { element: menu, anchor }; positionMenu(); anchor.setAttribute('aria-expanded', 'true'); menu.querySelector('button').focus({ preventScroll: true });
  }
  function positionMenu() { if (!state.menu) return; const { element, anchor } = state.menu; if (!anchor.isConnected) { closeMenu(); return; } const rect = anchor.getBoundingClientRect(); const { height, width } = element.getBoundingClientRect(); element.style.left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.right - width)) + 'px'; element.style.top = (rect.bottom + height + 10 > window.innerHeight ? Math.max(10, rect.top - height - 7) : rect.bottom + 7) + 'px'; }
  function field(id, label, type = 'text', value = '', options = {}) {
    const wrap = node('div', 'dialog-field'); const labelElement = node('label', '', label); labelElement.htmlFor = id;
    if (options.optional) labelElement.append(node('span', 'optional', '选填')); wrap.append(labelElement);
    const input = node(type === 'textarea' ? 'textarea' : 'input'); input.id = id; input.name = id; if (type !== 'textarea') input.type = type; input.value = value;
    input.required = options.required !== false; if (options.maxLength) input.maxLength = options.maxLength; if (options.minLength) input.minLength = options.minLength; if (options.pattern) input.pattern = options.pattern; if (options.placeholder) input.placeholder = options.placeholder;
    if (options.autocomplete) input.autocomplete = options.autocomplete; wrap.append(input); if (options.help) wrap.append(node('small', '', options.help)); $('dialog-fields').append(wrap); return input;
  }
  function addExpiryField(user) {
    const input = field('field-expiry', '授权到期日期', 'date', user?.expiresAt || addDays(currentDate(), 30), { help: '客户可使用至该日期结束，按北京时间计算。' });
    const presets = node('div', 'date-presets');
    for (const [days, label] of [[30, '+30 天'], [90, '+90 天'], [365, '+1 年']]) { const button = node('button', '', label); button.type = 'button'; button.addEventListener('click', () => { const base = user?.expiresAt && user.expiresAt > currentDate() ? user.expiresAt : currentDate(); input.value = addDays(base, days); }); presets.append(button); }
    input.parentElement.append(presets);
  }
  function addPasswordField(id, label) {
    const input = field(id, label, 'password', '', { minLength: 8, maxLength: 128, autocomplete: 'new-password', help: '至少 8 位。请将密码单独发送给客户，管理系统不会保存明文密码。' });
    const buttons = node('div', 'date-presets'); const show = node('button', '', '显示密码'); show.type = 'button'; show.setAttribute('aria-pressed', 'false');
    show.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; show.textContent = input.type === 'password' ? '显示密码' : '隐藏密码'; show.setAttribute('aria-pressed', String(input.type === 'text')); });
    const generate = node('button', '', '生成密码'); generate.type = 'button'; generate.addEventListener('click', () => { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; input.value = Array.from(bytes, value => alphabet[value % alphabet.length]).join(''); input.type = 'text'; show.textContent = '隐藏密码'; show.setAttribute('aria-pressed', 'true'); toast('已生成密码，请复制后交给客户。'); });
    const copy = node('button', '', '复制密码'); copy.type = 'button'; copy.addEventListener('click', async () => { if (!input.value) { input.focus(); toast('请先输入或生成密码。'); return; } try { await navigator.clipboard.writeText(input.value); toast('密码已复制，请交给对应客户。'); } catch { input.type = 'text'; input.focus(); input.select(); toast('请选中密码后手动复制。'); } });
    buttons.append(show, generate, copy); input.parentElement.append(buttons); return input;
  }
  function openDialog(action, user = null, trigger = null) {
    if (state.busy) return; closeMenu(); state.dialog = { action, user: user ? { ...user } : null }; state.returnFocus = trigger || document.activeElement;
    $('dialog-fields').replaceChildren(); showError($('dialog-error'), ''); $('dialog-submit').className = 'button primary'; $('dialog-eyebrow').textContent = action === 'create' ? '开通客户授权' : '账户管理';
    const labels = { details: ['账户详情', '查看客户授权信息与完整电脑标识。', ''], create: ['开通账户', '创建客户的软件使用账户。首次登录客户端时，将自动绑定客户的电脑。', '确认开通'], edit: ['续期 / 编辑', '调整授权到期日期和客户备注。修改后，客户可能需要重新登录客户端。', '保存修改'], disable: ['停用账户', '停用后，客户无法继续使用软件。之后可以再次启用。', '确认停用'], enable: ['启用账户', '恢复客户的软件使用权限；账户仍需要在有效期内。', '确认启用'], unbind: ['更换电脑', '清除旧电脑绑定，让客户在新电脑重新登录。下次登录会自动绑定新电脑。', '确认解绑'], 'reset-password': ['重置客户密码', '为此客户设置新密码。客户需要使用新密码重新登录独立客户端。', '确认重置'], delete: ['删除账户', '此操作会永久删除客户的授权账户，客户将无法继续登录软件。', '确认删除'] };
    const [title, description, submit] = labels[action]; $('dialog-title').textContent = title; $('dialog-description').textContent = description; $('dialog-submit').textContent = submit; $('dialog-submit').hidden = action === 'details'; $('dialog-cancel').textContent = action === 'details' ? '关闭' : '取消';
    if (user) { const card = node('div', 'dialog-account', '客户账户'); card.append(node('strong', '', user.username)); $('dialog-fields').append(card); }
    if (action === 'details') addDetails(user);
    if (action === 'create') { field('field-username', '客户账户名称', 'text', '', { maxLength: 64, autocomplete: 'off', pattern: '[\\p{L}\\p{N}_.@\\-]+', help: '支持中文、字母、数字及 _ . @ -，最多 64 个字符。' }); addPasswordField('field-password', '客户登录密码'); addExpiryField(); field('field-note', '客户备注', 'textarea', '', { required: false, optional: true, maxLength: 1000, placeholder: '例如：客户姓名、联系电话或所属团队' }); }
    if (action === 'edit') { addExpiryField(user); field('field-note', '客户备注', 'textarea', user.note || '', { required: false, optional: true, maxLength: 1000 }); }
    if (action === 'reset-password') { addPasswordField('field-password', '新的客户登录密码'); $('dialog-fields').append(node('div', 'password-feedback', '此密码仅用于上述客户的软件登录，不会修改管理员登录密码。')); }
    if (action === 'unbind') { const binding = node('div', 'binding-review'); binding.append(node('strong', '', '当前绑定 MAC 地址'), node('code', 'mac-address', user.mac || '未绑定电脑')); $('dialog-fields').append(binding); $('dialog-fields').append(node('div', 'dialog-caution', user.mac ? '旧电脑将失去该账户的授权。请确认客户确实需要更换电脑，再执行此操作。' : '此账户尚未绑定电脑。客户首次登录时，会自动完成绑定。')); }
    if (action === 'disable') $('dialog-fields').append(node('div', 'dialog-caution', '停用在客户端下一次授权校验时生效。在线校验可能有约 1 分钟延迟；离线电脑在已有临时授权到期后停止使用。'));
    if (action === 'enable' && (status(user) === 'expired' || dayDifference(user.expiresAt) < 0)) $('dialog-fields').append(node('div', 'dialog-caution', '这个账户已到期，启用后仍需要续期才能使用客户端。'));
    if (action === 'delete') { $('dialog-submit').className = 'button danger'; $('dialog-fields').append(node('div', 'dialog-caution danger', '删除无法撤销。若只是暂时暂停使用，建议选择“停用账户”。')); field('field-confirmation', '输入账户名称确认删除', 'text', '', { maxLength: 64, autocomplete: 'off', help: '请完整输入：' + user.username }); }
    $('account-dialog').showModal(); const first = $('dialog-fields').querySelector('input,textarea'); (first || $('dialog-cancel')).focus();
  }
  function closeDialog() { if (state.busy) return; $('account-dialog').close(); }
  function operationMessage(action, username) { return { create: '账户「' + username + '」已开通。请将账户名称和密码交给客户，在独立客户端登录。', edit: '账户「' + username + '」的授权日期和备注已更新。', disable: '账户「' + username + '」已停用。', enable: '账户「' + username + '」已启用，请确认授权仍在有效期内。', unbind: '账户「' + username + '」的旧电脑已解绑。请让客户在新电脑重新登录。', 'reset-password': '账户「' + username + '」的客户密码已重置。请将新密码交给客户，重新登录客户端。', delete: '账户「' + username + '」已删除。' }[action]; }
  async function submitDialog(event) {
    event.preventDefault(); if (state.busy || !state.dialog || state.dialog.action === 'details') return; const { action, user } = state.dialog; let endpoint = 'users', body;
    if (action === 'create') body = { username: $('field-username').value.trim(), password: $('field-password').value, expiresAt: $('field-expiry').value, note: $('field-note').value.trim() };
    else { endpoint += '/' + encodeURIComponent(user.username) + '/'; if (action === 'edit') { endpoint += 'update'; body = { expiresAt: $('field-expiry').value, note: $('field-note').value.trim() }; } if (action === 'enable' || action === 'disable') { endpoint += 'update'; body = { enabled: action === 'enable' }; } if (action === 'unbind') { endpoint += 'unbind'; body = {}; } if (action === 'reset-password') { endpoint += 'reset-password'; body = { newPassword: $('field-password').value }; } if (action === 'delete') { endpoint += 'delete'; body = { confirmation: $('field-confirmation').value }; if (body.confirmation !== user.username) { showError($('dialog-error'), '账户名称不一致，请完整输入「' + user.username + '」。'); $('field-confirmation').focus(); return; } } }
    setBusy(true); showError($('dialog-error'), '');
    try { await api(endpoint, { method: 'POST', body }); if (!state.csrf) return; const username = user?.username || body.username; setBusy(false); $('account-dialog').close(); $('operation-result-text').textContent = operationMessage(action, username); $('operation-result').hidden = false; await loadUsers(); }
    catch (error) { if (state.csrf) showError($('dialog-error'), error.message); }
    finally { setBusy(false); }
  }
  async function loadAudit() {
    $('audit-refresh').disabled = true; showError($('audit-error'), '');
    try { const result = await api('audit'); if (!state.csrf) return; const events = Array.isArray(result.events) ? result.events : []; $('audit-list').replaceChildren();
      for (const event of events) { const row = node('li', 'audit-entry'); const succeeded = event.result === 'success' || event.result === true; row.append(node('span', 'audit-icon', succeeded ? '✓' : '!')); const content = node('div'); const label = actionNames[event.action] || '账户管理操作'; content.append(node('h3', '', label + (event.target ? ' · ' + event.target : ''))); content.append(node('p', '', '操作人：' + (event.actor === 'anonymous' ? '未登录访问者' : event.actor || '管理员') + '　·　' + (resultNames[event.result] || (succeeded ? '已完成' : '操作未完成')))); row.append(content); const time = node('time', '', formatTime(event.timestamp)); if (event.timestamp) time.dateTime = event.timestamp; row.append(time); $('audit-list').append(row); }
      $('audit-empty').hidden = events.length !== 0;
    } catch (error) { if (state.csrf) showError($('audit-error'), error.message); }
    finally { $('audit-refresh').disabled = false; }
  }
  function formatTime(value) { const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) return '时间待确认'; return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed); }
  function setPage(page) { state.page = page; closeMenu(); $('accounts-view').hidden = page !== 'accounts'; $('audit-view').hidden = page !== 'audit'; $('page-location').textContent = page === 'accounts' ? '客户账户' : '操作记录'; for (const name of ['accounts', 'audit']) { $('nav-' + name).classList.toggle('selected', name === page); if (name === page) $('nav-' + name).setAttribute('aria-current', 'page'); else $('nav-' + name).removeAttribute('aria-current'); } if (page === 'audit') loadAudit(); }
  $('login-form').addEventListener('submit', async event => { event.preventDefault(); $('login-submit').disabled = true; $('login-submit').textContent = '正在登录…'; showError($('login-error'), ''); try { const result = await api('login', { method: 'POST', body: { username: $('login-username').value.trim(), password: $('login-password').value } }); await openApp(result); } catch (error) { $('login-password').value = ''; showError($('login-error'), error.message); $('login-password').focus(); } finally { $('login-submit').disabled = false; $('login-submit').replaceChildren(document.createTextNode('登录管理系统 '), node('span', '', '→')); } });
  $('login-show-password').addEventListener('click', () => { const input = $('login-password'); input.type = input.type === 'password' ? 'text' : 'password'; $('login-show-password').textContent = input.type === 'password' ? '显示' : '隐藏'; $('login-show-password').setAttribute('aria-pressed', String(input.type === 'text')); });
  $('logout-button').addEventListener('click', async () => { if (state.busy) return; $('logout-button').disabled = true; try { await api('logout', { method: 'POST', body: {} }); clearSession(); } catch (error) { if (state.csrf) toast(error.message); } finally { $('logout-button').disabled = false; } });
  $('create-button').addEventListener('click', event => openDialog('create', null, event.currentTarget)); $('account-form').addEventListener('submit', submitDialog);
  $('dialog-close').addEventListener('click', closeDialog); $('dialog-cancel').addEventListener('click', closeDialog); $('account-dialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
  $('account-dialog').addEventListener('close', () => { $('dialog-fields').replaceChildren(); state.dialog = null; $('toast').hidden = true; clearTimeout(toast.timer); if (state.returnFocus?.isConnected) state.returnFocus.focus(); state.returnFocus = null; });
  $('dismiss-result').addEventListener('click', () => { $('operation-result').hidden = true; $('operation-result-text').textContent = ''; });
  $('account-search').addEventListener('input', renderUsers); $('account-filter').addEventListener('change', renderUsers); $('refresh-button').addEventListener('click', loadUsers); $('audit-refresh').addEventListener('click', loadAudit);
  $('nav-accounts').addEventListener('click', () => setPage('accounts')); $('nav-audit').addEventListener('click', () => setPage('audit'));
  document.addEventListener('click', event => { if (state.menu && !state.menu.element.contains(event.target) && state.menu.anchor !== event.target) closeMenu(); });
  document.addEventListener('keydown', event => { if (!state.menu) return; const buttons = [...state.menu.element.querySelectorAll('button')]; if (event.key === 'Escape') { const anchor = state.menu.anchor; closeMenu(); anchor.focus(); event.preventDefault(); } if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { const index = buttons.indexOf(document.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); event.preventDefault(); } });
  window.addEventListener('resize', closeMenu); window.addEventListener('scroll', positionMenu, true);
  api('me').then(result => { if (result.authenticated) openApp(result); }).catch(error => showError($('login-error'), error.message));
})();
