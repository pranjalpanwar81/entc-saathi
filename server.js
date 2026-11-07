// ENTC Saathi — an AI exam tutor for Electronics & Telecommunication students.
// Zero dependencies: needs only Node.js 18+ (uses built-in fetch and http).
// Run:  BHARATCODE_API_KEY=bc_live_xxx node server.js   (or put the key in a .env file)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { TOOL_DEFS, runTool } = require('./tools');

// ---------- config ----------
loadDotEnv(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.BHARATCODE_API_KEY || '';
const BASE_URL = (process.env.BHARATCODE_BASE_URL || 'https://bharatcode.ai/api/model/v1').replace(/\/$/, '');
const MODEL = process.env.BHARATCODE_MODEL || 'qwen-3.8-27b';
const DEMO = process.env.DEMO_MODE === '1';
// Optional: 'none' | 'low' | 'medium' | 'high'. Lower = faster answers. Unset = model default.
const REASONING_EFFORT = process.env.BHARATCODE_REASONING_EFFORT || '';
const FIRST_BYTE_TIMEOUT_MS = 90_000;  // give up if BharatCode doesn't respond at all
const IDLE_TIMEOUT_MS = 120_000;       // give up if the stream goes silent
const MAX_IMAGE_CHARS = 4_000_000; // ~3 MB image as a data URL

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- tutoring prompts ----------
const SUBJECTS = [
  'Network Theory', 'Analog Circuits', 'Digital Electronics', 'Signals & Systems',
  'Control Systems', 'Microcontrollers (8051 / ARM)', 'Analog & Digital Communication',
  'Electromagnetics & Antennas', 'Digital Signal Processing', 'VLSI Design',
  'Embedded Systems', 'Power Electronics', 'Computer Networks',
];
const UNIVERSITIES = ['SPPU (Pune)', 'Mumbai University', 'VTU', 'AKTU', 'GTU', 'Anna University', 'RGPV', 'MAKAUT', 'JNTU', 'Other / Autonomous'];
const LANGUAGES = { en: 'English', hinglish: 'Hinglish' };

const BASE_PROMPT = `You are ENTC Saathi, a patient and precise tutor for Electronics & Telecommunication (ENTC / ECE) engineering students at Indian universities.
Rules:
- Be technically correct. Use standard textbook notation and SI units. If a value is assumed, say so.
- Show numerical working step by step: formula first, then substitution, then the result with units.
- Write maths in plain text that reads well without LaTeX (e.g. Vout = -(Rf/Rin) * Vin, f = 1/(2*pi*R*C)).
- Use short sections, bullet points and **bold** key terms. Keep answers exam-focused.
- If the student sends a photo (handwritten working, a circuit diagram, a question paper), first say briefly what you can read in it, then help. If part of it is unreadable, say which part instead of guessing.
- If the question is outside electronics/telecom, answer briefly and steer back to the subject.
- Never invent datasheet values; say "check the datasheet" when unsure.
Calculator tools:
- You have exact calculator tools (calculate, rc_filter, rlc_resonance, opamp_gain, voltage_divider, parallel_resistance, timer_555_astable, db_convert).
- NEVER do arithmetic in your head. Use a tool for every numeric result, including checking a student's numbers.
- Pass values with SI suffixes where natural ("10k", "0.1u"). Prefer the specific formula tool when it fits, otherwise use calculate.
- In your answer, still show the formula and the substitution, then state the tool's result with units.`;

const MODES = {
  explain: `Mode: EXPLAIN. Teach the topic the student asks about:
1. One-line intuition (an everyday analogy helps).
2. Core concept and key formulas.
3. One solved, exam-style numerical.
4. "Common mistakes": 2-3 bullets.
5. "Likely exam questions": 2-3 short questions.
End by asking if they want a quiz on it.`,
  quiz: `Mode: QUIZ. Give the student ONE exam-style question at a time (alternate between a numerical and a short theory question), state the marks (e.g. [4 marks]), and stop. Do NOT give the answer.
When the student replies with an answer (typed or as a photo), mark it out of the stated marks, show the correct full solution, point out exactly where they went wrong, then ask the next question: harder if they did well, similar difficulty if not.`,
  check: `Mode: CHECK MY ANSWER. The student will send a question and their working, as text or as a photo of their answer sheet. Grade it like a university examiner:
- Start with "**Score: X / Y**" (assume 5 marks if not given).
- Go line by line: mark each step ✅ correct or ❌ incorrect and explain why.
- Give the corrected solution.
- Finish with one tip to avoid the mistake next time.`,
  viva: `Mode: VIVA PRACTICE. Act as an external examiner taking an oral viva on the topic or lab experiment the student names.
Ask ONE short conceptual question at a time and wait. After each answer, give brief feedback (correct / partly / wrong, plus the right answer in 1-2 lines), then ask a follow-up that probes deeper.
After 6 questions, give a score out of 10 with strengths and topics to revise.`,
};

function systemPrompt({ mode, subject, topic, university, language }) {
  const parts = [BASE_PROMPT, MODES[mode] || MODES.explain];
  if (subject) parts.push(`Subject: ${subject}.`);
  if (topic) parts.push(`Current topic: ${topic}.`);
  if (university) parts.push(`The student studies under ${university}. Match that university's exam pattern, marking style and typical question wording where you know it; do not invent specific syllabus codes.`);
  if (language === 'hinglish') parts.push('Reply in natural Hinglish (Hindi written in Roman script, mixed with English) the way Indian students talk, but keep all technical terms, formulas and units in English.');
  return parts.join('\n\n');
}

// Turn the browser's message list into OpenAI-style messages.
// Only the most recent image is sent, to keep requests small; older ones become a short note.
function buildMessages(input) {
  const raw = (Array.isArray(input.messages) ? input.messages : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20);
  let lastImageIdx = -1;
  raw.forEach((m, i) => { if (m.role === 'user' && isImage(m.image)) lastImageIdx = i; });
  return raw.map((m, i) => {
    const text = m.content.slice(0, 8000);
    if (m.role === 'user' && isImage(m.image)) {
      if (i === lastImageIdx) {
        return { role: 'user', content: [
          { type: 'text', text: text || 'Please look at this image.' },
          { type: 'image_url', image_url: { url: m.image } },
        ] };
      }
      return { role: 'user', content: `${text}\n[The student attached a photo here earlier.]` };
    }
    return { role: m.role, content: text };
  });
}
function isImage(s) {
  return typeof s === 'string' && s.length < MAX_IMAGE_CHARS && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
}

// ---------- BharatCode API call (streaming + calculator tools) ----------
// emit(event) is called with { type: 'text', text } as text arrives and
// { type: 'tool', name, args, result } whenever a calculator tool runs.
// The model may call tools over several rounds; the final round must answer in text.
const MAX_TOOL_ROUNDS = 5;

async function runConversation(messages, emit) {
  if (DEMO) {
    const r = runTool('rc_filter', { R: '10k', C: '0.1u' });
    emit({ type: 'tool', name: 'rc_filter', args: { R: '10k', C: '0.1u' }, result: r });
    for (const w of `**Demo mode** is on (DEMO_MODE=1), so no model was called. Example calculation: ${r.formatted}. Set \`BHARATCODE_API_KEY\` to get real answers.`.split(' ')) {
      emit({ type: 'text', text: w + ' ' }); await sleep(20);
    }
    return { truncated: false };
  }
  if (!API_KEY) throw httpError(500, 'Server has no BHARATCODE_API_KEY set. Add it to a .env file (see README).');

  const convo = [...messages];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const allowTools = round < MAX_TOOL_ROUNDS;
    const { text, toolCalls, finish } = await callModel(convo, allowTools, emit);
    if (!toolCalls.length || finish === 'length') return { truncated: finish === 'length' };

    // The model asked for calculations: run them and send the results back.
    convo.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let args; try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = call.function.arguments; }
      const result = runTool(call.function.name, call.function.arguments);
      emit({ type: 'tool', name: call.function.name, args, result });
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    if (text.trim()) emit({ type: 'text', text: '\n\n' }); // keep pre-tool text separate from the final answer
  }
  return { truncated: false };
}

