'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const { createEmbeddedBrowserClient } = require('../lib/embedded-browser-client');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const previous = process.env.DY_LEAD_EMBEDDED_BROWSER;
  process.env.DY_LEAD_EMBEDDED_BROWSER = '1';
  const channel = new EventEmitter(); channel.connected = true;
  const sent = [], connections = [], order = [];
  let commandHandler = command => ({ echoMethod: command.method }), holdOp = '', connectFailure = false;
  channel.send = (message, callback) => {
    sent.push(message); order.push('host:' + message.op);
    setImmediate(() => {
      callback?.(null);
      if (message.op === holdOp) return;
      const result = message.op === 'open'
        ? { pageSession: 'page-' + message.accountId, targetId: 'target-' + message.accountId, contextId: 'context-' + message.accountId }
        : message.op === 'command' ? commandHandler(message.payload) : {};
      if (result === undefined) return;
      channel.emit('message', { type: 'embedded:reply', id: message.id, result });
    });
    return true;
  };
  const chromium = { async connectOverCDP(endpoint, connectOptions) {
    if (connectFailure) throw new Error('private-endpoint=' + endpoint + ' token=' + connectOptions.headers.Authorization);
    const ws = new WebSocket(endpoint, { headers: connectOptions.headers });
    ws.on('error', () => {});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const page = new EventEmitter(), context = new EventEmitter(), browser = new EventEmitter();
    let closed = false, closeCount = 0;
    page.isClosed = () => closed;
    page.bringToFront = async () => { order.push('native:front'); };
    context.pages = () => options.emptyPage ? [] : options.duplicatePage ? [page, page] : [page];
    context.newPage = async () => { throw new Error('Must never create an additional account page'); };
    browser.contexts = () => [context];
    browser.close = async () => {
      closeCount++; if (closed) return; closed = true;
      ws.terminate(); browser.emit('disconnected'); context.emit('close'); page.emit('close');
    };
    const connection = { ws, endpoint, headers: connectOptions.headers, page, context, browser, closeCount: () => closeCount };
    connections.push(connection);
    if (options.beforeConnectReturn) await options.beforeConnectReturn(connection);
    return browser;
  } };
  const client = createEmbeddedBrowserClient({ channel, chromium });
  t.after(async () => {
    // Never let a test's deliberate held request stall fixture cleanup.
    holdOp = ''; channel.connected = false; channel.emit('disconnect');
    await client.dispose();
    for (const connection of connections) connection.ws.terminate();
    if (previous === undefined) delete process.env.DY_LEAD_EMBEDDED_BROWSER; else process.env.DY_LEAD_EMBEDDED_BROWSER = previous;
  });
  return { client, channel, sent, connections, order,
    setHandler: callback => { commandHandler = callback; }, hold: op => { holdOp = op; }, failConnect: () => { connectFailure = true; },
    open: (accountId = 'a', extra = {}) => client.open({ accountId, name: 'synthetic account', profileDir: 'C:\\synthetic-profile', visible: false, ...extra }),
    event: (request, event) => channel.emit('message', { type: 'embedded:event', accountId: request.accountId, generation: request.generation, event }) };
}
function nextMessage(ws, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const message = bytes => {
      const value = JSON.parse(bytes.toString());
      if (!predicate(value)) return;
      ws.removeListener('message', message); ws.removeListener('close', close); resolve(value);
    };
    const close = () => { ws.removeListener('message', message); reject(new Error('Fixture socket closed before its expected response')); };
    ws.on('message', message); ws.once('close', close);
  });
}
async function rejectedConnection(connection, patch = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(patch.endpoint || connection.endpoint, { headers: patch.headers || connection.headers });
    ws.on('error', () => {});
    ws.once('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.once('open', () => { ws.terminate(); reject(new Error('Untrusted local websocket unexpectedly connected')); });
  });
}

test('availability requires the explicit embedded environment and connected IPC; disposal removes listeners', async t => {
  const f = await fixture(t);
  assert.equal(f.client.isAvailable(), true);
  process.env.DY_LEAD_EMBEDDED_BROWSER = '0'; assert.equal(f.client.isAvailable(), false);
  await assert.rejects(f.open(), { code: 'EMBEDDED_UNAVAILABLE' });
  process.env.DY_LEAD_EMBEDDED_BROWSER = '1'; f.channel.connected = false; assert.equal(f.client.isAvailable(), false);
  f.channel.connected = true; await f.client.dispose();
  assert.equal(f.client.isAvailable(), false); assert.equal(f.sent.length, 0);
  for (const event of ['message', 'disconnect', 'close']) assert.equal(f.channel.listenerCount(event), 0);
});

