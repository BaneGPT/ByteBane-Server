// vercel-dashboard/api/admin/backup.js
// Backup and Disaster Recovery - KV export/import to external storage

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';
import { logAuditEntry, AuditActions, AuditSeverity, ResourceTypes } from './audit.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
      case 'DELETE':
        return await handleDelete(request, response);
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Backup error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response) {
  const { action, backupId } = request.query;

  if (action === 'list') {
    // List all backups
    const backupIds = await kv.smembers('global:backups') || [];
    const backups = [];

    for (const id of backupIds) {
      const backup = await kv.get(`backup:${id}`);
      if (backup) {
        backups.push({
          id: backup.id,
          type: backup.type,
          status: backup.status,
          size: backup.size,
          keyCount: backup.keyCount,
          createdAt: backup.createdAt,
          completedAt: backup.completedAt,
          storage: backup.storage,
        });
      }
    }

    backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return response.json({ backups });
  }

  if (action === 'status' && backupId) {
    const backup = await kv.get(`backup:${backupId}`);
    if (!backup) return response.status(404).json({ error: 'Backup not found' });
    return response.json(backup);
  }

  if (action === 'download' && backupId) {
    // Generate signed download URL for external storage
    const backup = await kv.get(`backup:${backupId}`);
    if (!backup) return response.status(404).json({ error: 'Backup not found' });
    if (backup.status !== 'completed') return response.status(400).json({ error: 'Backup not completed' });

    const downloadUrl = await generateDownloadUrl(backup);
    return response.json({ downloadUrl, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function handlePost(request, response) {
  const { action, type = 'full', storage = 'auto' } = request.body;

  if (action === 'create') {
    return await createBackup(response, type, storage);
  }

  if (action === 'restore' && request.body.backupId) {
    return await restoreBackup(response, request.body.backupId, request.body.options);
  }

  if (action === 'schedule') {
    return await scheduleBackup(response, request.body);
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function handleDelete(request, response) {
  const { backupId } = request.query;
  if (!backupId) return response.status(400).json({ error: 'backupId required' });

  const backup = await kv.get(`backup:${backupId}`);
  if (!backup) return response.status(404).json({ error: 'Backup not found' });

  // Delete from external storage if applicable
  if (backup.storage?.provider && backup.storage?.key) {
    await deleteFromStorage(backup.storage.provider, backup.storage.key);
  }

  // Delete local references
  await kv.del(`backup:${backupId}`);
  await kv.srem('global:backups', backupId);

  await logAuditEntry({
    actorId: 'admin',
    action: AuditActions.DATA_DELETED,
    resourceType: ResourceTypes.SETTINGS,
    resourceId: backupId,
    severity: AuditSeverity.WARNING,
    details: { type: 'backup_deleted', backupType: backup.type },
  });

  return response.json({ success: true, deleted: backupId });
}

async function createBackup(response, type, storage) {
  const backupId = `backup_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const startTime = Date.now();

  const backup = {
    id: backupId,
    type, // 'full', 'incremental', 'campaigns', 'systems', 'files'
    status: 'running',
    storage: { provider: storage },
    createdAt: new Date().toISOString(),
    keyCount: 0,
    size: 0,
    progress: 0,
  };

  await kv.set(`backup:${backupId}`, backup);
  await kv.sadd('global:backups', backupId);

  // Start backup asynchronously
  runBackup(backupId, type, storage).catch(console.error);

  return response.status(202).json({ backupId, status: 'started' });
}

async function runBackup(backupId, type, storage) {
  try {
    const backup = await kv.get(`backup:${backupId}`);
    if (!backup) return;

    // Determine keys to backup
    let keyPatterns = [];
    switch (type) {
      case 'full':
        keyPatterns = ['campaign:*', 'system:*', 'file:*', 'global:*', 'affiliate:*', 'payment:*', 'ticket:*', 'leak:*', 'telemetry:*', 'audit:*'];
        break;
      case 'incremental':
        // Only keys modified since last backup
        const lastBackup = await getLastCompletedBackup();
        if (lastBackup) {
          keyPatterns = ['*']; // Would filter by timestamp in production
        } else {
          keyPatterns = ['campaign:*', 'system:*', 'file:*', 'global:*'];
        }
        break;
      case 'campaigns':
        keyPatterns = ['campaign:*', 'global:campaigns'];
        break;
      case 'systems':
        keyPatterns = ['system:*', 'global:systems', 'campaign:*:systems'];
        break;
      case 'files':
        keyPatterns = ['file:*', 'global:files', 'system:*:files'];
        break;
    }

    // Collect all keys
    let allKeys = [];
    for (const pattern of keyPatterns) {
      const keys = await kv.keys(pattern);
      allKeys.push(...keys);
    }

    // Deduplicate
    allKeys = [...new Set(allKeys)];
    backup.keyCount = allKeys.length;
    await kv.set(`backup:${backupId}`, { ...backup, keyCount: allKeys.length, progress: 10 });

    // Export data in batches
    const batchSize = 100;
    let exportedData = {};
    let totalSize = 0;

    for (let i = 0; i < allKeys.length; i += batchSize) {
      const batch = allKeys.slice(i, i + batchSize);
      const batchData = {};

      for (const key of batch) {
        const value = await kv.get(key);
        if (value !== null) {
          batchData[key] = value;
          totalSize += JSON.stringify(value).length;
        }
      }

      exportedData = { ...exportedData, ...batchData };
      
      // Update progress
      const progress = Math.min(90, Math.round(((i + batch.length) / allKeys.length) * 90));
      await kv.set(`backup:${backupId}`, { 
        ...backup, 
        progress, 
        size: totalSize,
        exportedKeys: Object.keys(exportedData).length,
      });
    }

    // Store backup
    let storageInfo = { provider: 'kv' };
    
    if (storage !== 'kv' && storage !== 'auto') {
      // Upload to external storage
      storageInfo = await uploadToStorage(backupId, exportedData, storage);
    } else if (storage === 'auto') {
      // Auto-select based on size
      if (totalSize > 50 * 1024 * 1024) { // > 50MB
        storageInfo = await uploadToStorage(backupId, exportedData, 'r2');
      } else {
        // Store in KV as multiple keys
        await storeBackupInKv(backupId, exportedData);
      }
    } else {
      await storeBackupInKv(backupId, exportedData);
    }

    // Finalize
    const completedBackup = {
      ...backup,
      status: 'completed',
      size: totalSize,
      progress: 100,
      completedAt: new Date().toISOString(),
      storage: storageInfo,
      duration: Date.now() - startTime,
    };

    await kv.set(`backup:${backupId}`, completedBackup);

    await logAuditEntry({
      actorId: 'admin',
      action: AuditActions.DATA_EXPORTED,
      resourceType: ResourceTypes.SETTINGS,
      resourceId: backupId,
      severity: AuditSeverity.INFO,
      details: { type: 'backup_created', backupType: type, size: totalSize, keyCount: allKeys.length },
    });

  } catch (error) {
    console.error('Backup failed:', error);
    await kv.set(`backup:${backupId}`, { 
      ...backup, 
      status: 'failed', 
      error: error.message,
      completedAt: new Date().toISOString(),
    });
  }
}

async function storeBackupInKv(backupId, data) {
  // Split into chunks if large
  const chunkSize = 1000;
  const keys = Object.keys(data);
  
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunkKeys = keys.slice(i, i + chunkSize);
    const chunkData = {};
    for (const key of chunkKeys) {
      chunkData[key] = data[key];
    }
    
    await kv.set(`backup:${backupId}:data:${i / chunkSize}`, chunkData, { ex: 2592000 }); // 30 days
  }
  
  await kv.set(`backup:${backupId}:manifest`, {
    chunks: Math.ceil(keys.length / chunkSize),
    totalKeys: keys.length,
    keyList: keys,
  }, { ex: 2592000 });
}

async function uploadToStorage(backupId, data, provider) {
  // In production, upload to R2, S3, or Vercel Blob
  // For now, simulate
  const json = JSON.stringify(data);
  const key = `backups/${backupId}.json`;
  
  // Would use actual SDK here
  return {
    provider,
    key,
    size: json.length,
    uploadedAt: new Date().toISOString(),
  };
}

async function generateDownloadUrl(backup) {
  if (backup.storage.provider === 'kv') {
    // Generate signed URL for KV download endpoint
    return `/api/admin/backup/download/${backup.id}`;
  }
  
  // Generate signed URL for external storage
  return `https://storage.example.com/${backup.storage.key}?signature=xxx&expires=3600`;
}

async function restoreBackup(response, backupId, options = {}) {
  const backup = await kv.get(`backup:${backupId}`);
  if (!backup) return response.status(404).json({ error: 'Backup not found' });
  if (backup.status !== 'completed') return response.status(400).json({ error: 'Backup not completed' });

  // Get backup data
  let data = {};
  
  if (backup.storage.provider === 'kv') {
    const manifest = await kv.get(`backup:${backupId}:manifest`);
    if (manifest) {
      for (let i = 0; i < manifest.chunks; i++) {
        const chunk = await kv.get(`backup:${backupId}:data:${i}`);
        if (chunk) data = { ...data, ...chunk };
      }
    }
  } else {
    // Download from external storage
    data = await downloadFromStorage(backup.storage.provider, backup.storage.key);
  }

  // Restore options
  const { overwrite = false, dryRun = false, keyFilter = null } = options;

  let restored = 0;
  let skipped = 0;
  let errors = 0;

  for (const [key, value] of Object.entries(data)) {
    if (keyFilter && !key.match(keyFilter)) continue;

    try {
      const exists = await kv.get(key);
      if (exists && !overwrite) {
        skipped++;
        continue;
      }

      if (!dryRun) {
        await kv.set(key, value);
      }
      restored++;
    } catch (error) {
      errors++;
      console.error(`Restore failed for ${key}:`, error);
    }
  }

  await logAuditEntry({
    actorId: 'admin',
    action: AuditActions.DATA_EXPORTED, // Reuse for restore
    resourceType: ResourceTypes.SETTINGS,
    resourceId: backupId,
    severity: AuditSeverity.CRITICAL,
    details: { type: 'backup_restored', restored, skipped, errors, dryRun },
  });

  return response.json({ restored, skipped, errors, dryRun });
}

async function downloadFromStorage(provider, key) {
  // In production, download from R2/S3/Blob
  return {};
}

async function deleteFromStorage(provider, key) {
  // In production, delete from R2/S3/Blob
  return true;
}

async function getLastCompletedBackup() {
  const backupIds = await kv.smembers('global:backups') || [];
  for (const id of backupIds) {
    const backup = await kv.get(`backup:${id}`);
    if (backup && backup.status === 'completed') return backup;
  }
  return null;
}

async function scheduleBackup(response, config) {
  // In production, use Vercel Cron or external scheduler
  const scheduleId = `schedule_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  const schedule = {
    id: scheduleId,
    type: config.type || 'full',
    storage: config.storage || 'auto',
    cron: config.cron || '0 2 * * *', // Daily at 2 AM UTC
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRun: getNextCronRun(config.cron || '0 2 * * *'),
  };

  await kv.set(`backup:schedule:${scheduleId}`, schedule);
  await kv.sadd('global:backup:schedules', scheduleId);

  return response.status(201).json(schedule);
}

function getNextCronRun(cron) {
  // Simplified - in production use a cron parser
  const now = new Date();
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}