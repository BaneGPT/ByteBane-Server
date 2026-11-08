// vercel-dashboard/api/auth/rateLimit.js
// Rate limiting middleware for payload endpoints

import { kv } from '../../lib/kv.js';

const RATE_LIMITS = {
  // Per-campaign limits (sliding window)
  'systems:register': { windowMs: 60000, max: 10 },      // 10 registrations/min
  'systems:heartbeat': { windowMs: 60000, max: 60 },     // 60 heartbeats/min
  'exfil:upload': { windowMs: 60000, max: 100 },         // 100 uploads/min
  'exfil:chunked': { windowMs: 60000, max: 500 },        // 500 chunks/min
  
  // Global limits (prevent abuse)
  'global:write': { windowMs: 60000, max: 1000 },        // 1000 writes/min globally
  'global:read': { windowMs: 60000, max: 5000 },         // 5000 reads/min globally
};

// In-memory fallback for when KV is unavailable
const memoryCounters = new Map();

function getWindowKey(identifier, windowMs) {
  const window = Math.floor(Date.now() / windowMs);
  return `${identifier}:${window}`;
}

async function checkRateLimit(identifier, limitConfig) {
  const key = getWindowKey(identifier, limitConfig.windowMs);
  const now = Date.now();
  const windowStart = now - limitConfig.windowMs;

  try {
    // Try KV first
    const current = await kv.get(key);
    const count = current ? parseInt(current) + 1 : 1;
    
    if (count > limitConfig.max) {
      const ttl = Math.ceil(limitConfig.windowMs / 1000);
      return { allowed: false, count, limit: limitConfig.max, retryAfter: ttl };
    }
    
    await kv.set(key, count.toString(), { ex: Math.ceil(limitConfig.windowMs / 1000) + 1 });
    return { allowed: true, count, limit: limitConfig.max };
  } catch (e) {
    // Fallback to memory
    const memKey = `mem:${key}`;
    const entry = memoryCounters.get(memKey) || { count: 0, resetAt: now + limitConfig.windowMs };
    
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + limitConfig.windowMs;
    }
    
    entry.count++;
    memoryCounters.set(memKey, entry);
    
    // Clean old entries periodically
    if (memoryCounters.size > 10000) {
      for (const [k, v] of memoryCounters.entries()) {
        if (now > v.resetAt) memoryCounters.delete(k);
      }
    }
    
    if (entry.count > limitConfig.max) {
      return { allowed: false, count: entry.count, limit: limitConfig.max, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    
    return { allowed: true, count: entry.count, limit: limitConfig.max };
  }
}

export function rateLimit(limitType) {
  const config = RATE_LIMITS[limitType];
  if (!config) return (req, res, next) => next();

  return async (request, response, next) => {
    const auth = request.auth;
    const identifier = auth?.campaignId ? `campaign:${auth.campaignId}:${limitType}` : `global:${limitType}`;
    
    const result = await checkRateLimit(identifier, config);
    
    response.setHeader('X-RateLimit-Limit', config.max);
    response.setHeader('X-RateLimit-Remaining', Math.max(0, config.max - result.count));
    response.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + config.windowMs) / 1000));
    
    if (!result.allowed) {
      response.setHeader('Retry-After', result.retryAfter);
      return response.status(429).json({ 
        error: 'Rate limit exceeded',
        limit: config.max,
        windowMs: config.windowMs,
        retryAfter: result.retryAfter
      });
    }
    
    next();
  };
}

// Specific limiters for common operations
export const registerLimiter = rateLimit('systems:register');
export const heartbeatLimiter = rateLimit('systems:heartbeat');
export const uploadLimiter = rateLimit('exfil:upload');
export const chunkedLimiter = rateLimit('exfil:chunked');