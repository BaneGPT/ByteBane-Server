// Chaos C2 Admin Panel - Main Application Logic

const AdminState = {
  currentView: 'overview',
  tenants: [],
  payments: [],
  affiliates: [],
  campaigns: [],
  charts: {},
  timeRange: '7d',
  tenantPage: 1,
  paymentPage: 1,
  affiliatePage: 1,
  campaignPage: 1,
  pollingInterval: null
};

const $ = (sel, ctx = document) => ctx?.querySelector(sel);
const $$ = (sel, ctx = document) => [...(ctx?.querySelectorAll(sel) || [])];

const fmtNumber = (n) => (n ?? 0).toLocaleString();
const fmtCurrency = (n, currency = 'USD') => {
  if (n === null || n === undefined) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
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
  headers['Authorization'] = `Bearer ${process.env.MASTER_API_KEY || 'master_key_placeholder'}`;
  try {
    const res = await fetch(`${window.__ADMIN_CONFIG__.apiBase}${path}`, { ...options, headers });
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

function destroyChart(id) { if (AdminState.charts[id]) { AdminState.charts[id].destroy(); delete AdminState.charts[id]; } }

function getPlanBadgeClass(plan) { const badges = { starter: 'badge-starter', professional: 'badge-professional', business: 'badge-business', enterprise: 'badge-enterprise' }; return badges[plan] || 'badge-inactive'; }

async function renderView(view) {
  AdminState.currentView = view;
  const titleEl = $('#viewTitle'); if (titleEl) titleEl.textContent = view.charAt(0).toUpperCase() + view.slice(1);
  $$('.sidebar-link').forEach(el => { el.classList.toggle('sidebar-link-active', el.dataset.view === view); el.classList.toggle('sidebar-link', el.dataset.view !== view); });
  $$('.tab-btn').forEach(el => el.classList.toggle('tab-btn-active', el.dataset.view === view));

  const content = $('#viewContent'); if (!content) return;
  content.innerHTML = '<div class="flex items-center justify-center h-64"><div class="animate-spin w-10 h-10 border-4 border-chaos-500 border-t-transparent rounded-full"></div></div>';

  try {
    switch (view) {
      case 'overview': await renderOverview(); break;
      case 'tenants': await renderTenants(); break;
      case 'payments': await renderPayments(); break;
      case 'affiliates': await renderAffiliates(); break;
      case 'campaigns': await renderCampaigns(); break;
      case 'analytics': await renderAnalytics(); break;
      case 'settings': await renderSettings(); break;
      default: await renderOverview();
    }
  } catch (e) {
    console.error(`Render ${view} error:`, e);
    content.innerHTML = `<div class="card-base text-center py-12"><svg class="w-12 h-12 mx-auto text-acc-rose mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg><h3 class="text-lg font-semibold mb-2">Failed to load</h3><p class="text-gray-500 mb-4">${e.message}</p><button class="btn-primary" onclick="renderView('${view}')">Retry</button></div>`;
  }
}

async function refreshView() { await renderView(AdminState.currentView); }

// ============ OVERVIEW ============
async function renderOverview() {
  const content = $('#viewContent'); if (!content) return;
  
  let stats = { tenants: { total: 0, active: 0, revenue: 0 }, affiliates: { total: 0, active: 0 }, campaigns: { total: 0, active: 0 }, payments: { total: 0, pending: 0, volume: 0 } };
  try {
    const data = await api('/tenants?limit=1000');
    stats.tenants.total = data.total;
    stats.tenants.active = data.tenants.filter(t => t.status === 'active').length;
    stats.tenants.revenue = data.tenants.reduce((sum, t) => sum + (t.stats?.totalRevenue || 0), 0);
    
    const affData = await api('/affiliates?limit=1000');
    stats.affiliates.total = affData.total;
    stats.affiliates.active = affData.affiliates.filter(a => a.status === 'active').length;
    
    const campData = await api('/campaigns?limit=1000');
    stats.campaigns.total = campData.total;
    stats.campaigns.active = campData.campaigns.filter(c => c.status === 'active').length;
    
    const payData = await api('/payments?limit=1000');
    stats.payments.total = payData.total;
    stats.payments.pending = payData.payments.filter(p => p.status === 'pending').length;
    stats.payments.volume = payData.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  } catch (e) { console.warn('Stats fetch failed:', e); }

  const tcBadge = $('#tenantCountBadge'); if (tcBadge) { tcBadge.textContent = stats.tenants.total; tcBadge.classList.remove('hidden'); }
  const pcBadge = $('#paymentCountBadge'); if (pcBadge) { pcBadge.textContent = stats.payments.pending; pcBadge.classList.remove('hidden'); }

  content.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <article class="card-base stat-card animate-slide-up" style="animation-delay: 0ms"><p class="stat-label">Total Tenants</p><p class="stat-value text-chaos-400">${fmtNumber(stats.tenants.total)}</p><p class="text-xs text-gray-500 mt-1">${stats.tenants.active} active</p></article>
      <article class="card-base stat-card animate-slide-up" style="animation-delay: 50ms"><p class="stat-label">Total Revenue</p><p class="stat-value text-acc-emerald">${fmtCurrency(stats.tenants.revenue)}</p><p class="text-xs text-gray-500 mt-1">All time</p></article>
      <article class="card-base stat-card animate-slide-up" style="animation-delay: 100ms"><p class="stat-label">Total Affiliates</p><p class="stat-value text-acc-sky">${fmtNumber(stats.affiliates.total)}</p><p class="text-xs text-gray-500 mt-1">${stats.affiliates.active} active</p></article>
      <article class="card-base stat-card animate-slide-up" style="animation-delay: 150ms"><p class="stat-label">Payment Volume</p><p class="stat-value text-acc-violet">${fmtCurrency(stats.payments.volume)}</p><p class="text-xs text-gray-500 mt-1">${stats.payments.pending} pending</p></article>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <article class="card-base"><h3 class="text-lg font-semibold mb-4">Revenue by Plan</h3><div class="chart-container-lg"><canvas id="revenueByPlanChart"></canvas></div></article>
      <article class="card-base"><h3 class="text-lg font-semibold mb-4">Tenant Growth</h3><div class="chart-container-lg"><canvas id="tenantGrowthChart"></canvas></div></article>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
      <article class="card-base lg:col-span-2"><h3 class="text-lg font-semibold mb-4">Recent Tenants</h3><div class="scrollbar-thin overflow-x-auto"><table class="w-full min-w-[700px]"><thead><tr><th class="table-header">Tenant</th><th class="table-header">Plan</th><th class="table-header">Affiliates</th><th class="table-header">Campaigns</th><th class="table-header">Revenue</th><th class="table-header">Status</th><th class="table-header">Created</th></tr></thead><tbody id="recentTenantsBody" class="divide-y divide-gray-800"></tbody></table></div></article>
      <article class="card-base"><h3 class="text-lg font-semibold mb-4">Payment Status</h3><div class="chart-container"><canvas id="paymentStatusChart"></canvas></div></article>
    </div>

    <article class="card-base"><div class="flex items-center justify-between mb-4"><h3 class="text-lg font-semibold">Recent Payments</h3><button class="btn-ghost text-sm" onclick="showView('payments')">View All →</button></div><div class="scrollbar-thin overflow-x-auto"><table class="w-full"><thead><tr><th class="table-header">ID</th><th class="table-header">Tenant</th><th class="table-header">Type</th><th class="table-header">Method</th><th class="table-header text-right">Amount</th><th class="table-header">Status</th><th class="table-header">Date</th></tr></thead><tbody id="recentPaymentsBody" class="divide-y divide-gray-800"></tbody></table></div></article>
  `;

  initOverviewCharts(stats);
  loadRecentTenants();
  loadRecentPayments();
}

function initOverviewCharts(stats) {
  destroyChart('revenueByPlanChart');
  const ctx1 = $('#revenueByPlanChart')?.getContext('2d');
  if (ctx1) {
    const planRevenue = { starter: 0, professional: 0, business: 0, enterprise: 0 };
    AdminState.tenants.forEach(t => { if (planRevenue[t.plan] !== undefined) planRevenue[t.plan] += t.stats?.totalRevenue || 0; });
    AdminState.charts.revenueByPlanChart = new Chart(ctx1, { type: 'doughnut', data: { labels: Object.keys(planRevenue), datasets: [{ data: Object.values(planRevenue), backgroundColor: [chartColors.amber, chartColors.sky, chartColors.violet, chartColors.chaos], borderWidth: 0, cutout: '70%' }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, pointStyle: 'circle', padding: 15 } } } } });
  }

  destroyChart('tenantGrowthChart');
  const ctx2 = $('#tenantGrowthChart')?.getContext('2d');
  if (ctx2) {
    const days = 7; const labels = []; const data = [];
    for (let i = days - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })); data.push(Math.floor(Math.random() * 5)); }
    AdminState.charts.tenantGrowthChart = new Chart(ctx2, { type: 'bar', data: { labels, datasets: [{ label: 'New Tenants', data, backgroundColor: chartColors.primaryLight, borderColor: chartColors.primary, borderWidth: 1, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: '#2d2d2d' } } } } });
  }

  destroyChart('paymentStatusChart');
  const ctx3 = $('#paymentStatusChart')?.getContext('2d');
  if (ctx3) {
    AdminState.charts.paymentStatusChart = new Chart(ctx3, { type: 'doughnut', data: { labels: ['Completed', 'Pending', 'Failed', 'Processing'], datasets: [{ data: [0, stats.payments.pending, 0, 0], backgroundColor: [chartColors.emerald, chartColors.amber, chartColors.rose, chartColors.sky], borderWidth: 0, cutout: '70%' }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, pointStyle: 'circle', padding: 15 } } } } });
  }
}

async function loadRecentTenants() {
  try {
    const data = await api('/tenants?limit=10');
    AdminState.tenants = data.tenants || [];
    const body = $('#recentTenantsBody'); if (!body) return;
    body.innerHTML = AdminState.tenants.map(t => `<tr class="table-row" onclick="openTenantDetail('${t.id}')"><td class="table-cell font-medium">${t.name}</td><td class="table-cell"><span class="badge ${getPlanBadgeClass(t.plan)}">${t.plan}</span></td><td class="table-cell text-right font-mono">${fmtNumber(t.affiliateCount)}</td><td class="table-cell text-right font-mono">${fmtNumber(t.campaignCount)}</td><td class="table-cell text-right font-mono text-acc-emerald">${fmtCurrency(t.stats?.totalRevenue)}</td><td class="table-cell"><span class="badge ${t.status === 'active' ? 'badge-active' : t.status === 'cancelled' ? 'badge-danger' : 'badge-inactive'}">${t.status}</span></td><td class="table-cell text-gray-400">${timeAgo(t.createdAt)}</td></tr>`).join('') || '<tr><td colspan="7" class="table-cell text-center text-gray-500 py-8">No tenants</td></tr>';
  } catch (e) { console.error('Load recent tenants:', e); }
}

async function loadRecentPayments() {
  try {
    const data = await api('/payments?limit=10');
    const payments = data.payments || [];
    const body = $('#recentPaymentsBody'); if (!body) return;
    const statusBadges = { pending: 'badge-warning', completed: 'badge-active', failed: 'badge-danger', processing: 'badge-info', cancelled: 'badge-inactive' };
    body.innerHTML = payments.map(p => `<tr class="table-row"><td class="table-cell font-mono text-xs">${p.id}</td><td class="table-cell">${p.tenantId ? 'Tenant' : 'Affiliate'}</td><td class="table-cell">${p.type}</td><td class="table-cell"><span class="badge badge-info">${p.method}</span></td><td class="table-cell text-right font-mono">${fmtCurrency(p.amount, p.currency)}</td><td class="table-cell"><span class="badge ${statusBadges[p.status] || 'badge-inactive'}">${p.status}</span></td><td class="table-cell text-gray-400">${timeAgo(p.createdAt)}</td></tr>`).join('') || '<tr><td colspan="7" class="table-cell text-center text-gray-500 py-8">No payments</td></tr>';
  } catch (e) { console.error('Load recent payments:', e); }
}

// ============ TENANTS ============
async function renderTenants() {
  const content = $('#viewContent'); if (!content) return;
  content.innerHTML = `
    <div class="flex flex-col gap-4">
      <div class="card-base flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"><h3 class="text-lg font-semibold">Tenants</h3><div class="flex gap-2 w-full sm:w-auto"><input type="text" id="tenantSearch" placeholder="Search tenants..." class="input-base w-full sm:w-64" oninput="filterTenants()"><select id="tenantPlanFilter" class="input-base w-auto" onchange="filterTenants()"><option value="">All Plans</option><option value="starter">Starter</option><option value="professional">Professional</option><option value="business">Business</option><option value="enterprise">Enterprise</option></select><select id="tenantStatusFilter" class="input-base w-auto" onchange="filterTenants()"><option value="">All Status</option><option value="active">Active</option><option value="cancelled">Cancelled</option><option value="suspended">Suspended</option></select><button class="btn-primary" onclick="openCreateTenantModal()"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>Create Tenant</button><button class="btn-secondary" onclick="refreshView()"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>Refresh</button></div></div>
      <div class="card-base overflow-hidden"><div class="scrollbar-thin overflow-x-auto"><table class="w-full min-w-[1100px]"><thead><tr><th class="table-header">Tenant</th><th class="table-header">Domain</th><th class="table-header">Plan</th><th class="table-header">Affiliates</th><th class="table-header">Campaigns</th><th class="table-header">Revenue</th><th class="table-header">Balance</th><th class="table-header">Status</th><th class="table-header">Created</th><th class="table-header">Expires</th><th class="table-header">Actions</th></tr></thead><tbody id="tenantsBody" class="divide-y divide-gray-800"></tbody></table></div><div class="p-4 border-t border-gray-800 flex items-center justify-between"><span id="tenantPaginationInfo" class="text-sm text-gray-400">Loading...</span><div class="flex gap-2"><button id="tenantPrevPage" class="btn-secondary text-sm" onclick="changeTenantPage(-1)" disabled>Previous</button><button id="tenantNextPage" class="btn-secondary text-sm" onclick="changeTenantPage(1)" disabled>Next</button></div></div></div>
    </div>`;
  await loadTenantsTable();
}

async function loadTenantsTable() {
  try {
    const data = await api(`/tenants?limit=50&offset=${(AdminState.tenantPage - 1) * 50}`);
    AdminState.tenants = data.tenants || [];
    const body = $('#tenantsBody'); const info = $('#tenantPaginationInfo'); const prevBtn = $('#tenantPrevPage'); const nextBtn = $('#tenantNextPage');
    if (!body) return;
    if (AdminState.tenants.length === 0) { body.innerHTML = '<tr><td colspan="11" class="table-cell text-center text-gray-500 py-8">No tenants</td></tr>'; if (info) info.textContent = 'No tenants'; if (prevBtn) prevBtn.disabled = true; if (nextBtn) nextBtn.disabled = true; return; }
    body.innerHTML = AdminState.tenants.map(t => `<tr class="table-row" onclick="openTenantDetail('${t.id}')"><td class="table-cell font-medium">${t.name}</td><td class="table-cell font-mono text-sm">${t.domain}</td><td class="table-cell"><span class="badge ${getPlanBadgeClass(t.plan)}">${t.plan}</span></td><td class="table-cell text-right font-mono">${fmtNumber(t.affiliateCount)}</td><td class="table-cell text-right font-mono">${fmtNumber(t.campaignCount)}</td><td class="table-cell text-right font-mono text-acc-emerald">${fmtCurrency(t.stats?.totalRevenue)}</td><td class="table-cell text-right font-mono text-chaos-400">${fmtCurrency(t.stats?.balance)}</td><td class="table-cell"><span class="badge ${t.status === 'active' ? 'badge-active' : t.status === 'cancelled' ? 'badge-danger' : 'badge-warning'}">${t.status}</span></td><td class="table-cell text-gray-400">${timeAgo(t.createdAt)}</td><td class="table-cell text-gray-400">${t.expiresAt ? fmtDate(t.expiresAt) : 'N/A'}</td><td class="table-cell"><div class="flex gap-1"><button class="btn-ghost text-xs p-1" onclick="event.stopPropagation(); openTenantDetail('${t.id}')">View</button><button class="btn-ghost text-xs p-1" onclick="event.stopPropagation(); openTenantBillingModal('${t.id}')">Billing</button></div></td></tr>`).join('');
    if (info) info.textContent = `Page ${data.page} of ${Math.ceil(data.total / data.pageSize)} (${data.total} total)`;
    if (prevBtn) prevBtn.disabled = AdminState.tenantPage <= 1;
    if (nextBtn) nextBtn.disabled = AdminState.tenantPage >= Math.ceil(data.total / data.pageSize);
  } catch (e) { console.error('Load tenants:', e); $('#tenantsBody').innerHTML = '<tr><td colspan="11" class="table-cell text-center text-acc-rose py-8">Failed to load tenants</td></tr>'; }
}

function changeTenantPage(delta) { AdminState.tenantPage += delta; loadTenantsTable(); }

function filterTenants() { const search = $('#tenantSearch')?.value?.toLowerCase() || ''; const plan = $('#tenantPlanFilter')?.value || ''; const status = $('#tenantStatusFilter')?.value || ''; $$('#tenantsBody tr').forEach(row => { const text = row.textContent.toLowerCase(); const rowPlan = row.querySelector('.badge')?.textContent?.toLowerCase() || ''; const rowStatus = row.querySelectorAll('.badge')[1]?.textContent?.toLowerCase() || ''; const matchSearch = !search || text.includes(search); const matchPlan = !plan || rowPlan === plan; const matchStatus = !status || rowStatus === status; row.style.display = (matchSearch && matchPlan && matchStatus) ? '' : 'none'; }); }

async function openTenantDetail(tenantId) {
  try {
    const tenant = await api(`/tenants?id=${tenantId}&includeStats=true&includeAffiliates=true&includeCampaigns=true`);
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-overlay open" onclick="closeModal()"><div class="modal-panel w-full max-w-4xl" onclick="event.stopPropagation()"><div class="p-6 border-b border-gray-800 flex items-center justify-between"><h3 class="text-lg font-semibold">Tenant Details</h3><button class="btn-ghost p-1" onclick="closeModal()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button></div><div class="p-6 space-y-6 max-h-[70vh] overflow-y-auto">${renderTenantDetailHTML(tenant)}</div></div></div>`;
  } catch (e) { showToast('Failed to load tenant details', 'error'); }
}

function renderTenantDetailHTML(t) {
  const statusBadge = { active: 'badge-active', cancelled: 'badge-danger', suspended: 'badge-warning' }[t.status] || 'badge-inactive';
  return `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="card-base p-4 text-center"><p class="text-xs text-gray-500">Status</p><p class="font-semibold"><span class="badge ${statusBadge}">${t.status}</span></p></div>
      <div class="card-base p-4 text-center"><p class="text-xs text-gray-500">Plan</p><p class="font-semibold"><span class="badge ${getPlanBadgeClass(t.plan)}">${t.plan}</span></p></div>
      <div class="card-base p-4 text-center"><p class="text-xs text-gray-500">Affiliates</p><p class="font-semibold font-mono text-acc-sky">${fmtNumber(t.affiliateCount)} / ${t.planLimits?.maxAffiliates === -1 ? '∞' : t.planLimits?.maxAffiliates}</p></div>
      <div class="card-base p-4 text-center"><p class="text-xs text-gray-500">Campaigns</p><p class="font-semibold font-mono text-chaos-400">${fmtNumber(t.campaignCount)} / ${t.planLimits?.maxCampaigns === -1 ? '∞' : t.planLimits?.maxCampaigns}</p></div>
    </div>
    <div class="card-base p-4"><h4 class="font-medium mb-3">Tenant Info</h4><div class="grid grid-cols-2 gap-4 text-sm"><div><p class="text-gray-500">Name</p><p class="font-medium">${t.name}</p></div><div><p class="text-gray-500">Domain</p><p class="font-medium font-mono">${t.domain}</p></div><div><p class="text-gray-500">Email</p><p class="font-medium">${t.email}</p></div><div><p class="text-gray-500">API Key</p><p class="font-medium font-mono text-xs truncate">${t.apiKey}</p></div><div><p class="text-gray-500">Created</p><p class="font-medium">${fmtDate(t.createdAt)}</p></div><div><p class="text-gray-500">Expires</p><p class="font-medium">${t.expiresAt ? fmtDate(t.expiresAt) : 'N/A'}</p></div><div><p class="text-gray-500">Billing Cycle</p><p class="font-medium">${t.billing?.cycle || 'monthly'}</p></div><div><p class="text-gray-500">Next Billing</p><p class="font-medium">${t.billing?.nextBillingDate ? fmtDate(t.billing.nextBillingDate) : 'N/A'}</p></div></div></div>
    <div class="card-base p-4"><h4 class="font-medium mb-3">Revenue Stats</h4><div class="grid grid-cols-3 gap-4 text-center"><div class="p-3 rounded-lg bg-surface-800"><p class="text-xs text-gray-500">Total Revenue</p><p class="font-mono text-lg text-acc-emerald">${fmtCurrency(t.stats?.totalRevenue)}</p></div><div class="p-3 rounded-lg bg-surface-800"><p class="text-xs text-gray-500">Total Deposits</p><p class="font-mono text-lg text-chaos-400">${fmtCurrency(t.stats?.totalDeposits)}</p></div><div class="p-3 rounded-lg bg-surface-800"><p class="text-xs text-gray-500">Balance</p><p class="font-mono text-lg text-acc-sky">${fmtCurrency(t.stats?.balance)}</p></div></div></div>
    ${t.affiliates && t.affiliates.length > 0 ? `<div class="card-base p-4"><h4 class="font-medium mb-3">Affiliates (${t.affiliates.length})</h4><div class="scrollbar-thin overflow-x-auto"><table class="w-full"><thead><tr><th class="table-header">Username</th><th class="table-header">Email</th><th class="table-header">Tier</th><th class="table-header">Status</th><th class="table-header text-right">Earnings</th><th class="table-header text-right">Referrals</th><th class="table-header">Last Login</th></tr></thead><tbody class="divide-y divide-gray-800">${t.affiliates.map(a => `<tr class="table-row"><td class="table-cell font-medium">${a.username}</td><td class="table-cell text-gray-400">${a.email}</td><td class="table-cell"><span class="badge badge-${a.tier}">${a.tier}</span></td><td class="table-cell"><span class="badge ${a.status === 'active' ? 'badge-active' : 'badge-inactive'}">${a.status}</span></td><td class="table-cell text-right font-mono text-acc-emerald">${fmtCurrency(a.stats?.totalEarnings)}</td><td class="table-cell text-right font-mono">${fmtNumber(a.stats?.totalReferrals)}</td><td class="table-cell text-gray-400">${a.lastLogin ? timeAgo(a.lastLogin) : 'Never'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${t.campaigns && t.campaigns.length > 0 ? `<div class="card-base p-4"><h4 class="font-medium mb-3">Campaigns (${t.campaigns.length})</h4><div class="scrollbar-thin overflow-x-auto"><table class="w-full"><thead><tr><th class="table-header">Name</th><th class="table-header">Status</th><th class="table-header text-right">Infections</th><th class="table-header text-right">Files</th><th class="table-header text-right">Revenue</th><th class="table-header">Created</th></tr></thead><tbody class="divide-y divide-gray-800">${t.campaigns.map(c => `<tr class="table-row"><td class="table-cell font-mono text-chaos-400">${c.name}</td><td class="table-cell"><span class="badge ${c.status === 'active' ? 'badge-active' : 'badge-inactive'}">${c.status}</span></td><td class="table-cell text-right font-mono">${fmtNumber(c.stats?.totalInfections)}</td><td class="table-cell text-right font-mono">${fmtNumber(c.stats?.totalFiles)}</td><td class="table-cell text-right font-mono text-acc-emerald">${fmtCurrency((c.stats?.totalInfections || 0) * 50)}</td><td class="table-cell text-gray-400">${timeAgo(c.createdAt)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="flex gap-2"><button class="btn-primary" onclick="openTenantBillingModal('${t.id}')">Manage Billing</button><button class="btn-secondary" onclick="openChangePlanModal('${t.id}', '${t.plan}')">Change Plan</button>${t.status === 'active' ? `<button class="btn-danger" onclick="suspendTenant('${t.id}')">Suspend</button>` : `<button class="btn-primary" onclick="reactivateTenant('${t.id}')">Reactivate</button>`}</div>
  `;
}

function openCreateTenantModal() {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-overlay open" onclick="closeModal()"><div class="modal-panel w-full max-w-md" onclick="event.stopPropagation()"><div class="p-6 border-b border-gray-800 flex items-center justify-between"><h3 class="text-lg font-semibold">Create Tenant</h3><button class="btn-ghost p-1" onclick="closeModal()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button></div><div class="p-6 space-y-4"><div><label class="block text-xs text-gray-500 mb-1">Tenant Name</label><input type="text" id="newTenantName" class="input-base" placeholder="Acme Corp"></div><div><label class="block text-xs text-gray-500 mb-1">Domain</label><input type="text" id="newTenantDomain" class="input-base" placeholder="acme-corp"></div><div><label class="block text-xs text-gray-500 mb-1">Admin Email</label><input type="email" id="newTenantEmail" class="input-base" placeholder="admin@acme.com"></div><div><label class="block text-xs text-gray-500 mb-1">Plan</label><select id="newTenantPlan" class="input-base"><option value="starter">Starter ($29/mo)</option><option value="professional">Professional ($99/mo)</option><option value="business">Business ($299/mo)</option><option value="enterprise">Enterprise ($999/mo)</option></select></div><button class="btn-primary w-full" onclick="createTenant()">Create Tenant</button></div></div></div>`;
}

async function createTenant() {
  const name = $('#newTenantName')?.value?.trim(); const domain = $('#newTenantDomain')?.value?.trim(); const email = $('#newTenantEmail')?.value?.trim(); const plan = $('#newTenantPlan')?.value;
  if (!name || !domain || !email) return showToast('Fill all fields', 'error');
  try { await api('/tenants', { method: 'POST', body: JSON.stringify({ name, domain, email, plan }) }); showToast('Tenant created!', 'success'); closeModal(); refreshView(); } catch (e) { showToast(e.message || 'Failed to create tenant', 'error'); }
}

function openChangePlanModal(tenantId, currentPlan) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-overlay open" onclick="closeModal()"><div class="modal-panel w-full max-w-md" onclick="event.stopPropagation()"><div class="p-6 border-b border-gray-800 flex items-center justify-between"><h3 class="text-lg font-semibold">Change Plan</h3><button class="btn-ghost p-1" onclick="closeModal()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button></div><div class="p-6 space-y-4"><p class="text-sm text-gray-400">Current plan: <span class="badge ${getPlanBadgeClass(currentPlan)}">${currentPlan}</span></p><select id="changePlanSelect" class="input-base"><option value="starter">Starter ($29/mo)</option><option value="professional">Professional ($99/mo)</option><option value="business">Business ($299/mo)</option><option value="enterprise">Enterprise ($999/mo)</option></select><button class="btn-primary w-full" onclick="changeTenantPlan('${tenantId}')">Change Plan</button></div></div></div>`;
  $('#changePlanSelect').value = currentPlan;
}

async function changeTenantPlan(tenantId) {
  const newPlan = $('#changePlanSelect')?.value;
  try { await api(`/tenants/billing`, { method: 'POST', body: JSON.stringify({ action: 'change_plan', plan: newPlan }) }); showToast('Plan changed!', 'success'); closeModal(); refreshView(); } catch (e) { showToast(e.message || 'Failed to change plan', 'error'); }
}

async function suspendTenant(tenantId) {
  if (!confirm('Suspend this tenant?')) return;
  try { await api(`/tenants?id=${tenantId}`, { method: 'PUT', body: JSON.stringify({ status: 'suspended' }) }); showToast('Tenant suspended', 'success'); closeModal(); refreshView(); } catch (e) { showToast(e.message || 'Failed', 'error'); }
}

async function reactivateTenant(tenantId) {
  try { await api(`/tenants?id=${tenantId}`, { method: 'PUT', body: JSON.stringify({ status: 'active' }) }); showToast('Tenant reactivated', 'success'); closeModal(); refreshView(); } catch (e) { showToast(e.message || 'Failed', 'error'); }
}

function openTenantBillingModal(tenantId) {
  closeModal();
  setTimeout(() => { showView('tenants'); }, 100);
  // Would open billing detail modal
  showToast('Billing detail view coming soon', 'info');
}

// ============ PAYMENTS ============
async function renderPayments() {
  const content = $('#viewContent'); if (!content) return;
  content.innerHTML = `<div class="flex flex-col gap-4"><div class="card-base flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"><h3 class="text-lg font-semibold">All Payments</h3><div class="flex gap-2 w-full sm:w-auto"><input type="text" id="paymentSearch" placeholder="Search payments..." class="input-base w-full sm:w-64" oninput="filterPayments()"><select id="paymentTypeFilter" class="input-base w-auto" onchange="filterPayments()"><option value="">All Types</option><option value="deposit">Deposit</option><option value="payout">Payout</option><option value="commission">Commission</option></select><select id="paymentMethodFilter" class="input-base w-auto" onchange="filterPayments()"><option value="">All Methods</option><option value="btc">BTC</option><option value="eth">ETH</option><option value="usdt">USDT</option><option value="xmr">XMR</option><option value="stripe">Stripe</option><option value="coinbase">Coinbase</option></select><select id="paymentStatusFilter" class="input-base w-auto" onchange="filterPayments()"><option value="">All Status</option><option value="pending">Pending</option><option value="processing">Processing</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select><button class="btn-secondary" onclick="refreshView()"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>Refresh</button></div></div><div class="card-base overflow-hidden"><div class="scrollbar-thin overflow-x-auto"><table class="w-full min-w-[1200px]"><thead><tr><th class="table-header">ID</th><th class="table-header">Tenant/Affiliate</th><th class="table-header">Type</th><th class="table-header">Method</th><th class="table-header text-right">Amount</th><th class="table-header text-right">Fee</th><th class="table-header text-right">Net</th><th class="table-header">Status</th><th class="table-header">Confirmations</th><th class="table-header">TX Hash</th><th class="table-header">Created</th><th class="table-header">Actions</th></tr></thead><tbody id="paymentsBody" class="divide-y divide-gray-800"></tbody></table></div><div class="p-4 border-t border-gray-800 flex items-center justify-between"><span id="paymentPaginationInfo" class="text-sm text-gray-400">Loading...</span><div class="flex gap-2"><button id="paymentPrevPage" class="btn-secondary text-sm" onclick="changePaymentPage(-1)" disabled>Previous</button><button id="paymentNextPage" class="btn-secondary text-sm" onclick="changePaymentPage(1)" disabled>Next</button></div></div></div></div>`;
  await loadPaymentsTable();
}

async function loadPaymentsTable() {
  try {
    const data = await api(`/payments?limit=50&offset=${(AdminState.paymentPage - 1) * 50}`);
    AdminState.payments = data.payments || [];
    const body = $('#paymentsBody'); const info = $('#paymentPaginationInfo'); const prevBtn = $('#paymentPrevPage'); const nextBtn = $('#paymentNextPage');
    if (!body) return;
    if (AdminState.payments.length === 0) { body.innerHTML = '<tr><td colspan="12" class="table-cell text-center text-gray-500 py-8">No payments</td></tr>'; if (info) info.textContent = 'No payments'; if (prevBtn) prevBtn.disabled = true; if (nextBtn) nextBtn.disabled = true; return; }
    const statusBadges = { pending: 'badge-warning', processing: 'badge-info', completed: 'badge-active', failed: 'badge-danger', cancelled: 'badge-inactive' };
    body.innerHTML = AdminState.payments.map(p => `<tr class="table-row"><td class="table-cell font-mono text-xs">${p.id}</td><td class="table-cell">${p.tenantId ? 'Tenant' : 'Affiliate'}</td><td class="table-cell">${p.type}</td><td class="table-cell"><span class="badge badge-info">${p.method}</span></td><td class="table-cell text-right font-mono">${fmtCurrency(p.amount, p.currency)}</td><td class="table-cell text-right font-mono text-acc-amber">${fmtCurrency(p.fee, p.currency)}</td><td class="table-cell text-right font-mono text-acc-emerald">${fmtCurrency(p.netAmount, p.currency)}</td><td class="table-cell"><span class="badge ${statusBadges[p.status] || 'badge-inactive'}">${p.status}</span></td><td class="table-cell text-right font-mono">${p.confirmations || 0} / ${p.requiredConfirmations || 0}</td><td class="table-cell font-mono text-xs truncate max-w-[150px]">${p.txHash || '-'}</td><td class="table-cell text-gray-400">${timeAgo(p.createdAt)}</td><td class="table-cell"><button class="btn-ghost text-xs p-1" onclick="viewPaymentDetail('${p.id}')">View</button></td></tr>`).join('');
    if (info) info.textContent = `Page ${data.page} of ${Math.ceil(data.total / data.pageSize)} (${data.total} total)`;
    if (prevBtn) prevBtn.disabled = AdminState.paymentPage <= 1;
    if (nextBtn) nextBtn.disabled = AdminState.paymentPage >= Math.ceil(data.total / data.pageSize);
  } catch (e) { console.error('Load payments:', e); $('#paymentsBody').innerHTML = '<tr><td colspan="12" class="table-cell text-center text-acc-rose py-8">Failed to load payments</td></tr>'; }
}

function changePaymentPage(delta) { AdminState.paymentPage += delta; loadPaymentsTable(); }

function filterPayments() { const search = $('#paymentSearch')?.value?.toLowerCase() || ''; const type = $('#paymentTypeFilter')?.value || ''; const method = $('#paymentMethodFilter')?.value || ''; const status = $('#paymentStatusFilter')?.value || ''; $$('#paymentsBody tr').forEach(row => { const text = row.textContent.toLowerCase(); const matchSearch = !search || text.includes(search); const matchType = !type || text.includes(type); const matchMethod = !method || text.includes(method); const matchStatus = !status || text.includes(status); row.style.display = (matchSearch && matchType && matchMethod && matchStatus) ? '' : 'none'; }); }

// ============ AFFILIATES ============
async function renderAffiliates() {
  const content = $('#viewContent'); if (!content) return;
  content.innerHTML = `<div class="flex flex-col gap-4"><div class="card-base flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"><h3 class="text-lg font-semibold">All Affiliates</h3><div class="flex gap-2 w-full sm:w-auto"><input type="text" id="affiliateSearch" placeholder="Search affiliates..." class="input-base w-full sm:w-64" oninput="filterAffiliates()"><select id="affiliateTierFilter" class="input-base w-auto" onchange="filterAffiliates()"><option value="">All Tiers</option><option value="bronze">Bronze</option><option value="silver">Silver</option><option value="gold">Gold</option><option value="platinum">Platinum</option></select><select id="affiliateStatusFilter" class="input-base w-auto" onchange="filterAffiliates()"><option value="">All Status</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option></select><button class="btn-secondary" onclick="refreshView()"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>Refresh</button></div></div><div class="card-base overflow-hidden"><div class="scrollbar-thin overflow-x-auto"><table class="w-full min-w-[1100px]"><thead><tr><th class="table-header">Affiliate</th><th class="table-header">Email</th><th class="table-header">Tenant</th><th class="table-header">Tier</th><th class="table-header">Commission</th><th class="table-header">Status</th><th class="table-header text-right">Total Earnings</th><th class="table-header text-right">Pending</th><th class="table-header text-right">Referrals</th><th class="table-header">Campaigns</th><th class="table-header">Last Login</th><th class="table-header">Created</th></tr></thead><tbody id="affiliatesBody" class="divide-y divide-gray-800"></tbody></table></div><div class="p-4 border-t border-gray-800 flex items-center justify-between"><span id="affiliatePaginationInfo" class="text-sm text-gray-400">Loading...</span><div class="flex gap-2"><button id="affiliatePrevPage" class="btn-secondary text-sm" onclick="changeAffiliatePage(-1)" disabled>Previous</button><button id="affiliateNextPage" class="btn-secondary text-sm" onclick="changeAffiliatePage(1)" disabled>Next</button></div></div></div></div>`;
  await loadAffiliatesTable();
}

async function loadAffiliatesTable() {
  try {
    const data = await api(`/affiliates?limit=50&offset=${(AdminState.affiliatePage - 1) * 50}`);
    AdminState.affiliates = data.affiliates || [];
    const body = $('#affiliatesBody'); const info = $('#affiliatePaginationInfo'); const prevBtn = $('#affiliatePrevPage'); const nextBtn = $('#affiliateNextPage');
    if (!body) return;
    if (AdminState.affiliates.length === 0) { body.innerHTML = '<tr><td colspan="13" class="table-cell text-center text-gray-500 py-8">No affiliates</td></tr>'; if (info) info.textContent = 'No affiliates'; if (prevBtn) prevBtn.disabled = true; if (nextBtn) nextBtn.disabled = true; return; }
    const tierBadges = { bronze: 'badge-bronze', silver: 'badge-silver', gold: 'badge-gold', platinum: 'badge-platinum' };
    body.innerHTML = AdminState.affiliates.map(a => `<tr class="table-row"><td class="table-cell font-medium">${a.username}</td><td class="table-cell text-gray-400">${a.email}</td><td class="table-cell">${a.tenantId || 'Global'}</td><td class="table-cell"><span class="badge ${tierBadges[a.tier] || 'badge-inactive'}">${a.tier}</span></td><td class="table-cell font-mono">${(a.commissionRate * 100).toFixed(0)}%</td><td class="table-cell"><span class="badge ${a.status === 'active' ? 'badge-active' : 'badge-inactive'}">${a.status}</span></td><td class="table-cell text-right font-mono text-acc-emerald">${fmtCurrency(a.stats?.totalEarnings)}</td><td class="table-cell text-right font-mono text-chaos-400">${fmtCurrency(a.stats?.pendingEarnings)}</td><td class="table-cell text-right font-mono">${fmtNumber(a.stats?.totalReferrals)}</td><td class="table-cell text-right font-mono">${fmtNumber(a.stats?.totalCampaignsCreated)}</td><td class="table-cell text-gray-400">${a.lastLogin ? timeAgo(a.lastLogin) : 'Never'}</td><td class="table-cell text-gray-400">${timeAgo(a.createdAt)}</td></tr>`).join('');
    if (info) info.textContent = `Page ${data.page} of ${Math.ceil(data.total / data.pageSize)} (${data.total} total)`;
    if (prevBtn) prevBtn.disabled = AdminState.affiliatePage <= 1;
    if (nextBtn) nextBtn.disabled = AdminState.affiliatePage >= Math.ceil(data.total / data.pageSize);
  } catch (e) { console.error('Load affiliates:', e); $('#affiliatesBody').innerHTML = '<tr><td colspan="13" class="table-cell text-center text-acc-rose py-8">Failed to load affiliates</td></tr>'; }
}

function changeAffiliatePage(delta) { AdminState.affiliatePage += delta; loadAffiliatesTable(); }

function filterAffiliates() { const search = $('#affiliateSearch')?.value?.toLowerCase() || ''; const tier = $('#affiliateTierFilter')?.value || ''; const status = $('#affiliateStatusFilter')?.value || ''; $$('#affiliatesBody tr').forEach(row => { const text = row.textContent.toLowerCase(); const rowTier = row.querySelector('.badge')?.textContent?.toLowerCase() || ''; const rowStatus = row.querySelectorAll('.badge')[1]?.textContent?.toLowerCase() || ''; const matchSearch = !search || text.includes(search); const matchTier = !tier || rowTier === tier; const matchStatus = !status || rowStatus === status; row.style.display = (matchSearch && matchTier && matchStatus) ? '' : 'none'; }); }

// ============ CAMPAIGNS ============
async function renderCampaigns() {
  const content = $('#viewContent'); if (!content) return;
  content.innerHTML = `<div class="flex flex-col gap-4"><div class="card-base flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"><h3 class="text-lg font-semibold">All Campaigns</h3><div class="flex gap-2 w-full sm:w-auto"><input type="text" id="campaignSearch" placeholder="Search campaigns..." class="input-base w-full sm:w-64" oninput="filterCampaigns()"><select id="campaignStatusFilter" class="input-base w-auto" onchange="filterCampaigns()"><option value="">All Status</option><option value="active">Active</option><option value="inactive">Inactive</option></select><button class="btn-secondary" onclick="refreshView()"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>Refresh</button></div></div><div class="card-base overflow-hidden"><div class="scrollbar-thin overflow-x-auto"><table class="w-full min-w-[1100px]"><thead><tr><th class="table-header">Campaign</th><th class="table-header">Tenant</th><th class="table-header">Affiliate</th><th class="table-header">Status</th><th class="table-header text-right">Infections</th><th class="table-header text-right">Files</th><th class="table-header text-right">Data</th><th class="table-header">Created</th><th class="table-header">Last Activity</th><th class="table-header">Actions</th></tr></thead><tbody id="campaignsBody" class="divide-y divide-gray-800"></tbody></table></div><div class="p-4 border-t border-gray-800 flex items-center justify-between"><span id="campaignPaginationInfo" class="text-sm text-gray-400">Loading...</span><div class="flex gap-2"><button id="campaignPrevPage" class="btn-secondary text-sm" onclick="changeCampaignPage(-1)" disabled>Previous</button><button id="campaignNextPage" class="btn-secondary text-sm" onclick="changeCampaignPage(1)" disabled>Next</button></div></div></div></div>`;
  await loadCampaignsTable();
}

async function loadCampaignsTable() {
  try {
    const data = await api(`/campaigns?limit=50&offset=${(AdminState.campaignPage - 1) * 50}`);
    AdminState.campaigns = data.campaigns || [];
    const body = $('#campaignsBody'); const info = $('#campaignPaginationInfo'); const prevBtn = $('#campaignPrevPage'); const nextBtn = $('#campaignNextPage');
    if (!body) return;
    if (AdminState.campaigns.length === 0) { body.innerHTML = '<tr><td colspan="10" class="table-cell text-center text-gray-500 py-8">No campaigns</td></tr>'; if (info) info.textContent = 'No campaigns'; if (prevBtn) prevBtn.disabled = true; if (nextBtn) nextBtn.disabled = true; return; }
    body.innerHTML = AdminState.campaigns.map(c => `<tr class="table-row"><td class="table-cell font-mono text-chaos-400">${c.name}</td><td class="table-cell">${c.tenantId || 'Global'}</td><td class="table-cell">${c.affiliateId || 'N/A'}</td><td class="table-cell"><span class="badge ${c.status === 'active' ? 'badge-active' : 'badge-inactive'}">${c.status}</span></td><td class="table-cell text-right font-mono">${fmtNumber(c.stats?.totalInfections)}</td><td class="table-cell text-right font-mono">${fmtNumber(c.stats?.totalFiles)}</td><td class="table-cell text-right font-mono">${fmtBytes(c.stats?.totalBytes)}</td><td class="table-cell text-gray-400">${timeAgo(c.createdAt)}</td><td class="table-cell text-gray-400">${c.stats?.lastActivity ? timeAgo(c.stats.lastActivity) : 'Never'}</td><td class="table-cell"><button class="btn-ghost text-xs p-1" onclick="viewCampaignDetail('${c.id}')">View</button></td></tr>`).join('');
    if (info) info.textContent = `Page ${data.page} of ${Math.ceil(data.total / data.pageSize)} (${data.total} total)`;
    if (prevBtn) prevBtn.disabled = AdminState.campaignPage <= 1;
    if (nextBtn) nextBtn.disabled = AdminState.campaignPage >= Math.ceil(data.total / data.pageSize);
  } catch (e) { console.error('Load campaigns:', e); $('#campaignsBody').innerHTML = '<tr><td colspan="10" class="table-cell text-center text-acc-rose py-8">Failed to load campaigns</td></tr>'; }
}

function changeCampaignPage(delta) { AdminState.campaignPage += delta; loadCampaignsTable(); }

function filterCampaigns() { const search = $('#campaignSearch')?.value?.toLowerCase() || ''; const status = $('#campaignStatusFilter')?.value || ''; $$('#campaignsBody tr').forEach(row => { const text = row.textContent.toLowerCase(); const rowStatus = row.querySelector('.badge')?.textContent?.toLowerCase() || ''; const matchSearch = !search || text.includes(search); const matchStatus = !status || rowStatus === status; row.style.display = (matchSearch && matchStatus) ? '' : 'none'; }); }

function fmtBytes(bytes) { if (!bytes || bytes === 0) return '0 B'; const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(bytes) / Math.log(k)); return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`; }

// ============ ANALYTICS ============
async function renderAnalytics() {
  const content = $('#viewContent'); if (!content) return;
  content.innerHTML = `<div class="space-y-6"><div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" id="analyticsSummary"></div><div class="grid grid-cols-1 lg:grid-cols-2 gap-4"><article class="card-base"><h3 class="text-lg font-semibold mb-4">Revenue Trend</h3><div class="chart-container-lg"><canvas id="revenueTrendChart"></canvas></div></article><article class="card-base"><h3 class="text-lg font-semibold mb-4">Tenant Distribution by Plan</h3><div class="chart-container-lg"><canvas id="planDistributionChart"></canvas></div></article></div><div class="grid grid-cols-1 lg:grid-cols-2 gap-4"><article class="card-base"><h3 class="text-lg font-semibold mb-4">Payment Methods</h3><div class="chart-container-lg"><canvas id="paymentMethodsChart"></canvas></div></article><article class="card-base"><h3 class="text-lg font-semibold mb-4">Top Tenants by Revenue</h3><div class="chart-container-lg"><canvas id="topTenantsChart"></canvas></div></article></div></div>`;
  initAnalyticsCharts();
  loadAnalyticsSummary();
}

function initAnalyticsCharts() {
  destroyChart('revenueTrendChart'); const ctx1 = $('#revenueTrendChart')?.getContext('2d'); if (ctx1) { const days = 30; const labels = []; const data = []; for (let i = days - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })); data.push(Math.random() * 5000); } AdminState.charts.revenueTrendChart = new Chart(ctx1, { type: 'line', data: { labels, datasets: [{ label: 'Revenue (USD)', data, borderColor: chartColors.emerald, backgroundColor: chartColors.emeraldLight, fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: '#2d2d2d' }, ticks: { callback: v => '$' + v } } } } }); }

  destroyChart('planDistributionChart'); const ctx2 = $('#planDistributionChart')?.getContext('2d'); if (ctx2) { AdminState.charts.planDistributionChart = new Chart(ctx2, { type: 'doughnut', data: { labels: ['Starter', 'Professional', 'Business', 'Enterprise'], datasets: [{ data: [45, 30, 15, 10], backgroundColor: [chartColors.amber, chartColors.sky, chartColors.violet, chartColors.chaos], borderWidth: 0, cutout: '60%' }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, pointStyle: 'circle', padding: 15 } } } } }); }

  destroyChart('paymentMethodsChart'); const ctx3 = $('#paymentMethodsChart')?.getContext('2d'); if (ctx3) { AdminState.charts.paymentMethodsChart = new Chart(ctx3, { type: 'pie', data: { labels: ['BTC', 'ETH', 'USDT', 'XMR', 'Stripe', 'Coinbase'], datasets: [{ data: [30, 25, 20, 10, 10, 5], backgroundColor: [chartColors.chaos, chartColors.sky, chartColors.emerald, chartColors.amber, chartColors.violet, chartColors.cyan], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, pointStyle: 'circle', padding: 15 } } } } }); }

  destroyChart('topTenantsChart'); const ctx4 = $('#topTenantsChart')?.getContext('2d'); if (ctx4) { AdminState.charts.topTenantsChart = new Chart(ctx4, { type: 'bar', data: { labels: ['Tenant A', 'Tenant B', 'Tenant C', 'Tenant D', 'Tenant E'], datasets: [{ label: 'Revenue (USD)', data: [15000, 12000, 9000, 7500, 5000], backgroundColor: chartColors.primaryLight, borderColor: chartColors.primary, borderWidth: 1, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, grid: { color: '#2d2d2d' }, ticks: { callback: v => '$' + v } }, y: { grid: { display: false } } } } }); }
}

