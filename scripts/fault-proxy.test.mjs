import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFaultProxy } from './fault-proxy.mjs';

async function dial(proxy, request) {
  const socket = net.connect(Number(new URL(proxy.url).port), '127.0.0.1');
  socket.on('error', () => socket.destroy());
  await once(socket, 'connect');
  const data = once(socket, 'data');
  socket.write(request);
  return { socket, response: (await data)[0].toString() };
}
const connect = 'CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n';

test('fault closes live tunnels, cancels delayed bytes, rejects subsequent CONNECT', async () => {
  const peers = new Set();
  const upstream = net.createServer(socket => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.on('data', () => socket.write('must-not-arrive'));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = await startFaultProxy({ delayMs: 150,
    connector: () => net.connect(upstream.address().port, '127.0.0.1') });
  try {
    const {socket, response} = await dial(proxy, connect);
    assert.match(response, /200 Connection Established/);
    let received = '';
    socket.on('data', data => { received += data.toString(); });
    socket.write('opaque TLS bytes');
    await sleep(40);
    const closed = once(socket, 'close');
    proxy.fault();
    await closed;
    await sleep(180);
    assert.equal(received, '');
    assert.deepEqual(proxy.stats(), { accepted: 1, rejected: 0, active: 0, faulted: true,
      firstFaultTime: proxy.stats().firstFaultTime, firstFaultReason: 'injected' });
    assert.equal(typeof proxy.stats().firstFaultTime, 'number');
    const future = await dial(proxy, connect);
    assert.match(future.response, /503/);
    future.socket.destroy();
    assert.equal(proxy.stats().rejected, 1);
  } finally {
    await proxy.close();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('strict CONNECT target/header policy prevents connector invocation', async () => {
  let calls = 0;
  const proxy = await startFaultProxy({ connector: () => { calls++; throw Error('unexpected'); } });
  try {
    for (const request of [
      'CONNECT evil.example:443 HTTP/1.1\r\n\r\n',
      'CONNECT api.github.com:80 HTTP/1.1\r\n\r\n',
      'GET http://api.github.com/ HTTP/1.1\r\n\r\n',
      'CONNECT api.github.com:443 HTTP/1.1\r\nbad header\r\n\r\n',
      'CONNECT api.github.com:443 HTTP/1.1\r\nX: ' + 'a'.repeat(8192) + '\r\n\r\n',
    ]) {
      const {socket, response} = await dial(proxy, request);
      assert.match(response, /403|431/);
      socket.destroy();
    }
    assert.equal(calls, 0);
  } finally { await proxy.close(); }
  assert.equal(proxy.stats().active, 0);
});

test('connector errors return failure and close is idempotent', async () => {
  const proxy = await startFaultProxy({ connector: () => { throw Error('test'); } });
  const { socket, response } = await dial(proxy, connect);
  assert.match(response, /502/);
  socket.destroy();
  await proxy.close();
  await proxy.close();
  assert.equal(proxy.stats().active, 0);
});

test('normal upstream EOF drains delayed payload and request EOF reaches upstream', async () => {
  let request = '';
  let requestEnded = false;
  const upstream = net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('error', () => socket.destroy());
    socket.on('data', data => { request += data.toString(); });
    socket.on('end', () => {
      requestEnded = true;
      socket.end('payload');
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = await startFaultProxy({ delayMs: 70,
    connector: () => net.connect({ port: upstream.address().port, host: '127.0.0.1', allowHalfOpen: true }) });
  try {
    const { socket, response } = await dial(proxy, connect);
    assert.match(response, /200 Connection Established/);
    let received = '';
    socket.on('data', data => { received += data.toString(); });
    const ended = once(socket, 'end');
    socket.end('request bytes');
    await ended;
    assert.equal(request, 'request bytes');
    assert.equal(requestEnded, true);
    assert.equal(received, 'payload');
    assert.equal(proxy.stats().faulted, false);
    socket.destroy();
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});


test('first actual fault timestamp and reason survive repeated fault and shutdown', async () => {
  const proxy = await startFaultProxy();
  assert.equal(proxy.stats().firstFaultTime, null);
  assert.equal(proxy.stats().firstFaultReason, null);
  const before = Date.now();
  proxy.fault();
  const first = proxy.stats();
  assert.ok(first.firstFaultTime >= before && first.firstFaultTime <= Date.now());
  assert.equal(first.firstFaultReason, 'injected');
  await sleep(5);
  proxy.fault('later');
  await proxy.close();
  assert.equal(proxy.stats().firstFaultTime, first.firstFaultTime);
  assert.equal(proxy.stats().firstFaultReason, first.firstFaultReason);
});

test('automatic byte-budget fault records actual cause before any injected fault', async () => {
  const peers = new Set();
  const upstream = net.createServer(socket => {
    peers.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => peers.delete(socket));
    socket.on('data', () => {});
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = await startFaultProxy({ delayMs: 0,
    connector: () => net.connect(upstream.address().port, '127.0.0.1') });
  try {
    const { socket } = await dial(proxy, connect);
    const closed = new Promise(resolve => socket.once('close', resolve));
    const block = Buffer.alloc(64 * 1024);
    const before = Date.now();
    for (let i = 0; i < 2049 && !socket.destroyed; i++) {
      if (!socket.write(block)) {
        await new Promise(resolve => {
          const done = () => {
            socket.removeListener('drain', done);
            socket.removeListener('close', done);
            resolve();
          };
          socket.once('drain', done);
          socket.once('close', done);
        });
      }
    }
    await closed;
    const first = proxy.stats();
    assert.equal(first.faulted, true);
    assert.equal(first.firstFaultReason, 'byte-budget');
    assert.ok(first.firstFaultTime >= before && first.firstFaultTime <= Date.now());
    proxy.fault();
    await proxy.close();
    assert.equal(proxy.stats().firstFaultTime, first.firstFaultTime);
    assert.equal(proxy.stats().firstFaultReason, 'byte-budget');
  } finally {
    await proxy.close();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => upstream.close(resolve));
  }
});