test('background open returns the unique existing page, show precedes native front, and account close is idempotent', async t => {
  const f = await fixture(t), a = await f.open('a'), b = await f.open('b');
  assert.equal(a.embedded, true); assert.equal(a.page, f.connections[0].page);
  assert.deepEqual(f.sent.filter(item => item.op === 'open').map(item => item.payload.visible), [false, false]);
  assert.equal(f.sent.filter(item => item.op === 'show').length, 0);
  await a.page.bringToFront(); assert.deepEqual(f.order.slice(-2), ['host:show', 'native:front']);
  await Promise.all([a.context.close(), a.close(), a.context.close()]);
  assert.equal(f.connections[0].closeCount(), 1); assert.equal(b.page.isClosed(), false);
  assert.equal(f.sent.filter(item => item.op === 'close' && item.accountId === 'a').length, 1);
  assert.equal(f.sent.filter(item => item.op === 'close' && item.accountId === 'b').length, 0);
  await assert.rejects(a.show(), { code: 'EMBEDDED_CLOSED' });
  await b.show(); await b.close();
  assert.equal(f.connections[1].closeCount(), 1);
});

test('IPC commands and events retain CDP session and a binary response body larger than 8 MiB without interpretation', async t => {
  const f = await fixture(t), binary = Buffer.alloc(9 * 1024 * 1024, 173);
  await f.open(); const connection = f.connections[0];
  f.setHandler(command => command.method === 'Network.getResponseBody' ? { body: binary.toString('base64'), base64Encoded: true } : {});
  const received = nextMessage(connection.ws, value => value.id === 17);
  connection.ws.send(JSON.stringify({ id: 17, sessionId: 'page-a', method: 'Network.getResponseBody', params: { requestId: 'synthetic-request' } }));
  const reply = await received;
  assert.equal(reply.sessionId, 'page-a'); assert.equal(reply.result.base64Encoded, true);
  assert.deepEqual(Buffer.from(reply.result.body, 'base64'), binary);
  const command = f.sent.find(item => item.op === 'command');
  assert.equal(command.payload.params.requestId, 'synthetic-request'); assert.equal(command.payload.sessionId, 'page-a');
  const event = { method: 'Network.responseReceived', sessionId: 'page-a', params: { requestId: 'synthetic-request' } };
  const observed = nextMessage(connection.ws); f.event(f.sent.find(item => item.op === 'open'), event);
  assert.deepEqual(await observed, event);
});

test('loopback capability rejects missing/wrong auth, Origin, changed Host, unknown path and duplicate connection', async t => {
  const f = await fixture(t); await f.open(); const connection = f.connections[0];
  const endpoint = new URL(connection.endpoint);
  assert.equal(endpoint.hostname, '127.0.0.1'); assert(Number(endpoint.port) > 0);
  assert.match(connection.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
  for (const headers of [{}, { Authorization: 'Bearer ' + '0'.repeat(64) },
    { ...connection.headers, Origin: 'http://127.0.0.1' }, { ...connection.headers, Origin: '' },
    { ...connection.headers, Host: 'localhost:' + endpoint.port }, connection.headers]) {
    assert.equal(await rejectedConnection(connection, { headers }), 403);
  }
  assert.equal(await rejectedConnection(connection, { endpoint: 'ws://127.0.0.1:' + endpoint.port + '/unknown' }), 403);
  assert.equal(await rejectedConnection(connection, { endpoint: connection.endpoint + '?unexpected=1' }), 403);
  assert.equal(f.connections[0].page.isClosed(), false);
  const ipc = JSON.stringify(f.sent);
  assert(!ipc.includes(connection.endpoint)); assert(!ipc.includes(connection.headers.Authorization));
});

test('duplicate concurrent open is rejected, and old-generation events cannot close or inject into a replacement', async t => {
  const f = await fixture(t), opening = f.open('a');
  await assert.rejects(f.open('a'), { code: 'EMBEDDED_ACCOUNT_OPEN' });
  const old = await opening, oldRequest = f.sent.find(item => item.op === 'open'); await old.close();
  const fresh = await f.open('a'), other = await f.open('b');
  const freshRequest = f.sent.filter(item => item.op === 'open' && item.accountId === 'a').at(-1);
  assert.notEqual(freshRequest.generation, oldRequest.generation);
  assert.notEqual(f.connections[0].headers.Authorization, f.connections[1].headers.Authorization);
  let events = 0; f.connections[1].ws.on('message', () => events++);
  f.event(oldRequest, { method: 'Host.closed', params: { reason: 'synthetic stale close' } });
  f.event(oldRequest, { method: 'Page.frameNavigated', params: { marker: 'stale' } }); await tick();
  assert.equal(fresh.page.isClosed(), false); assert.equal(events, 0);
  f.event(freshRequest, { method: 'Host.closed', params: { reason: 'synthetic current close' } }); await tick();
  assert.equal(fresh.page.isClosed(), true); assert.equal(other.page.isClosed(), false);
});

test('disconnect immediately rejects pending work and closes only owned connections without waiting for a late reply', async t => {
  const f = await fixture(t), resource = await f.open(); f.hold('show');
  const showing = resource.show(); const rejected = assert.rejects(showing, { code: 'EMBEDDED_DISCONNECTED' });
  const request = f.sent.at(-1); f.channel.connected = false; f.channel.emit('disconnect'); await rejected; await tick();
  assert.equal(resource.page.isClosed(), true); assert.equal(f.client.isAvailable(), false);
  f.channel.emit('message', { type: 'embedded:reply', id: request.id, result: {} }); await tick();
  assert.equal(resource.page.isClosed(), true);
});

test('30-second IPC timeout is bounded, and timed-out replies cannot fulfill later commands', async t => {
  const f = await fixture(t), resource = await f.open(); f.hold('show');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = resource.show(), rejected = assert.rejects(waiting, { code: 'EMBEDDED_TIMEOUT' });
  const oldRequest = f.sent.at(-1); t.mock.timers.tick(30001); await rejected;
  t.mock.timers.reset(); f.hold('');
  f.channel.emit('message', { type: 'embedded:reply', id: oldRequest.id, result: {} });
  await resource.show(); assert.equal(resource.page.isClosed(), false);
});

test('pending-command cap returns a safe CDP failure, and close cancels outstanding command waits', async t => {
  const f = await fixture(t), resource = await f.open(); f.setHandler(() => undefined);
  const connection = f.connections[0], rejected = nextMessage(connection.ws, value => value.id === 129);
  for (let id = 1; id <= 129; id++) connection.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: 'synthetic' } }));
  const result = await rejected;
  assert.equal(result.error.code, -32000); assert.match(result.error.message, /请求过多/);
  assert.equal(f.sent.filter(item => item.op === 'command').length, 128);
  await resource.close(); assert.equal(connection.closeCount(), 1);
});

