// Calculator tools the model can call, so every number in an answer is computed exactly
// instead of being "guessed" by the language model.
// Uses BharatCode's OpenAI-compatible function calling (tools / tool_calls).

// ---------- safe expression evaluator (no eval) ----------
// Supports + - * / ^, parentheses, unary minus, scientific notation,
// engineering suffixes (10k, 4.7u, 100n, 2.2M), constants (pi, e) and common functions.
const SUFFIX = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  deg: (r) => (r * 180) / Math.PI, rad: (d) => (d * Math.PI) / 180,
};
const CONSTS = { pi: Math.PI, e: Math.E };

function evaluate(expr) {
  if (typeof expr !== 'string' || !expr.trim()) throw new Error('Empty expression');
  if (expr.length > 500) throw new Error('Expression too long');
  const src = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/π/g, 'pi').replace(/\*\*/g, '^');
  const tokens = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)([pnuµmkKMG](?![a-zA-Z]))?|([a-zA-Z_][a-zA-Z0-9_]*)|(\S))/gy;
  let m;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined) tokens.push({ t: 'num', v: parseFloat(m[1]) * (m[2] ? SUFFIX[m[2]] : 1) });
    else if (m[3] !== undefined) tokens.push({ t: 'id', v: m[3] });
    else if (m[4] !== undefined) {
      if (!'+-*/^(),'.includes(m[4])) throw new Error(`Unexpected character "${m[4]}"`);
      tokens.push({ t: m[4] });
    }
  }
  let i = 0;
  const peek = () => tokens[i];
  const take = (t) => { if (peek()?.t !== t) throw new Error(`Expected "${t}"`); return tokens[i++]; };

  function expr0() { let v = term(); while (peek()?.t === '+' || peek()?.t === '-') { const op = tokens[i++].t; const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  function term() { let v = unary(); while (peek()?.t === '*' || peek()?.t === '/') { const op = tokens[i++].t; const r = unary(); v = op === '*' ? v * r : v / r; } return v; }
  function unary() { if (peek()?.t === '-') { i++; return -unary(); } if (peek()?.t === '+') { i++; return unary(); } return power(); }
  function power() { const b = atom(); if (peek()?.t === '^') { i++; return Math.pow(b, unary()); } return b; }
  function atom() {
    const tok = tokens[i++];
    if (!tok) throw new Error('Unexpected end of expression');
    if (tok.t === 'num') return tok.v;
    if (tok.t === '(') { const v = expr0(); take(')'); return v; }
    if (tok.t === 'id') {
      const name = tok.v.toLowerCase();
      if (peek()?.t === '(') {
        const fn = FUNCS[name];
        if (!fn) throw new Error(`Unknown function "${tok.v}"`);
        i++; const args = [expr0()];
        while (peek()?.t === ',') { i++; args.push(expr0()); }
        take(')');
        return fn(...args);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new Error(`Unknown name "${tok.v}"`);
    }
    throw new Error(`Unexpected "${tok.t}"`);
  }
  const v = expr0();
  if (i < tokens.length) throw new Error(`Unexpected "${tokens[i].v ?? tokens[i].t}"`);
  if (!Number.isFinite(v)) throw new Error('Result is not a finite number (check for division by zero)');
  return v;
}

// ---------- engineering formatting ----------
const PREFIXES = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
function eng(value, unit = '') {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return `0 ${unit}`.trim();
  const abs = Math.abs(value);
  if (unit) {
    for (const [f, p] of PREFIXES) if (abs >= f * 0.9995) return `${round(value / f)} ${p}${unit}`;
    return `${value.toExponential(3)} ${unit}`;
  }
  return abs >= 1e6 || abs < 1e-3 ? value.toExponential(4) : String(round(value));
}
const round = (x) => Number(x.toPrecision(4));

// Accept numbers or strings like "10k", "0.1u", "4.7e-6".
function num(v, name) {
  const n = typeof v === 'number' ? v : evaluate(String(v ?? ''));
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}
function positive(v, name) { const n = num(v, name); if (n <= 0) throw new Error(`${name} must be greater than 0`); return n; }

// ---------- the tools ----------
// Values are strings so the model can pass "10k" or "0.1u"; plain numbers are accepted too.
const valueParam = (desc) => ({ type: 'string', description: `${desc}. A number in SI base units, or with a suffix like "10k", "4.7u", "100n".` });

const TOOLS = {
  calculate: {
    description: 'Evaluate any arithmetic expression exactly. Use for EVERY numeric step. Supports + - * / ^, parentheses, pi, e, sqrt, ln, log10, exp, sin/cos/tan (radians), deg(), rad(), and suffixes p n u m k M G (e.g. "1/(2*pi*10k*0.1u)").',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'The expression to evaluate' } }, required: ['expression'] },
    run: ({ expression }) => { const v = evaluate(expression); return { result: v, formatted: eng(v) }; },
  },
  rc_filter: {
    description: 'First-order RC low-pass or high-pass filter: cutoff frequency fc = 1/(2*pi*R*C) and time constant tau = R*C.',
    parameters: { type: 'object', properties: { R: valueParam('Resistance in ohms'), C: valueParam('Capacitance in farads') }, required: ['R', 'C'] },
    run: ({ R, C }) => {
      R = positive(R, 'R'); C = positive(C, 'C');
      const tau = R * C, fc = 1 / (2 * Math.PI * tau);
      return { fc_Hz: fc, tau_s: tau, formatted: `fc = ${eng(fc, 'Hz')}, tau = ${eng(tau, 's')}` };
    },
  },
  rlc_resonance: {
    description: 'Series RLC circuit: resonant frequency f0 = 1/(2*pi*sqrt(L*C)), and if R is given, quality factor Q = (1/R)*sqrt(L/C) and bandwidth BW = f0/Q.',
    parameters: { type: 'object', properties: { L: valueParam('Inductance in henry'), C: valueParam('Capacitance in farads'), R: valueParam('Series resistance in ohms (optional)') }, required: ['L', 'C'] },
    run: ({ L, C, R }) => {
      L = positive(L, 'L'); C = positive(C, 'C');
      const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C));
      const out = { f0_Hz: f0, formatted: `f0 = ${eng(f0, 'Hz')}` };
      if (R !== undefined && R !== null && R !== '') {
        R = positive(R, 'R');
        const Q = Math.sqrt(L / C) / R, bw = f0 / Q;
        Object.assign(out, { Q, bandwidth_Hz: bw, formatted: `${out.formatted}, Q = ${eng(Q)}, BW = ${eng(bw, 'Hz')}` });
      }
      return out;
    },
  },
  opamp_gain: {
    description: 'Ideal op-amp closed-loop voltage gain. Inverting: Av = -Rf/Rin. Non-inverting: Av = 1 + Rf/Rin. Optionally computes Vout for a given Vin.',
    parameters: { type: 'object', properties: {
      config: { type: 'string', enum: ['inverting', 'non_inverting'] },
      Rf: valueParam('Feedback resistance in ohms'), Rin: valueParam('Input (or ground-leg) resistance in ohms'), Vin: valueParam('Input voltage in volts (optional)'),
    }, required: ['config', 'Rf', 'Rin'] },
    run: ({ config, Rf, Rin, Vin }) => {
      Rf = positive(Rf, 'Rf'); Rin = positive(Rin, 'Rin');
      const gain = config === 'non_inverting' ? 1 + Rf / Rin : -Rf / Rin;
      const dB = 20 * Math.log10(Math.abs(gain));
      const out = { gain, gain_dB: dB, formatted: `Av = ${eng(gain)} (${eng(dB)} dB)` };
      if (Vin !== undefined && Vin !== null && Vin !== '') {
        const vout = gain * num(Vin, 'Vin');
        Object.assign(out, { Vout_V: vout, formatted: `${out.formatted}, Vout = ${eng(vout, 'V')} (ideal, ignoring saturation)` });
      }
      return out;
    },
  },
  voltage_divider: {
    description: 'Unloaded voltage divider: Vout = Vin * R2 / (R1 + R2), where R2 is the resistor across which Vout is taken.',
    parameters: { type: 'object', properties: { Vin: valueParam('Input voltage in volts'), R1: valueParam('Top resistor in ohms'), R2: valueParam('Bottom resistor in ohms') }, required: ['Vin', 'R1', 'R2'] },
    run: ({ Vin, R1, R2 }) => {
      Vin = num(Vin, 'Vin'); R1 = positive(R1, 'R1'); R2 = positive(R2, 'R2');
      const v = Vin * R2 / (R1 + R2), rth = (R1 * R2) / (R1 + R2);
      return { Vout_V: v, Rth_ohm: rth, formatted: `Vout = ${eng(v, 'V')}, Thevenin resistance = ${eng(rth, 'Ω')}` };
    },
  },
  parallel_resistance: {
    description: 'Equivalent resistance of resistors in parallel (1/Req = sum of 1/Ri) and in series (sum of Ri).',
    parameters: { type: 'object', properties: { resistors: { type: 'array', items: valueParam('Resistance in ohms'), minItems: 2 } }, required: ['resistors'] },
    run: ({ resistors }) => {
      if (!Array.isArray(resistors) || resistors.length < 2) throw new Error('Give at least two resistors');
      const r = resistors.slice(0, 50).map((x, i) => positive(x, `resistor ${i + 1}`));
      const par = 1 / r.reduce((s, x) => s + 1 / x, 0), ser = r.reduce((s, x) => s + x, 0);
      return { parallel_ohm: par, series_ohm: ser, formatted: `Parallel = ${eng(par, 'Ω')}, Series = ${eng(ser, 'Ω')}` };
    },
  },
  timer_555_astable: {
    description: '555 timer in astable mode: tHigh = 0.693*(R1+R2)*C, tLow = 0.693*R2*C, f = 1.44/((R1+2*R2)*C), duty cycle = (R1+R2)/(R1+2*R2).',
    parameters: { type: 'object', properties: { R1: valueParam('R1 (RA) in ohms'), R2: valueParam('R2 (RB) in ohms'), C: valueParam('Timing capacitor in farads') }, required: ['R1', 'R2', 'C'] },
    run: ({ R1, R2, C }) => {
      R1 = positive(R1, 'R1'); R2 = positive(R2, 'R2'); C = positive(C, 'C');
      const th = 0.693 * (R1 + R2) * C, tl = 0.693 * R2 * C, T = th + tl, f = 1 / T, duty = (th / T) * 100;
      return { f_Hz: f, tHigh_s: th, tLow_s: tl, duty_percent: duty, formatted: `f = ${eng(f, 'Hz')}, tHigh = ${eng(th, 's')}, tLow = ${eng(tl, 's')}, duty = ${round(duty)} %` };
    },
  },
  db_convert: {
    description: 'Convert between a ratio and decibels. Power ratio: dB = 10*log10(ratio). Voltage/current ratio: dB = 20*log10(ratio). Direction "to_db" or "from_db".',
    parameters: { type: 'object', properties: {
      value: valueParam('The ratio (for to_db) or the dB value (for from_db)'),
      kind: { type: 'string', enum: ['power', 'voltage'] },
      direction: { type: 'string', enum: ['to_db', 'from_db'] },
    }, required: ['value', 'kind', 'direction'] },
    run: ({ value, kind, direction }) => {
      const k = kind === 'power' ? 10 : 20;
      const v = num(value, 'value');
      if (direction === 'from_db') { const ratio = Math.pow(10, v / k); return { ratio, formatted: `${v} dB = ratio of ${eng(ratio)} (${kind})` }; }
      if (v <= 0) throw new Error('Ratio must be greater than 0');
      const dB = k * Math.log10(v);
      return { dB, formatted: `ratio ${eng(v)} = ${eng(dB)} dB (${kind})` };
    },
  },
};

// OpenAI-style tool definitions to send to the model.
const TOOL_DEFS = Object.entries(TOOLS).map(([name, t]) => ({ type: 'function', function: { name, description: t.description, parameters: t.parameters } }));

// Run a tool call safely. Always returns an object (errors are returned to the model so it can fix its call).
function runTool(name, argsJson) {
  const tool = TOOLS[name];
  if (!tool) return { error: `Unknown tool "${name}"` };
  let args;
  try { args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : (argsJson || {}); }
  catch { return { error: 'Arguments were not valid JSON' }; }
  try { return tool.run(args); }
  catch (e) { return { error: e.message }; }
}

module.exports = { evaluate, eng, TOOLS, TOOL_DEFS, runTool };
