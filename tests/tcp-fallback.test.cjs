const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { loadWorker } = require('./worker-harness.cjs');

function webSocket() {
  return {
    readyState: 1, sent: [], closes: 0,
    send(data) {
      assert.equal(this.readyState, 1, 'fallback must send on an open WebSocket');
      this.sent.push(new Uint8Array(data));
    },
    close() { this.readyState = 3; this.closes++; },
  };
}

function socket({ readError, chunks = [], writeError, pending = false } = {}) {
  let controller;
  const writes = [];
  const readable = new ReadableStream({
    start(c) {
      controller = c;
      if (readError) c.error(readError);
      else {
        for (const chunk of chunks) c.enqueue(Uint8Array.from(chunk));
        if (!pending) c.close();
      }
    },
  });
  return {
    readable, writes,
    writable: new WritableStream({
      write(data) {
        if (writeError) throw writeError;
        writes.push([...new Uint8Array(data)]);
      },
    }),
    closed: new Promise(() => {}),
    close() { try { controller.close(); } catch {} },
  };
}

async function eventually(condition) {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(condition(), 'expected asynchronous forwarding to finish');
}

test('an initial read failure keeps the client open until fallback delivers its TLS bytes', async () => {
  const worker = loadWorker(() => {});
  const client = webSocket();
  let retries = 0;
  await worker.bridge(socket({ readError: new Error('destination prohibited') }), client,
    Uint8Array.of(0, 0), async () => {
      retries++;
      await worker.bridge(socket({ chunks: [[22, 3, 3, 1]] }), client, Uint8Array.of(0, 0), null, () => {});
    }, () => {});
  await eventually(() => client.sent.length > 0);
  assert.equal(retries, 1);
  assert.equal(client.closes, 1, 'close only after the fallback response is forwarded');
  assert.deepEqual([...client.sent[0]], [0, 0, 22, 3, 3, 1]);
});

test('a failed initial write uses the configured fallback and replays the ClientHello once', async () => {
  const direct = socket({ writeError: new Error('socket refused') });
  const fallback = socket({ chunks: [[22, 3, 3, 2]] });
  const addresses = [];
  const worker = loadWorker(({ hostname }) => {
    addresses.push(hostname);
    return addresses.length === 1 ? direct : fallback;
  });
  const client = webSocket();
  await worker.handle({ value: null }, 2, 'android.chat.openai.com', 443,
    Uint8Array.of(1, 2, 3), client, Uint8Array.of(0, 0), () => {},
    { proxyIP: 'fallback.example', socks5: null });
  await eventually(() => client.sent.length > 0);
  assert.deepEqual(addresses, ['android.chat.openai.com', 'fallback.example']);
  assert.deepEqual(fallback.writes, [[1, 2, 3]]);
  assert.equal(direct.writable.locked, false);
});

test('an active connection retains its own fallback after another request changes global settings', async () => {
  let rejectRead;
  const direct = socket({ pending: true });
  const failedReadable = new ReadableStream({ start(c) { rejectRead = () => c.error(new Error('reset')); } });
  direct.readable = failedReadable;
  const fallback = socket({ chunks: [[22, 3, 3, 3]] });
  const addresses = [];
  const worker = loadWorker(({ hostname }) => {
    addresses.push(hostname);
    return addresses.length === 1 ? direct : fallback;
  });
  const client = webSocket();
  await worker.handle({ value: null }, 2, 'android.chat.openai.com', 443,
    Uint8Array.of(1), client, Uint8Array.of(0, 0), () => {},
    { proxyIP: 'connection-a.example', socks5: null });
  vm.runInContext("proxyIP = 'connection-b.example'; enableSocks = false;", worker.context);
  rejectRead();
  await eventually(() => client.sent.length > 0);
  assert.equal(addresses[1], 'connection-a.example');
});

test('a failure after the server has responded closes the client without replaying TLS data', async () => {
  let remoteController;
  const upstream = socket();
  upstream.readable = new ReadableStream({ start(c) { remoteController = c; c.enqueue(Uint8Array.of(22, 3)); } });
  const client = webSocket();
  let retries = 0;
  const worker = loadWorker(() => {});
  const forwarding = worker.bridge(upstream, client, Uint8Array.of(0, 0), async () => { retries++; }, () => {});
  await eventually(() => client.sent.length === 1);
  remoteController.error(new Error('connection reset after ServerHello'));
  await forwarding;
  assert.equal(retries, 0);
  assert.equal(client.closes, 1);
});

