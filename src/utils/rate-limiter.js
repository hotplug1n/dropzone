// Minimal in-memory fixed-window rate limiter (per IP) and a concurrency
// semaphore. No external dependency needed for a single-process deployment.

export function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }

  return function rateLimit(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }

    entry.count += 1;

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > max) {
      res.status(429).json({
        code: 'RATE_LIMIT',
        message: 'Muitas solicitações em pouco tempo. Tente novamente em instantes.',
      });
      return;
    }

    next();
  };
}

export class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.maxConcurrent) {
      this.current += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.current += 1;
  }

  release() {
    this.current -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
