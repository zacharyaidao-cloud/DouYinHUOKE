'use strict';
// One read-only official balance request. No completions, retries or credential
// output. Only the provider's availability flag is reported; amounts omitted.
const fs = require('node:fs'), path = require('node:path');
const appDir = path.resolve(process.argv[2] || '');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
(async () => {
  const settings = read(path.join(appDir, 'data', 'settings.json'));
  const key = settings.ai?.apiKey;
  if (typeof key !== 'string' || !key.trim()) throw new Error('API Key not configured');
  const response = await fetch('https://api.deepseek.com/user/balance', {
    method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000)
  });
  const report = { at: new Date().toISOString(), operation: 'read_only_balance_availability', httpStatus: response.status, completionRequests: 0 };
  if (response.ok) {
    const body = await response.json();
    report.isAvailable = typeof body.is_available === 'boolean' ? body.is_available : null;
  }
  console.log(JSON.stringify(report));
})().catch(error => {
  console.error(JSON.stringify({ operation: 'read_only_balance_availability', error: error.name === 'TimeoutError' ? 'timeout' : 'unavailable', completionRequests: 0 }));
  process.exitCode = 1;
});
