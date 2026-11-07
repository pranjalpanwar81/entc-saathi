const test = require('node:test');
const assert = require('node:assert');
const { RateLimiter, clientKey } = require('../rateLimit');

test('per-user limit in a sliding window', () => {
  let now = 0;
  const rl = new RateLimiter({ perUser: 3, windowMs: 1000, maxConcurrent: 99, now: () => now });
  for (let i = 0; i < 3; i++) rl.take('a').release();
  const blocked = rl.take('a');
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.status, 429);
  assert.ok(rl.take('b').ok, 'other users are not affected');
  now = 1001;
  assert.ok(rl.take('a').ok, 'allowed again after the window');
});

test('concurrent requests per user', () => {
  const rl = new RateLimiter({ perUser: 99, maxConcurrent: 1 });
  const first = rl.take('a');
  assert.ok(first.ok);
  assert.strictEqual(rl.take('a').ok, false);
  first.release();
  first.release(); // double release is harmless
  assert.ok(rl.take('a').ok);
});

test('global hourly cap', () => {
  const rl = new RateLimiter({ perUser: 99, maxConcurrent: 99, globalPerHour: 2 });
  rl.take('a').release(); rl.take('b').release();
  const r = rl.take('c');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 503);
});

test('client key uses the first X-Forwarded-For address', () => {
  assert.strictEqual(clientKey({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: {} }), '1.2.3.4');
  assert.strictEqual(clientKey({ headers: {}, socket: { remoteAddress: '5.6.7.8' } }), '5.6.7.8');
});

test('server returns 429 with a friendly message after the limit', async () => {
  process.env.DEMO_MODE = '1';
  process.env.RATE_LIMIT_PER_USER = '2';
  delete require.cache[require.resolve('../server')];
  const { server } = require('../server');
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/api/chat`;
  const ask = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  for (let i = 0; i < 2; i++) { const r = await ask(); assert.strictEqual(r.status, 200); await r.text(); }
  const blocked = await ask();
  assert.strictEqual(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
  assert.match((await blocked.json()).error, /limit/);
  server.close();
});
