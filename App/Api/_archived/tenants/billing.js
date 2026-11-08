// vercel-dashboard/api/tenants/billing.js
// Tenant Billing & Subscription Management

import { kv } from '../../lib/kv.js';
import { withTenantIsolation } from './middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
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
        default:
          return res.status(405).json({ error: 'Method not allowed' });
      }
    } catch (error) {
      console.error('Tenant Billing API error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })(request, response);
}

async function handleGet(request, response, context) {
  const { action } = request.query;

  const tenant = await kv.get(`tenant:${context.tenantId}`);
  if (!tenant) return response.status(404).json({ error: 'Tenant not found' });

  switch (action) {
    case 'invoices':
      return await getInvoices(context, response);
    case 'usage':
      return await getUsage(context, response);
    case 'payment_methods':
      return await getPaymentMethods(context, response);
    case 'upcoming':
      return await getUpcomingInvoice(context, response);
    default:
      return response.json({
        billing: tenant.billing,
        plan: tenant.plan,
        planLimits: tenant.planLimits,
        features: tenant.features,
        balance: await getBalance(context)
      });
  }
}

async function handlePost(request, response, context) {
  const { action, ...data } = request.body;

  switch (action) {
    case 'change_plan':
      return await changePlan(context, response, data.plan);
    case 'add_payment_method':
      return await addPaymentMethod(context, response, data);
    case 'create_invoice':
      return await createManualInvoice(context, response, data);
    case 'apply_coupon':
      return await applyCoupon(context, response, data.coupon);
    default:
      return response.status(400).json({ error: 'Invalid action' });
  }
}

async function handlePut(request, response, context) {
  const { action, ...data } = request.body;

  switch (action) {
    case 'update_payment_method':
      return await updatePaymentMethod(context, response, data);
    case 'cancel_subscription':
      return await cancelSubscription(context, response);
    case 'reactivate_subscription':
      return await reactivateSubscription(context, response);
    default:
      return response.status(400).json({ error: 'Invalid action' });
  }
}

// ============ HELPER FUNCTIONS ============

async function getInvoices(context, response) {
  const invoices = [];
  const invoiceIds = await kv.smembers(`tenant:${context.tenantId}:invoices`) || [];
  
  for (const iid of invoiceIds) {
    const invoice = await kv.get(`invoice:${iid}`);
    if (invoice) invoices.push(invoice);
  }
  
  invoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  response.json({ invoices });
}

async function getUsage(context, response) {
  const stats = await kv.hgetall(`tenant:${context.tenantId}:stats`);
  const tenant = await kv.get(`tenant:${context.tenantId}`);
  
  const usage = {
    affiliates: {
      current: parseInt(stats?.totalAffiliates || '0'),
      limit: tenant.planLimits.maxAffiliates,
      percentage: tenant.planLimits.maxAffiliates === -1 ? 0 : (parseInt(stats?.totalAffiliates || '0') / tenant.planLimits.maxAffiliates) * 100
    },
    campaigns: {
      current: parseInt(stats?.totalCampaigns || '0'),
      limit: tenant.planLimits.maxCampaigns,
      percentage: tenant.planLimits.maxCampaigns === -1 ? 0 : (parseInt(stats?.totalCampaigns || '0') / tenant.planLimits.maxCampaigns) * 100
    },
    storage: {
      current: parseFloat(stats?.storageUsedGB || '0'),
      limit: tenant.planLimits.maxStorageGB,
      percentage: tenant.planLimits.maxStorageGB === -1 ? 0 : (parseFloat(stats?.storageUsedGB || '0') / tenant.planLimits.maxStorageGB) * 100
    },
    apiCalls: {
      current: parseInt(stats?.apiCallsThisMonth || '0'),
      limit: tenant.planLimits.apiRateLimit * 43200, // per month approx
      percentage: tenant.planLimits.apiRateLimit === -1 ? 0 : (parseInt(stats?.apiCallsThisMonth || '0') / (tenant.planLimits.apiRateLimit * 43200)) * 100
    },
    revenue: {
      currentMonth: parseFloat(stats?.revenueThisMonth || '0'),
      total: parseFloat(stats?.totalRevenue || '0')
    },
    period: {
      start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString()
    }
  };
  
  response.json({ usage });
}

async function getPaymentMethods(context, response) {
  const methods = [];
  const methodIds = await kv.smembers(`tenant:${context.tenantId}:payment_methods`) || [];
  
  for (const mid of methodIds) {
    const method = await kv.get(`payment_method:${mid}`);
    if (method) {
      // Don't return full sensitive data
      methods.push({
        id: method.id,
        type: method.type,
        brand: method.brand,
        last4: method.last4,
        expiryMonth: method.expiryMonth,
        expiryYear: method.expiryYear,
        isDefault: method.isDefault,
        createdAt: method.createdAt
      });
    }
  }
  
  response.json({ paymentMethods: methods });
}

async function getUpcomingInvoice(context, response) {
  const tenant = await kv.get(`tenant:${context.tenantId}`);
  const nextBilling = tenant.billing?.nextBillingDate;
  
  if (!nextBilling) {
    return response.json({ upcoming: null });
  }
  
  // Calculate estimated amount based on usage
  const stats = await kv.hgetall(`tenant:${context.tenantId}:stats`);
  const baseAmount = tenant.billing.amount;
  let estimatedAmount = baseAmount;
  
  // Add overage charges if applicable
  if (tenant.planLimits.maxAffiliates !== -1) {
    const affiliateCount = parseInt(stats?.totalAffiliates || '0');
    const overage = Math.max(0, affiliateCount - tenant.planLimits.maxAffiliates);
    estimatedAmount += overage * 5; // $5 per extra affiliate
  }
  
  response.json({
    upcoming: {
      amount: estimatedAmount,
      currency: tenant.billing.currency,
      dueDate: nextBilling,
      baseAmount,
      overageAmount: estimatedAmount - baseAmount,
      description: `${tenant.plan} plan renewal`
    }
  });
}

async function getBalance(context, response) {
  const stats = await kv.hgetall(`tenant:${context.tenantId}:stats`);
  const balance = {
    available: parseFloat(stats?.balance || '0'),
    pending: parseFloat(stats?.pendingBalance || '0'),
    currency: 'USD'
  };
  return balance;
}

async function changePlan(context, response, newPlan) {
  const validPlans = ['starter', 'professional', 'business', 'enterprise'];
  if (!validPlans.includes(newPlan)) {
    return response.status(400).json({ error: 'Invalid plan' });
  }

  const tenant = await kv.get(`tenant:${context.tenantId}`);
  if (!tenant) return response.status(404).json({ error: 'Tenant not found' });

  const currentPlan = tenant.plan;
  if (currentPlan === newPlan) {
    return response.status(400).json({ error: 'Already on this plan' });
  }

  const newLimits = getPlanLimits(newPlan);
  
  // Check if current usage fits in new plan (for downgrades)
  const stats = await kv.hgetall(`tenant:${context.tenantId}:stats`);
  if (newLimits.maxAffiliates !== -1) {
    const affiliateCount = parseInt(stats?.totalAffiliates || '0');
    if (affiliateCount > newLimits.maxAffiliates) {
      return response.status(400).json({ 
        error: `Cannot downgrade: ${affiliateCount} affiliates exceeds ${newPlan} limit of ${newLimits.maxAffiliates}` 
      });
    }
  }
  if (newLimits.maxCampaigns !== -1) {
    const campaignCount = parseInt(stats?.totalCampaigns || '0');
    if (campaignCount > newLimits.maxCampaigns) {
      return response.status(400).json({ 
        error: `Cannot downgrade: ${campaignCount} campaigns exceeds ${newPlan} limit of ${newLimits.maxCampaigns}` 
      });
    }
  }

  const now = new Date().toISOString();
  const proration = calculateProration(tenant, newPlan);

  const updated = {
    ...tenant,
    plan: newPlan,
    planLimits: newLimits,
    features: getPlanFeatures(newPlan),
    settings: {
      ...tenant.settings,
      maxAffiliates: newLimits.maxAffiliates,
      maxCampaigns: newLimits.maxCampaigns,
      maxStorageGB: newLimits.maxStorageGB
    },
    billing: {
      ...tenant.billing,
      amount: newLimits.price,
      prorationCredit: proration.credit,
      prorationCharge: proration.charge
    },
    updatedAt: now
  };

  await kv.set(`tenant:${context.tenantId}`, updated);

  // Create invoice for plan change if there's a charge
  if (proration.charge > 0) {
    await createPlanChangeInvoice(context, newPlan, proration);
  }

  response.json({
    success: true,
    plan: newPlan,
    proration,
    effectiveImmediately: true
  });
}

async function addPaymentMethod(context, response, data) {
  const { type, token, setAsDefault } = data; // token from Stripe.js, etc.
  
  if (!type || !token) {
    return response.status(400).json({ error: 'Payment method type and token required' });
  }

  // In production, attach payment method to customer in Stripe
  // For now, create mock payment method
  const id = `pm_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  const method = {
    id,
    tenantId: context.tenantId,
    type, // 'card', 'bank_account', 'crypto'
    brand: data.brand || 'Visa',
    last4: data.last4 || '4242',
    expiryMonth: data.expiryMonth || 12,
    expiryYear: data.expiryYear || 2025,
    isDefault: setAsDefault || false,
    createdAt: now,
    metadata: data.metadata || {}
  };

  // If setting as default, unset other defaults
  if (method.isDefault) {
    const existingIds = await kv.smembers(`tenant:${context.tenantId}:payment_methods`) || [];
    for (const eid of existingIds) {
      const existing = await kv.get(`payment_method:${eid}`);
      if (existing && existing.isDefault) {
        await kv.set(`payment_method:${eid}`, { ...existing, isDefault: false });
      }
    }
  }

  await Promise.all([
    kv.set(`payment_method:${id}`, method),
    kv.sadd(`tenant:${context.tenantId}:payment_methods`, id)
  ]);

  // Update tenant billing
  const tenant = await kv.get(`tenant:${context.tenantId}`);
  await kv.set(`tenant:${context.tenantId}`, {
    ...tenant,
    billing: {
      ...tenant.billing,
      paymentMethod: id
    }
  });

  response.status(201).json(method);
}

async function updatePaymentMethod(context, response, data) {
  const { id, ...updates } = data;
  if (!id) return response.status(400).json({ error: 'Payment method ID required' });

  const existing = await kv.get(`payment_method:${id}`);
  if (!existing) return response.status(404).json({ error: 'Payment method not found' });
  if (existing.tenantId !== context.tenantId) return response.status(403).json({ error: 'Forbidden' });

  const updated = { ...existing, ...updates };
  await kv.set(`payment_method:${id}`, updated);

  response.json(updated);
}

async function cancelSubscription(context, response) {
  const tenant = await kv.get(`tenant:${context.tenantId}`);
  if (!tenant) return response.status(404).json({ error: 'Tenant not found' });

  if (tenant.status === 'cancelled') {
    return response.status(400).json({ error: 'Already cancelled' });
  }

  const now = new Date().toISOString();
  const updated = {
    ...tenant,
    status: 'cancelled',
    cancelledAt: now,
    billing: {
      ...tenant.billing,
      cancelledAt: now,
      cancelAtPeriodEnd: true
    }
  };

  await kv.set(`tenant:${context.tenantId}`, updated);

  response.json({ success: true, message: 'Subscription cancelled at period end' });
}

async function reactivateSubscription(context, response) {
  const tenant = await kv.get(`tenant:${context.tenantId}`);
  if (!tenant) return response.status(404).json({ error: 'Tenant not found' });

  if (tenant.status !== 'cancelled') {
    return response.status(400).json({ error: 'Not cancelled' });
  }

  const now = new Date().toISOString();
  const updated = {
    ...tenant,
    status: 'active',
    cancelledAt: null,
    billing: {
      ...tenant.billing,
      cancelledAt: null,
      cancelAtPeriodEnd: false,
      nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }
  };

  await kv.set(`tenant:${context.tenantId}`, updated);

  response.json({ success: true, message: 'Subscription reactivated' });
}

async function createManualInvoice(context, response, data) {
  const { amount, description, dueDate } = data;
  if (!amount || amount <= 0) return response.status(400).json({ error: 'Valid amount required' });

  const id = `inv_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  const invoice = {
    id,
    tenantId: context.tenantId,
    amount: parseFloat(amount.toFixed(2)),
    currency: 'USD',
    description: description || 'Manual invoice',
    status: 'open',
    dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    items: data.items || [{ description: description || 'Manual charge', amount: parseFloat(amount.toFixed(2)) }]
  };

  await Promise.all([
    kv.set(`invoice:${id}`, invoice),
    kv.sadd(`tenant:${context.tenantId}:invoices`, id)
  ]);

  response.status(201).json(invoice);
}

async function applyCoupon(context, response, couponCode) {
  // In production, validate against coupon database
  const coupons = {
    'WELCOME20': { type: 'percent', value: 20, maxMonths: 3 },
    'SAVE50': { type: 'flat', value: 50, maxMonths: 1 },
    'ENTERPRISE_TRIAL': { type: 'trial', days: 30 }
  };

  const coupon = coupons[couponCode];
  if (!coupon) return response.status(404).json({ error: 'Invalid coupon' });

  const tenant = await kv.get(`tenant:${context.tenantId}`);
  const now = new Date().toISOString();

  const updated = {
    ...tenant,
    billing: {
      ...tenant.billing,
      coupon: couponCode,
      couponAppliedAt: now,
      couponExpiresAt: coupon.maxMonths 
        ? new Date(Date.now() + coupon.maxMonths * 30 * 24 * 60 * 60 * 1000).toISOString()
        : null
    }
  };

  await kv.set(`tenant:${context.tenantId}`, updated);

  response.json({ success: true, coupon });
}

async function createPlanChangeInvoice(context, newPlan, proration) {
  const id = `inv_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  const invoice = {
    id,
    tenantId: context.tenantId,
    amount: proration.charge,
    currency: 'USD',
    description: `Plan change to ${newPlan}`,
    status: 'open',
    dueDate: now,
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    items: [
      { description: `${newPlan} plan`, amount: getPlanLimits(newPlan).price },
      { description: 'Proration adjustment', amount: proration.charge - getPlanLimits(newPlan).price }
    ],
    metadata: { type: 'plan_change', newPlan }
  };

  await Promise.all([
    kv.set(`invoice:${id}`, invoice),
    kv.sadd(`tenant:${context.tenantId}:invoices`, id)
  ]);
}

function calculateProration(tenant, newPlan) {
  const currentPrice = tenant.billing.amount;
  const newPrice = getPlanLimits(newPlan).price;
  const billingCycle = tenant.billing.cycle === 'yearly' ? 365 : 30;
  const daysUsed = Math.floor((Date.now() - new Date(tenant.billing.nextBillingDate - billingCycle * 24 * 60 * 60 * 1000).getTime()) / (24 * 60 * 60 * 1000));
  const daysRemaining = billingCycle - daysUsed;
  
  const currentDaily = currentPrice / billingCycle;
  const newDaily = newPrice / billingCycle;
  const diff = newDaily - currentDaily;
  
  let credit = 0;
  let charge = 0;
  
  if (diff > 0) {
    charge = Math.round(diff * daysRemaining * 100) / 100;
  } else {
    credit = Math.round(Math.abs(diff) * daysRemaining * 100) / 100;
  }
  
  return { credit, charge, daysRemaining };
}

function getPlanLimits(plan) {
  const plans = {
    starter: { price: 29, maxAffiliates: 10, maxCampaigns: 5, maxStorageGB: 10, apiRateLimit: 100 },
    professional: { price: 99, maxAffiliates: 100, maxCampaigns: 50, maxStorageGB: 100, apiRateLimit: 1000 },
    business: { price: 299, maxAffiliates: 1000, maxCampaigns: 500, maxStorageGB: 1000, apiRateLimit: 5000 },
    enterprise: { price: 999, maxAffiliates: -1, maxCampaigns: -1, maxStorageGB: -1, apiRateLimit: 50000 }
  };
  return plans[plan] || plans.starter;
}

function getPlanFeatures(plan) {
  const features = {
    starter: { affiliateProgram: true, multiLevelReferrals: false, customCommissionRates: false, dedicatedSupport: false, sla: '99%', apiRateLimit: 100 },
    professional: { affiliateProgram: true, multiLevelReferrals: true, customCommissionRates: false, dedicatedSupport: false, sla: '99.5%', apiRateLimit: 1000 },
    business: { affiliateProgram: true, multiLevelReferrals: true, customCommissionRates: true, dedicatedSupport: true, sla: '99.9%', apiRateLimit: 5000 },
    enterprise: { affiliateProgram: true, multiLevelReferrals: true, customCommissionRates: true, dedicatedSupport: true, sla: '99.99%', apiRateLimit: 50000 }
  };
  return features[plan] || features.starter;
}
