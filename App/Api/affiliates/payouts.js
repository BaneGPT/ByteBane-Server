// vercel-dashboard/api/affiliates/payouts.js
// Payout Management API

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  try {
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
    console.error('Payouts API error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/affiliates/payouts - List payouts
async function handleGet(request, response) {
  const { affiliateId, id, status, limit = 50, offset = 0 } = request.query;

  const auth = await verifyAuth(request);
  if (!auth.valid) return response.status(401).json({ error: 'Unauthorized' });

  const targetAffiliateId = affiliateId || auth.affiliateId;
  if (!targetAffiliateId && auth.role !== 'admin') {
    return response.status(400).json({ error: 'Affiliate ID required' });
  }

  // Check permissions
  if (auth.role !== 'admin' && targetAffiliateId !== auth.affiliateId) {
    return response.status(403).json({ error: 'Forbidden' });
  }

  if (id) {
    const payout = await kv.get(`payout:${id}`);
    if (!payout) return response.status(404).json({ error: 'Payout not found' });
    return response.json(payout);
  }

  // List payouts
  let payoutIds = await kv.smembers(`affiliate:${targetAffiliateId}:payouts`) || [];

  // Admin can see all
  if (auth.role === 'admin' && !affiliateId) {
    // Get all payout IDs from all affiliates
    const allAffiliateIds = await kv.smembers('global:affiliates') || [];
    const allPayoutIds = [];
    for (const aid of allAffiliateIds) {
      const ids = await kv.smembers(`affiliate:${aid}:payouts`) || [];
      allPayoutIds.push(...ids);
    }
    payoutIds = [...new Set(allPayoutIds)];
  }

  // Filter by status
  if (status) {
    const filtered = [];
    for (const pid of payoutIds) {
      const p = await kv.get(`payout:${pid}`);
      if (p && p.status === status) filtered.push(pid);
    }
    payoutIds = filtered;
  }

  // Sort by creation date (newest first)
  const payoutsWithTime = [];
  for (const pid of payoutIds) {
    const p = await kv.get(`payout:${pid}`);
    if (p) payoutsWithTime.push({ id: pid, createdAt: p.createdAt });
  }
  payoutsWithTime.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Paginate
  const start = parseInt(offset);
  const lim = parseInt(limit);
  const paginatedIds = payoutsWithTime.slice(start, start + lim).map(p => p.id);

  const payouts = [];
  for (const pid of paginatedIds) {
    const p = await kv.get(`payout:${pid}`);
    if (p) {
      const affiliate = await kv.get(`affiliate:${p.affiliateId}`);
      payouts.push({
        ...p,
        affiliateUsername: affiliate?.username || 'Unknown',
        affiliateEmail: affiliate?.email || 'Unknown'
      });
    }
  }

  response.json({
    payouts,
    total: payoutIds.length,
    page: Math.floor(start / lim) + 1,
    pageSize: lim
  });
}

// POST /api/affiliates/payouts - Request payout (affiliate) or Create payout (admin)
async function handlePost(request, response) {
  const { affiliateId, amount, walletAddress, walletType, notes } = request.body;

  const auth = await verifyAuth(request);
  if (!auth.valid) return response.status(401).json({ error: 'Unauthorized' });

  let targetAffiliateId = affiliateId;

  if (auth.role === 'admin') {
    if (!targetAffiliateId) return response.status(400).json({ error: 'Affiliate ID required for admin payout' });
  } else {
    targetAffiliateId = auth.affiliateId;
  }

  const affiliate = await kv.get(`affiliate:${targetAffiliateId}`);
  if (!affiliate) return response.status(404).json({ error: 'Affiliate not found' });

  const stats = await kv.hgetall(`affiliate:${targetAffiliateId}:stats`) || {};
  const pendingEarnings = parseFloat(stats.pendingEarnings || '0');

  const payoutAmount = amount || pendingEarnings;
  if (payoutAmount <= 0) return response.status(400).json({ error: 'No pending earnings to payout' });
  if (payoutAmount > pendingEarnings) return response.status(400).json({ error: 'Insufficient pending earnings' });

  // Check minimum threshold
  const threshold = affiliate.settings?.payoutThreshold || 100;
  if (payoutAmount < threshold && auth.role !== 'admin') {
    return response.status(400).json({ error: `Minimum payout amount is $${threshold}` });
  }

  // Use provided wallet or affiliate's default
  const finalWalletAddress = walletAddress || affiliate.walletAddress;
  const finalWalletType = walletType || affiliate.walletType;

  if (!finalWalletAddress) {
    return response.status(400).json({ error: 'No wallet address configured' });
  }

  const id = `payout_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  const payout = {
    id,
    affiliateId: targetAffiliateId,
    amount: parseFloat(payoutAmount.toFixed(2)),
    currency: affiliate.settings?.preferredCurrency || 'USD',
    walletAddress: finalWalletAddress,
    walletType: finalWalletType,
    status: auth.role === 'admin' ? 'processing' : 'requested',
    requestedAt: now,
    processedAt: null,
    completedAt: null,
    txHash: null,
    fee: calculateFee(payoutAmount, finalWalletType),
    netAmount: parseFloat((payoutAmount - calculateFee(payoutAmount, finalWalletType)).toFixed(2)),
    notes: notes || (auth.role === 'admin' ? 'Admin initiated' : 'Affiliate requested'),
    adminNotes: auth.role === 'admin' ? notes : null,
    retryCount: 0,
    metadata: {
      requestedBy: auth.role === 'admin' ? 'admin' : 'affiliate',
      ip: request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.headers['x-real-ip']
    }
  };

  // Save payout
  await Promise.all([
    kv.set(`payout:${id}`, payout),
    kv.sadd(`affiliate:${targetAffiliateId}:payouts`, id),
    kv.hincrbyfloat(`affiliate:${targetAffiliateId}:stats`, 'pendingEarnings', -payoutAmount),
    kv.hincrbyfloat(`affiliate:${targetAffiliateId}:stats`, 'paidOut', payoutAmount)
  ]);

  // Log activity
  await kv.lpush(`affiliate:${targetAffiliateId}:payout_activity`, JSON.stringify({
    payoutId: id,
    action: 'requested',
    amount: payoutAmount,
    status: payout.status,
    createdAt: now
  }));
  await kv.ltrim(`affiliate:${targetAffiliateId}:payout_activity`, 0, 99);

  response.status(201).json(payout);
}

// PUT /api/affiliates/payouts - Update payout (admin only)
async function handlePut(request, response) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Payout ID required' });

  const auth = await verifyAuth(request);
  if (!auth.valid || auth.role !== 'admin') {
    return response.status(403).json({ error: 'Admin access required' });
  }

  const payout = await kv.get(`payout:${id}`);
  if (!payout) return response.status(404).json({ error: 'Payout not found' });

  const now = new Date().toISOString();
  const updated = { ...payout, ...updates, updatedAt: now };

  // Handle status transitions
  if (updates.status && updates.status !== payout.status) {
    switch (updates.status) {
      case 'processing':
        updated.processedAt = now;
        break;
      case 'completed':
        updated.completedAt = now;
        if (updates.txHash) updated.txHash = updates.txHash;
        break;
      case 'failed':
        // Refund pending earnings
        await kv.hincrbyfloat(`affiliate:${payout.affiliateId}:stats`, 'pendingEarnings', payout.amount);
        await kv.hincrbyfloat(`affiliate:${payout.affiliateId}:stats`, 'paidOut', -payout.amount);
        break;
      case 'cancelled':
        // Refund pending earnings
        await kv.hincrbyfloat(`affiliate:${payout.affiliateId}:stats`, 'pendingEarnings', payout.amount);
        await kv.hincrbyfloat(`affiliate:${payout.affiliateId}:stats`, 'paidOut', -payout.amount);
        break;
    }
  }

  await kv.set(`payout:${id}`, updated);

  // Log activity
  await kv.lpush(`affiliate:${payout.affiliateId}:payout_activity`, JSON.stringify({
    payoutId: id,
    action: 'status_change',
    from: payout.status,
    to: updated.status,
    amount: payout.amount,
    createdAt: now
  }));
  await kv.ltrim(`affiliate:${payout.affiliateId}:payout_activity`, 0, 99);

  response.json(updated);
}

// DELETE /api/affiliates/payouts - Cancel payout request (affiliate) or Delete (admin)
async function handleDelete(request, response) {
  const { id } = request.query;
  if (!id) return response.status(400).json({ error: 'Payout ID required' });

  const auth = await verifyAuth(request);
  if (!auth.valid) return response.status(401).json({ error: 'Unauthorized' });

  const payout = await kv.get(`payout:${id}`);
  if (!payout) return response.status(404).json({ error: 'Payout not found' });

  // Check permissions
  if (auth.role !== 'admin' && payout.affiliateId !== auth.affiliateId) {
    return response.status(403).json({ error: 'Forbidden' });
  }

  // Can only cancel if requested or processing
  if (!['requested', 'processing'].includes(payout.status)) {
    return response.status(400).json({ error: `Cannot cancel payout with status: ${payout.status}` });
  }

  // Refund
  await Promise.all([
    kv.hincrbyfloat(`affiliate:${payout.affiliateId}:stats`, 'pendingEarnings', payout.amount),
    kv.hincrbyfloat(`affiliate:${payout.affiliateId}:stats`, 'paidOut', -payout.amount),
    kv.set(`payout:${id}`, { ...payout, status: 'cancelled', cancelledAt: new Date().toISOString() })
  ]);

  // Log activity
  await kv.lpush(`affiliate:${payout.affiliateId}:payout_activity`, JSON.stringify({
    payoutId: id,
    action: 'cancelled',
    amount: payout.amount,
    createdAt: new Date().toISOString()
  }));
  await kv.ltrim(`affiliate:${payout.affiliateId}:payout_activity`, 0, 99);

  response.json({ success: true, message: 'Payout cancelled and amount refunded to pending earnings' });
}

// ============ HELPER FUNCTIONS ============

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

function calculateFee(amount, walletType) {
  const fees = {
    'BTC': 0.0005, // Fixed BTC fee ~$20-30
    'ETH': 0.005,  // Fixed ETH fee ~$10-15
    'USDT': 5,     // $5 fixed
    'XMR': 0.0001, // Minimal XMR fee
    'LTC': 0.001,
    'BCH': 0.0001
  };
  return fees[walletType] || 10; // Default $10
}
