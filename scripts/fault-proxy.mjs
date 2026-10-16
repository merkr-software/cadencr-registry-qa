import net from 'node:net';

const HOSTS = new Set(['api.github.com', 'uploads.github.com', 'github.com',
  'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_PENDING = 1024 * 1024;

// connector is an explicit test seam; production callers use net.connect unchanged.
export async function startFaultProxy({ delayMs = 750, connector = net.connect } = {}) {
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 120_000) {
    throw new Error('delayMs must be between 0 and 120000');
  }
  let faulted = false;
  let firstFaultTime = null;
  let firstFaultReason = null;
  let closed = false;
  let accepted = 0;
  let rejected = 0;
  let bytes = 0;
  const tunnels = new Set();
  const sockets = new Set();
  const fail = (socket, status = '403 Forbidden') => {
    rejected++;
    socket.setTimeout(1000, () => socket.destroy());
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const server = net.createServer({ allowHalfOpen: true }, (incoming) => {
    sockets.add(incoming);
    incoming.on('error', () => incoming.destroy());
    incoming.on('close', () => sockets.delete(incoming));
    if (faulted || closed || sockets.size > 32) return fail(incoming, '503 Service Unavailable');
    const tunnel = { incoming, outgoing: null, timers: new Set(), pending: 0, dead: false };
    tunnels.add(tunnel);
    const stop = () => {
      if (tunnel.dead) return;
      tunnel.dead = true;
      for (const timer of tunnel.timers) clearTimeout(timer);
      tunnel.timers.clear();
      tunnel.pending = 0;
      incoming.destroy();
      tunnel.outgoing?.destroy();
      tunnels.delete(tunnel);
    };
    tunnel.stop = stop;
    incoming.on('close', stop);
    incoming.setTimeout(120_000, stop);
    const lifetime = setTimeout(stop, 15 * 60_000);
    lifetime.unref();
    tunnel.timers.add(lifetime);
    let header = Buffer.alloc(0);
    let requestEnded = false;
    let responseEnded = false;
    const finishResponse = () => {
      if (responseEnded && tunnel.pending === 0 && !tunnel.dead && !faulted) incoming.end();
    };
    incoming.on('end', () => {
      requestEnded = true;
      // end() queues FIN after previously written request bytes.
      if (tunnel.outgoing && !tunnel.outgoing.connecting) tunnel.outgoing.end();
      else if (!tunnel.outgoing && header.length === 0) stop();
    });
    const count = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { fault('byte-budget'); return false; }
      return !tunnel.dead && !faulted;
    };
    const onHeader = (chunk) => {
      if (header.length + chunk.length > MAX_PENDING) { fail(incoming, '431 Request Header Fields Too Large'); return; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if ((end < 0 && header.length > 8192) || end + 4 > 8192) {
        incoming.removeListener('data', onHeader);
        fail(incoming, '431 Request Header Fields Too Large');
        return;
      }
      if (end < 0) return;
      incoming.removeListener('data', onHeader);
      const lines = header.subarray(0, end).toString('ascii').split('\r\n');
      const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(lines[0]);
      if (!match || !HOSTS.has(match[1]) || lines.slice(1).some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e]*$/.test(line))) {
        fail(incoming); return;
      }
      incoming.pause();
      let outgoing;
      try { outgoing = connector({ host: match[1], port: 443, allowHalfOpen: true }); }
      catch { fail(incoming, '502 Bad Gateway'); return; }
      tunnel.outgoing = outgoing;
      outgoing.on('error', stop);
      outgoing.on('end', () => { responseEnded = true; finishResponse(); });
      outgoing.on('close', () => {
        if (!responseEnded) stop();
        else finishResponse();
      });
      outgoing.setTimeout(120_000, stop);
      outgoing.on('connect', () => {
        if (faulted || tunnel.dead) return stop();
        accepted++;
        incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        incoming.on('data', data => {
          if (!count(data)) return;
          if (outgoing.writableLength + data.length > MAX_PENDING) return stop();
          if (!outgoing.write(data)) incoming.pause();
        });
        outgoing.on('drain', () => { if (!tunnel.dead) incoming.resume(); });
        const rest = header.subarray(end + 4);
        header = Buffer.alloc(0);
        if (rest.length && count(rest) && !outgoing.write(rest)) incoming.pause();
        else incoming.resume();
        if (requestEnded) outgoing.end();
      });
      outgoing.on('data', data => {
        if (!count(data)) return;
        tunnel.pending += data.length;
        if (tunnel.pending + incoming.writableLength > MAX_PENDING) return stop();
        const timer = setTimeout(() => {
          tunnel.timers.delete(timer);
          tunnel.pending -= data.length;
          if (faulted || tunnel.dead) return;
          if (!incoming.write(data)) outgoing.pause();
          finishResponse();
        }, delayMs);
        tunnel.timers.add(timer);
      });
      incoming.on('drain', () => { if (!tunnel.dead) outgoing.resume(); });
    };
    incoming.on('data', onHeader);
  });
  function fault(reason = 'injected') {
    if (faulted) return;
    firstFaultTime = Date.now();
    firstFaultReason = reason;
    faulted = true;
    for (const tunnel of [...tunnels]) tunnel.stop();
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  // A runtime listener makes server errors explicit rather than unhandled or ignored.
  server.on('error', () => fault('server-error'));
  const proxyLifetime = setTimeout(() => fault('lifetime'), 15 * 60_000);
  proxyLifetime.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    fault,
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(proxyLifetime);
      fault('shutdown');
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
    stats: () => ({ accepted, rejected, active: tunnels.size, faulted, firstFaultTime, firstFaultReason }),
  };
}
