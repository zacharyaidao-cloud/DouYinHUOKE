const assert = require('assert/strict');
const http = require('http');
const { assertNoLegacyService, identifyLegacyService } = require('../desktop/legacy-preflight');
async function main() {
  let count = 0;
  const health = async url => ({ ok: true, json: async () => ({ app: 'dy-lead-app', version: '1.6.1' }), text: async () => '' });
  const oldHtml = async url => ({ ok: !url.endsWith('/health'), json: async () => ({}),
    text: async () => '<title>抖音获客软件</title><div id="login-layer"></div>' });
  assert.equal((await identifyLegacyService(17888, health)).version, '1.6.1'); count++;
  assert.equal((await identifyLegacyService(17888, oldHtml)).version, '旧版'); count++;
  await assert.rejects(assertNoLegacyService({ fetcher: health }), /请先停止原版任务/); count++;
  await assert.rejects(assertNoLegacyService({ fetcher: oldHtml }), /本次尚未启动任务/); count++;
  await assertNoLegacyService({ fetcher: async () => { throw new Error('ECONNREFUSED'); } }); count++;
  await assertNoLegacyService({ fetcher: async () => ({ ok: true, json: async () => ({ app: 'other-app' }), text: async () => '<title>其他软件</title>' }) }); count++;
  let seen = [];
  await assertNoLegacyService({ oldPort: '19222', fetcher: async url => { seen.push(new URL(url).port); throw new Error('offline'); } });
  assert(seen.includes('19222') && seen.includes('17888')); count++;
  const fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app: 'dy-lead-app', version: 'isolated-legacy-fixture' }));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  try {
    const fixturePort = fixture.address().port;
    assert.equal((await identifyLegacyService(fixturePort)).version, 'isolated-legacy-fixture'); count++;
    await assert.rejects(assertNoLegacyService({ oldPort: fixturePort }), /检测到另一份获客软件后台/); count++;
  } finally { await new Promise(resolve => fixture.close(resolve)); }
  console.log('PASS: ' + count + ' 旧服务隔离预检');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
