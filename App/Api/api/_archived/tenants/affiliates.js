// vercel-dashboard/api/tenants/affiliates.js
// Tenant Affiliate Management API

import { kv } from '../../lib/kv.js';
import { withTenantIsolation, getTenantContext } from './middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  return withTenantIsolation(async (req, res, context) => {
    try {
      // Check if tenant admin or tenant owner
      if (!['tenant_admin', 'tenant'].includes(context.role)) {
        return res.status(403).json({ error: 'Tenant admin access required' });
      }

      switch (req.method) {
        case 'GET':
          return await handleGet(req, res, context);
        case 'POST':
          return await handlePost(req, res, context);
        case 'PUT':
          return await handlePut(req, res, context);
        case 'DELETE':
          return await handleDelete(req, res, context);
        default:
          return res.status(405).json({ error: 'Method not allowed' });
      }
    } catch (error) {
      console.error('Tenant Affiliates API error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })(request, response);
}

async function handleGet(request, response, context) {
  const { id, includeStats, includeReferrals, limit = 50, offset = 0 } = request.query;

  if (id) {
    // Get specific affiliate
    const affiliate = await kv.get(`affiliate:${id}`);
    if (!affiliate) return response.status(404).json({ error: 'Affiliate not found' });
    if (affiliate.tenantId !== context.tenantId) return response.status(403).json({ error: 'Forbidden' });

    const { passwordHash, apiSecret, twoFASecret, ...safeAffiliate } = affiliate;

    if (includeStats === 'true') {
      const stats = await kv.hgetall(`affiliate:${id}:stats`);
      safeAffiliate.stats = stats || {};
    }

    if (includeReferrals === 'true') {
      const referralIds = await kv.smembers(`affiliate:${id}:referrals`) || [];
      const referrals = [];
      for (const rid of referralIds.slice(0, 50)) {
        const ref = await kv.get(`referral:${rid}`);
        if (ref) referrals.push(ref);
      }
      safeAffiliate.referrals = referrals;
    }

    return response.json(safeAffiliate);
  }

  // List tenant's affiliates
  const affiliateIds = await kv.smembers(`tenant:${context.tenantId}:affiliates`) || [];
  const affiliates = [];

  for (const aid of affiliateIds) {
    const a = await kv.get(`affiliate:${aid}`);
    if (a) {
      const { passwordHash, apiSecret, twoFASecret, ...safeAffiliate } = a;
      const stats = await kv.hgetall(`affiliate:${aid}:stats`);
      affiliates.push({
        id: a.id,
        username: a.username,
        email: a.email,
        status: a.status,
        tier: a.tier,
        commissionRate: a.commissionRate,
        role: a.role || 'affiliate',
        createdAt: a.createdAt,
        lastLogin: a.lastLogin,
        stats: {
          totalReferrals: parseInt(stats?.totalReferrals || '0'),
          activeReferrals: parseInt(stats?.activeReferrals || '0'),
          totalEarnings: parseFloat(stats?.totalEarnings || '0'),
          pendingEarnings: parseFloat(stats?.pendingEarnings || '0'),
          paidOut: parseFloat(stats?.paidOut || '0'),
          totalCampaignsCreated: parseInt(stats?.totalCampaignsCreated || '0'),
          totalInfectionsReferred: parseInt(stats?.totalInfectionsReferred || '0')
        }
      });
    }
  }

  // Sort by total earnings
  affiliates.sort((a, b) => b.stats.totalEarnings - a.stats.totalEarnings);

  // Paginate
  const start = parseInt(offset);
  const lim = parseInt(limit);
  const paginated = affiliates.slice(start, start + lim);

  response.json({
    affiliates: paginated,
    total: affiliates.length,
    page: Math.floor(start / lim) + 1,
    pageSize: lim
  });
}

async function handlePost(request, response, context) {
  const { username, email, password, commissionRate, role, walletAddress, walletType } = request.body;

  if (!username || !email || !password) {
    return response.status(400).json({ error: 'Username, email, and password required' });
  }

  // Check limits
  const currentCount = affiliateIds.length;
  const limitCheck = await context.checkLimit('maxAffiliates', currentCount);
  if (!limitCheck.allowed) {
    return response.status(400).json({ error: `Affiliate limit reached (${limitCheck.limit})` });
  }

  // Check if username/email exists globally
  const existingByUsername = await kv.get(`affiliate:username:${username}`);
  if (existingByUsername) return response.status(409).json({ error: 'Username already taken' });

  const existingByEmail = await kv.get(`affiliate:email:${email}`);
  if (existingByEmail) return response.status(409).json({ error: 'Email already registered' });

  const id = `aff_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const apiKey = `ak_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 10)}`;
  const apiSecret = `as_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
  const refCode = username.toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

  const affiliate = {
    id,
    username,
    email,
    passwordHash: hashPassword(password),
    apiKey,
    apiSecret,
    refCode,
    walletAddress: walletAddress || null,
    walletType: walletType || 'BTC',
    tier: 'bronze',
    commissionRate: commissionRate || 0.20,
    role: role || 'affiliate',
    tenantId: context.tenantId,
    status: 'active',
    twoFAEnabled: false,
    twoFASecret: null,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    loginCount: 0,
    settings: {
      emailNotifications: true,
      payoutThreshold: 100,
      autoPayout: false,
      preferredCurrency: 'USD'
    }
  };

  const operations = [
    kv.set(`affiliate:${id}`, affiliate),
    kv.set(`affiliate:username:${username}`, id),
    kv.set(`affiliate:email:${email}`, id),
    kv.set(`referral_code:${refCode}`, id),
    kv.sadd('global:affiliates', id),
    kv.sadd(`tenant:${context.tenantId}:affiliates`, id),
    kv.hset(`affiliate:${id}:stats`, {
      totalReferrals: 0,
      activeReferrals: 0,
      totalEarnings: 0,
      pendingEarnings: 0,
      paidOut: 0,
      totalCampaignsCreated: 0,
      totalInfectionsReferred: 0
    }),
    kv.hincrby(`tenant:${context.tenantId}:stats`, 'totalAffiliates', 1),
    kv.hincrby(`tenant:${context.tenantId}:stats`, 'activeAffiliates', 1)
  ];

  await Promise.all(operations);

  const { passwordHash, apiSecret: _, twoFASecret: __, ...safeAffiliate } = affiliate;
  response.status(201).json(safeAffiliate);
}

