// vercel-dashboard/api/affiliate/referral/stats.js
// Affiliate referral statistics

import { kv } from '../../../lib/kv.js';
import { verifyPayloadApiKey } from '../../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });

  const auth = await verifyPayloadApiKey(request);
  if (!auth.valid || auth.role !== 'campaign') {
    return response.status(403).json({ error: 'Affiliate access required' });
  }

  const affiliateId = `aff_${auth.campaignId.replace('camp_', '')}`;

  try {
    const affiliate = await kv.get(`affiliate:${affiliateId}`);
    if (!affiliate) {
      return response.status(404).json({ error: 'Affiliate not found' });
    }

    // Get direct referrals (Tier 1)
    const referralIds = await kv.smembers(`affiliate:${affiliateId}:referrals`) || [];
    let totalReferrals = referralIds.length;
    let activeReferrals = 0;
    let totalCommissionEarned = 0;
    let pendingCommission = 0;

    for (const refId of referralIds) {
      const ref = await kv.get(`affiliate:${refId}`);
      if (ref) {
        if (ref.status === 'active') activeReferrals++;
        totalCommissionEarned += ref.paidEarnings * 0.1; // 10% tier 1
        pendingCommission += ref.pendingEarnings * 0.1;
      }
    }

    // Tier 2 (referrals of referrals)
    let tier2Count = 0;
    for (const refId of referralIds) {
      const tier2Ids = await kv.smembers(`affiliate:${refId}:referrals`) || [];
      tier2Count += tier2Ids.length;
    }

    // Tier 3
    let tier3Count = 0;
    for (const refId of referralIds) {
      const tier2Ids = await kv.smembers(`affiliate:${refId}:referrals`) || [];
      for (const t2Id of tier2Ids) {
        const tier3Ids = await kv.smembers(`affiliate:${t2Id}:referrals`) || [];
        tier3Count += tier3Ids.length;
      }
    }

    const referralLink = `${process.env.NEXT_PUBLIC_APP_URL || 'https://your-project.vercel.app'}/register?ref=${affiliate.referralCode}`;

    return response.json({
      totalReferrals,
      activeReferrals,
      totalCommissionEarned,
      pendingCommission,
      referralCode: affiliate.referralCode,
      referralLink,
      tierBreakdown: [
        { tier: 1, count: totalReferrals, commissionRate: 10 },
        { tier: 2, count: tier2Count, commissionRate: 5 },
        { tier: 3, count: tier3Count, commissionRate: 2 },
      ],
    });
  } catch (error) {
    console.error('Affiliate referral stats error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}