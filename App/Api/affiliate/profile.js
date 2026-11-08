// vercel-dashboard/api/affiliate/profile.js
// Affiliate profile management

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  const auth = await verifyPayloadApiKey(request);
  if (!auth.valid || auth.role !== 'campaign') {
    return response.status(403).json({ error: 'Affiliate access required' });
  }

  try {
    switch (request.method) {
      case 'GET':
        return await handleGet(request, response, auth);
      case 'PUT':
        return await handlePut(request, response, auth);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Affiliate profile error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response, auth) {
  const affiliateId = `aff_${auth.campaignId.replace('camp_', '')}`;
  
  let affiliate = await kv.get(`affiliate:${affiliateId}`);
  
  if (!affiliate) {
    // Create default affiliate profile
    affiliate = {
      id: affiliateId,
      username: `affiliate_${affiliateId.substring(4, 12)}`,
      email: '',
      walletAddress: '',
      referralCode: generateReferralCode(`affiliate_${affiliateId.substring(4, 12)}`),
      commissionRate: 70, // 70% to affiliate, 30% to platform
      totalEarnings: 0,
      pendingEarnings: 0,
      paidEarnings: 0,
      campaignCount: 1,
      infectionCount: 0,
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
      status: 'active',
      notificationSettings: {
        emailNewInfection: true,
        emailPayment: true,
        emailPayout: true,
        emailTicket: true,
        telegramNewInfection: false,
        telegramPayment: true,
        telegramPayout: true,
      },
      appearanceSettings: {
        theme: 'dark',
        compactMode: false,
        animations: true,
      },
      securitySettings: {
        twoFactorEnabled: false,
        sessionTimeout: 30,
        apiKeyRotationDays: 90,
      },
    };
    await kv.set(`affiliate:${affiliateId}`, affiliate);
  }

  // Update stats from campaigns
  const campaignIds = await kv.smembers(`affiliate:${affiliateId}:campaigns`) || [];
  let totalInfections = 0;
  let totalEarnings = 0;
  let pendingEarnings = 0;

  for (const cid of campaignIds) {
    const stats = await kv.hgetall(`campaign:${cid}:stats`) || {};
    totalInfections += parseInt(stats.totalInfections || '0');
    // Earnings would come from payment tracking
  }

  affiliate.campaignCount = campaignIds.length;
  affiliate.infectionCount = totalInfections;
  affiliate.lastLogin = new Date().toISOString();

  await kv.set(`affiliate:${affiliateId}`, affiliate);

  // Remove sensitive fields
  const { ...safeAffiliate } = affiliate;
  return response.json(safeAffiliate);
}

async function handlePut(request, response, auth) {
  const affiliateId = `aff_${auth.campaignId.replace('camp_', '')}`;
  const { email, walletAddress } = request.body;

  const affiliate = await kv.get(`affiliate:${affiliateId}`);
  if (!affiliate) {
    return response.status(404).json({ error: 'Affiliate not found' });
  }

  const updated = {
    ...affiliate,
    email: email || affiliate.email,
    walletAddress: walletAddress || affiliate.walletAddress,
    updatedAt: new Date().toISOString(),
  };

  await kv.set(`affiliate:${affiliateId}`, updated);

  const { ...safeAffiliate } = updated;
  return response.json(safeAffiliate);
}

function generateReferralCode(username: string): string {
  const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `CHAOS-${username.toUpperCase().substring(0, 4)}-${suffix}`;
}