async function loadAnalyticsSummary() {
  const summary = $('#analyticsSummary'); if (!summary) return;
  summary.innerHTML = `<article class="card-base"><p class="stat-label">Total Revenue</p><p class="stat-value text-acc-emerald">$127,450</p><p class="text-xs text-gray-500 mt-1">+12.5% vs last month</p></article><article class="card-base"><p class="stat-label">Active Tenants</p><p class="stat-value text-chaos-400">234</p><p class="text-xs text-gray-500 mt-1">+8 this week</p></article><article class="card-base"><p class="stat-label">Avg Revenue/Tenant</p><p class="stat-value text-acc-sky">$544</p><p class="text-xs text-gray-500 mt-1">+5.2%</p></article><article class="card-base"><p class="stat-label">Churn Rate</p><p class="stat-value text-acc-rose">2.1%</p><p class="text-xs text-gray-500 mt-1">-0.3%</p></article>`;
}

// ============ SETTINGS ============
async function renderSettings() {
  const content = $('#viewContent'); if (!content) return;
  content.innerHTML = `<div class="space-y-6 max-w-3xl"><article class="card-base"><h3 class="text-lg font-semibold mb-4">System Settings</h3><div class="space-y-4"><div><label class="block text-xs text-gray-500 mb-1">Master API Key</label><div class="flex gap-2"><code class="flex-1 font-mono text-sm bg-surface-800 px-3 py-2 rounded-lg border border-gray-700">${process.env.MASTER_API_KEY || 'master_key_placeholder'}</code><button class="btn-secondary copy-btn" onclick="copyToClipboard('${process.env.MASTER_API_KEY || 'master_key_placeholder'}')">Copy</button></div></div><div><label class="block text-xs text-gray-500 mb-1">Default Tenant Plan</label><select class="input-base"><option value="starter">Starter</option><option value="professional" selected>Professional</option><option value="business">Business</option><option value="enterprise">Enterprise</option></select></div><div><label class="block text-xs text-gray-500 mb-1">Default Commission Rate</label><input type="number" class="input-base" value="20" min="1" max="50" step="1" placeholder="20%"></div><div class="flex items-center gap-3"><input type="checkbox" class="w-4 h-4 rounded border-gray-600 bg-surface-800 text-chaos-500 focus:ring-chaos-500" checked><span class="text-sm">Enable Multi-Level Referrals by Default</span></div><div class="flex items-center gap-3"><input type="checkbox" class="w-4 h-4 rounded border-gray-600 bg-surface-800 text-chaos-500 focus:ring-chaos-500" checked><span class="text-sm">Require Email Verification</span></div><div class="flex items-center gap-3"><input type="checkbox" class="w-4 h-4 rounded border-gray-600 bg-surface-800 text-chaos-500 focus:ring-chaos-500"><span class="text-sm">Enable 2FA for Admins</span></div></div></article><article class="card-base"><h3 class="text-lg font-semibold mb-4">Payment Providers</h3><div class="space-y-4"><div class="flex items-center justify-between"><span>Stripe</span><span class="badge badge-active">Configured</span></div><div class="flex items-center justify-between"><span>Coinbase Commerce</span><span class="badge badge-warning">Not Configured</span></div><div class="flex items-center justify-between"><span>NowPayments</span><span class="badge badge-inactive">Disabled</span></div><div class="flex items-center justify-between"><span>BTCPay Server</span><span class="badge badge-inactive">Disabled</span></div><div class="flex items-center justify-between"><span>BlockCypher Webhooks</span><span class="badge badge-active">Active</span></div></div></article><article class="card-base border-acc-rose"><h3 class="text-lg font-semibold mb-4 text-acc-rose">Danger Zone</h3><div class="space-y-3"><button class="btn-danger w-full" onclick="confirmPurgeAllData()">Purge All Data</button><p class="text-xs text-gray-500 text-center">This will delete ALL tenants, affiliates, campaigns, and payments. This action is IRREVERSIBLE.</p></div></article></div>`;
}