async function handlePut(request, response, context) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Affiliate ID required' });

  const existing = await kv.get(`affiliate:${id}`);
  if (!existing) return response.status(404).json({ error: 'Affiliate not found' });
  if (existing.tenantId !== context.tenantId) return response.status(403).json({ error: 'Forbidden' });

  // Tenant admins can't change certain fields
  if (context.role !== 'tenant') {
    delete updates.tenantId;
    delete updates.apiKey;
    delete updates.apiSecret;
    delete updates.refCode;
  }

  // Handle email change
  if (updates.email && updates.email !== existing.email) {
    const emailExists = await kv.get(`affiliate:email:${updates.email}`);
    if (emailExists) return response.status(409).json({ error: 'Email already in use' });
    await kv.del(`affiliate:email:${existing.email}`);
    await kv.set(`affiliate:email:${updates.email}`, id);
  }

  const updated = {
    ...existing,
    ...updates,
    id,
    tenantId: context.tenantId, // Ensure tenantId can't be changed
    updatedAt: new Date().toISOString()
  };

  await kv.set(`affiliate:${id}`, updated);

  const { passwordHash, apiSecret, twoFASecret, ...safeUpdated } = updated;
  response.json(safeUpdated);
}

async function handleDelete(request, response, context) {
  const { id } = request.query;
  if (!id) return response.status(400).json({ error: 'Affiliate ID required' });

  const existing = await kv.get(`affiliate:${id}`);
  if (!existing) return response.status(404).json({ error: 'Affiliate not found' });
  if (existing.tenantId !== context.tenantId) return response.status(403).json({ error: 'Forbidden' });

  // Soft delete - just deactivate
  await kv.set(`affiliate:${id}`, {
    ...existing,
    status: 'deleted',
    deletedAt: new Date().toISOString()
  });

  await Promise.all([
    kv.srem(`tenant:${context.tenantId}:affiliates`, id),
    kv.hincrby(`tenant:${context.tenantId}:stats`, 'totalAffiliates', -1),
    kv.hincrby(`tenant:${context.tenantId}:stats`, 'activeAffiliates', -1)
  ]);

  response.json({ success: true, deleted: id });
}

function hashPassword(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `sha256_${Math.abs(hash).toString(16)}_${password.length}`;
}

// Need to get affiliateIds for limit check
const affiliateIds = await kv.smembers(`tenant:${context.tenantId}:affiliates`) || [];
