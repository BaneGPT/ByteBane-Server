// vercel-dashboard/api/auth/verify.js
// Simple API key verification for dashboard access

import { kv } from '../../lib/kv.js';

const MASTER_KEYS = [
  // Add your master keys here, or use environment variable
  // process.env.MASTER_API_KEY
];

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  const { apiKey } = request.body;
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');

  const key = apiKey || authHeader;
  if (!key) return response.status(401).json({ error: 'API key required' });

  // Check master keys
  if (MASTER_KEYS.includes(key) || key === process.env.MASTER_API_KEY) {
    return response.json({ valid: true, role: 'admin', permissions: ['*'] });
  }

  // Check if it's a campaign key
  const campaignIds = await kv.smembers('global:campaigns') || [];
  for (const cid of campaignIds) {
    const campaign = await kv.get(`campaign:${cid}`);
    if (campaign && campaign.apiKey === key) {
      return response.json({ 
        valid: true, 
        role: 'campaign', 
        campaignId: cid,
        campaignName: campaign.name,
        permissions: ['read:campaign', 'read:systems', 'read:files']
      });
    }
  }

  return response.status(401).json({ valid: false, error: 'Invalid API key' });
}
