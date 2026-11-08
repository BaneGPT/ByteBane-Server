// vercel-dashboard/api/payments/index.js
// Payment Processing API - Crypto & Fiat

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
      case 'PUT':
        return await handlePut(request, response, auth);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Payments API error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response, auth) {
  const { id, type, status, limit = 50, offset = 0 } = request.query;

  if (id) {
    const payment = await kv.get(`payment:${id}`);
    if (!payment) return response.status(404).json({ error: 'Payment not found' });
    
    // Check ownership
    if (auth.role !== 'admin' && payment.tenantId !== auth.tenantId && payment.affiliateId !== auth.affiliateId) {
      return response.status(403).json({ error: 'Forbidden' });
    }
    return response.json(payment);
  }

  // Build filter
  let paymentIds = [];
  
  if (auth.role === 'admin') {
    // Admin sees all
    paymentIds = await kv.smembers('global:payments') || [];
  } else if (auth.tenantId) {
    // Tenant sees their payments
    paymentIds = await kv.smembers(`tenant:${auth.tenantId}:payments`) || [];
  } else if (auth.affiliateId) {
    // Affiliate sees their payments
    paymentIds = await kv.smembers(`affiliate:${auth.affiliateId}:payments`) || [];
  }

  // Apply filters
  if (type) {
    const filtered = [];
    for (const pid of paymentIds) {
      const p = await kv.get(`payment:${pid}`);
      if (p && p.type === type) filtered.push(pid);
    }
    paymentIds = filtered;
  }

  if (status) {
    const filtered = [];
    for (const pid of paymentIds) {
      const p = await kv.get(`payment:${pid}`);
      if (p && p.status === status) filtered.push(pid);
    }
    paymentIds = filtered;
  }

  // Sort by date (newest first)
  const paymentsWithTime = [];
  for (const pid of paymentIds) {
    const p = await kv.get(`payment:${pid}`);
    if (p) paymentsWithTime.push({ id: pid, createdAt: p.createdAt });
  }
  paymentsWithTime.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Paginate
  const start = parseInt(offset);
  const lim = parseInt(limit);
  const paginatedIds = paymentsWithTime.slice(start, start + lim).map(p => p.id);

  const payments = [];
  for (const pid of paginatedIds) {
    const p = await kv.get(`payment:${pid}`);
    if (p) payments.push(p);
  }

  response.json({
    payments,
    total: paymentIds.length,
    page: Math.floor(start / lim) + 1,
    pageSize: lim
  });
}

async function handlePost(request, response, auth) {
  const { 
    amount, 
    currency, 
    type, // 'crypto', 'fiat', 'payout', 'deposit'
    method, // 'btc', 'eth', 'usdt', 'xmr', 'stripe', 'coinbase', 'manual'
    walletAddress,
    walletType,
    description,
    metadata,
    callbackUrl,
    webhookUrl
  } = request.body;

  if (!amount || amount <= 0) return response.status(400).json({ error: 'Valid amount required' });
  if (!currency) return response.status(400).json({ error: 'Currency required' });
  if (!type) return response.status(400).json({ error: 'Payment type required' });
  if (!method) return response.status(400).json({ error: 'Payment method required' });

  const tenantId = auth.tenantId || (await getTenantForAffiliate(auth.affiliateId));
  if (!tenantId && auth.role !== 'admin') {
    return response.status(400).json({ error: 'No tenant associated' });
  }

  const id = `pay_${type}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  // Calculate fees
  const feeInfo = calculateFees(amount, currency, method, type);

  const payment = {
    id,
    tenantId,
    affiliateId: auth.affiliateId || null,
    amount: parseFloat(amount.toFixed(8)),
    currency: currency.toUpperCase(),
    type, // 'deposit', 'payout', 'commission', 'subscription'
    method, // 'btc', 'eth', 'usdt', 'xmr', 'stripe', 'coinbase', 'manual'
    status: 'pending',
    fee: feeInfo.fee,
    netAmount: parseFloat((amount - feeInfo.fee).toFixed(8)),
    walletAddress: walletAddress || null,
    walletType: walletType || null,
    description: description || '',
    metadata: metadata || {},
    callbackUrl: callbackUrl || null,
    webhookUrl: webhookUrl || null,
    txHash: null,
    confirmations: 0,
    requiredConfirmations: getRequiredConfirmations(method),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    failedAt: null,
    failureReason: null,
    retryCount: 0,
    ip: request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.headers['x-real-ip']
  };

  // Generate payment address for crypto deposits
  if (type === 'deposit' && isCryptoMethod(method)) {
    payment.depositAddress = await generateDepositAddress(method, tenantId, id);
    payment.qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payment.depositAddress)}`;
  }

  // For fiat payments, create payment intent
  if (type === 'deposit' && isFiatMethod(method)) {
    const intent = await createFiatPaymentIntent(method, payment);
    payment.paymentIntentId = intent.id;
    payment.clientSecret = intent.clientSecret;
    payment.redirectUrl = intent.redirectUrl;
  }

  // Save payment
  const operations = [
    kv.set(`payment:${id}`, payment),
    kv.sadd('global:payments', id)
  ];

  if (tenantId) {
    operations.push(kv.sadd(`tenant:${tenantId}:payments`, id));
  }
  if (auth.affiliateId) {
    operations.push(kv.sadd(`affiliate:${auth.affiliateId}:payments`, id));
  }

  await Promise.all(operations);

  // If crypto deposit, start monitoring
  if (type === 'deposit' && isCryptoMethod(method)) {
    await startCryptoMonitoring(id, method, payment.depositAddress);
  }

  response.status(201).json(payment);
}

