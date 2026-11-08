// vercel-dashboard/api/affiliates/index.js
// Affiliate Management API

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  try {
    switch (request.method) {
      case 'GET':
        return await handleGet(request, response);
      case 'POST':
        return await handlePost(request, response);
      case 'PUT':
        return await handlePut(request, response);
      case 'DELETE':
        return await handleDelete(request, response);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Affiliates API error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/affiliates - List affiliates or get single affiliate
async function handleGet(request, response) {
  const { id, includeStats, includeReferrals, includePayouts } = request.query;

  if (id) {
    // Single affiliate detail
    const affiliate = await kv.get(`affiliate:${id}`);
    if (!affiliate) return response.status(404).json({ error: 'Affiliate not found' });

    // Remove sensitive fields unless admin
    const isAdmin = request.headers['authorization']?.includes('master');
    if (!isAdmin) {
      delete affiliate.apiSecret;
      delete affiliate.twoFASecret;
    }

    if (includeStats === 'true') {
      const stats = await kv.hgetall(`affiliate:${id}:stats`);
      affiliate.stats = stats || {};
    }

    if (includeReferrals === 'true') {
      const referralIds = await kv.smembers(`affiliate:${id}:referrals`) || [];
      const referrals = [];
      for (const rid of referralIds.slice(0, 100)) {
        const ref = await kv.get(`referral:${rid}`);
        if (ref) referrals.push(ref);
      }
      affiliate.referrals = referrals;
    }

    if (includePayouts === 'true') {
      const payoutIds = await kv.smembers(`affiliate:${id}:payouts`) || [];
      const payouts = [];
      for (const pid of payoutIds) {
        const p = await kv.get(`payout:${pid}`);
        if (p) payouts.push(p);
      }
      payouts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      affiliate.payouts = payouts;
    }

    return response.json(affiliate);
  }

  // List all affiliates (admin only)
  const affiliateIds = await kv.smembers('global:affiliates') || [];
  const affiliates = [];

  for (const aid of affiliateIds) {
    const a = await kv.get(`affiliate:${aid}`);
    if (a) {
      const stats = await kv.hgetall(`affiliate:${aid}:stats`);
      affiliates.push({
        id: a.id,
        username: a.username,
        email: a.email,
        status: a.status,
        tier: a.tier,
        commissionRate: a.commissionRate,
        createdAt: a.createdAt,
        lastLogin: a.lastLogin,
        stats: {
          totalReferrals: parseInt(stats?.totalReferrals || '0'),
          activeReferrals: parseInt(stats?.activeReferrals || '0'),
          totalEarnings: parseFloat(stats?.totalEarnings || '0'),
          pendingEarnings: parseFloat(stats?.pendingEarnings || '0'),
          paidOut: parseFloat(stats?.paidOut || '0')
        }
      });
    }
  }

  // Sort by total earnings descending
  affiliates.sort((a, b) => b.stats.totalEarnings - a.stats.totalEarnings);

  response.json({ affiliates, total: affiliates.length });
}

// POST /api/affiliates - Create new affiliate (registration)
async function handlePost(request, response) {
  const { username, email, password, referralCode, walletAddress, walletType } = request.body;

  if (!username || !email || !password) {
    return response.status(400).json({ error: 'Username, email, and password required' });
  }

  // Check if username or email exists
  const existingByUsername = await kv.get(`affiliate:username:${username}`);
  if (existingByUsername) return response.status(409).json({ error: 'Username already taken' });

  const existingByEmail = await kv.get(`affiliate:email:${email}`);
  if (existingByEmail) return response.status(409).json({ error: 'Email already registered' });

  const id = `aff_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const apiKey = `ak_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 10)}`;
  const apiSecret = `as_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
  const refCode = referralCode || username.toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

  // Check referral code exists
  const referrerId = await kv.get(`referral_code:${refCode}`);
  let referrer = null;
  if (referrerId) {
    referrer = await kv.get(`affiliate:${referrerId}`);
  }

  const affiliate = {
    id,
    username,
    email,
    passwordHash: hashPassword(password), // In production, use bcrypt
    apiKey,
    apiSecret,
    refCode,
    walletAddress: walletAddress || null,
    walletType: walletType || 'BTC', // BTC, ETH, USDT, XMR
    tier: 'bronze',
    commissionRate: 0.20, // 20% default
    status: 'active',
    twoFAEnabled: false,
    twoFASecret: null,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    loginCount: 0,
    ipWhitelist: [],
    settings: {
      emailNotifications: true,
      payoutThreshold: 100, // Minimum $100 for auto-payout
      autoPayout: false,
      preferredCurrency: 'USD'
    }
  };

  // Save affiliate
  const operations = [
    kv.set(`affiliate:${id}`, affiliate),
    kv.set(`affiliate:username:${username}`, id),
    kv.set(`affiliate:email:${email}`, id),
    kv.set(`referral_code:${refCode}`, id),
    kv.sadd('global:affiliates', id),
    kv.hset(`affiliate:${id}:stats`, {
      totalReferrals: 0,
      activeReferrals: 0,
      totalEarnings: 0,
      pendingEarnings: 0,
      paidOut: 0,
      totalCampaignsCreated: 0,
      totalInfectionsReferred: 0
    })
  ];

  // If referred by someone, create referral link
  if (referrer) {
    const referralId = `ref_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const referral = {
      id: referralId,
      affiliateId: referrer.id,
      referredAffiliateId: id,
      referralCode: refCode,
      status: 'pending', // pending, active, qualified
      tier: 'bronze',
      commissionRate: referrer.commissionRate,
      createdAt: new Date().toISOString(),
      qualifiedAt: null,
      firstEarningAt: null
    };

    operations.push(
      kv.set(`referral:${referralId}`, referral),
      kv.sadd(`affiliate:${referrer.id}:referrals`, referralId),
      kv.hincrby(`affiliate:${referrer.id}:stats`, 'totalReferrals', 1)
    );

    // Add to referral tree (multi-level)
    await buildReferralTree(referrer.id, id, 1);
  }

  await Promise.all(operations);

  // Return without sensitive data
  const { passwordHash, apiSecret: _, twoFASecret: __, ...safeAffiliate } = affiliate;
  response.status(201).json({ ...safeAffiliate, referralCode: refCode });
}

// PUT /api/affiliates - Update affiliate
async function handlePut(request, response) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Affiliate ID required' });

  const existing = await kv.get(`affiliate:${id}`);
  if (!existing) return response.status(404).json({ error: 'Affiliate not found' });

  // Verify authorization
  const authKey = request.headers['authorization']?.replace('Bearer ', '');
  const isAdmin = authKey && (authKey === process.env.MASTER_API_KEY || MASTER_KEYS.includes(authKey));
  const isOwner = authKey === existing.apiKey;

  if (!isAdmin && !isOwner) {
    return response.status(403).json({ error: 'Unauthorized' });
  }

  // Non-admins can't change certain fields
  if (!isAdmin) {
    delete updates.tier;
    delete updates.commissionRate;
    delete updates.status;
    delete updates.apiKey;
    delete updates.apiSecret;
    delete updates.refCode;
  }

  const updated = {
    ...existing,
    ...updates,
    id,
    updatedAt: new Date().toISOString()
  };

  // Handle email change
  if (updates.email && updates.email !== existing.email) {
    const emailExists = await kv.get(`affiliate:email:${updates.email}`);
    if (emailExists) return response.status(409).json({ error: 'Email already in use' });
    await kv.del(`affiliate:email:${existing.email}`);
    await kv.set(`affiliate:email:${updates.email}`, id);
  }

  await kv.set(`affiliate:${id}`, updated);

  // Return without sensitive data
  const { passwordHash, apiSecret: _, twoFASecret: __, ...safeUpdated } = updated;
  response.json(safeUpdated);
}

// DELETE /api/affiliates - Delete affiliate (admin only)
async function handleDelete(request, response) {
  const { id } = request.query;
  if (!id) return response.status(400).json({ error: 'Affiliate ID required' });

  const authKey = request.headers['authorization']?.replace('Bearer ', '');
  const isAdmin = authKey && (authKey === process.env.MASTER_API_KEY || MASTER_KEYS.includes(authKey));

  if (!isAdmin) {
    return response.status(403).json({ error: 'Admin access required' });
  }

  const existing = await kv.get(`affiliate:${id}`);
  if (!existing) return response.status(404).json({ error: 'Affiliate not found' });

  // Clean up
  const cleanup = [
    kv.del(`affiliate:${id}`),
    kv.del(`affiliate:username:${existing.username}`),
    kv.del(`affiliate:email:${existing.email}`),
    kv.del(`referral_code:${existing.refCode}`),
    kv.del(`affiliate:${id}:stats`),
    kv.srem('global:affiliates', id)
  ];

  // Clean up referrals
  const referralIds = await kv.smembers(`affiliate:${id}:referrals`) || [];
  for (const rid of referralIds) {
    cleanup.push(kv.del(`referral:${rid}`));
  }
  cleanup.push(kv.del(`affiliate:${id}:referrals`));

  // Clean up payouts
  const payoutIds = await kv.smembers(`affiliate:${id}:payouts`) || [];
  for (const pid of payoutIds) {
    cleanup.push(kv.del(`payout:${pid}`));
  }
  cleanup.push(kv.del(`affiliate:${id}:payouts`));

  await Promise.all(cleanup);
  response.json({ success: true, deleted: id });
}

// ============ HELPER FUNCTIONS ============

const MASTER_KEYS = [process.env.MASTER_API_KEY].filter(Boolean);

function hashPassword(password) {
  // Simple hash for demo - use bcrypt in production
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `sha256_${Math.abs(hash).toString(16)}_${password.length}`;
}

async function buildReferralTree(referrerId, newAffiliateId, level) {
  if (level > 3) return; // Max 3 levels deep

  const referrer = await kv.get(`affiliate:${referrerId}`);
  if (!referrer) return;

  // Find referrer's referrer
  const referralIds = await kv.smembers(`affiliate:${referrerId}:referrals`) || [];
  for (const rid of referralIds) {
    const ref = await kv.get(`referral:${rid}`);
    if (ref && ref.referredAffiliateId === referrerId) {
      // This is the referral that brought in the referrer
      // Create multi-level referral entry
      const mlRefId = `mlref_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const mlRef = {
        id: mlRefId,
        rootAffiliateId: ref.affiliateId,
        intermediateAffiliateId: referrerId,
        leafAffiliateId: newAffiliateId,
        level,
        commissionRate: getMultiLevelRate(level),
        createdAt: new Date().toISOString()
      };
      await kv.set(`multilevel_referral:${mlRefId}`, mlRef);
      await kv.sadd(`affiliate:${ref.affiliateId}:multilevel`, mlRefId);

      // Recurse
      await buildReferralTree(ref.affiliateId, newAffiliateId, level + 1);
      break;
    }
  }
}

function getMultiLevelRate(level) {
  const rates = { 1: 0.20, 2: 0.05, 3: 0.02 };
  return rates[level] || 0;
}
