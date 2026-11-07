// Answer cache for identical first questions (no photo, no earlier conversation).
// Why: BharatCode is a shared, queued API, and the starter questions everyone clicks first
// would otherwise wait 15-90 s each time. Cached answers are real model answers, replayed
// instantly and labelled as saved in the UI. Follow-ups and new questions always go live.
//
// Two sources:
//  - seed file (answers-cache.json): answers collected from the live model, shipped with the app,
//    so they survive restarts on free hosting;
//  - runtime LRU: any identical first question answered since the server started.

const fs = require('fs');

class AnswerCache {
  constructor({ max = 300, ttlMs = 12 * 3_600_000, seedFile, now = () => Date.now() } = {}) {
    Object.assign(this, { max, ttlMs, now });
    this.map = new Map(); // key -> { events, at, seeded }
    if (seedFile && fs.existsSync(seedFile)) {
      try {
        const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        for (const [key, events] of Object.entries(seed)) this.map.set(key, { events, at: 0, seeded: true });
      } catch (e) { console.warn(`[cache] could not read seed file: ${e.message}`); }
    }
  }

  // Only plain first questions are cacheable.
  static key(opts, history) {
    if (history.length !== 1 || typeof history[0].content !== 'string') return null;
    const q = history[0].content.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!q || q.length > 300) return null;
    return [opts.mode, opts.subject, opts.university, opts.language, (opts.topic || '').trim().toLowerCase(), q].join('|');
  }

  get(key) {
    if (!key) return null;
    const hit = this.map.get(key);
    if (!hit) return null;
    if (!hit.seeded && this.now() - hit.at > this.ttlMs) { this.map.delete(key); return null; }
    this.map.delete(key); this.map.set(key, hit); // refresh LRU order
    return hit.events;
  }

  set(key, events) {
    if (!key) return;
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    if (text.trim().length < 40) return; // don't cache empty or broken answers
    this.map.set(key, { events, at: this.now(), seeded: false });
    while (this.map.size > this.max) {
      const oldest = [...this.map.entries()].find(([, v]) => !v.seeded);
      if (!oldest) break;
      this.map.delete(oldest[0]);
    }
  }
}

// Merge consecutive text events so a cached answer is compact.
function compactEvents(events) {
  const out = [];
  for (const e of events) {
    if (e.type === 'text' && out.length && out[out.length - 1].type === 'text') out[out.length - 1] = { type: 'text', text: out[out.length - 1].text + e.text };
    else if (e.type === 'text' || e.type === 'tool') out.push({ ...e });
  }
  return out;
}

module.exports = { AnswerCache, compactEvents };