async function handlePut(request, response, auth) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Payment ID required' });

  const payment = await kv.get(`payment:${id}`);
  if (!payment) return response.status(404).json({ error: 'Payment not found' });

  // Check permissions
  if (auth.role !== 'admin') {
    if (payment.tenantId !== auth.tenantId && payment.affiliateId !== auth.affiliateId) {
      return response.status(403).json({ error: 'Forbidden' });
    }
    // Non-admins can only cancel pending payments
    if (updates.status && updates.status !== 'cancelled') {
      return response.status(403).json({ error: 'Cannot update payment status' });
    }
    if (payment.status !== 'pending' && updates.status === 'cancelled') {
      return response.status(400).json({ error: 'Can only cancel pending payments' });
    }
  }

  const now = new Date().toISOString();
  const updated = { ...payment, ...updates, updatedAt: now };

  // Handle status transitions
  if (updates.status && updates.status !== payment.status) {
    switch (updates.status) {
      case 'processing':
        updated.processedAt = now;
        break;
      case 'completed':
        updated.completedAt = now;
        updated.status = 'completed';
        if (updates.txHash) updated.txHash = updates.txHash;
        if (updates.confirmations) updated.confirmations = updates.confirmations;
        break;
      case 'failed':
        updated.failedAt = now;
        updated.failureReason = updates.failureReason || 'Unknown error';
        break;
      case 'cancelled':
        updated.cancelledAt = now;
        break;
    }
  }

  await kv.set(`payment:${id}`, updated);

  // Trigger webhook if configured
  if (payment.webhookUrl && updates.status) {
    await triggerWebhook(payment.webhookUrl, {
      event: `payment.${updates.status}`,
      payment: updated
    });
  }

  // If completed deposit, credit account
  if (updates.status === 'completed' && payment.type === 'deposit') {
    await creditAccount(payment);
  }

  response.json(updated);
}

function calculateFees(amount, currency, method, type) {
  const feeStructures = {
    // Crypto deposit fees (network fees paid by sender, we charge service fee)
    btc: { deposit: 0.0005, payout: 0.0005, service: 0.01 }, // 1% service fee
    eth: { deposit: 0.005, payout: 0.005, service: 0.01 },
    usdt: { deposit: 5, payout: 5, service: 0.01 },
    xmr: { deposit: 0.0001, payout: 0.0001, service: 0.01 },
    // Fiat fees
    stripe: { deposit: 0.029, fixed: 0.30, service: 0.01 }, // 2.9% + $0.30 + 1% service
    coinbase: { deposit: 0.01, service: 0.01 }, // 1% + 1% service
    manual: { deposit: 0, service: 0 }
  };

  const structure = feeStructures[method] || { service: 0.05 };
  let fee = 0;

  if (type === 'deposit') {
    if (structure.deposit !== undefined) {
      if (typeof structure.deposit === 'number' && structure.deposit < 1) {
        fee = amount * structure.deposit; // Percentage
      } else {
        fee = structure.deposit; // Fixed
      }
    }
    if (structure.fixed) fee += structure.fixed;
  } else if (type === 'payout') {
    if (structure.payout !== undefined) {
      fee = structure.payout;
    }
  }

  // Add service fee
  fee += amount * (structure.service || 0);

  return { fee: parseFloat(fee.toFixed(8)), structure };
}

