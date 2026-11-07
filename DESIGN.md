# ENTC Saathi: design notes

This document explains how ENTC Saathi works and **why** it is built this way. Most decisions were driven by measurements on the live app running against the BharatCode API (qwen-3.8-27b). The numbers below come from the server logs (`[api] …` lines) recorded on 7 Nov 2026.

---

## 1. The problem

ENTC exams are mostly **handwritten numericals and vivas**. A tutor for them has to:

1. **Get numbers exactly right.** A wrong cutoff frequency is worse than no answer, and language models are unreliable at arithmetic.
2. **Read a student's handwritten working** and mark it the way an examiner does, with method marks and the final answer judged separately.
3. **Feel responsive** on a shared, queued API and on mobile data.
4. **Be safe to leave public** for judges and classmates without leaking the API key or burning the daily quota.

## 2. Architecture

```
Browser (index.html, no framework)
  │  POST /api/chat  {mode, subject, university, language, messages[, image]}
  ▼
Node server (server.js, zero dependencies)
  ├─ rate limiter (rateLimit.js)          per user, concurrency, global hourly cap
  ├─ prompt builder                       base rules + calculator rules + mode + context
  ├─ ONE streamed call ───────────────▶   BharatCode /chat/completions (stream, image input)
  ├─ InlineCalc (tools.js)                evaluates [[calc]] / [[check]] tags mid-stream
  └─ NDJSON event stream ◀─────────────   {start | queued | thinking | text | tool | done | error}
  ▼
Browser renders Markdown safely, shows the queue status, the "verified calculations" box and the answer
```

* **Zero dependencies.** Only Node's built-in `http` and `fetch`. Nothing to install, nothing to audit, and it deploys on any Node host.
* **The API key never reaches the browser.** All model calls go through the server, as BharatCode's docs recommend.

## 3. Key decisions

### 3.1 Exact numbers: from function calling to inline calculator tags

**Version 1: OpenAI-style function calling.** `tools.js` defines 8 ENTC tools (`rc_filter`, `opamp_gain`, `timer_555_astable`, …). It worked and was accurate, but every calculation needs a **second model call** to send the result back. On a shared, queued API each call waits in the queue, so the wait doubled:

| Version | Model calls | Measured time to answer | Notes |
|---|---|---|---|
| Function calling | 2 | **~204 s** (96 s + 107 s) | Photo-grading request at peak time; each round queued separately |
| Inline tags, default reasoning | 1 | **~81 s** | Model "thought" for ~10,000 characters before writing |
| Inline tags, `reasoning_effort: low` | 1 | **~40 s** server / **48 s** in the browser | Reasoning dropped to ~1,500 characters; same marking quality |

**Version 2: inline tags (current default).** The model never computes. It writes tags in its answer:

```
fc = 1/(2πRC) = [[calc: 1/(2*pi*4.7k*10n) | Hz]]               →  3.386 kHz
your fc = [[check: 33.9k | 1/(2*pi*4.7k*10n) | Hz]]             →  33.9 kHz ❌ (correct: 3.386 kHz)
```

`InlineCalc` is a small streaming transformer. It holds back text only while a tag is incomplete (tags can be split across network chunks), evaluates the tag, and streams the exact value. `[[check]]` compares the student's value with a **2 % tolerance** (for rounding in handwritten work), so the ✅/❌ verdict comes from code, not from the model.

* The evaluator is a **hand-written recursive-descent parser**, not `eval`. It supports engineering suffixes (`4.7k`, `10n`, `0.1u`), constants and common functions, and rejects anything else.
* Function calling is kept behind `TOOL_MODE=api` for APIs without queueing, where the extra round costs little.

### 3.2 Reasoning effort

With exact arithmetic delegated to the calculator, long hidden reasoning added latency without improving answers. `reasoning_effort: low` halved response time (81 s → 40 s) with the same grading results. If the API ever rejects the setting, the server drops it and retries once automatically.

### 3.3 Designing for a queued, shared API

BharatCode queues requests at busy times and sends `: bharatcode queued` heartbeats. The server:

* turns heartbeats into `queued` events, so the user sees *"BharatCode is busy, waiting in the queue (45 s)…"* instead of a frozen spinner;
* retries `503 busy` with back-off;
* aborts if no response arrives in 90 s, or if the stream goes silent for 120 s, and shows a clear error;
* logs time-to-first-byte, reasoning and content sizes and finish reason for every call. That is how the bottlenecks above were found.

At peak time (about 10 PM IST, the weekend before the deadline) about 90 s of an answer was pure queue wait and under 10 s was generation. That part is outside the app's control, so the app makes it visible.

### 3.4 Photos of handwritten answers

* Images are **resized in the browser** to a maximum side of 1600 px and sent as JPEG, which keeps uploads fast on mobile data.
* Only the **most recent image** in a conversation is sent to the model. Earlier ones are replaced with a short note, which keeps requests small.
* The prompt makes the model first state **what it can read** in the photo and say which part is unreadable instead of guessing. In testing it correctly read a sideways phone photo and refused to grade a sheet with no working on it.

### 3.5 Marking like an examiner

Each mode has its own instructions (Explain, Quiz, Check, Viva). Check mode asks for a score first, then line-by-line ✅/❌ with reasons, then the corrected solution and one tip. Because numeric verdicts come from `[[check]]`, method marks and answer marks are separated cleanly. For example, a 10× slip earned 3/4: formula and substitution correct, final value wrong. A university picker (SPPU, VTU, AKTU, …) and a Hinglish mode adjust the style without changing the maths.

### 3.6 Protecting the public demo

Student access allows 10M tokens a day, and one spammer could exhaust it while judges are testing. `rateLimit.js` enforces:

* **20 questions per user per 10 minutes** (sliding window, keyed by the first `X-Forwarded-For` address behind Render's proxy);
* **2 concurrent requests per user**;
* **600 requests per hour globally**, a safety cap well under the daily token budget.

Blocked requests get `429` (or `503` for the global cap) with a `Retry-After` header and a friendly message. The limiter is in-memory, which is right for a single instance; several instances would need Redis.

### 3.7 Security

* No secrets in the repo. The key lives in the host's environment variables, and `.env` is git-ignored.
* Model output is rendered through a small Markdown renderer that **escapes HTML first**, so a reply containing `<img onerror=…>` shows as text. This is covered by a browser test.
* Request bodies are size-limited (6 MB), images are validated as base64 `png/jpeg/webp` data URLs, and history is capped at 20 messages × 8,000 characters.

## 4. Testing

`npm test` (Node's built-in test runner, no dependencies) runs on every push via GitHub Actions on Node 18, 20 and 22:

* **Calculator:** precedence, suffixes, functions, and rejection of unsafe input (`process.exit()`, `require(...)`, division by zero).
* **Formula tools:** RC, RLC (f₀, Q, BW), op-amp, divider, parallel resistors, 555 timer, dB.
* **Inline tags:** tags split across stream chunks, ✅/❌ checks including sign errors, and malformed tags left harmless.
* **Rate limiting:** sliding window, concurrency, global cap, and a real HTTP server returning `429`.

During development the app was also tested end to end against a mock BharatCode server (tool-call fragments, queue heartbeats, 503 retries) and against the live API.

## 5. Limitations and next steps

* **Queue latency** depends on BharatCode's load. Next step: cache answers to common "Explain" questions.
* **Handwriting recognition** is only as good as the model's vision. Very messy or dark photos may need retaking.
* **No accounts yet.** Progress lives in the browser. Next: track weak topics across sessions and suggest revision.
* **Content:** add previous-year question papers per university for Quiz mode.