test('invalid or oversized client frames close their account while preserving another account', async t => {
  const f = await fixture(t), a = await f.open('a'), b = await f.open('b');
  const closed = new Promise(resolve => f.connections[0].ws.once('close', resolve));
  f.connections[0].ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'x'.repeat(1024 * 1024) } }));
  await closed; await tick(); assert.equal(a.page.isClosed(), true); assert.equal(b.page.isClosed(), false);
});

test('closing an idle account still reaches the host when other accounts saturate the command queue', async t => {
  const f = await fixture(t); await f.open('a'); await f.open('b'); const idle = await f.open('c');
  f.setHandler(() => undefined);
  for (const connection of f.connections.slice(0, 2)) {
    for (let id = 1; id <= 128; id++) connection.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {} }));
  }
  while (f.sent.filter(item => item.op === 'command').length < 256) await tick();
  await idle.close();
  assert.equal(f.sent.filter(item => item.op === 'close' && item.accountId === 'c').length, 1);
  assert.equal(f.connections[2].closeCount(), 1);
});

test('a host close while connectOverCDP is completing cannot leak or revive its late browser', async t => {
  let resume;
  const barrier = new Promise(resolve => { resume = resolve; });
  const f = await fixture(t, { beforeConnectReturn: () => barrier });
  const opening = f.open(), rejected = assert.rejects(opening, { code: 'EMBEDDED_CLOSED' });
  while (!f.connections.length) await tick();
  f.event(f.sent.find(item => item.op === 'open'), { method: 'Host.closed' }); await tick();
  resume(); await rejected;
  assert.equal(f.connections[0].closeCount(), 1);
});

test('connect and host errors cannot expose capability URL, token or raw IPC error payload', async t => {
  const f = await fixture(t); f.failConnect();
  await assert.rejects(f.open(), failure => failure.code === 'EMBEDDED_CONNECT_FAILED' && !/Bearer|127\.0\.0\.1|private-endpoint/.test(failure.message));
  assert.equal(f.sent.filter(item => item.op === 'close').length, 1);
  const g = await fixture(t), resource = await g.open(); g.hold('show');
  const waiting = resource.show(), rejected = assert.rejects(waiting, failure => failure.code === 'EMBEDDED_HOST_ERROR' && !failure.message.includes('synthetic-private-payload'));
  g.channel.emit('message', { type: 'embedded:reply', id: g.sent.at(-1).id, error: { code: -32000, message: 'synthetic-private-payload' } });
  await rejected;
});

test('zero or duplicate existing pages fail closed and never create a page', async t => {
  for (const options of [{ emptyPage: true }, { duplicatePage: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.open(), { code: 'EMBEDDED_PAGE_INVALID' });
    assert.equal(f.connections[0].closeCount(), 1); assert.equal(f.sent.filter(item => item.op === 'close').length, 1);
  }
});

test('stop after host open or CDP connect closes that generation before propagating the original stop', async t => {
  for (const stopAt of [3, 4]) {
    const f = await fixture(t); let checks = 0;
    const stop = Object.assign(new Error('synthetic task stopped'), { code: 'TASK_STOPPED' });
    await assert.rejects(f.open('a', { checkStopped: () => { if (++checks === stopAt) throw stop; } }), failure => failure === stop);
    assert.equal(f.sent.filter(item => item.op === 'close').length, 1);
    for (const connection of f.connections) assert.equal(connection.closeCount(), 1);
  }
});
