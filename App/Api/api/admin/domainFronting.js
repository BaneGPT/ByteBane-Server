// vercel-dashboard/api/admin/domainFronting.js
// Domain Fronting / Cloudflare Workers Configuration

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
    console.error('Domain fronting error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response) {
  const { action, configId } = request.query;

  if (action === 'list') {
    const configIds = await kv.smembers('global:domainfront:configs') || [];
    const configs = [];

    for (const id of configIds) {
      const config = await kv.get(`domainfront:config:${id}`);
      if (config) {
        configs.push({
          id: config.id,
          name: config.name,
          provider: config.provider,
          frontDomain: config.frontDomain,
          originDomain: config.originDomain,
          status: config.status,
          workersCount: config.workers?.length || 0,
          createdAt: config.createdAt,
          lastDeployed: config.lastDeployed,
        });
      }
    }

    return response.json({ configs });
  }

  if (action === 'status' && configId) {
    const config = await kv.get(`domainfront:config:${configId}`);
    if (!config) return response.status(404).json({ error: 'Config not found' });

    // Check worker health
    const health = await checkWorkersHealth(config);

    return response.json({
      ...config,
      health,
      lastChecked: new Date().toISOString(),
    });
  }

  if (action === 'workerScript' && configId) {
    const config = await kv.get(`domainfront:config:${configId}`);
    if (!config) return response.status(404).json({ error: 'Config not found' });

    const script = generateWorkerScript(config);
    return response.setHeader('Content-Type', 'application/javascript').send(script);
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function handlePost(request, response) {
  const { action, name, provider, frontDomain, originDomain, routePattern, workers, headers, caching } = request.body;

  if (action === 'create') {
    return await createDomainFrontConfig(response, { name, provider, frontDomain, originDomain, routePattern, workers, headers, caching });
  }

  if (action === 'deploy' && request.body.configId) {
    return await deployConfig(response, request.body.configId);
  }

  if (action === 'test' && request.body.configId) {
    return await testConfig(response, request.body.configId);
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function handlePut(request, response) {
  const { configId, ...updates } = request.body;
  if (!configId) return response.status(400).json({ error: 'configId required' });

  const config = await kv.get(`domainfront:config:${configId}`);
  if (!config) return response.status(404).json({ error: 'Config not found' });

  const updated = {
    ...config,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await kv.set(`domainfront:config:${configId}`, updated);

  await logAuditEntry({
    actorId: 'admin',
    action: AuditActions.SETTINGS_CHANGED,
    resourceType: ResourceTypes.SETTINGS,
    resourceId: configId,
    severity: AuditSeverity.INFO,
    details: { type: 'domain_fronting_updated', updates: Object.keys(updates) },
  });

  return response.json(updated);
}

async function handleDelete(request, response) {
  const { configId } = request.query;
  if (!configId) return response.status(400).json({ error: 'configId required' });

  const config = await kv.get(`domainfront:config:${configId}`);
  if (!config) return response.status(404).json({ error: 'Config not found' });

  // Delete workers if deployed
  if (config.workers) {
    for (const worker of config.workers) {
      await deleteWorker(config.provider, worker.id);
    }
  }

  await kv.del(`domainfront:config:${configId}`);
  await kv.srem('global:domainfront:configs', configId);

  await logAuditEntry({
    actorId: 'admin',
    action: AuditActions.DATA_DELETED,
    resourceType: ResourceTypes.SETTINGS,
    resourceId: configId,
    severity: AuditSeverity.WARNING,
    details: { type: 'domain_fronting_deleted', frontDomain: config.frontDomain },
  });

  return response.json({ success: true, deleted: configId });
}

async function createDomainFrontConfig(response, config) {
  if (!name || !provider || !frontDomain || !originDomain) {
    return response.status(400).json({ error: 'name, provider, frontDomain, and originDomain required' });
  }

  // Validate provider
  const validProviders = ['cloudflare', 'cloudfront', 'fastly', 'akamai'];
  if (!validProviders.includes(provider)) {
    return response.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
  }

  const configId = `df_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const domainFrontConfig = {
    id: configId,
    name,
    provider,
    frontDomain,
    originDomain,
    routePattern: routePattern || '/*',
    workers: workers || [],
    headers: headers || {},
    caching: caching || { enabled: true, ttl: 300, staleWhileRevalidate: 60 },
    status: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await kv.set(`domainfront:config:${configId}`, domainFrontConfig);
  await kv.sadd('global:domainfront:configs', configId);

  // Generate deployment artifacts
  const artifacts = generateDeploymentArtifacts(domainFrontConfig);

  await logAuditEntry({
    actorId: 'admin',
    action: 'domain_fronting_created',
    resourceType: ResourceTypes.SETTINGS,
    resourceId: configId,
    severity: AuditSeverity.INFO,
    details: { provider, frontDomain, originDomain },
  });

  return response.status(201).json({
    config: domainFrontConfig,
    artifacts,
    instructions: generateDeploymentInstructions(domainFrontConfig, artifacts),
  });
}

async function deployConfig(response, configId) {
  const config = await kv.get(`domainfront:config:${configId}`);
  if (!config) return response.status(404).json({ error: 'Config not found' });

  const results = [];

  for (const worker of config.workers) {
    try {
      const deployed = await deployWorker(config.provider, worker, config);
      results.push({ workerId: worker.id, success: true, url: deployed.url });
      
      // Update worker with deployment info
      worker.deployed = true;
      worker.deployedAt = new Date().toISOString();
      worker.url = deployed.url;
    } catch (error) {
      results.push({ workerId: worker.id, success: false, error: error.message });
    }
  }

  config.status = results.every(r => r.success) ? 'deployed' : 'partial';
  config.lastDeployed = new Date().toISOString();
  config.workers = config.workers.map(w => {
    const result = results.find(r => r.workerId === w.id);
    return { ...w, deployed: result?.success, deployedAt: result?.success ? new Date().toISOString() : null, url: result?.url };
  });

  await kv.set(`domainfront:config:${configId}`, config);

  await logAuditEntry({
    actorId: 'admin',
    action: 'domain_fronting_deployed',
    resourceType: ResourceTypes.SETTINGS,
    resourceId: configId,
    severity: AuditSeverity.INFO,
    details: { results },
  });

  return response.json({ config, results });
}

async function testConfig(response, configId) {
  const config = await kv.get(`domainfront:config:${configId}`);
  if (!config) return response.status(404).json({ error: 'Config not found' });

  const tests = [];

  // Test 1: Front domain resolves
  try {
    const frontIp = await resolveDomain(config.frontDomain);
    tests.push({ name: 'Front Domain Resolution', success: true, detail: frontIp });
  } catch (error) {
    tests.push({ name: 'Front Domain Resolution', success: false, error: error.message });
  }

  // Test 2: Origin domain resolves
  try {
    const originIp = await resolveDomain(config.originDomain);
    tests.push({ name: 'Origin Domain Resolution', success: true, detail: originIp });
  } catch (error) {
    tests.push({ name: 'Origin Domain Resolution', success: false, error: error.message });
  }

  // Test 3: Worker endpoints (if deployed)
  if (config.workers && config.workers.some(w => w.deployed)) {
    for (const worker of config.workers.filter(w => w.deployed)) {
      try {
        const response = await fetch(`https://${worker.url}`, { 
          method: 'HEAD',
          headers: { 'Host': config.frontDomain },
          timeout: 5000,
        });
        tests.push({ 
          name: `Worker ${worker.id} Health Check`, 
          success: response.ok, 
          detail: `Status: ${response.status}` 
        });
      } catch (error) {
        tests.push({ 
          name: `Worker ${worker.id} Health Check`, 
          success: false, 
          error: error.message 
        });
      }
    }
  }

  // Test 4: Domain fronting works
  try {
    const testUrl = `https://${config.frontDomain}${config.routePattern.replace('*', 'test')}`;
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: { 'Host': config.frontDomain },
      timeout: 10000,
    });
    tests.push({ 
      name: 'Domain Fronting Request', 
      success: response.ok, 
      detail: `Status: ${response.status}, Final URL: ${response.url}` 
    });
  } catch (error) {
    tests.push({ 
      name: 'Domain Fronting Request', 
      success: false, 
      error: error.message 
    });
  }

  const allPassed = tests.every(t => t.success);

  await logAuditEntry({
    actorId: 'admin',
    action: 'domain_fronting_tested',
    resourceType: ResourceTypes.SETTINGS,
    resourceId: configId,
    severity: AuditSeverity.INFO,
    details: { tests, allPassed },
  });

  return response.json({ tests, allPassed });
}

