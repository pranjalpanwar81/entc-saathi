// Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, eng, runTool, TOOL_DEFS } = require('../tools');

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('evaluator: arithmetic, precedence, power, unary minus', () => {
  close(evaluate('2+3*4'), 14);
  close(evaluate('(2+3)*4'), 20);
  close(evaluate('2^3^2'), 512);
  close(evaluate('-2^2'), -4);
  close(evaluate('10/4'), 2.5);
  close(evaluate('2**10'), 1024);
});
test('evaluator: suffixes, constants, functions', () => {
  close(evaluate('10k'), 10000);
  close(evaluate('0.1u'), 1e-7);
  close(evaluate('4.7n'), 4.7e-9);
  close(evaluate('2.2M'), 2.2e6);
  close(evaluate('1e-3'), 0.001);
  close(evaluate('1/(2*pi*10k*0.1u)'), 159.15494309189535);
  close(evaluate('20*log10(100)'), 40);
  close(evaluate('sqrt(16) + ln(e)'), 5);
  close(evaluate('sin(rad(30))'), 0.5);
  close(evaluate('2π'.replace('π', '*π')), 2 * Math.PI);
});
test('evaluator: rejects unsafe or bad input', () => {
  for (const bad of ['process.exit()', 'require("fs")', '1/0', '2+', '', 'foo(2)', '3 $ 4', 'x']) {
    assert.throws(() => evaluate(bad), undefined, bad);
  }
});
test('eng formatting', () => {
  assert.strictEqual(eng(159.15494, 'Hz'), '159.2 Hz');
  assert.strictEqual(eng(15915.494, 'Hz'), '15.92 kHz');
  assert.strictEqual(eng(0.001, 's'), '1 ms');
  assert.strictEqual(eng(4.7e-6, 'F'), '4.7 µF');
  assert.strictEqual(eng(-10), '-10');
});
test('rc_filter', () => {
  const r = runTool('rc_filter', JSON.stringify({ R: '10k', C: '0.1u' }));
  close(r.fc_Hz, 159.15494309189535); close(r.tau_s, 1e-3);
  assert.match(r.formatted, /159.2 Hz/);
});
test('rlc_resonance with Q', () => {
  const r = runTool('rlc_resonance', { L: '10m', C: '1u', R: '10' });
  close(r.f0_Hz, 1591.5494309189535); close(r.Q, 10); close(r.bandwidth_Hz, 159.15494309189535);
});
test('opamp gain', () => {
  const inv = runTool('opamp_gain', { config: 'inverting', Rf: '100k', Rin: '10k', Vin: '0.5' });
  close(inv.gain, -10); close(inv.Vout_V, -5); close(inv.gain_dB, 20);
  close(runTool('opamp_gain', { config: 'non_inverting', Rf: '9k', Rin: '1k' }).gain, 10);
});
test('divider, parallel, 555, dB', () => {
  close(runTool('voltage_divider', { Vin: 12, R1: '10k', R2: '5k' }).Vout_V, 4);
  close(runTool('parallel_resistance', { resistors: ['10k', '10k'] }).parallel_ohm, 5000);
  const t = runTool('timer_555_astable', { R1: '1k', R2: '10k', C: '10u' });
  close(t.f_Hz, 1 / (0.693 * 21000 * 10e-6)); close(t.duty_percent, 11 / 21 * 100);
  close(runTool('db_convert', { value: 100, kind: 'power', direction: 'to_db' }).dB, 20);
  close(runTool('db_convert', { value: 6, kind: 'voltage', direction: 'from_db' }).ratio, 1.9952623149688795);
});
test('tool errors are returned, not thrown', () => {
  assert.ok(runTool('rc_filter', { R: '-5', C: '1u' }).error);
  assert.ok(runTool('nope', {}).error);
  assert.ok(runTool('calculate', '{bad json').error);
  assert.ok(runTool('calculate', { expression: 'process.exit(1)' }).error);
});
test('tool definitions are valid OpenAI function specs', () => {
  for (const d of TOOL_DEFS) {
    assert.strictEqual(d.type, 'function');
    assert.match(d.function.name, /^[a-z0-9_]+$/);
    assert.strictEqual(d.function.parameters.type, 'object');
  }
});
