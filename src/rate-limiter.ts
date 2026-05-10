// IP-based rate limiter to prevent API credit exhaustion
// Uses in-memory storage with sliding window algorithm

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private hourlyLimits: Map<string, RateLimitEntry> = new Map();
  private dailyLimits: Map<string, RateLimitEntry> = new Map();
  private hourlyLimit: number;
  private dailyLimit: number;
  private hourlyWindowMs: number = 60 * 60 * 1000; // 1 hour
  private dailyWindowMs: number = 24 * 60 * 60 * 1000; // 24 hours

  constructor(hourlyLimit: number = 10, dailyLimit: number = 20) {
    this.hourlyLimit = hourlyLimit;
    this.dailyLimit = dailyLimit;
    
    // Clean up old entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  private cleanup() {
    const now = Date.now();
    
    // Clean hourly limits
    for (const [ip, entry] of this.hourlyLimits.entries()) {
      if (now - entry.windowStart > this.hourlyWindowMs) {
        this.hourlyLimits.delete(ip);
      }
    }
    
    // Clean daily limits
    for (const [ip, entry] of this.dailyLimits.entries()) {
      if (now - entry.windowStart > this.dailyWindowMs) {
        this.dailyLimits.delete(ip);
      }
    }
  }

  private checkLimit(
    limits: Map<string, RateLimitEntry>,
    ip: string,
    windowMs: number,
    limit: number
  ): { allowed: boolean; remaining: number; resetTime: number } {
    const now = Date.now();
    const entry = limits.get(ip);

    if (!entry || now - entry.windowStart > windowMs) {
      // New window
      limits.set(ip, { count: 1, windowStart: now });
      return {
        allowed: true,
        remaining: limit - 1,
        resetTime: now + windowMs,
      };
    }

    if (entry.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.windowStart + windowMs,
      };
    }

    entry.count++;
    return {
      allowed: true,
      remaining: limit - entry.count,
      resetTime: entry.windowStart + windowMs,
    };
  }

  check(ip: string): {
    allowed: boolean;
    remainingHourly: number;
    remainingDaily: number;
    resetTimeHourly: number;
    resetTimeDaily: number;
  } {
    const hourly = this.checkLimit(
      this.hourlyLimits,
      ip,
      this.hourlyWindowMs,
      this.hourlyLimit
    );
    const daily = this.checkLimit(
      this.dailyLimits,
      ip,
      this.dailyWindowMs,
      this.dailyLimit
    );

    return {
      allowed: hourly.allowed && daily.allowed,
      remainingHourly: hourly.remaining,
      remainingDaily: daily.remaining,
      resetTimeHourly: hourly.resetTime,
      resetTimeDaily: daily.resetTime,
    };
  }

  getStats() {
    return {
      hourlyEntries: this.hourlyLimits.size,
      dailyEntries: this.dailyLimits.size,
    };
  }
}

// Create singleton instance
const hourlyLimit = Number(process.env.RATE_LIMIT_HOUR) || 10;
const dailyLimit = Number(process.env.RATE_LIMIT_DAY) || 20;
export const rateLimiter = new RateLimiter(hourlyLimit, dailyLimit);

// Helper to extract IP from request
export function getClientIp(req: {
  headers: { [key: string]: string | string[] | undefined };
  socket?: { remoteAddress?: string };
}): string {
  // Check for forwarded headers (proxy/load balancer)
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded)) {
    return forwarded[0].split(",")[0].trim();
  }

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string") {
    return realIp;
  }

  // Fallback to socket address
  return req.socket?.remoteAddress || "unknown";
}
