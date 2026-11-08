// vercel-dashboard/api/affiliate/payouts.js
// Affiliate payout management

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  const auth = await verifyPayloadApiKey(request);
  if (!auth.valid || auth.role !== 'campaign') {
    return response.status(403).json({ error: 'Affiliate access required' });
  }

  const affiliateId = `aff_${auth.campaignId.replace('camp_', '')}`;

  try {
    switch (request.method) {
      case 'GET':
        return await handleGet(request, response, affiliateId);
      case 'POST':
        return await handlePost(request, response, affiliateId);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Affiliate payouts error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response, affiliateId) {
  const { status, page = 1, limit = 20 } = request.query;
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);

  const payoutIds = await kv.smembers(`affiliate:${affiliateId}:payouts`) || [];
  const payouts = [];

  for (const pid of payoutIds) {
    const payout = await kv.get(`payout:${pid}`);
    if (payout && (!status || payout.status === status)) {
      payouts.push(payout);
    }
  }

  payouts.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

  const start = (pageNum - 1) * limitNum;
  const paginated = payouts.slice(start, start + limitNum);

  return response.json({
    payouts: paginated,
    total: payouts.length,
    page: pageNum,
    pageSize: limitNum,
  });
}

async function handlePost(request, response, affiliateId) {
  const { amount, walletAddress } = request.body;

  if (!amount || amount < 10) {
    return response.status(400).json({ error: 'Minimum payout amount is $10' });
  }
  if (!walletAddress) {
    return response.status(400).json({ error: 'Wallet address required' });
  }

  // Check available balance
  const affiliate = await kv.get(`affiliate:${affiliateId}`);
  if (!affiliate) {
    return response.status(404).json({ error: 'Affiliate not found' });
  }

  // Calculate available balance (mock)
  const campaignIds = await kv.smembers(`affiliate:${affiliateId}:campaigns`) || [];
  let totalEarned = 0;
  for (const cid of campaignIds) {
    const stats = await kv.hgetall(`campaign:${cid}:stats`) || {};
    totalEarned += parseInt(stats.totalFiles || '0') * 0.5;
  }

  const payoutIds = await kv.smembers(`affiliate:${affiliateId}:payouts`) || [];
  let paidOut = 0;
  let pendingOut = 0;
  for (const pid of payoutIds) {
    const payout = await kv.get(`payout:${pid}`);
    if (payout) {
      if (payout.status === 'completed') paidOut += payout.amount;
      else if (payout.status === 'pending' || payout.status === 'processing') pendingOut += payout.amount;
    }
  }

  const available = totalEarned - paidOut - pendingOut;
  if (amount > available) {
    return response.status(400).json({ error: `Insufficient balance. Available: $${available.toFixed(2)}` });
  }

  // Create payout
  const payoutId = `payout_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const payout = {
    id: payoutId,
    affiliateId,
    amount,
    walletAddress,
    status: 'pending',
    requestedAt: new Date().toISOString(),
    networkFee: amount * 0.01, // 1% network fee estimate
    netAmount: amount * 0.99,
  };

  await kv.set(`payout:${payoutId}`, payout);
  await kv.sadd(`affiliate:${affiliateId}:payouts`, payoutId);

  // Notify admin (in production, this would trigger a webhook)
  await notifyAdminPayout(payout);

  return response.status(201).json(payout);
}

async function notifyAdminPayout(payout) {
  // In production: send to admin webhook, Discord, etc.
  console.log('New payout request:', payout);
}