function generateDeploymentArtifacts(config) {
  return {
    workerScript: generateWorkerScript(config),
    cloudflare: generateCloudflareConfig(config),
    cloudfront: generateCloudfrontConfig(config),
    fastly: generateFastlyConfig(config),
    akamai: generateAkamaiConfig(config),
    terraform: generateTerraformConfig(config),
  };
}

function generateWorkerScript(config) {
  return `
// Cloudflare Worker for Domain Fronting
// Config: ${config.name} (${config.id})
// Front: ${config.frontDomain} -> Origin: ${config.originDomain}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    
    // Only handle requests for our front domain
    if (hostname !== '${config.frontDomain}') {
      return new Response('Not Found', { status: 404 });
    }

    // Build origin URL
    const originUrl = new URL(request.url);
    originUrl.hostname = '${config.originDomain}';
    originUrl.protocol = 'https:';

    // Clone request with modified headers
    const headers = new Headers(request.headers);
    headers.set('Host', '${config.originDomain}');
    headers.set('X-Forwarded-Host', '${config.frontDomain}');
    headers.set('X-Forwarded-Proto', 'https');
    headers.set('X-Real-IP', request.headers.get('CF-Connecting-IP') || '');
    
    // Add custom headers
    ${Object.entries(config.headers || {}).map(([k, v]) => `headers.set('${k}', '${v}');`).join('\n    ')}

    // Create new request to origin
    const originRequest = new Request(originUrl.toString(), {
      method: request.method,
      headers: headers,
      body: request.body,
      redirect: 'follow',
      cf: {
        cacheTtl: ${config.caching?.ttl || 300},
        cacheEverything: ${config.caching?.enabled || false},
      },
    });

    try {
      const response = await fetch(originRequest);
      
      // Process response
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('Server');
      responseHeaders.set('X-Content-Type-Options', 'nosniff');
      responseHeaders.set('X-Frame-Options', 'DENY');
      responseHeaders.set('X-XSS-Protection', '1; mode=block');
      
      // Add caching headers
      if (${config.caching?.enabled || false}) {
        responseHeaders.set('Cache-Control', 'public, max-age=${config.caching?.ttl || 300}, stale-while-revalidate=${config.caching?.staleWhileRevalidate || 60}');
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      // Return a generic error without leaking origin info
      return new Response('Service Unavailable', { 
        status: 503,
        headers: {
          'Retry-After': '30',
          'Cache-Control': 'no-cache',
        }
      });
    }
  }
};
`;
}

