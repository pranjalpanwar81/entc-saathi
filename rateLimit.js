// Simple in-memory rate limiter that protects the shared BharatCode quota (10M tokens/day on
// student access) from accidental or deliberate spam on the public demo.
// Three limits: per-user requests in a sliding window, per-user concurrent requests, and a
// global hourly cap. In-memory is enough for a single small instance; a multi-instance
// deployment would move this to Redis.

class RateLimiter {
  constructor({ perUser = 20, windowMs = 10 * 60_000, maxConcurrent = 2, globalPerHour = 600, now = () => Date.now() } = {}) {
    Object.assign(this, { perUser, windowMs, maxConcurrent, globalPerHour, now });
    this.hits = new Map();     // key -> timestamps within the window
    this.active = new Map();   // key -> requests in flight
    this.global = [];          // timestamps within the last hour
  }

  // Returns { ok: true, release } or { ok: false, status, retryAfterSec, message }.
  take(key) {
    const t = this.now();
    this.global = this.global.filter((x) => t - x < 3_600_000);
    if (this.global.length >= this.globalPerHour) {
      const retry = Math.ceil((3_600_000 - (t - this.global[0])) / 1000);
      return { ok: false, status: 503, retryAfterSec: retry, message: 'ENTC Saathi is very busy right now. Please try again in a few minutes.' };
    }
    const list = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.perUser) {
      const retry = Math.ceil((this.windowMs - (t - list[0])) / 1000);
      this.hits.set(key, list);
      return { ok: false, status: 429, retryAfterSec: retry, message: `You've asked ${this.perUser} questions in ${Math.round(this.windowMs / 60_000)} minutes, which is the limit for this free demo. Please try again in ${Math.max(1, Math.ceil(retry / 60))} min.` };
    }
    const running = this.active.get(key) || 0;
    if (running >= this.maxConcurrent) {
      return { ok: false, status: 429, retryAfterSec: 5, message: 'Please wait for your current answer to finish before asking another question.' };
    }
    list.push(t);
    this.hits.set(key, list);
    this.global.push(t);
    this.active.set(key, running + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const n = (this.active.get(key) || 1) - 1;
        if (n <= 0) this.active.delete(key); else this.active.set(key, n);
      },
    };
  }

  // Drop stale entries so memory stays small.
  sweep() {
    const t = this.now();
    for (const [k, list] of this.hits) {
      const fresh = list.filter((x) => t - x < this.windowMs);
      if (fresh.length) this.hits.set(k, fresh); else this.hits.delete(k);
    }
  }
}

// Client IP. Behind Render's proxy the real address is the first entry of X-Forwarded-For.
function clientKey(req, trustProxy = true) {
  const fwd = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd || req.socket?.remoteAddress || 'unknown';
}

module.exports = { RateLimiter, clientKey };