function confirmPurgeAllData() { const confirm1 = prompt('Type "PURGE ALL DATA" to confirm:'); if (confirm1 !== 'PURGE ALL DATA') return showToast('Cancelled', 'info'); const confirm2 = prompt('This cannot be undone. Type your admin username:'); if (confirm2 !== 'admin') return showToast('Cancelled', 'info'); showToast('Purge function not implemented (safety)', 'warning'); }

function copyToClipboard(text) { navigator.clipboard.writeText(text); showToast('Copied!', 'success'); }

function closeModal() { $('#modalRoot').innerHTML = ''; }

function toggleSidebar() { $('#sidebar')?.classList?.toggle('-translate-x-full'); $('#sidebarOverlay')?.classList?.toggle('hidden'); }

function showView(view) { $('#sidebar')?.classList?.add('-translate-x-full'); $('#sidebarOverlay')?.classList?.add('hidden'); renderView(view); }

function viewPaymentDetail(paymentId) { showToast('Payment detail view coming soon', 'info'); }

function viewCampaignDetail(campaignId) { showToast('Campaign detail view coming soon', 'info'); }

document.addEventListener('DOMContentLoaded', async () => { await checkAuth(); });

async function checkAuth() {
  // In production, verify admin session
  // For now, assume authenticated
  renderView('overview');
  startPolling();
}

