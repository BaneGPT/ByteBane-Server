// vercel-dashboard/api/affiliate/tickets/[id].js
// Affiliate ticket detail and replies

import { kv } from '../../../lib/kv.js';
import { verifyPayloadApiKey } from '../../auth/middleware.js';

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
  const { id } = request.query;

  if (!id) return response.status(400).json({ error: 'Ticket ID required' });

  try {
    // Verify ownership
    const ticketIds = await kv.smembers(`affiliate:${affiliateId}:tickets`) || [];
    if (!ticketIds.includes(id)) {
      return response.status(403).json({ error: 'Access denied' });
    }

    const ticket = await kv.get(`ticket:${id}`);
    if (!ticket) return response.status(404).json({ error: 'Ticket not found' });

    switch (request.method) {
      case 'GET':
        return response.json(ticket);
      case 'POST':
        return await handleReply(request, response, ticket, affiliate);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Affiliate ticket detail error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleReply(request, response, ticket, auth) {
  const { message } = request.body;
  if (!message || !message.trim()) {
    return response.status(400).json({ error: 'Message required' });
  }

  const affiliate = await kv.get(`affiliate:${affiliateId}`);
  if (!affiliate) {
    return response.status(404).json({ error: 'Affiliate not found' });
  }

  const reply = {
    id: `reply_${Date.now()}`,
    author: 'affiliate',
    authorName: affiliate.username,
    message: message.trim(),
    attachments: [],
    createdAt: new Date().toISOString(),
    internal: false,
  };

  ticket.replies = ticket.replies || [];
  ticket.replies.push(reply);
  ticket.updatedAt = new Date().toISOString();
  ticket.lastReplyAt = reply.createdAt;
  ticket.status = 'waiting'; // Waiting for support

  await kv.set(`ticket:${id}`, ticket);

  // Notify support
  await notifySupportReply(ticket, reply);

  return response.json(ticket);
}

async function notifySupportReply(ticket, reply) {
  console.log('New reply on ticket:', ticket.id, 'from affiliate');
}