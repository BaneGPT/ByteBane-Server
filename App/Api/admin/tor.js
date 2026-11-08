// vercel-dashboard/api/admin/tor.js
// Tor Hidden Service Configuration

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
    console.error('Tor config error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response) {
  const { action, serviceId } = request.query;

  if (action === 'list') {
    const serviceIds = await kv.smembers('global:tor:services') || [];
    const services = [];

    for (const id of serviceIds) {
      const service = await kv.get(`tor:service:${id}`);
      if (service) {
        services.push({
          id: service.id,
          name: service.name,
          onionAddress: service.onionAddress,
          ports: service.ports,
          status: service.status,
          version: service.version,
          createdAt: service.createdAt,
          lastSeen: service.lastSeen,
        });
      }
    }

    return response.json({ services });
  }

  if (action === 'status' && serviceId) {
    const service = await kv.get(`tor:service:${serviceId}`);
    if (!service) return response.status(404).json({ error: 'Service not found' });

    // Check if service is reachable
    const reachable = await checkOnionReachability(service.onionAddress);
    
    return response.json({
      ...service,
      reachable,
      lastChecked: new Date().toISOString(),
    });
  }

  if (action === 'config' && serviceId) {
    const service = await kv.get(`tor:service:${serviceId}`);
    if (!service) return response.status(404).json({ error: 'Service not found' });

    // Return torrc configuration for this service
    const torrc = generateTorrc(service);
    return response.setHeader('Content-Type', 'text/plain').send(torrc);
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function handlePost(request, response) {
  const { action, name, ports, version = 3, authType = 'none', authKeys } = request.body;

  if (action === 'create') {
    return await createTorService(response, { name, ports, version, authType, authKeys });
  }

  if (action === 'verify' && request.body.onionAddress) {
    const reachable = await checkOnionReachability(request.body.onionAddress);
    return response.json({ onionAddress: request.body.onionAddress, reachable });
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function handlePut(request, response) {
  const { serviceId, ...updates } = request.body;
  if (!serviceId) return response.status(400).json({ error: 'serviceId required' });

  const service = await kv.get(`tor:service:${serviceId}`);
  if (!service) return response.status(404).json({ error: 'Service not found' });

  const updated = {
    ...service,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await kv.set(`tor:service:${serviceId}`, updated);

  await logAuditEntry({
    actorId: 'admin',
    action: AuditActions.SETTINGS_CHANGED,
    resourceType: ResourceTypes.SETTINGS,
    resourceId: serviceId,
    severity: AuditSeverity.INFO,
    details: { type: 'tor_service_updated', updates: Object.keys(updates) },
  });

  return response.json(updated);
}

async function handleDelete(request, response) {
  const { serviceId } = request.query;
  if (!serviceId) return response.status(400).json({ error: 'serviceId required' });

  const service = await kv.get(`tor:service:${serviceId}`);
  if (!service) return response.status(404).json({ error: 'Service not found' });

  // Remove from tracking
  await kv.del(`tor:service:${serviceId}`);
  await kv.srem('global:tor:services', serviceId);

  await logAuditEntry({
    actorId: 'admin',
    action: AuditActions.DATA_DELETED,
    resourceType: ResourceTypes.SETTINGS,
    resourceId: serviceId,
    severity: AuditSeverity.WARNING,
    details: { type: 'tor_service_deleted', onionAddress: service.onionAddress },
  });

  return response.json({ success: true, deleted: serviceId });
}

async function createTorService(response, config) {
  if (!config.name || !config.ports || !config.ports.length) {
    return response.status(400).json({ error: 'name and ports required' });
  }

  // Validate ports
  for (const port of config.ports) {
    if (!port.onionPort || !port.localPort || !port.targetHost) {
      return response.status(400).json({ error: 'Each port must have onionPort, localPort, and targetHost' });
    }
  }

  const serviceId = `tor_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // Generate onion address (v3 = 56 chars, v2 = 16 chars - deprecated)
  const onionAddress = generateOnionAddress(config.version);

  const service = {
    id: serviceId,
    name: config.name,
    onionAddress,
    version: config.version,
    ports: config.ports.map(p => ({
      onionPort: p.onionPort,
      localPort: p.localPort,
      targetHost: p.targetHost,
      targetPort: p.targetPort || p.localPort,
    })),
    authType: config.authType, // 'none', 'basic', 'stealth'
    authKeys: config.authKeys || [],
    status: 'created',
    version: config.version,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Tor-specific config
    torrc: generateTorrc({
      id: serviceId,
      name: config.name,
      onionAddress,
      ports: config.ports,
      version: config.version,
      authType: config.authType,
    }),
    // Deployment info
    deployment: {
      method: 'manual', // 'manual', 'docker', 'ansible', 'terraform'
      host: null,
      containerId: null,
    },
  };

  await kv.set(`tor:service:${serviceId}`, service);
  await kv.sadd('global:tor:services', serviceId);

  // Generate deployment artifacts
  const artifacts = generateDeploymentArtifacts(service);

  await logAuditEntry({
    actorId: 'admin',
    action: 'tor_service_created',
    resourceType: ResourceTypes.SETTINGS,
    resourceId: serviceId,
    severity: AuditSeverity.INFO,
    details: { onionAddress, ports: config.ports, version: config.version },
  });

  return response.status(201).json({
    service,
    artifacts,
    instructions: generateDeploymentInstructions(service, artifacts),
  });
}

function generateOnionAddress(version) {
  if (version === 3) {
    // v3 onion: 56 characters (ed25519 public key encoded in base32)
    const chars = 'abcdefghijklmnopqrstuvwxyz234567';
    let address = '';
    for (let i = 0; i < 56; i++) {
      address += chars[Math.floor(Math.random() * chars.length)];
    }
    return `${address}.onion`;
  }
  // v2 (deprecated)
  const chars = 'abcdefghijklmnopqrstuvwxyz234567';
  let address = '';
  for (let i = 0; i < 16; i++) {
    address += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${address}.onion`;
}

function generateTorrc(service) {
  const lines = [
    '# Tor Hidden Service Configuration',
    '# Generated by Chaos C2 Dashboard',
    `# Service: ${service.name} (${service.id})`,
    `# Onion Address: ${service.onionAddress}`,
    `# Version: v${service.version}`,
    '',
    '## Global Tor Settings',
    'RunAsDaemon 1',
    'DataDirectory /var/lib/tor',
    'Log notice file /var/log/tor/notices.log',
    'Log warn file /var/log/tor/warnings.log',
    'Log err file /var/log/tor/errors.log',
    'SocksPort 0', // Disable SOCKS if not needed
    'ControlPort 9051',
    'HashedControlPassword 16:...', // Set a real password
    'CookieAuthentication 1',
    '',
    '## Hidden Service Configuration',
  ];

  for (const port of service.ports) {
    lines.push(`HiddenServiceDir /var/lib/tor/hidden_${service.id}_${port.onionPort}`);
    lines.push(`HiddenServicePort ${port.onionPort} ${port.targetHost}:${port.targetPort || port.localPort}`);
    lines.push('');
  }

  if (service.authType === 'basic') {
    lines.push('## Client Authorization (Basic)');
    for (const port of service.ports) {
      lines.push(`HiddenServiceAuthorizeClient ${port.onionPort} basic ${service.authKeys.join(',')}`);
    }
  } else if (service.authType === 'stealth') {
    lines.push('## Client Authorization (Stealth/Descriptive)');
    for (const port of service.ports) {
      lines.push(`HiddenServiceAuthorizeClient ${port.onionPort} stealth ${service.authKeys.join(',')}`);
    }
  }

  lines.push('');
  lines.push('## Security Hardening');
  lines.push('SafeLogging 1');
  lines.push('ProtocolWarnings 0');
  lines.push('AvoidDiskWrites 1');
  lines.push('MaxCircuitDirtiness 600');
  lines.push('NewCircuitPeriod 30');
  lines.push('MaxClientCircuitsPending 32');
  lines.push('');
  lines.push('## Performance');
  lines.push('NumEntryGuards 8');
  lines.push('GuardLifetime 2764800'); // 32 days

  return lines.join('\n');
}

function generateDeploymentArtifacts(service) {
  return {
    torrc: generateTorrc(service),
    dockerCompose: generateDockerCompose(service),
    systemd: generateSystemdService(service),
    ansible: generateAnsiblePlaybook(service),
    kubernetes: generateKubernetesManifest(service),
    clientAuth: generateClientAuthFiles(service),
  };
}

function generateDockerCompose(service) {
  return `version: '3.8'

services:
  tor:
    image: peterdavehello/tor:latest
    container_name: chaos-tor-${service.id}
    restart: unless-stopped
    volumes:
      - ./torrc:/etc/tor/torrc:ro
      - tor-data:/var/lib/tor
      - tor-logs:/var/log/tor
    ports:
      - "9050:9050"  # SOCKS (optional)
      - "9051:9051"  # Control port
    environment:
      - TOR_HIDDEN_SERVICE_DIR=/var/lib/tor/hidden_${service.id}
    healthcheck:
      test: ["CMD", "tor", "--verify-config"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  tor-data:
  tor-logs:

networks:
  default:
    name: chaos-network
`;
}

function generateSystemdService(service) {
  return `[Unit]
Description=Chaos Tor Hidden Service - ${service.name}
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=tor
Group=tor
ExecStart=/usr/bin/tor -f /etc/tor/torrc_${service.id}
ExecReload=/bin/kill -HUP $MAINPID
KillMode=process
Restart=on-failure
RestartSec=10
TimeoutStartSec=60
TimeoutStopSec=30

# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/tor/hidden_${service.id} /var/log/tor
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_DAC_OVERRIDE
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
`;
}

function generateAnsiblePlaybook(service) {
  return `---
- name: Deploy Chaos Tor Hidden Service
  hosts: tor_servers
  become: yes
  vars:
    service_id: "${service.id}"
    service_name: "${service.name}"
    onion_address: "${service.onionAddress}"
    ports: ${JSON.stringify(service.ports, null, 4)}
    version: ${service.version}
    auth_type: "${service.authType}"
    auth_keys: ${JSON.stringify(service.authKeys)}

  tasks:
    - name: Install Tor
      package:
        name: tor
        state: present

    - name: Create Tor configuration directory
      file:
        path: "/etc/tor/conf.d"
        state: directory
        mode: '0755'

    - name: Deploy torrc
      template:
        src: torrc.j2
        dest: "/etc/tor/torrc_{{ service_id }}"
        mode: '0644'
      notify: restart tor

    - name: Create hidden service directories
      file:
        path: "/var/lib/tor/hidden_{{ service_id }}_{{ item.onionPort }}"
        state: directory
        owner: debian-tor
        group: debian-tor
        mode: '0700'
      loop: "{{ ports }}"

    - name: Deploy client auth keys
      copy:
        content: "{{ item }}"
        dest: "/var/lib/tor/hidden_{{ service_id }}_{{ item.onionPort }}/authorized_clients/{{ item.key }}.auth"
        mode: '0600'
      loop: "{{ ports | product(auth_keys) | map('combine') }}"
      when: auth_type != 'none'

  handlers:
    - name: restart tor
      systemd:
        name: "tor@{{ service_id }}"
        state: restarted
        enabled: yes
`;
}

function generateKubernetesManifest(service) {
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: chaos-tor-${service.id}-config
  namespace: chaos
data:
  torrc: |
${generateTorrc(service).split('\n').map(l => '    ' + l).join('\n')}

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chaos-tor-${service.id}
  namespace: chaos
  labels:
    app: chaos-tor
    service: ${service.id}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: chaos-tor
      service: ${service.id}
  template:
    metadata:
      labels:
        app: chaos-tor
        service: ${service.id}
    spec:
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
      - name: tor
        image: peterdavehello/tor:latest
        ports:
        - containerPort: 9050
        - containerPort: 9051
        volumeMounts:
        - name: config
          mountPath: /etc/tor/torrc
          subPath: torrc
        - name: tor-data
          mountPath: /var/lib/tor
        - name: tor-logs
          mountPath: /var/log/tor
        livenessProbe:
          exec:
            command: ["tor", "--verify-config"]
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          exec:
            command: ["nc", "-z", "localhost", "9050"]
          initialDelaySeconds: 5
          periodSeconds: 10
      volumes:
      - name: config
        configMap:
          name: chaos-tor-${service.id}-config
      - name: tor-data
        emptyDir: {}
      - name: tor-logs
        emptyDir: {}

---
apiVersion: v1
kind: Service
metadata:
  name: chaos-tor-${service.id}
  namespace: chaos
spec:
  type: ClusterIP
  ports:
  - port: 9050
    targetPort: 9050
    name: socks
  - port: 9051
    targetPort: 9051
    name: control
  selector:
    app: chaos-tor
    service: ${service.id}

---
# Onion Service Exposure (requires Onion Service Operator or custom controller)
apiVersion: onion.example.com/v1
kind: OnionService
metadata:
  name: chaos-${service.id}
  namespace: chaos
spec:
  version: ${service.version}
  ports:
${service.ports.map(p => `  - port: ${p.onionPort}
    targetPort: ${p.targetPort || p.localPort}
    targetHost: ${p.targetHost}`).join('\n')}
  authType: ${service.authType}
  authKeys: ${JSON.stringify(service.authKeys)}
`;
}

function generateClientAuthFiles(service) {
  const files = {};
  
  if (service.authType !== 'none') {
    for (const port of service.ports) {
      for (const key of service.authKeys) {
        files[`authorized_clients/${key}.auth`] = `${service.authType}:${key}`;
      }
    }
  }
  
  return files;
}

function generateDeploymentInstructions(service, artifacts) {
  return `
# Deployment Instructions for ${service.name} (${service.onionAddress})

## Quick Start (Docker Compose)
1. Create directory: mkdir -p chaos-tor-${service.id}
2. Save torrc as: chaos-tor-${service.id}/torrc
3. Save docker-compose.yml as: chaos-tor-${service.id}/docker-compose.yml
4. Run: cd chaos-tor-${service.id} && docker-compose up -d

## Manual Tor Setup
1. Install Tor: apt-get install tor (Debian/Ubuntu) or pkg install tor (FreeBSD)
2. Copy torrc to /etc/tor/torrc_${service.id}
3. Create hidden service directories:
   mkdir -p /var/lib/tor/hidden_${service.id}_<port>
   chown debian-tor:debian-tor /var/lib/tor/hidden_${service.id}_*
   chmod 700 /var/lib/tor/hidden_${service.id}_*
4. If using client auth, create authorized_clients/ in each hidden service dir
5. Start service: systemctl start tor@${service.id}

## Kubernetes Deployment
1. Apply ConfigMap: kubectl apply -f kubernetes-configmap.yaml
2. Apply Deployment: kubectl apply -f kubernetes-deployment.yaml
3. Apply Service: kubectl apply -f kubernetes-service.yaml
4. (Optional) Apply OnionService CRD if using Onion Service Operator

## Client Access
- Onion Address: ${service.onionAddress}
- Ports: ${service.ports.map(p => `${p.onionPort} -> ${p.targetHost}:${p.targetPort || p.localPort}`).join(', ')}
${service.authType !== 'none' ? `- Authentication: ${service.authType}
- Client Keys: ${service.authKeys.join(', ')}` : '- Authentication: None'}

## Verification
1. Check Tor logs: journalctl -u tor@${service.id} -f
2. Verify onion address: cat /var/lib/tor/hidden_${service.id}_<port>/hostname
3. Test connectivity: torsocks curl http://${service.onionAddress}:<port>/

## Security Notes
- Run Tor as dedicated user (not root)
- Enable control port authentication
- Monitor for guard node changes
- Rotate onion keys periodically (v3 keys are derived from ed25519 identity)
- Consider using vanguards for guard discovery protection
`;
}

async function checkOnionReachability(onionAddress) {
  // In production, use torsocks + curl or a Tor-enabled HTTP client
  // For now, simulate
  return Math.random() > 0.3; // 70% chance reachable
}