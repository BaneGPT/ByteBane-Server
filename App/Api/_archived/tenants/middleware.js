// vercel-dashboard/api/tenants/middleware.js
// Multi-Tenant Isolation Middleware

import { kv } from '../../lib/kv.js';

/**
 * Tenant Context - Holds tenant-specific data for request isolation
 */
export class TenantContext {
  constructor(tenantId, tenantData = {}) {
    this.tenantId = tenantId;
    this.data = tenantData;
    this.affiliateId = null;
    this.userId = null;
    this.role = 'tenant';
    this.permissions = [];
    this.rateLimitKey = `ratelimit:tenant:${tenantId}`;
  }

  /**
   * Get isolated KV key with tenant prefix
   */
  kvKey(key) {
    return `tenant:${this.tenantId}:${key}`;
  }

  /**
   * Get isolated set key
   */
  kvSet(key) {
    return `tenant:${this.tenantId}:${key}`;
  }

  /**
   * Check if tenant has feature enabled
   */
  hasFeature(feature) {
    return this.data.features?.[feature] === true;
  }

  /**
   * Get plan limit
   */
  getLimit(limit) {
    return this.data.planLimits?.[limit];
  }

  /**
   * Check if tenant is within limits
   */
  async checkLimit(limitType, currentCount) {
    const limit = this.getLimit(limitType);
    if (limit === -1) return { allowed: true, remaining: -1 }; // unlimited
    return { 
      allowed: currentCount < limit, 
      remaining: Math.max(0, limit - currentCount),
      limit 
    };
  }
}

/**
 * Extract tenant context from request
 */
export async function getTenantContext(request) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  if (!authHeader) return null;

  // Master key - global access
  if (authHeader === process.env.MASTER_API_KEY) {
    return new TenantContext('global', { 
      id: 'global', 
      name: 'Global Admin', 
      plan: 'enterprise',
      features: { all: true },
      planLimits: { maxAffiliates: -1, maxCampaigns: -1, maxStorageGB: -1, apiRateLimit: -1 }
    });
  }

  // Check tenant API key
  const tenantIds = await kv.smembers('global:tenants') || [];
  for (const tid of tenantIds) {
    const tenant = await kv.get(`tenant:${tid}`);
    if (tenant && tenant.apiKey === authHeader) {
      const context = new TenantContext(tid, tenant);
      context.role = 'tenant';
      return context;
    }
  }

  // Check affiliate session
  const session = await kv.get(`session:${authHeader}`);
  if (session && new Date(session.expiresAt) > new Date()) {
    const affiliate = await kv.get(`affiliate:${session.affiliateId}`);
    if (affiliate) {
      const tenantId = affiliate.tenantId;
      if (tenantId) {
        const tenant = await kv.get(`tenant:${tenantId}`);
        const context = new TenantContext(tenantId, tenant || {});
        context.affiliateId = session.affiliateId;
        context.role = affiliate.role || 'affiliate';
        return context;
      }
    }
  }

  // Check affiliate API key
  const affiliateIds = await kv.smembers('global:affiliates') || [];
  for (const aid of affiliateIds) {
    const a = await kv.get(`affiliate:${aid}`);
    if (a && a.apiKey === authHeader) {
      const tenantId = a.tenantId;
      if (tenantId) {
        const tenant = await kv.get(`tenant:${tenantId}`);
        const context = new TenantContext(tenantId, tenant || {});
        context.affiliateId = aid;
        context.role = a.role || 'affiliate';
        return context;
      }
    }
  }

  return null;
}

/**
 * Middleware to enforce tenant isolation
 */
export function withTenantIsolation(handler) {
  return async (request, response) => {
    const context = await getTenantContext(request);
    
    if (!context) {
      return response.status(401).json({ error: 'Authentication required' });
    }

    // Attach context to request
    request.tenantContext = context;
    request.tenantId = context.tenantId;

    // Add tenant-scoped KV helpers
    request.kv = {
      get: (key) => kv.get(context.kvKey(key)),
      set: (key, value) => kv.set(context.kvKey(key), value),
      del: (key) => kv.del(context.kvKey(key)),
      hget: (hash, field) => kv.hget(context.kvKey(hash), field),
      hset: (hash, data) => kv.hset(context.kvKey(hash), data),
      hgetall: (hash) => kv.hgetall(context.kvKey(hash)),
      hincrby: (hash, field, amount) => kv.hincrby(context.kvKey(hash), field, amount),
      hincrbyfloat: (hash, field, amount) => kv.hincrbyfloat(context.kvKey(hash), field, amount),
      sadd: (set, ...members) => kv.sadd(context.kvSet(set), ...members),
      srem: (set, ...members) => kv.srem(context.kvSet(set), ...members),
      smembers: (set) => kv.smembers(context.kvSet(set)),
      scard: (set) => kv.scard(context.kvSet(set)),
      lpush: (list, ...values) => kv.lpush(context.kvKey(list), ...values),
      lrange: (list, start, stop) => kv.lrange(context.kvKey(list), start, stop),
      ltrim: (list, start, stop) => kv.ltrim(context.kvKey(list), start, stop)
    };

    // Add global KV for cross-tenant operations (admin only)
    request.globalKv = kv;

    // Rate limiting
    const rateLimitResult = await checkRateLimit(context);
    if (!rateLimitResult.allowed) {
      return response.status(429).json({ 
        error: 'Rate limit exceeded',
        retryAfter: rateLimitResult.retryAfter
      });
    }

    // Set rate limit headers
    response.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    response.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    response.setHeader('X-RateLimit-Reset', rateLimitResult.reset);

    return handler(request, response, context);
  };
}

