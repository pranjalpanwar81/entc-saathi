const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AnswerCache, compactEvents } = require('../cache');

const opts = { mode: 'explain', subject: '', university: '', language: 'en', topic: '' };

test('only plain first questions are cacheable', () => {
  assert.ok(AnswerCache.key(opts, [{ role: 'user', content: 'Explain PLL' }]));
  assert.strictEqual(AnswerCache.key(opts, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]), null);
  assert.strictEqual(AnswerCache.key(opts, [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]), null, 'photo questions are never cached');
});

test('key ignores case and spacing but respects settings', () => {
  const a = AnswerCache.key(opts, [{ role: 'user', content: 'Explain  PLL ' }]);
  assert.strictEqual(a, AnswerCache.key(opts, [{ role: 'user', content: 'explain pll' }]));
  assert.notStrictEqual(a, AnswerCache.key({ ...opts, language: 'hinglish' }, [{ role: 'user', content: 'explain pll' }]));
});

test('stores, expires and refuses broken answers', () => {
  let now = 0;
  const c = new AnswerCache({ ttlMs: 1000, now: () => now });
  c.set('k', [{ type: 'text', text: 'short' }]);
  assert.strictEqual(c.get('k'), null, 'too-short answers are not cached');
  c.set('k', [{ type: 'text', text: 'A full and proper answer about phase-locked loops.' }]);
  assert.ok(c.get('k'));
  now = 2000;
  assert.strictEqual(c.get('k'), null, 'expired');
});

test('seed answers load from file and never expire', () => {
  const file = path.join(os.tmpdir(), `seed-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ k: [{ type: 'text', text: 'Seeded answer that is long enough.' }] }));
  let now = 0;
  const c = new AnswerCache({ seedFile: file, ttlMs: 1, now: () => now });
  now = 10 ** 9;
  assert.ok(c.get('k'));
  fs.unlinkSync(file);
});

test('compactEvents merges text and keeps calculator events', () => {
  const out = compactEvents([{ type: 'start' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'tool', name: 'calculate' }, { type: 'text', text: 'c' }, { type: 'done' }]);
  assert.deepStrictEqual(out.map((e) => e.type), ['text', 'tool', 'text']);
  assert.strictEqual(out[0].text, 'ab');
});
