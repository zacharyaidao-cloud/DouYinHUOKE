'use strict';
const fs = require('node:fs');
const file = 'build-tools/verify-outreach-browser.js';
let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const removeCase = title => {
  const start = s.indexOf(`    await test('${title}',`);
  if (start < 0) throw Error('Missing case: ' + title);
  const end = s.indexOf('\n    });', start) + '\n    });'.length;
  s = s.slice(0, start) + s.slice(end);
};
// Avatar/UID gates are intentionally retired for the observed StackLayout.
// Their replacement cases below exercise the user's nickname-only policy.
for (const title of [
  'Profile identity capture: missing sibling avatar keeps the UID-less editor untouched with safe diagnostics',
  'Profile identity capture: a delayed avatar is captured before the native entry click',
  'Profile identity capture: duplicate visible sibling avatars cannot become captured identity',
  'Profile identity capture: stopping during pending avatar readiness prevents the entry click',
  'Explicit foreign UID outranks matching observed name and avatar',
  'Explicit matching UID remains authoritative after profile display name changes',
  'Recipient boundary: a foreign UID on the editor itself overrides matching DOM identity',
  'Recipient boundary: a matching UID on the editor is explicit recipient evidence',
  'Recipient boundary: stale currentSrc cannot hide a pending different profile avatar',
  'Observed list: explicit foreign UID vetoes an otherwise matching identity row',
  'Observed list: a target link cannot bypass conflicting identity elsewhere in its entire row',
]) removeCase(title);
s = s.replace(/^.*\['matching name cannot override (?:a different avatar|a foreign UID)'.*\n/gm, '')
  .replace(/^.*\['same name (?:with|but) different avatar'.*\n/gm, '')
  .replace(/^.*\['placeholder avatar cannot be identity evidence'.*\n/gm, '')
  .replace("['different chat avatar', { chatAsset: 'tos-cn-i-0813c001_qaDifferentAvatar654321' }]", "['empty chat name', { chatName: '' }]")
  .replace("assert.equal(adapter.getDiagnostic(page).chatAvatarMatches, 1);", "assert.equal(adapter.getDiagnostic(page).chatNameMatches, 1);")
  .replace(/dom_profile_identity/g, 'dom_profile_name')
  .replace('foreign identity introduced during row authorization prevents selection', 'nickname changed during row authorization prevents selection')
  .replace("row.setAttribute('data-recipient-sec-uid', 'qa_foreign_user');", "row.querySelector('.conversationConversationItemtitle').textContent = '别的昵称';")
  .replace("await page.locator('[data-e2e=\"live-avatar\"] img').evaluate(e => { e.src = 'https://p3.douyinpic.com/img/aweme-avatar/tos-cn-i-0813c001_qaOtherAvatarAsset789123~c5_300x300.jpeg'; });", "await page.locator('[data-e2e=\"user-info\"] h1').evaluate(e => { e.textContent = '别的昵称'; });")
  .replace('duplicate name-and-avatar matches do not permit a first-row guess', 'duplicate full names do not permit a first-row guess')
  .replace('unique profile name and avatar select', 'unique full profile name selects')
  .replace('confirms profile name plus avatar asset without UID', 'confirms full profile name without avatar or UID checks');
const anchor = "    await test('Nickname identity: observed legacy avatar";
const pos = s.indexOf(anchor);
if (pos < 0) throw Error('Missing insertion point');
s = s.slice(0, pos) + `
    for (const [name, options, alter] of [
      ['different avatar', { chatAsset: 'qaOtherAvatarAssetDifferent123456' }],
      ['missing avatar', {}, async page => page.locator('[data-e2e="live-avatar"]').evaluate(node => node.remove())],
      ['unloaded avatar', {}, async page => page.locator('[data-e2e="live-avatar"] img').evaluate(node => node.removeAttribute('src'))],
      ['duplicate avatar elements', {}, async page => page.locator('[data-e2e="live-avatar"]').evaluate(node => node.after(node.cloneNode(true)))],
      ['placeholder avatar', { profileAsset: 'default_qaAvatarAsset12345678' }],
      ['UID attributes are not a nickname gate', { explicitUid: 'qa_foreign' }, async page => page.locator('#qa-editor').evaluate(node => node.setAttribute('data-sec-uid', 'qa_other'))],
      ['same list nickname with different avatar', { selectToChat: true, rowAsset: 'qaOtherAvatarAssetDifferent123456' }],
      ['list UID attributes are not a nickname gate', { selectToChat: true }, async page => page.locator('#qa-target-row').evaluate(node => node.setAttribute('data-sec-uid', 'qa_other'))],
      ['emoji-only name with missing avatar', { profileName: emojiImage('💎', '1f48e'), chatName: '💎' }, async page => page.locator('[data-e2e="live-avatar"]').evaluate(node => node.remove())],
    ]) await test('Nickname identity: ' + name + ' permits full-name match', async () => {
      const page = await fixture({ stack: true, ...options });
      if (alter) await alter(page);
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), true, JSON.stringify(adapter.getDiagnostic(page)));
      assert.equal(adapter.getDiagnostic(page).recipientEvidence, 'dom_profile_name');
      assert.equal(await adapter.fillDirectMessage(page, lead, MESSAGE), true);
      const send = await adapter.prepareSend(page, lead, MESSAGE); assert.equal(send.state, 'ready'); await send.click();
      const result = await actions(page);
      assert.deepEqual([result.open, result.select, result.send, result.decoy], [1, options.selectToChat ? 1 : 0, 1, 0]);
      assert(result.trustedOpen && result.trustedInput && result.trustedSend);
    });
    await test('Nickname identity: matching UID cannot override a different nickname', async () => {
      const page = await fixture({ stack: true, explicitUid: lead.uid, chatName: '别人的聊天' });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), false);
      assert.equal((await actions(page)).send, 0);
      assert.equal((await actions(page)).trustedInput, false);
    });
    await test('Nickname identity: duplicate full names with distinct avatars remain ambiguous', async () => {
      const page = await fixture({ stack: true, selectToChat: true });
      await page.locator('#qa-decoy-row .conversationConversationItemtitle').evaluate(node => { node.textContent = '承恩勇闯亚马逊'; });
      await page.locator('#qa-decoy-row img').evaluate(node => { node.src = 'https://example.invalid/another-avatar'; });
      assert.equal(await adapter.openDirectMessage(page, lead), true);
      assert.equal(await adapter.ensureDirectMessageConversation(page, lead), false);
      assert.equal(adapter.getDiagnostic(page).targetConversationRowCount, 2);
      assert.deepEqual([(await actions(page)).select, (await actions(page)).decoy, (await actions(page)).send], [0, 0, 0]);
    });
    await test('Nickname identity: stop before entry prevents native click', async () => {
      const page = await fixture({ stack: true });
      await assert.rejects(adapter.openDirectMessage(page, lead, { beforeUiAction: () => { throw new Error('user stopped'); } }), /user stopped/);
      assert.equal((await actions(page)).open, 0);
    });
` + s.slice(pos);
// Run just the affected identity/history groups, not the unrelated full suite.
s = s.replace("const exclude = process.argv", "const nicknamePolicy = process.argv.includes('--nickname-policy');\nconst exclude = process.argv");
s = s.replace("      if (match && !name.includes(match)) return;", "      if (nicknamePolicy && !/^(?:Nickname identity:|Emoji identity:|Profile identity capture:|DOM history:|Observed list:|Observed list boundary:|Observed StackLayout|Observed identity|Observed profile identity)/.test(name)) return;\n      if (match && !name.includes(match)) return;");
fs.writeFileSync(file, s);
const tests = 'dy-lead-app/tests/engine-actions.test.js';
fs.writeFileSync(tests, fs.readFileSync(tests, 'utf8').replace(/dom_profile_identity/g, 'dom_profile_name'));
