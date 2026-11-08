// vercel-dashboard/api/affiliate/tickets.js
// Affiliate support tickets

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
        return await handleGet(request, response, affiliateId);
      case 'POST':
        return await handlePost(request, response, affiliateId);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Affiliate tickets error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response, affiliateId) {
  const { status, page = 1, limit = 20 } = request.query;
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);

  const ticketIds = await kv.smembers(`affiliate:${affiliateId}:tickets`) || [];
  const tickets = [];

  for (const tid of ticketIds) {
    const ticket = await kv.get(`ticket:${tid}`);
    if (ticket && (!status || ticket.status === status)) {
      // Don't send full replies in list view
      const { replies, ...ticketSummary } = ticket;
      tickets.push({
        ...ticketSummary,
        replyCount: replies?.length || 0,
        lastReplyAt: replies?.[replies.length - 1]?.createdAt || ticket.createdAt,
      });
    }
  }

  tickets.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const start = (pageNum - 1) * limitNum;
  const paginated = tickets.slice(start, start + limitNum);

  return response.json({
    tickets: paginated,
    total: tickets.length,
    page: pageNum,
    pageSize: limitNum,
  });
}

async function handlePost(request, response, affiliateId) {
  const { subject, message, priority = 'medium', category = 'technical' } = request.body;

  if (!subject || !message) {
    return response.status(400).json({ error: 'Subject and message required' });
  }

  const affiliate = await kv.get(`affiliate:${affiliateId}`);
  if (!affiliate) {
    return response.status(404).json({ error: 'Affiliate not found' });
  }

  const ticketId = `ticket_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  const ticket = {
    id: ticketId,
    affiliateId,
    affiliateUsername: affiliate.username,
    subject,
    status: 'open',
    priority,
    category,
    createdAt: now,
    updatedAt: now,
    lastReplyAt: now,
    replies: [{
      id: `reply_${Date.now()}`,
      author: 'affiliate',
      authorName: affiliate.username,
      message,
      attachments: [],
      createdAt: now,
      internal: false,
    }],
    unreadCount: 0,
  };

  await kv.set(`ticket:${ticketId}`, ticket);
  await kv.sadd(`affiliate:${affiliateId}:tickets`, ticketId);
  await kv.sadd(`global:tickets`, ticketId);

  // Notify support (in production: webhook, email, etc.)
  await notifySupport(ticket);

  return response.status(201).json(ticket);
}

async function notifySupport(ticket) {
  console.log('New ticket created:', ticket.id, ticket.subject);
  // In production: send to Discord, email, etc.
}