test('a final fallback that closes without returning data closes the client', async () => {
  const worker = loadWorker(() => {});
  const client = webSocket();
  await worker.bridge(socket(), client, Uint8Array.of(0, 0), null, () => {});
  assert.equal(client.closes, 1);
});

test('WebSocket routing options are isolated between concurrent environment and URL overrides', async () => {
  const worker = loadWorker(() => {});
  assert.equal(typeof worker.options, 'function');
  const [a, b] = await Promise.all([
    worker.options(new Request('https://worker.example/?proxyip=connection-a.example'), { PROXYIP: 'default-a.example' }),
    worker.options(new Request('https://worker.example/proxyip=connection-b.example'), { PROXYIP: 'default-b.example' }),
  ]);
  assert.equal(a.proxyIP, 'connection-a.example');
  assert.equal(b.proxyIP, 'connection-b.example');
  assert.equal(a.socks5, null);
  assert.equal(b.socks5, null);
});

test('SOCKS5 routing settings do not leak into a later connection', async () => {
  const worker = loadWorker(() => {});
  const a = await worker.options(new Request('https://worker.example/?socks5=user%3Apassword%40socks.example%3A1080'), {});
  const b = await worker.options(new Request('https://worker.example/'), {});
  assert.equal(a.socks5.hostname, 'socks.example');
  assert.equal(a.socks5.port, 1080);
  assert.equal(b.socks5, null);
});

function fakeWebSocketPair() {
  let server;
  class Pair {
    constructor() {
      server = Object.assign(webSocket(), {
        events: new Map(),
        accept() {},
        addEventListener(type, callback) {
          this.events.set(type, callback);
        },
        receive(data) { this.events.get('message')({ data }); },
      });
      this[0] = {};
      this[1] = server;
    }
  }
  return { Pair, getServer: () => server };
}

function initialVlessFrame(payload) {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const bytes = Buffer.from(uuid.replaceAll('-', ''), 'hex');
  const host = Buffer.from('android.chat.openai.com');
  return Uint8Array.from([0, ...bytes, 0, 1, 1, 187, 2, host.length, ...host, ...payload]).buffer;
}

test('subsequent client frames wait for the initial write instead of taking its stream lock', async () => {
  let finishFirstWrite;
  const writes = [];
  const upstream = socket({ pending: true });
  upstream.writable = new WritableStream({
    write(data) {
      writes.push([...new Uint8Array(data)]);
      if (writes.length === 1) return new Promise(resolve => { finishFirstWrite = resolve; });
    },
  });
  const pair = fakeWebSocketPair();
  const worker = loadWorker(() => upstream, {
    WebSocketPair: pair.Pair,
    Response: class { constructor(body, init) { Object.assign(this, init); } },
  });
  const response = await worker.websocketHandler(new Request('https://worker.example/'), {
    userID: '11111111-1111-4111-8111-111111111111', proxyIP: 'fallback.example', socks5: null,
  });
  assert.equal(response.status, 101);
  pair.getServer().receive(initialVlessFrame([1]));
  pair.getServer().receive(Uint8Array.of(2).buffer);
  await eventually(() => writes.length === 1);
  finishFirstWrite();
  await eventually(() => writes.length === 2);
  assert.deepEqual(writes, [[1], [2]]);
  assert.equal(pair.getServer().closes, 0);
  upstream.close();
});

test('failed direct and fallback writes close the tunnel without an unhandled promise', async () => {
  const pair = fakeWebSocketPair();
  const worker = loadWorker(() => socket({ writeError: new Error('upstream unavailable') }), {
    WebSocketPair: pair.Pair,
    Response: class { constructor(body, init) { Object.assign(this, init); } },
  });
  await worker.websocketHandler(new Request('https://worker.example/'), {
    userID: '11111111-1111-4111-8111-111111111111', proxyIP: 'fallback.example', socks5: null,
  });
  pair.getServer().receive(initialVlessFrame([1]));
  await eventually(() => pair.getServer().closes === 1);
});
