// Chaos C2 Victim Negotiation Portal

const NegotiationState = {
  negotiationId: null,
  victimToken: null,
  negotiation: null,
  messages: [],
  proofs: [],
  pollingInterval: null,
  countdownInterval: null,
  unreadCount: 0,
  typingTimeout: null
};

const $ = (sel, ctx = document) => ctx?.querySelector(sel);
const $$ = (sel, ctx = document) => [...(ctx?.querySelectorAll(sel) || [])];

const fmtCurrency = (n, currency = 'USD') => {
  if (n === null || n === undefined) return '$0';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
};
const fmtCrypto = (n) => n ? n.toFixed(8) : '0.00000000';
const fmtBytes = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never';
const timeAgo = (iso) => {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
};

const showToast = (message, type = 'info', duration = 4000) => {
  const container = $('#toastContainer');
  if (!container) return;
  const colors = { info: 'border-chaos-500 bg-surface-900', success: 'border-acc-emerald bg-acc-emeraldDim', warning: 'border-acc-amber bg-acc-amberDim', error: 'border-acc-rose bg-acc-roseDim' };
  const icons = { info: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>', success: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>', warning: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>', error: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>' };
  const toast = document.createElement('div');
  toast.className = `flex items-center gap-3 px-4 py-3 rounded-xl border ${colors[type] || colors.info} shadow-xl animate-slide-up`;
  toast.innerHTML = `${icons[type] || icons.info}<span class="text-sm font-medium text-white">${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, duration);
};

const api = async (path, options = {}) => {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (NegotiationState.victimToken) {
    headers['X-Negotiation-Token'] = NegotiationState.victimToken;
  }
  try {
    const res = await fetch(`${window.__NEGOTIATION_CONFIG__.apiBase}${path}`, { ...options, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (e) {
    console.error(`API ${path} failed:`, e);
    throw e;
  }
};

// ============ INITIALIZATION ============
document.addEventListener('DOMContentLoaded', async () => {
  // Get negotiation ID from URL
  const urlParams = new URLSearchParams(window.location.search);
  NegotiationState.negotiationId = urlParams.get('id');
  NegotiationState.victimToken = urlParams.get('token');

  if (!NegotiationState.negotiationId || !NegotiationState.victimToken) {
    showErrorState('Invalid negotiation link. Please use the link from your ransom note.');
    return;
  }

  await loadNegotiation();
  startPolling();
  startCountdown();
});

function showErrorState(message) {
  $('#viewContent')?.innerHTML = '';
  document.body.innerHTML = `
    <div class="min-h-screen flex items-center justify-center bg-surface-950 bg-radial bg-grid">
      <div class="card-base max-w-md mx-4 text-center p-8">
        <svg class="w-16 h-16 mx-auto text-acc-rose mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
        <h2 class="text-xl font-semibold mb-2">Invalid Link</h2>
        <p class="text-gray-400 mb-6">${message}</p>
        <p class="text-xs text-gray-500">Contact support if you believe this is an error.</p>
      </div>
    </div>
  `;
}

// ============ NEGOTIATION LOADING ============
async function loadNegotiation() {
  try {
    const data = await api(`/negotiations?id=${NegotiationState.negotiationId}&includeMessages=true`);
    NegotiationState.negotiation = data;
    NegotiationState.messages = data.messages || [];
    
    renderNegotiationHeader();
    renderMessages();
    renderDeadlines();
    renderProofSection();
    updateFileStats();
    updateSendButton();
  } catch (e) {
    showErrorState(`Failed to load negotiation: ${e.message}`);
  }
}

async function refreshNegotiation() {
  try {
    const data = await api(`/negotiations?id=${NegotiationState.negotiationId}&includeMessages=true`);
    const hadMessages = NegotiationState.messages.length;
    
    NegotiationState.negotiation = data;
    NegotiationState.messages = data.messages || [];
    
    renderNegotiationHeader();
    if (data.messages.length !== hadMessages) {
      renderMessages();
    }
    renderDeadlines();
    renderProofSection();
    updateFileStats();
    updateSendButton();
  } catch (e) {
    console.error('Refresh failed:', e);
  }
}

// ============ RENDERING ============
function renderNegotiationHeader() {
  const n = NegotiationState.negotiation;
  if (!n) return;

  $('#caseId').textContent = n.id;
  
  const statusBadges = {
    open: 'badge-warning',
    active: 'badge-info',
    stalled: 'badge-warning',
    completed: 'badge-active',
    cancelled: 'badge-inactive',
    expired: 'badge-danger'
  };
  
  const statusLabels = {
    open: 'Awaiting Response',
    active: 'Negotiation Active',
    stalled: 'Stalled',
    completed: 'Completed',
    cancelled: 'Cancelled',
    expired: 'Expired'
  };

  $('#negotiationStatus').innerHTML = `<span class="badge ${statusBadges[n.status] || 'badge-inactive'}">${statusLabels[n.status] || n.status}</span>`;
  $('#currentRansom').textContent = fmtCurrency(n.currentRansom);
  $('#cryptoAmount').textContent = fmtCrypto(n.cryptoAmount);
}

function renderDeadlines() {
  const n = NegotiationState.negotiation;
  if (!n?.deadlines) return;

  const container = $('#deadlinesList');
  const now = new Date();
  
  const deadlines = [
    { key: 'priceIncrease', label: 'Price Increase (+50%)', icon: '💰' },
    { key: 'initial', label: 'Initial Response Deadline', icon: '⏰' },
    { key: 'final', label: 'Final Deadline (Data Publication)', icon: '💀' }
  ];

  container.innerHTML = deadlines.map(d => {
    const deadline = n.deadlines[d.key];
    if (!deadline) return '';
    
    const date = new Date(deadline);
    const diff = date - now;
    const isPast = diff <= 0;
    const isCritical = diff > 0 && diff < 3600000; // < 1 hour
    const isWarning = diff > 0 && diff < 86400000; // < 24 hours
    
    let timeStr = isPast ? 'EXPIRED' : formatCountdown(diff);
    let badgeClass = isPast ? 'badge-danger' : isCritical ? 'badge-danger countdown-critical' : isWarning ? 'badge-warning countdown-warning' : 'badge-info';
    
    return `
      <div class="flex items-center justify-between p-3 rounded-lg bg-surface-800 ${isCritical ? 'shake' : ''}">
        <div class="flex items-center gap-3">
          <span class="text-2xl">${d.icon}</span>
          <div>
            <p class="font-medium">${d.label}</p>
            <p class="text-xs text-gray-500">${fmtDate(deadline)}</p>
          </div>
        </div>
        <span class="badge ${badgeClass} font-mono">${timeStr}</span>
      </div>
    `;
  }).join('');
}

function formatCountdown(ms) {
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function renderMessages() {
  const container = $('#messagesContainer');
  if (!container) return;

  if (NegotiationState.messages.length === 0) {
    container.innerHTML = `
      <div class="text-center text-gray-500 py-8" id="emptyState">
        <svg class="w-12 h-12 mx-auto mb-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
        <p>Waiting for first message...</p>
        <p class="text-xs mt-1">Messages from the operator will appear here</p>
      </div>
    `;
    return;
  }

  container.innerHTML = NegotiationState.messages.map(msg => renderMessage(msg)).join('');
  
  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function renderMessage(msg) {
  const isSystem = msg.sender === 'system';
  const isVictim = msg.sender === 'victim';
  const isAdmin = msg.sender === 'admin';
  const isProof = msg.fileType?.includes('proof') || msg.fileType?.includes('decryption');

  let bubbleClass = 'message-bubble ';
  let senderLabel = '';
  
  if (isSystem) {
    bubbleClass += 'message-system mx-auto max-w-full';
  } else if (isVictim) {
    bubbleClass += 'message-victim';
    senderLabel = 'You';
  } else if (isAdmin) {
    bubbleClass += 'message-admin';
    senderLabel = 'Operator';
  } else if (isProof) {
    bubbleClass += 'message-proof';
    senderLabel = 'Operator';
  }

  const fileHtml = msg.fileId ? `
    <div class="mt-2 p-2 rounded bg-surface-800 border border-gray-700 flex items-center gap-2">
      <svg class="w-5 h-5 text-chaos-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/></svg>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium truncate">${msg.fileType || 'File'}</p>
        <p class="text-xs text-gray-500 truncate">${msg.fileId}</p>
      </div>
      <button class="btn-ghost text-xs p-1" onclick="downloadFile('${msg.fileId}')">Download</button>
    </div>
  ` : '';

  return `
    <div class="flex ${isVictim ? 'justify-end' : 'justify-start'} animate-fade-in" data-message-id="${msg.id}">
      <div class="${bubbleClass}">
        ${!isSystem ? `<p class="text-xs text-gray-500 mb-1">${senderLabel} • ${timeAgo(msg.createdAt)}</p>` : ''}
        ${msg.content ? `<p class="whitespace-pre-wrap">${escapeHtml(msg.content)}</p>` : ''}
        ${fileHtml}
        ${isProof ? `<p class="text-xs text-acc-emerald mt-2">✓ Decryption proof available</p>` : ''}
      </div>
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderProofSection() {
  const n = NegotiationState.negotiation;
  if (!n) return;

  const container = $('#proofContent');
  const section = $('#proofSection');
  
  if (!n.proofFiles || n.proofFiles.length === 0) {
    section?.classList.add('hidden');
    return;
  }

  section?.classList.remove('hidden');
  
  container.innerHTML = n.proofFiles.map(pf => {
    const proof = n.proofs?.find(p => p.id === pf.fileId) || pf;
    const verified = proof.verified ? '✓ Verified' : 'Pending verification';
    const verifiedClass = proof.verified ? 'text-acc-emerald' : 'text-acc-amber';
    
    return `
      <div class="p-3 rounded-lg bg-surface-800 border border-gray-700">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <svg class="w-8 h-8 text-acc-emerald" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            <div>
              <p class="font-medium">${proof.fileName || pf.fileId}</p>
              <p class="text-xs text-gray-500">${proof.fileType || pf.type} • ${fmtBytes(proof.fileSize)}</p>
            </div>
          </div>
          <span class="badge ${proof.verified ? 'badge-active' : 'badge-warning'}">${verified}</span>
        </div>
        ${proof.metadata?.sampleFiles ? `
          <div class="mt-2 ml-11 text-xs text-gray-400">
            <p>Sample files:</p>
            <ul class="list-disc list-inside mt-1 space-y-1">
              ${proof.metadata.sampleFiles.map(f => `<li>${f}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function updateFileStats() {
  const n = NegotiationState.negotiation;
  if (!n) return;

  // These would come from system info in production
  $('#statEncrypted').textContent = '127,432';
  $('#statSize').textContent = '47.3 GB';
  $('#statTypes').textContent = '23 extensions';
}

function updateSendButton() {
  const n = NegotiationState.negotiation;
  const input = $('#messageInput');
  const btn = $('#sendBtn');
  
  if (!n || ['completed', 'cancelled', 'expired'].includes(n.status)) {
    if (input) input.disabled = true;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="text-xs">Negotiation Closed</span>'; }
  } else {
    if (input) input.disabled = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>'; }
  }
}

// ============ MESSAGE SENDING ============
function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

async function sendMessage() {
  const input = $('#messageInput');
  const content = input?.value?.trim();
  if (!content) return;

  const btn = $('#sendBtn');
  btn.disabled = true;
  btn.innerHTML = '<svg class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';

  try {
    await api(`/negotiations`, {
      method: 'POST',
      body: JSON.stringify({ action: 'send_message', negotiationId: NegotiationState.negotiationId, message: content })
    });
    
    input.value = '';
    input.style.height = 'auto';
    showToast('Message sent', 'success');
  } catch (e) {
    showToast(e.message || 'Failed to send message', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>';
  }
}

// ============ FILE HANDLING ============
function handleDragOver(e) {
  e.preventDefault();
  $('#dropZone')?.classList.add('active');
}

function handleDragLeave(e) {
  e.preventDefault();
  $('#dropZone')?.classList.remove('active');
}

function handleDrop(e) {
  e.preventDefault();
  $('#dropZone')?.classList.remove('active');
  
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleFiles(files);
  }
}

function handleFileSelect(e) {
  const files = e.target.files;
  if (files.length > 0) {
    handleFiles(files);
  }
  e.target.value = '';
}

async function handleFiles(files) {
  const maxSize = 10 * 1024 * 1024; // 10MB
  const validFiles = [];
  
  for (const file of files) {
    if (file.size > maxSize) {
      showToast(`${file.name} exceeds 10MB limit`, 'error');
      continue;
    }
    validFiles.push(file);
  }

  if (validFiles.length === 0) return;

  showToast(`Uploading ${validFiles.length} file(s)...`, 'info');

  // In production, upload to storage and get file IDs
  // For now, simulate file upload
  for (const file of validFiles) {
    const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    try {
      await api(`/negotiations`, {
        method: 'POST',
        body: JSON.stringify({ 
          action: 'send_message', 
          negotiationId: NegotiationState.negotiationId, 
          message: `Uploaded file: ${file.name} (${fmtBytes(file.size)})`,
          fileId,
          fileType: 'attachment'
        })
      });
      showToast(`${file.name} uploaded`, 'success');
    } catch (e) {
      showToast(`Failed to upload ${file.name}`, 'error');
    }
  }
}

// ============ PROOF REQUESTS ============
function requestProof() {
  if (!NegotiationState.negotiation) return;
  
  showToast('Requesting proof of decryption...', 'info');
  
  api(`/negotiations/proof`, {
    method: 'POST',
    body: JSON.stringify({ action: 'request_proof', negotiationId: NegotiationState.negotiationId })
  }).then(() => {
    showToast('Proof requested. Operator will respond shortly.', 'success');
  }).catch(e => {
    showToast(e.message || 'Failed to request proof', 'error');
  });
}

function verifyProof() {
  showToast('Proof verification coming soon', 'info');
}

function requestMoreProof() {
  showToast('Additional proof requested', 'info');
}

function downloadChatLog() {
  const log = NegotiationState.messages.map(m => 
    `[${fmtDate(m.createdAt)}] ${m.sender === 'system' ? 'SYSTEM' : m.sender.toUpperCase()}: ${m.content}`
  ).join('\n\n');
  
  const blob = new Blob([log], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `negotiation_${NegotiationState.negotiationId}_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  
  showToast('Chat log downloaded', 'success');
}

function downloadFile(fileId) {
  showToast('File download coming soon', 'info');
}

// ============ COUNTDOWN TIMER ============
function startCountdown() {
  updateCountdown();
  NegotiationState.countdownInterval = setInterval(updateCountdown, 1000);
}

function updateCountdown() {
  const n = NegotiationState.negotiation;
  if (!n?.deadlines) return;

  const now = new Date();
  const finalDeadline = new Date(n.deadlines.final);
  const diff = finalDeadline - now;

  const timer = $('#countdownTimer');
  if (!timer) return;

  if (diff <= 0) {
    timer.textContent = 'EXPIRED';
    timer.className = 'stat-value font-mono text-acc-rose countdown-critical';
    return;
  }

  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const secs = Math.floor((diff % 60000) / 1000);

  let timeStr = '';
  if (days > 0) timeStr = `${days}d ${hours}h ${mins}m`;
  else if (hours > 0) timeStr = `${hours}h ${mins}m ${secs}s`;
  else timeStr = `${mins}m ${secs}s`;

  timer.textContent = timeStr;

  // Update styling based on urgency
  timer.classList.remove('countdown-critical', 'countdown-warning');
  if (diff < 3600000) { // < 1 hour
    timer.classList.add('countdown-critical');
  } else if (diff < 86400000) { // < 24 hours
    timer.classList.add('countdown-warning');
  }
}

// ============ POLLING ============
function startPolling() {
  NegotiationState.pollingInterval = setInterval(() => {
    refreshNegotiation();
  }, 5000); // Poll every 5 seconds for real-time feel
}

function stopPolling() {
  if (NegotiationState.pollingInterval) {
    clearInterval(NegotiationState.pollingInterval);
    NegotiationState.pollingInterval = null;
  }
  if (NegotiationState.countdownInterval) {
    clearInterval(NegotiationState.countdownInterval);
    NegotiationState.countdownInterval = null;
  }
}

// Cleanup on page unload
window.addEventListener('beforeunload', stopPolling);

// Make functions globally available
window.requestProof = requestProof;
window.verifyProof = verifyProof;
window.requestMoreProof = requestMoreProof;
window.downloadChatLog = downloadChatLog;
window.sendMessage = sendMessage;
window.handleKeydown = handleKeydown;
window.handleDragOver = handleDragOver;
window.handleDragLeave = handleDragLeave;
window.handleDrop = handleDrop;
window.handleFileSelect = handleFileSelect;
window.downloadFile = downloadFile;