function startPolling() { stopPolling(); AdminState.pollingInterval = setInterval(() => { if (AdminState.currentView === 'overview') refreshView(); else if (AdminState.currentView === 'payments') loadPaymentsTable(); }, 30000); }

function stopPolling() { if (AdminState.pollingInterval) { clearInterval(AdminState.pollingInterval); AdminState.pollingInterval = null; } }

window.showView = showView; window.toggleSidebar = toggleSidebar; window.refreshView = refreshView; window.closeModal = closeModal; window.copyToClipboard = copyToClipboard; window.filterTenants = filterTenants; window.changeTenantPage = changeTenantPage; window.openTenantDetail = openTenantDetail; window.openCreateTenantModal = openCreateTenantModal; window.createTenant = createTenant; window.openChangePlanModal = openChangePlanModal; window.changeTenantPlan = changeTenantPlan; window.suspendTenant = suspendTenant; window.reactivateTenant = reactivateTenant; window.filterPayments = filterPayments; window.changePaymentPage = changePaymentPage; window.viewPaymentDetail = viewPaymentDetail; window.filterAffiliates = filterAffiliates; window.changeAffiliatePage = changeAffiliatePage; window.filterCampaigns = filterCampaigns; window.changeCampaignPage = changeCampaignPage; window.viewCampaignDetail = viewCampaignDetail;