function generateCloudflareConfig(config) {
  return {
    zoneId: '<YOUR_ZONE_ID>',
    accountId: '<YOUR_ACCOUNT_ID>',
    workerScript: `domainfront-${config.id}`,
    routes: [
      { pattern: `${config.frontDomain}${config.routePattern}`, script: `domainfront-${config.id}` },
    ],
    dnsRecords: [
      { type: 'CNAME', name: config.frontDomain.replace(/https?:\/\//, ''), target: '<workers.dev>', proxied: true },
    ],
    pageRules: [
      {
        target: `${config.frontDomain}${config.routePattern}`,
        actions: [
          { id: 'cache_level', value: 'cache_everything' },
          { id: 'edge_cache_ttl', value: config.caching?.ttl || 300 },
          { id: 'always_online', value: true },
        ],
      },
    ],
    wafRules: [
      {
        description: 'Block known bad bots',
        action: 'block',
        expression: '(http.user_agent contains "sqlmap") or (http.user_agent contains "nikto")',
      },
    ],
  };
}

function generateCloudfrontConfig(config) {
  return {
    distributionConfig: {
      callerReference: `domainfront-${config.id}-${Date.now()}`,
      comment: `Domain Fronting: ${config.name}`,
      enabled: true,
      origins: {
        quantity: 1,
        items: [{
          id: 'origin-1',
          domainName: config.originDomain.replace(/https?:\/\//, ''),
          originPath: '',
          customHeaders: { quantity: 0, items: [] },
          s3OriginConfig: null,
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: 'https-only',
            originSslProtocols: { quantity: 1, items: ['TLSv1.2'] },
            originReadTimeout: 30,
            originKeepaliveTimeout: 5,
          },
        }],
      },
      defaultCacheBehavior: {
        targetOriginId: 'origin-1',
        viewerProtocolPolicy: 'https-only',
        allowedMethods: { quantity: 7, items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'], cachedMethods: { quantity: 2, items: ['GET', 'HEAD'] } },
        compress: true,
        minTtl: 0,
        defaultTtl: config.caching?.ttl || 300,
        maxTtl: 86400,
        forwardedValues: {
          queryString: true,
          cookies: { forward: 'none' },
          headers: { quantity: 0, items: [] },
          queryStringCacheKeys: { quantity: 0, items: [] },
        },
        trustedSigners: { enabled: false, quantity: 0 },
        lambdaFunctionAssociations: { quantity: 0 },
        functionAssociations: { quantity: 0 },
      },
      cacheBehaviors: { quantity: 0, items: [] },
      customErrorResponses: { quantity: 0 },
      logging: { enabled: false },
      priceClass: 'PriceClass_All',
      restrictions: { geoRestriction: { restrictionType: 'none', quantity: 0, items: [] } },
      webAclId: '',
      httpVersion: 'http2',
      isIpv6Enabled: true,
    },
  };
}

function generateFastlyConfig(config) {
  return {
    serviceId: '<YOUR_SERVICE_ID>',
    version: 1,
    backends: [{
      name: 'origin',
      address: config.originDomain.replace(/https?:\/\//, ''),
      port: 443,
      ssl: true,
      sslHostname: config.originDomain.replace(/https?:\/\//, ''),
      shield: 'none',
    }],
    domains: [{
      name: config.frontDomain.replace(/https?:\/\//, ''),
      comment: `Domain Fronting: ${config.name}`,
    }],
    routes: [{
      route: config.routePattern,
      serviceId: '<YOUR_SERVICE_ID>',
      version: 1,
    }],
    vcl: `
sub vcl_recv {
  if (req.http.host == "${config.frontDomain}") {
    set req.backend = origin;
    set req.http.Host = "${config.originDomain.replace(/https?:\/\//, '')}";
    set req.http.X-Forwarded-Host = "${config.frontDomain}";
    return (hash);
  }
  return (synth(404, "Not Found"));
}

sub vcl_backend_response {
  if (beresp.ttl > 0) {
    set beresp.ttl = ${config.caching?.ttl || 300}s;
    set beresp.grace = ${config.caching?.staleWhileRevalidate || 60}s;
  }
}
`,
  };
}

function generateAkamaiConfig(config) {
  return {
    propertyId: '<YOUR_PROPERTY_ID>',
    contractId: '<YOUR_CONTRACT_ID>',
    groupId: '<YOUR_GROUP_ID>',
    productId: 'prd_SPM',
    ruleFormat: 'v2023-01-01',
    hostnames: [{ cnameFrom: config.frontDomain.replace(/https?:\/\//, ''), cnameTo: '<edgekey.net>', certProvisioningType: 'automated' }],
    rules: {
      name: 'default',
      children: [
        {
          name: 'Domain Fronting',
          criteria: [{ name: 'hostname', value: config.frontDomain.replace(/https?:\/\//, ''), matchOperator: 'equals' }],
          behaviors: [
            { name: 'origin', value: config.originDomain.replace(/https?:\/\//, ''), options: { hostname: config.originDomain.replace(/https?:\/\//, ''), forwardHostHeader: 'origin' } },
            { name: 'caching', value: { behavior: 'MAX_AGE', ttl: `${config.caching?.ttl || 300}s` } },
            { name: 'modifyOutgoingRequestHeader', value: { action: 'ADD', headerName: 'X-Forwarded-Host', value: config.frontDomain } },
          ],
        },
      ],
    },
  };
}

function generateTerraformConfig(config) {
  return `
# Terraform configuration for ${config.name}
# Provider: ${config.provider}

terraform {
  required_version = ">= 1.0"
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

resource "cloudflare_worker_script" "domainfront_${config.id}" {
  name     = "domainfront-${config.id}"
  content  = file("worker.js")
  module   = false
}

resource "cloudflare_worker_route" "domainfront_${config.id}" {
  zone_id = var.cloudflare_zone_id
  pattern = "${config.frontDomain}${config.routePattern}"
  script_name = "domainfront-${config.id}"
}

resource "cloudflare_record" "domainfront_${config.id}" {
  zone_id = var.cloudflare_zone_id
  name    = "${config.frontDomain.replace(/https?:\/\//, '')}"
  type    = "CNAME"
  value   = "workers.dev"
  proxied = true
  ttl     = 1
}
`;
}

function generateDeploymentInstructions(config, artifacts) {
  return `
# Domain Fronting Deployment Instructions for ${config.name}

## Provider: ${config.provider.toUpperCase()}

## Front Domain: ${config.frontDomain}
## Origin Domain: ${config.originDomain}
## Route Pattern: ${config.routePattern}

## Deployment Steps

### 1. Cloudflare Workers (Recommended)
\`\`\`bash
# Install Wrangler CLI
npm install -g wrangler

# Login
wrangler login

# Create worker
wrangler init domainfront-${config.id}
cd domainfront-${config.id}

# Replace worker.js with generated script
# Update wrangler.toml with your account/zone IDs

# Deploy
wrangler deploy
\`\`\`

### 2. Configure DNS
- Add CNAME record: ${config.frontDomain} -> <worker>.workers.dev (proxied)
- Or use Cloudflare Pages with custom domain

### 3. Configure Caching
- Edge Cache TTL: ${config.caching?.ttl || 300}s
- Stale While Revalidate: ${config.caching?.staleWhileRevalidate || 60}s

### 4. Security Headers (Auto-applied by worker)
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- X-XSS-Protection: 1; mode=block

## Testing
\`\`\`bash
# Test front domain resolves
dig ${config.frontDomain}

# Test domain fronting
curl -H "Host: ${config.frontDomain}" https://${config.frontDomain}/test

# Verify origin is hidden
curl -I https://${config.frontDomain}/ | grep -i server
\`\`\`

## Monitoring
- Check Cloudflare Analytics for request volumes
- Monitor worker CPU time and errors
- Set up alerts for 5xx responses
`;
}

async function deployWorker(provider, worker, config) {
  // In production, deploy to Cloudflare Workers, CloudFront Functions, etc.
  return { url: `https://${worker.name}.workers.dev` };
}

async function deleteWorker(provider, workerId) {
  // In production, delete from provider
  return true;
}

async function checkWorkersHealth(config) {
  const health = [];
  for (const worker of config.workers || []) {
    if (!worker.deployed) {
      health.push({ workerId: worker.id, status: 'not_deployed' });
      continue;
    }
    try {
      const response = await fetch(`https://${worker.url}/health`, { timeout: 5000 });
      health.push({ workerId: worker.id, status: response.ok ? 'healthy' : 'unhealthy', statusCode: response.status });
    } catch (error) {
      health.push({ workerId: worker.id, status: 'unreachable', error: error.message });
    }
  }
  return health;
}

function resolveDomain(domain) {
  // In production, use dns.resolve
  return '1.2.3.4';
}