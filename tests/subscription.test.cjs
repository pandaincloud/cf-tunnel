const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { loadWorker } = require('./worker-harness.cjs');

test('an unavailable address API fails instead of silently generating two nodes', async () => {
  const worker = loadWorker(() => {}, { fetch: async () => new Response('Not found', { status: 404 }) });
  await assert.rejects(worker.getAddresses(['https://source.example/ipv4.txt']), /No valid addresses/);
});

test('a successful HTTP response containing an error page is not treated as proxy nodes', async () => {
  const worker = loadWorker(() => {}, { fetch: async () => new Response('<html><body>Service unavailable</body></html>') });
  await assert.rejects(worker.getAddresses(['https://source.example/ipv4.txt']), /No valid addresses/);
});

test('healthy sources survive a partial outage and blanks and duplicates are removed', async () => {
  const worker = loadWorker(() => {}, {
    fetch: async url => url.includes('down') ? new Response('', { status: 503 })
      : new Response('\n104.17.68.85:443#HK\n104.17.68.85:443#HK\n\n'),
  });
  const result = await worker.getAddresses(['https://down.example/list', 'https://up.example/list']);
  assert.deepEqual([...result], ['104.17.68.85:443#HK']);
  assert.deepEqual([...await worker.getAddresses([])], []);
});

test('subscription updates do not retain another request\'s address pool', () => {
  const worker = loadWorker(() => {});
  vm.runInContext("addresses = ['104.17.68.85:443#base'];", worker.context);
  const uuid = '11111111-1111-4111-8111-111111111111';
  const first = atob(worker.subscription('worker.example', uuid, 'false', ['104.17.71.31:443#first'], [], [], []));
  const second = atob(worker.subscription('worker.example', uuid, 'false', ['162.159.129.11:2053#second'], [], [], []));
  assert.match(first, /104\.17\.71\.31/);
  assert.doesNotMatch(second, /104\.17\.71\.31/);
  assert.match(second, /162\.159\.129\.11/);
  assert.equal(second.trim().split('\n').length, 2);
});

test('the HTTP endpoint returns 503 when all address sources are unavailable', async () => {
  const worker = loadWorker(() => {}, { fetch: async () => new Response('Not found', { status: 404 }) });
  const uuid = '11111111-1111-4111-8111-111111111111';
  const response = await worker.worker.fetch(new Request(`https://worker.example/${uuid}`, {
    headers: { Host: 'worker.example', 'User-Agent': 'v2rayN' },
  }), { UUID: uuid }, {});
  assert.equal(response.status, 503);
});

test('with only UUID configured the raw subscription contains all maintained nodes', async () => {
  const calls = [];
  const worker = loadWorker(() => {}, {
    fetch: async url => {
      calls.push(url);
      return new Response('104.17.68.85:443#HK 5\n');
    },
  });
  const uuid = '11111111-1111-4111-8111-111111111111';
  const response = await worker.worker.fetch(new Request(`https://worker.example/${uuid}`, {
    headers: { Host: 'worker.example', 'User-Agent': 'v2rayN' },
  }), { UUID: uuid }, {});
  assert.equal(response.status, 200);
  assert.ok(calls.some(url => url.includes('pandaincloud/cf-tunnel/main/ipv4.txt')));
  const nodes = atob(await response.text()).trim().split('\n');
  assert.equal(nodes.length, 9);
  assert.ok(nodes.every(node => node.startsWith(`vless://${uuid}@`)));
});

test('Pages subscriptions still work when the optional legacy proxy-host list is gone', async () => {
  const worker = loadWorker(() => {}, {
    fetch: async url => url.endsWith('proxyhosts.txt')
      ? new Response('Not found', { status: 404 })
      : new Response('104.17.68.85:443#HK 5\n'),
  });
  const uuid = '11111111-1111-4111-8111-111111111111';
  const response = await worker.worker.fetch(new Request(`https://preview.project.pages.dev/${uuid}`, {
    headers: { Host: 'preview.project.pages.dev', 'User-Agent': 'v2rayN' },
  }), { UUID: uuid }, {});
  assert.equal(response.status, 200);
  assert.equal(atob(await response.text()).trim().split('\n').length, 9);
});

test('a deployment without UUID fails closed', async () => {
  const worker = loadWorker(() => {});
  const response = await worker.worker.fetch(new Request('https://worker.example/'), {}, {});
  assert.equal(response.status, 503);
  assert.match(await response.text(), /UUID environment variable/);
});

test('a deployment with an invalid UUID fails closed', async () => {
  const worker = loadWorker(() => {});
  const response = await worker.worker.fetch(new Request('https://worker.example/'), { UUID: 'invalid' }, {});
  assert.equal(response.status, 503);
});