/**
 * Check rate limit for tenant
 */
async function checkRateLimit(context) {
  const limit = context.getLimit('apiRateLimit') || 1000;
  if (limit === -1) return { allowed: true, remaining: -1, limit: -1, reset: 0 };

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 60; // 1 minute window
  const key = `${context.rateLimitKey}:${now}`;

  const current = await kv.incr(key);
  if (current === 1) {
    await kv.expire(key, 120); // Expire after 2 minutes
  }

  // Also check sliding window
  const keys = [];
  for (let i = 0; i < 60; i++) {
    keys.push(`${context.rateLimitKey}:${now - i}`);
  }
  
  const counts = await Promise.all(keys.map(k => kv.get(k).then(v => parseInt(v || '0'))));
  const total = counts.reduce((a, b) => a + b, 0);

  return {
    allowed: total <= limit,
    remaining: Math.max(0, limit - total),
    limit,
    reset: now + 60,
    retryAfter: total > limit ? 60 : 0
  };
}

/**
 * Validate tenant access to resource
 */
export async function validateTenantAccess(context, resourceType, resourceId) {
  if (context.tenantId === 'global') return true; // Admin has access to all

  const tenantKey = context.kvKey(`${resourceType}s`);
  const member = await kv.sismember(tenantKey, resourceId);
  return member === 1;
}

/**
 * Get tenant-scoped list of resources
 */
export async function getTenantResources(context, resourceType, options = {}) {
  const { limit = 50, offset = 0, filter = {} } = options;
  
  const tenantKey = context.kvKey(`${resourceType}s`);
  const ids = await kv.smembers(tenantKey) || [];
  
  // Apply filters
  let filteredIds = ids;
  if (Object.keys(filter).length > 0) {
    filteredIds = [];
    for (const id of ids) {
      const resource = await kv.get(`${resourceType}:${id}`);
      if (resource && matchesFilter(resource, filter)) {
        filteredIds.push(id);
      }
    }
  }

  // Sort by createdAt descending
  const withTime = [];
  for (const id of filteredIds) {
    const resource = await kv.get(`${resourceType}:${id}`);
    if (resource) withTime.push({ id, createdAt: resource.createdAt || 0 });
  }
  withTime.sort((a, b) => b.createdAt - a.createdAt);

  // Paginate
  const start = offset;
  const paginatedIds = withTime.slice(start, start + limit).map(r => r.id);

  const resources = [];
  for (const id of paginatedIds) {
    const resource = await kv.get(`${resourceType}:${id}`);
    if (resource) resources.push(resource);
  }

  return {
    resources,
    total: filteredIds.length,
    page: Math.floor(start / limit) + 1,
    pageSize: limit
  };
}

function matchesFilter(resource, filter) {
  for (const [key, value] of Object.entries(filter)) {
    if (resource[key] !== value) return false;
  }
  return true;
}

/**
 * Create tenant-scoped resource
 */
export async function createTenantResource(context, resourceType, resource) {
  if (!context.hasFeature('apiAccess')) {
    throw new Error('API access not enabled for this plan');
  }

  // Check limits
  const currentCount = await kv.scard(context.kvKey(`${resourceType}s`)) || 0;
  const limitCheck = await context.checkLimit(`max${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}s`, currentCount);
  
  if (!limitCheck.allowed) {
    throw new Error(`${resourceType} limit reached (${limitCheck.limit})`);
  }

  const id = `${resourceType}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  const newResource = {
    ...resource,
    id,
    tenantId: context.tenantId,
    createdAt: now,
    updatedAt: now
  };

  await Promise.all([
    kv.set(`${resourceType}:${id}`, newResource),
    kv.sadd(context.kvKey(`${resourceType}s`), id),
    kv.hincrby(`tenant:${context.tenantId}:stats`, `total${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}s`, 1)
  ]);

  return newResource;
}

/**
 * Update tenant-scoped resource
 */
export async function updateTenantResource(context, resourceType, id, updates) {
  const resource = await kv.get(`${resourceType}:${id}`);
  if (!resource) throw new Error('Resource not found');
  if (resource.tenantId !== context.tenantId && context.tenantId !== 'global') {
    throw new Error('Access denied');
  }

  const updated = {
    ...resource,
    ...updates,
    id,
    updatedAt: new Date().toISOString()
  };

  await kv.set(`${resourceType}:${id}`, updated);
  return updated;
}

/**
 * Delete tenant-scoped resource
 */
export async function deleteTenantResource(context, resourceType, id) {
  const resource = await kv.get(`${resourceType}:${id}`);
  if (!resource) throw new Error('Resource not found');
  if (resource.tenantId !== context.tenantId && context.tenantId !== 'global') {
    throw new Error('Access denied');
  }

  await Promise.all([
    kv.del(`${resourceType}:${id}`),
    kv.srem(context.kvKey(`${resourceType}s`), id),
    kv.hincrby(`tenant:${context.tenantId}:stats`, `total${resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}s`, -1)
  ]);

  return { success: true, deleted: id };
}