function getRequiredConfirmations(method) {
  const confirmations = {
    btc: 3,
    eth: 12,
    usdt: 12, // ERC20
    xmr: 10,
    stripe: 0,
    coinbase: 0,
    manual: 0
  };
  return confirmations[method] || 0;
}

function isCryptoMethod(method) {
  return ['btc', 'eth', 'usdt', 'xmr', 'ltc', 'bch'].includes(method.toLowerCase());
}

function isFiatMethod(method) {
  return ['stripe', 'coinbase', 'manual', 'bank_transfer'].includes(method.toLowerCase());
}

async function generateDepositAddress(method, tenantId, paymentId) {
  // In production, use HD wallet derivation or payment processor
  // For now, return a placeholder
  const prefixes = {
    btc: 'bc1q',
    eth: '0x',
    usdt: '0x', // ERC20
    xmr: '4'
  };
  const prefix = prefixes[method] || 'addr_';
  return `${prefix}${tenantId}_${paymentId}_${Math.random().toString(36).substring(2, 20)}`;
}

async function createFiatPaymentIntent(method, payment) {
  // In production, integrate with Stripe, Coinbase Commerce, etc.
  // Return mock intent for now
  return {
    id: `pi_${payment.id}`,
    clientSecret: `cs_${Math.random().toString(36).substring(2, 30)}`,
    redirectUrl: `https://pay.example.com/${payment.id}`
  };
}

async function startCryptoMonitoring(paymentId, method, address) {
  // In production, this would:
  // 1. Subscribe to blockchain notifications (webhook from blockcypher, blocknative, etc.)
  // 2. Poll blockchain for incoming transactions
  // 3. Update payment status when confirmations reached
  
  // For now, schedule a check
  await kv.set(`crypto_monitor:${paymentId}`, {
    paymentId,
    method,
    address,
    startedAt: new Date().toISOString(),
    lastChecked: null,
    status: 'monitoring'
  });
}

async function creditAccount(payment) {
  const { tenantId, affiliateId, amount, currency, type } = payment;
  
  if (affiliateId && (type === 'commission' || type === 'deposit')) {
    await kv.hincrbyfloat(`affiliate:${affiliateId}:stats`, 'pendingEarnings', amount);
    await kv.hincrbyfloat(`affiliate:${affiliateId}:stats`, 'totalEarnings', amount);
  }
  
  if (tenantId && type === 'deposit') {
    await kv.hincrbyfloat(`tenant:${tenantId}:balance`, currency.toLowerCase(), amount);
  }
}

async function triggerWebhook(url, payload) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Webhook failed:', e);
  }
}

async function verifyAuth(request) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  if (!authHeader) return { valid: false };

  if (authHeader === process.env.MASTER_API_KEY) {
    return { valid: true, role: 'admin', tenantId: null, affiliateId: null };
  }

  // Check session (affiliate)
  const session = await kv.get(`session:${authHeader}`);
  if (session && new Date(session.expiresAt) > new Date()) {
    const affiliate = await kv.get(`affiliate:${session.affiliateId}`);
    return { 
      valid: true, 
      role: 'affiliate', 
      affiliateId: session.affiliateId,
      tenantId: affiliate?.tenantId || null
    };
  }

  // Check API key (tenant)
  const tenantIds = await kv.smembers('global:tenants') || [];
  for (const tid of tenantIds) {
    const tenant = await kv.get(`tenant:${tid}`);
    if (tenant && tenant.apiKey === authHeader) {
      return { valid: true, role: 'tenant', tenantId: tid, affiliateId: null };
    }
  }

  // Check affiliate API key
  const affiliateIds = await kv.smembers('global:affiliates') || [];
  for (const aid of affiliateIds) {
    const a = await kv.get(`affiliate:${aid}`);
    if (a && a.apiKey === authHeader) {
      return { valid: true, role: 'affiliate', affiliateId: aid, tenantId: a.tenantId || null };
    }
  }

  return { valid: false };
}

async function getTenantForAffiliate(affiliateId) {
  if (!affiliateId) return null;
  const affiliate = await kv.get(`affiliate:${affiliateId}`);
  return affiliate?.tenantId || null;
}