// One streamed request. Text is emitted live; tool calls are collected and returned.
async function callModel(messages, allowTools, emit) {
  const payload = { model: MODEL, messages, max_tokens: 6000, temperature: 0.3, stream: true };
  if (allowTools) Object.assign(payload, { tools: TOOL_DEFS, tool_choice: 'auto' });
  if (REASONING_EFFORT) payload.reasoning_effort = REASONING_EFFORT;
  const body = JSON.stringify(payload);

  const started = Date.now();
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new Error('first-byte timeout')), FIRST_BYTE_TIMEOUT_MS);
  const resetIdle = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('idle timeout')), IDLE_TIMEOUT_MS); };

  let res;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (res.status === 503 && attempt < 2) { await sleep(3000 * (attempt + 1)); continue; } // model busy
      break;
    }
  } catch (e) {
    clearTimeout(timer);
    throw httpError(504, 'BharatCode did not respond in time. The model may be busy; please try again.');
  }
  resetIdle();
  console.log(`[api] ${res.status} ${res.headers.get('content-type')} in ${Date.now() - started} ms, tools=${allowTools}, x-request-id=${res.headers.get('x-request-id')}`);
  if (!res.ok) {
    const raw = await res.text();
    let msg; try { msg = JSON.parse(raw)?.error?.message; } catch { /* not json */ }
    msg = msg || raw.slice(0, 300) || res.statusText;
    const err = httpError(502, res.status === 401 || res.status === 403
      ? `BharatCode rejected the API key (${res.status}). API access needs Lite, Pro or verified student access. Details: ${msg}`
      : res.status === 503 ? 'The BharatCode model is busy right now. Please try again in a few seconds.'
      : `BharatCode API error ${res.status}: ${msg}`);
    err.requestId = res.headers.get('x-request-id');
    clearTimeout(timer);
    throw err;
  }

  // Some servers ignore stream:true and send plain JSON; handle both.
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const data = await res.json();
    clearTimeout(timer);
    const choice = data?.choices?.[0] || {};
    const text = choice.message?.content || '';
    if (text) emit({ type: 'text', text });
    return { text, toolCalls: normaliseCalls(choice.message?.tool_calls || []), finish: choice.finish_reason };
  }

  let text = '';
  let finish = null;
  const calls = []; // assembled from streamed fragments, keyed by index
  let buffer = '';
  const decoder = new TextDecoder();
  let reasoningChars = 0, lastThinking = 0, firstContentMs = null, chunkCount = 0, unhandled = 0;
  try {
  outer: for await (const chunk of res.body) {
    resetIdle();
    const piece = decoder.decode(chunk, { stream: true });
    chunkCount++;
    buffer += piece;
    if (piece.includes(': bharatcode queued')) emit({ type: 'queued', seconds: Math.round((Date.now() - started) / 1000) });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break outer;
      let evt; try { evt = JSON.parse(data); } catch { continue; }
      if (evt.error) throw httpError(502, `BharatCode stream error: ${evt.error.message || 'unknown'}`);
      const choice = evt.choices?.[0];
      if (!choice) { if (++unhandled <= 3) console.log(`[api] event without choices: ${data.slice(0, 300)}`); continue; }
      const delta = choice.delta || {};
      const reasoning = delta.reasoning_content || delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        reasoningChars += reasoning.length;
        if (Date.now() - lastThinking > 1000) { lastThinking = Date.now(); emit({ type: 'thinking' }); }
      }
      if (delta.content) {
        if (firstContentMs === null) firstContentMs = Date.now() - started;
        text += delta.content; emit({ type: 'text', text: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] = calls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  } catch (e) {
    if (controller.signal.aborted) throw httpError(504, 'The BharatCode stream stopped responding. Please try again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  console.log(`[api] done in ${Date.now() - started} ms: chunks=${chunkCount}, unhandled=${unhandled}, reasoning=${reasoningChars} chars, content=${text.length} chars (first at ${firstContentMs} ms), toolCalls=${calls.filter(Boolean).length}, finish=${finish}`);
  return { text, toolCalls: normaliseCalls(calls.filter(Boolean)), finish };
}

function normaliseCalls(calls) {
  return calls
    .filter((c) => c?.function?.name)
    .slice(0, 8)
    .map((c, i) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) },
    }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    if (req.method === 'GET' && url === '/api/config') {
      return json(res, 200, { subjects: SUBJECTS, universities: UNIVERSITIES, languages: LANGUAGES, modes: Object.keys(MODES), model: MODEL, ready: DEMO || Boolean(API_KEY) });
    }
    if (req.method === 'GET' && url === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'POST' && url === '/api/chat') {
      let input;
      try { input = JSON.parse(await readBody(req, 6_000_000)); }
      catch (e) { return json(res, e.status || 400, { error: e.status ? e.message : 'Invalid request body' }); }

      const opts = {
        mode: MODES[input.mode] ? input.mode : 'explain',
        subject: SUBJECTS.includes(input.subject) ? input.subject : '',
        university: UNIVERSITIES.includes(input.university) ? input.university : '',
        language: LANGUAGES[input.language] ? input.language : 'en',
        topic: String(input.topic || '').slice(0, 200),
      };
      const history = buildMessages(input);
      if (!history.length || history[history.length - 1].role !== 'user') return json(res, 400, { error: 'Send a message first.' });
      const messages = [{ role: 'system', content: systemPrompt(opts) }, ...history];

      // Stream newline-delimited JSON events to the browser:
      // {type:'text'|'tool'|'truncated'|'error'|'done', ...}
      let started = false;
      const send = (evt) => {
        if (!started) {
          started = true;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        }
        res.write(JSON.stringify(evt) + '\n');
      };
      send({ type: 'start' });
      try {
        const { truncated } = await runConversation(messages, send);
        if (truncated) send({ type: 'truncated' });
        send({ type: 'done' });
        return res.end();
      } catch (err) {
        if (!started) throw err;
        console.error(err.message, err.requestId ? `(x-request-id: ${err.requestId})` : '');
        send({ type: 'error', message: err.message });
        return res.end();
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err.message, err.requestId ? `(x-request-id: ${err.requestId})` : '');
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Something went wrong' });
    else res.end();
  }
});

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'Message or image is too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
    req.on('error', reject);
  });
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`ENTC Saathi running at http://localhost:${PORT}  (model: ${MODEL}${DEMO ? ', DEMO MODE' : ''})`);
    if (!API_KEY && !DEMO) console.warn('Warning: BHARATCODE_API_KEY is not set, so chat requests will fail until you add it.');
  });
}
module.exports = { server, systemPrompt, buildMessages, runConversation, SUBJECTS, MODES };
