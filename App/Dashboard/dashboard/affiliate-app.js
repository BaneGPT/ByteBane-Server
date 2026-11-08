// Chaos C2 Affiliate Panel - Main Application Logic

const AffiliateState = {
  currentView: 'dashboard',
  affiliate: null,
  sessionToken: null,
  refreshToken: null,
  referrals: [],
  earnings: [],
  payouts: [],
  campaigns: [],
  charts: {},
  timeRange: '7d',
  pollingInterval: null,
  referralPage: 1,
  earningsPage: 1,
  payoutsPage: 1
};

// ============ UTILITIES ============
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
  const colors = {
    info: 'border-chaos-500 bg-surface-900',
    success: 'border-acc-emerald bg-acc-emeraldDim',
    warning: 'border-acc-amber bg-acc-amberDim',
    error: 'border-acc-rose bg-acc-roseDim'
  };
  const icons = {
    info: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
    success: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>',
    warning: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>',
    error: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>'
  };
  const toast = document.createElement('div');
  toast.className = `flex items-center gap-3 px-4 py-3 rounded-xl border ${colors[type] || colors.info} shadow-xl animate-slide-in-right`;
  toast.innerHTML = `${icons[type] || icons.info}<span class="text-sm font-medium text-white">${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, duration);
};

const api = async (path, options = {}) => {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (AffiliateState.sessionToken) {
    headers['Authorization'] = `Bearer ${AffiliateState.sessionToken}`;
  }
  try {
    const res = await fetch(`${window.__AFFILIATE_CONFIG__.apiBase}${path}`, { ...options, headers });
    if (res.status === 401) {
      // Try to refresh token
      const refreshed = await refreshSession();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${AffiliateState.sessionToken}`;
        const retryRes = await fetch(`${window.__AFFILIATE_CONFIG__.apiBase}${path}`, { ...options, headers });
        if (!retryRes.ok) {
          const err = await retryRes.json().catch(() => ({ error: retryRes.statusText }));
          throw new Error(err.error || `HTTP ${retryRes.status}`);
        }
        return retryRes.json();
      } else {
        logout();
        throw new Error('Session expired');
      }
    }
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
  primary: '#d6781e',
  primaryLight: 'rgba(214,120,30,0.15)',
  emerald: '#10b981',
  emeraldLight: 'rgba(16,185,129,0.15)',
  amber: '#f59e0b',
  amberLight: 'rgba(245,158,11,0.15)',
  rose: '#f43f5e',
  roseLight: 'rgba(244,63,94,0.15)',
  sky: '#0ea5e9',
  skyLight: 'rgba(14,165,233,0.15)',
  violet: '#8b5cf6',
  violetLight: 'rgba(139,92,246,0.15)',
  cyan: '#06b6d4',
  cyanLight: 'rgba(6,182,212,0.15)'
};

function destroyChart(id) {
  if (AffiliateState.charts[id]) { AffiliateState.charts[id].destroy(); delete AffiliateState.charts[id]; }
}

function getTierConfig(tier) {
  const tiers = {
    bronze: { name: 'Bronze', color: '#cd7f32', bg: 'rgba(205,127,50,0.15)', badge: 'badge-bronze', next: 'silver', threshold: 1000, commissionRate: 0.20 },
    silver: { name: 'Silver', color: '#c0c0c0', bg: 'rgba(192,192,192,0.15)', badge: 'badge-silver', next: 'gold', threshold: 5000, commissionRate: 0.25 },
    gold: { name: 'Gold', color: '#ffd700', bg: 'rgba(255,215,0,0.15)', badge: 'badge-gold', next: 'platinum', threshold: 25000, commissionRate: 0.30 },
    platinum: { name: 'Platinum', color: '#e5e4e2', bg: 'rgba(229,228,226,0.15)', badge: 'badge-platinum', next: null, threshold: null, commissionRate: 0.35 }
  };
  return tiers[tier] || tiers.bronze;
}

// ============ AUTHENTICATION ============
async function checkSession() {
  const token = localStorage.getItem('affiliate_session');
  const refresh = localStorage.getItem('affiliate_refresh');
  if (token && refresh) {
    AffiliateState.sessionToken = token;
    AffiliateState.refreshToken = refresh;
    try {
      const data = await api('/affiliates/auth', { method: 'POST', body: JSON.stringify({ action: 'verify', sessionToken: token }) });
      if (data.valid) {
        AffiliateState.affiliate = data.affiliate;
        updateAuthUI(true);
        showView('dashboard');
        startPolling();
        return true;
      }
    } catch (e) {
      console.warn('Session check failed:', e);
    }
    // Try refresh
    const refreshed = await refreshSession();
    if (refreshed) {
      updateAuthUI(true);
      showView('dashboard');
      startPolling();
      return true;
    }
  }
  updateAuthUI(false);
  showView('dashboard'); // Show login prompt in dashboard
  return false;
}

async function refreshSession() {
  if (!AffiliateState.refreshToken) return false;
  try {
    const data = await api('/affiliates/auth', { method: 'POST', body: JSON.stringify({ action: 'refresh', refreshToken: AffiliateState.refreshToken }) });
    AffiliateState.sessionToken = data.sessionToken;
    AffiliateState.refreshToken = data.refreshToken;
    localStorage.setItem('affiliate_session', data.sessionToken);
    localStorage.setItem('affiliate_refresh', data.refreshToken);
    // Verify and get affiliate data
    const verify = await api('/affiliates/auth', { method: 'POST', body: JSON.stringify({ action: 'verify', sessionToken: data.sessionToken }) });
    if (verify.valid) {
      AffiliateState.affiliate = verify.affiliate;
      return true;
    }
  } catch (e) {
    console.error('Token refresh failed:', e);
  }
  return false;
}

async function login(username, password, twoFACode) {
  try {
    const data = await api('/affiliates/auth', { 
      method: 'POST', 
      body: JSON.stringify({ action: 'login', username, password, twoFACode }) 
    });
    
    if (data.requires2FA) {
      return { requires2FA: true, tempToken: data.tempToken };
    }
    
    AffiliateState.sessionToken = data.sessionToken;
    AffiliateState.refreshToken = data.refreshToken;
    AffiliateState.affiliate = data.affiliate;
    localStorage.setItem('affiliate_session', data.sessionToken);
    localStorage.setItem('affiliate_refresh', data.refreshToken);
    
    updateAuthUI(true);
    showToast('Welcome back!', 'success');
    showView('dashboard');
    startPolling();
    return { success: true };
  } catch (e) {
    showToast(e.message || 'Login failed', 'error');
    return { error: e.message };
  }
}

async function register(data) {
  try {
    const result = await api('/affiliates/auth', { 
      method: 'POST', 
      body: JSON.stringify({ action: 'register', ...data }) 
    });
    
    AffiliateState.sessionToken = result.sessionToken;
    AffiliateState.refreshToken = result.refreshToken;
    AffiliateState.affiliate = result.affiliate;
    localStorage.setItem('affiliate_session', result.sessionToken);
    localStorage.setItem('affiliate_refresh', result.refreshToken);
    
    updateAuthUI(true);
    showToast('Account created successfully!', 'success');
    showView('dashboard');
    startPolling();
    return { success: true };
  } catch (e) {
    showToast(e.message || 'Registration failed', 'error');
    return { error: e.message };
  }
}

function logout() {
  AffiliateState.sessionToken = null;
  AffiliateState.refreshToken = null;
  AffiliateState.affiliate = null;
  localStorage.removeItem('affiliate_session');
  localStorage.removeItem('affiliate_refresh');
  stopPolling();
  updateAuthUI(false);
  showView('dashboard');
  showToast('Logged out', 'info');
}

function updateAuthUI(loggedIn) {
  const loginPrompt = $('#loginPrompt');
  const navLinks = $('#navLinks');
  const affiliateInfoBar = $('#affiliateInfoBar');
  const userMenu = $('#userMenu');
  const authBtn = $('#authBtn');
  
  if (loggedIn && AffiliateState.affiliate) {
    loginPrompt?.classList.add('hidden');
    navLinks?.classList.remove('hidden');
    affiliateInfoBar?.classList.remove('hidden');
    userMenu?.classList.remove('hidden');
    authBtn?.classList.add('hidden');
    
    // Update affiliate info
    const tierConfig = getTierConfig(AffiliateState.affiliate.tier);
    $('#avatarInitial')?.textContent?.(AffiliateState.affiliate.username.charAt(0).toUpperCase());
    $('#userAvatar')?.textContent?.(AffiliateState.affiliate.username.charAt(0).toUpperCase());
    $('#affiliateUsername')?.textContent?.(AffiliateState.affiliate.username);
    $('#affiliateTier')?.textContent?.(tierConfig.name);
    $('#tierBadge')?.textContent?.(tierConfig.name);
    $('#tierBadge')?.className?.(`badge ${tierConfig.badge}`);
    
    // Tier progress
    if (tierConfig.next) {
      const nextTier = getTierConfig(tierConfig.next);
      const currentEarnings = AffiliateState.affiliate.stats?.totalEarnings || 0;
      const progress = Math.min(100, (currentEarnings / nextTier.threshold) * 100);
      $('#tierProgressFill').style.width = `${progress}%`;
      $('#tierProgressText').textContent = `${fmtCurrency(currentEarnings)} / ${fmtCurrency(nextTier.threshold)}`;
    } else {
      $('#tierProgressFill').style.width = '100%';
      $('#tierProgressText').textContent = 'MAX TIER';
    }
  } else {
    loginPrompt?.classList.remove('hidden');
    navLinks?.classList.add('hidden');
    affiliateInfoBar?.classList.add('hidden');
    userMenu?.classList.add('hidden');
    authBtn?.classList.remove('hidden');
  }
}

// ============ MODALS ============
function openAuthModal(mode = 'login') {
  const root = $('#modalRoot');
  const isLogin = mode === 'login';
  
  root.innerHTML = `
    <div class="modal-overlay open" onclick="closeModal()">
      <div class="modal-panel w-full max-w-md" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-gray-800 flex items-center justify-between">
          <h3 class="text-lg font-semibold">${isLogin ? 'Sign In' : 'Create Account'}</h3>
          <button class="btn-ghost p-1" onclick="closeModal()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
        </div>
        <div class="p-6 space-y-4">
          ${!isLogin ? `
            <div>
              <label class="block text-xs text-gray-500 mb-1">Username</label>
              <input type="text" id="regUsername" class="input-base" placeholder="Choose username" autocomplete="username">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">Email</label>
              <input type="email" id="regEmail" class="input-base" placeholder="your@email.com" autocomplete="email">
            </div>
          ` : ''}
          <div>
            <label class="block text-xs text-gray-500 mb-1">${isLogin ? 'Username or Email' : 'Password'}</label>
            <input type="${isLogin ? 'text' : 'password'}" id="${isLogin ? 'loginIdentifier' : 'regPassword'}" class="input-base" placeholder="${isLogin ? 'Enter username or email' : 'Min 8 characters'}" autocomplete="${isLogin ? 'username' : 'new-password'}">
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Password</label>
            <input type="password" id="${isLogin ? 'loginPassword' : 'regConfirmPassword'}" class="input-base" placeholder="${isLogin ? 'Enter password' : 'Confirm password'}" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
          </div>
          ${!isLogin ? `
            <div>
              <label class="block text-xs text-gray-500 mb-1">Referral Code (Optional)</label>
              <input type="text" id="regReferralCode" class="input-base" placeholder="Referral code if you have one">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">Wallet Address (Optional)</label>
              <input type="text" id="regWalletAddress" class="input-base" placeholder="BTC/ETH/USDT/XMR address">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">Wallet Type</label>
              <select id="regWalletType" class="input-base">
                <option value="BTC">Bitcoin (BTC)</option>
                <option value="ETH">Ethereum (ETH)</option>
                <option value="USDT">Tether (USDT)</option>
                <option value="XMR">Monero (XMR)</option>
              </select>
            </div>
          ` : ''}
          <div id="authError" class="text-sm text-acc-rose hidden"></div>
          
          <button class="btn-primary w-full" onclick="${isLogin ? 'handleLogin()' : 'handleRegister()'}" id="authSubmitBtn">
            <span id="authBtnText">${isLogin ? 'Sign In' : 'Create Account'}</span>
            <svg id="authBtnSpinner" class="w-5 h-5 ml-2 animate-spin hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          </button>
          
          <p class="text-center text-xs text-gray-500">
            ${isLogin ? 'Don\'t have an account?' : 'Already have an account?'}
            <button class="btn-ghost text-chaos-400 ml-1" onclick="openAuthModal('${isLogin ? 'register' : 'login'}')">
              ${isLogin ? 'Sign Up' : 'Sign In'}
            </button>
          </p>
        </div>
      </div>
    </div>
  `;
}

function openPayoutModal() {
  if (!AffiliateState.affiliate) return;
  const stats = AffiliateState.affiliate.stats || {};
  const pending = parseFloat(stats.pendingEarnings || 0);
  
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-overlay open" onclick="closeModal()">
      <div class="modal-panel w-full max-w-md" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-gray-800 flex items-center justify-between">
          <h3 class="text-lg font-semibold">Request Payout</h3>
          <button class="btn-ghost p-1" onclick="closeModal()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
        </div>
        <div class="p-6 space-y-4">
          <div class="card-base p-4">
            <p class="text-xs text-gray-500">Available for Payout</p>
            <p class="stat-value text-acc-emerald">${fmtCurrency(pending)}</p>
            <p class="text-xs text-gray-500 mt-1">Minimum: ${fmtCurrency(AffiliateState.affiliate.settings?.payoutThreshold || 100)}</p>
          </div>
          
          <div>
            <label class="block text-xs text-gray-500 mb-1">Amount</label>
            <input type="number" id="payoutAmount" class="input-base" step="0.01" min="${AffiliateState.affiliate.settings?.payoutThreshold || 100}" max="${pending}" value="${pending}" placeholder="Amount">
          </div>
          
          <div>
            <label class="block text-xs text-gray-500 mb-1">Wallet Address</label>
            <input type="text" id="payoutWallet" class="input-base" value="${AffiliateState.affiliate.walletAddress || ''}" placeholder="Your wallet address">
          </div>
          
          <div>
            <label class="block text-xs text-gray-500 mb-1">Wallet Type</label>
            <select id="payoutWalletType" class="input-base">
              <option value="BTC" ${AffiliateState.affiliate.walletType === 'BTC' ? 'selected' : ''}>Bitcoin (BTC)</option>
              <option value="ETH" ${AffiliateState.affiliate.walletType === 'ETH' ? 'selected' : ''}>Ethereum (ETH)</option>
              <option value="USDT" ${AffiliateState.affiliate.walletType === 'USDT' ? 'selected' : ''}>Tether (USDT)</option>
              <option value="XMR" ${AffiliateState.affiliate.walletType === 'XMR' ? 'selected' : ''}>Monero (XMR)</option>
            </select>
          </div>
          
          <div class="flex items-center justify-between text-sm text-gray-500">
            <span>Estimated Fee</span>
            <span id="payoutFee" class="font-mono text-chaos-400">~$10.00</span>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span>Net Amount</span>
            <span id="payoutNet" class="font-mono text-acc-emerald font-semibold">${fmtCurrency(pending - 10)}</span>
          </div>
          
          <button class="btn-primary w-full" onclick="submitPayout()">Request Payout</button>
        </div>
      </div>
    </div>
  `;
  
  // Update fee/net on input change
  $('#payoutAmount')?.addEventListener('input', updatePayoutPreview);
  $('#payoutWalletType')?.addEventListener('change', updatePayoutPreview);
  updatePayoutPreview();
}

function updatePayoutPreview() {
  const amount = parseFloat($('#payoutAmount')?.value || 0);
  const type = $('#payoutWalletType')?.value || 'BTC';
  const fees = { 'BTC': 25, 'ETH': 15, 'USDT': 5, 'XMR': 1 };
  const fee = fees[type] || 10;
  const net = amount - fee;
  $('#payoutFee')?.textContent?.(`~${fmtCurrency(fee)}`);
  $('#payoutNet')?.textContent?.(fmtCurrency(Math.max(0, net)));
}

async function submitPayout() {
  const amount = parseFloat($('#payoutAmount')?.value || 0);
  const wallet = $('#payoutWallet')?.value?.trim();
  const type = $('#payoutWalletType')?.value;
  
  if (!amount || amount <= 0) return showToast('Enter valid amount', 'error');
  if (!wallet) return showToast('Enter wallet address', 'error');
  
  const btn = $('#authSubmitBtn') || $('button[onclick="submitPayout()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<svg class="w-5 h-5 mx-auto animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>'; }
  
  try {
    await api('/affiliates/payouts', {
      method: 'POST',
      body: JSON.stringify({ amount, walletAddress: wallet, walletType: type })
    });
    showToast('Payout requested successfully!', 'success');
    closeModal();
    refreshView();
  } catch (e) {
    showToast(e.message || 'Payout request failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = 'Request Payout'; }
  }
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
}

// ============ VIEW RENDERING ============
async function renderView(view) {
  AffiliateState.currentView = view;
  const titleEl = $('#viewTitle');
  if (titleEl) titleEl.textContent = view.charAt(0).toUpperCase() + view.slice(1);
  
  $$('.sidebar-link').forEach(el => {
    el.classList.toggle('sidebar-link-active', el.dataset.view === view);
    el.classList.toggle('sidebar-link', el.dataset.view !== view);
  });
  $$('.tab-btn').forEach(el => el.classList.toggle('tab-btn-active', el.dataset.view === view));

  const content = $('#viewContent');
  if (!content) return;
  
  if (!AffiliateState.affiliate && view !== 'dashboard') {
    content.innerHTML = `
      <div class="card-base text-center py-12">
        <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
        <h3 class="text-lg font-semibold mb-2">Please Sign In</h3>
        <p class="text-gray-500 mb-4">You need to be logged in to access this page</p>
        <button class="btn-primary" onclick="openAuthModal('login')">Sign In</button>
      </div>
    `;
    return;
  }
  
  content.innerHTML = '<div class="flex items-center justify-center h-64"><div class="animate-spin w-10 h-10 border-4 border-chaos-500 border-t-transparent rounded-full"></div></div>';

  try {
    switch (view) {
      case 'dashboard': await renderDashboard(); break;
      case 'referrals': await renderReferrals(); break;
      case 'earnings': await renderEarnings(); break;
      case 'payouts': await renderPayouts(); break;
      case 'campaigns': await renderCampaigns(); break;
      case 'settings': await renderSettings(); break;
      default: await renderDashboard();
    }
  } catch (e) {
    console.error(`Render ${view} error:`, e);
    content.innerHTML = `<div class="card-base text-center py-12"><svg class="w-12 h-12 mx-auto text-acc-rose mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg><h3 class="text-lg font-semibold mb-2">Failed to load</h3><p class="text-gray-500 mb-4">${e.message}</p><button class="btn-primary" onclick="renderView('${view}')">Retry</button></div>`;
  }
}

async function refreshView() {
  await renderView(AffiliateState.currentView);
}

// ============ DASHBOARD ============
async function renderDashboard() {
  const content = $('#viewContent');
  if (!content) return;
  
  if (!AffiliateState.affiliate) {
    content.innerHTML = `
      <div class="space-y-6">
        <!-- Hero -->
        <article class="card-base glass-hover relative overflow-hidden">
          <div class="absolute inset-0 bg-gradient-to-r from-chaos-500/10 via-transparent to-acc-emerald/10"></div>
          <div class="relative p-6 sm:p-8">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
              <div>
                <h2 class="text-2xl sm:text-3xl font-bold mb-2">Welcome to the Chaos C2 Affiliate Program</h2>
                <p class="text-gray-400 max-w-2xl">Earn generous commissions by referring affiliates and campaigns. Track your earnings in real-time with our transparent dashboard.</p>
              </div>
              <div class="flex gap-3">
                <button class="btn-primary" onclick="openAuthModal('register')">Get Started</button>
                <button class="btn-secondary" onclick="openAuthModal('login')">Sign In</button>
              </div>
            </div>
            
            <!-- Stats Preview -->
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-6 border-t border-gray-800">
              <div class="text-center">
                <p class="stat-value text-chaos-400">20%</p>
                <p class="text-xs text-gray-500">Base Commission</p>
              </div>
              <div class="text-center">
                <p class="stat-value text-acc-emerald">3</p>
                <p class="text-xs text-gray-500">Tier Levels</p>
              </div>
              <div class="text-center">
                <p class="stat-value text-acc-sky">$100</p>
                <p class="text-xs text-gray-500">Min Payout</p              </div>
              <div class="text-center">
                <p class="stat-value text-acc-violet">24/7</p>
                <p class="text-xs text-gray-500">Support</p>
              </div>
            </div>
          </div>
        </article>

        <!-- Features -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <article class="card-base glass-hover p-6">
            <div class="w-12 h-12 rounded-xl bg-acc-emeraldDim flex items-center justify-center mb-4">
              <svg class="w-6 h-6 text-acc-emerald" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
            </div>
            <h3 class="text-lg font-semibold mb-2">Multi-Level Referrals</h3>
            <p class="text-gray-400 text-sm">Earn from direct referrals (20%), their referrals (5%), and third level (2%). Build a network, earn passively.</p>
          </article>
          <article class="card-base glass-hover p-6">
            <div class="w-12 h-12 rounded-xl bg-chaos-500/15 flex items-center justify-center mb-4">
              <svg class="w-6 h-6 text-chaos-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            </div>
            <h3 class="text-lg font-semibold mb-2">Real-Time Earnings</h3>
            <p class="text-gray-400 text-sm">Track every infection, file exfiltration, and payment in real-time. Transparent reporting with detailed breakdowns.</p>
          </article>
          <article class="card-base glass-hover p-6">
            <div class="w-12 h-12 rounded-xl bg-acc-violet/15 flex items-center justify-center mb-4">
              <svg class="w-6 h-6 text-acc-violet" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            </div>
            <h3 class="text-lg font-semibold mb-2">Crypto Payouts</h3>
            <p class="text-gray-400 text-sm">Get paid in BTC, ETH, USDT, or XMR. Low fees, fast processing, no minimum thresholds for active affiliates.</p>
          </article>
        </div>

        <!-- Tier Benefits -->
        <article class="card-base">
          <h3 class="text-lg font-semibold mb-4">Tier Benefits</h3>
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead>
                <tr>
                  <th class="table-header">Tier</th>
                  <th class="table-header">Commission</th>
                  <th class="table-header">Multi-Level</th>
                  <th class="table-header">Min Payout</th>
                  <th class="table-header">Support</th>
                  <th class="table-header">Requirements</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-800">
                <tr class="table-row">
                  <td class="table-cell"><span class="badge badge-bronze">Bronze</span></td>
                  <td class="table-cell font-mono">20%</td>
                  <td class="table-cell">Level 1 only</td>
                  <td class="table-cell">$100</td>
                  <td class="table-cell">Standard</td>
                  <td class="table-cell">Default</td>
                </tr>
                <tr class="table-row">
                  <td class="table-cell"><span class="badge badge-silver">Silver</span></td>
                  <td class="table-cell font-mono">25%</td>
                  <td class="table-cell">Level 1-2 (5%)</td>
                  <td class="table-cell">$50</td>
                  <td class="table-cell">Priority</td>
                  <td class="table-cell">$5,000 earnings</td>
                </tr>
                <tr class="table-row">
                  <td class="table-cell"><span class="badge badge-gold">Gold</span></td>
                  <td class="table-cell font-mono">30%</td>
                  <td class="table-cell">Level 1-3 (2%)</td>
                  <td class="table-cell">$25</td>
                  <td class="table-cell">Dedicated</td>
                  <td class="table-cell">$25,000 earnings</td>
                </tr>
                <tr class="table-row">
                  <td class="table-cell"><span class="badge badge-platinum">Platinum</span></td>
                  <td class="table-cell font-mono">35%</td>
                  <td class="table-cell">All levels + bonuses</td>
                  <td class="table-cell">No minimum</td>
                  <td class="table-cell">24/7 Direct</td>
                  <td class="table-cell">Invite only</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    `;
    return;
  }

  // Load stats
  const affiliate = AffiliateState.affiliate;
  const stats = affiliate.stats || {};
  const tierConfig = getTierConfig(affiliate.tier);
  
  content.innerHTML = `
    <div class="space-y-6">
      <!-- Key Stats -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <article class="card-base stat-card animate-slide-up" style="animation-delay: 0ms">
          <p class="stat-label">Pending Earnings</p>
          <p class="stat-value text-acc-emerald" id="dashPending">${fmtCurrency(stats.pendingEarnings)}</p>
          <p class="text-xs text-gray-500 mt-1">Available for payout</p>
        </article>
        <article class="card-base stat-card animate-slide-up" style="animation-delay: 50ms">
          <p class="stat-label">Total Earned</p>
          <p class="stat-value text-chaos-400" id="dashTotal">${fmtCurrency(stats.totalEarnings)}</p>
          <p class="text-xs text-gray-500 mt-1">Lifetime earnings</p>
        </article>
        <article class="card-base stat-card animate-slide-up" style="animation-delay: 100ms">
          <p class="stat-label">Active Referrals</p>
          <p class="stat-value text-acc-sky" id="dashActiveRefs">${fmtNumber(stats.activeReferrals)}</p>
          <p class="text-xs text-gray-500 mt-1">Of ${fmtNumber(stats.totalReferrals)} total</p>
        </article>
        <article class="card-base stat-card animate-slide-up" style="animation-delay: 150ms">
          <p class="stat-label">Infections Referred</p>
          <p class="stat-value text-acc-amber" id="dashInfections">${fmtNumber(stats.totalInfectionsReferred)}</p>
          <p class="text-xs text-gray-500 mt-1">From your network</p>
        </article>
      </div>

      <!-- Tier Progress & Quick Actions -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <article class="card-base lg:col-span-2">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-semibold">Your Tier: <span class="badge ${tierConfig.badge}">${tierConfig.name}</span></h3>
            <span class="text-sm text-gray-500">${tierConfig.commissionRate * 100}% base commission</span>
          </div>
          <div class="mb-4">
            <div class="flex items-center justify-between text-xs mb-1">
              <span class="text-gray-500">Progress to ${getTierConfig(tierConfig.next)?.name || 'Max'}</span>
              <span class="text-chaos-400 font-mono" id="dashTierProgress">${fmtCurrency(stats.totalEarnings)} / ${fmtCurrency(getTierConfig(tierConfig.next)?.threshold || stats.totalEarnings)}</span>
            </div>
            <div class="tier-progress">
              <div id="dashTierFill" class="tier-progress-fill bg-chaos-500" style="width: ${tierConfig.next ? Math.min(100, (stats.totalEarnings / getTierConfig(tierConfig.next).threshold) * 100) : 100}%"></div>
            </div>
          </div>
          
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div class="p-3 rounded-lg bg-surface-800 text-center">
              <p class="text-2xl font-bold font-mono text-chaos-400" id="dashTodayEarnings">$0.00</p>
              <p class="text-xs text-gray-500">Today</p>
            </div>
            <div class="p-3 rounded-lg bg-surface-800 text-center">
              <p class="text-2xl font-bold font-mono text-acc-emerald" id="dashWeekEarnings">$0.00</p>
              <p class="text-xs text-gray-500">This Week</p>
            </div>
            <div class="p-3 rounded-lg bg-surface-800 text-center">
              <p class="text-2xl font-bold font-mono text-acc-sky" id="dashMonthEarnings">$0.00</p>
              <p class="text-xs text-gray-500">This Month</p>
            </div>
            <div class="p-3 rounded-lg bg-surface-800 text-center">
              <p class="text-2xl font-bold font-mono text-acc-violet" id="dashCampaigns">${fmtNumber(stats.totalCampaignsCreated)}</p>
              <p class="text-xs text-gray-500">Campaigns</p>
            </div>
          </div>
        </article>

        <article class="card-base">
          <h3 class="text-lg font-semibold mb-4">Quick Actions</h3>
          <div class="space-y-2">
            <button class="btn-primary w-full justify-start" onclick="openPayoutModal()" ${parseFloat(stats.pendingEarnings || 0) < (affiliate.settings?.payoutThreshold || 100) ? 'disabled' : ''}>
              <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
              Request Payout ${parseFloat(stats.pendingEarnings || 0) >= (affiliate.settings?.payoutThreshold || 100) ? `(${fmtCurrency(stats.pendingEarnings)})` : ''}
            </button>
            <button class="btn-secondary w-full justify-start" onclick="showView('referrals')">
              <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
              View Referrals
            </button>
            <button class="btn-secondary w-full justify-start" onclick="showView('campaigns')">
              <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
              My Campaigns
            </button>
            <button class="btn-secondary w-full justify-start" onclick="copyReferralLink()">
              <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
              Copy Referral Link
            </button>
            <button class="btn-secondary w-full justify-start" onclick="showView('settings')">
              <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
              Settings
            </button>
          </div>
          
          <div class="mt-6 pt-6 border-t border-gray-800">
            <h4 class="text-sm font-medium mb-3">Your Referral Code</h4>
            <div class="flex gap-2">
              <code class="flex-1 font-mono text-sm bg-surface-800 px-3 py-2 rounded-lg border border-gray-700 text-chaos-400" id="referralCodeDisplay">${affiliate.refCode}</code>
              <button class="btn-secondary copy-btn" onclick="copyReferralCode()" title="Copy">Copy</button>
            </div>
            <p class="text-xs text-gray-500 mt-2">Share this code. When someone signs up with it, you earn from their activity.</p>
          </div>
        </article>
      </div>

      <!-- Earnings Chart -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <article class="card-base lg:col-span-2">
          <h3 class="text-lg font-semibold mb-4">Earnings Overview (${AffiliateState.timeRange})</h3>
          <div class="chart-container-lg"><canvas id="earningsChart"></canvas></div>
        </article>
      </div>

      <!-- Recent Activity -->
      <article class="card-base">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold">Recent Referral Activity</h3>
          <button class="btn-ghost text-sm" onclick="showView('referrals')">View All →</button>
        </div>
        <div class="scrollbar-thin overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr>
                <th class="table-header">Date</th>
                <th class="table-header">Referral</th>
                <th class="table-header">Action</th>
                <th class="table-header">Campaign</th>
                <th class="table-header text-right">Amount</th>
                <th class="table-header text-right">Commission</th>
              </tr>
            </thead>
            <tbody id="recentActivityBody" class="divide-y divide-gray-800"></tbody>
          </table>
        </div>
      </article>
    </div>
  `;

  initDashboardCharts();
  loadRecentActivity();
  loadEarningsSummary();
}

async function initDashboardCharts() {
  destroyChart('earningsChart');
  const ctx = $('#earningsChart')?.getContext('2d');
  if (!ctx) return;
  
  // Generate sample data based on timeRange
  const days = AffiliateState.timeRange === '24h' ? 1 : AffiliateState.timeRange === '7d' ? 7 : AffiliateState.timeRange === '30d' ? 30 : 90;
  const labels = [];
  const earningsData = [];
  const referralsData = [];
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    labels.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    // Simulated data
    earningsData.push(Math.random() * 500);
    referralsData.push(Math.floor(Math.random() * 5));
  }
  
  AffiliateState.charts.earningsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Earnings (USD)',
          data: earningsData,
          borderColor: chartColors.emerald,
          backgroundColor: chartColors.emeraldLight,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 6,
          yAxisID: 'y'
        },
        {
          label: 'New Referrals',
          data: referralsData,
          borderColor: chartColors.chaos,
          backgroundColor: 'transparent',
          borderWidth: 2,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: chartColors.chaos,
          pointHoverRadius: 6,
          type: 'line',
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, pointStyle: 'circle' } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
        y: { type: 'linear', position: 'left', grid: { color: '#2d2d2d' }, beginAtZero: true, ticks: { callback: v => '$' + v } },
        y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, beginAtZero: true }
      }
    }
  });
}

async function loadRecentActivity() {
  try {
    const data = await api('/affiliates/referrals', { 
      method: 'POST', 
      body: JSON.stringify({ action: 'get_activity', limit: 10 }) 
    });
    
    // Fallback: get from referral activity log
    const activity = await api('/affiliates/referrals', { 
      method: 'GET'
    });
    
    const body = $('#recentActivityBody');
    if (!body) return;
    
    // For now, show placeholder
    body.innerHTML = '<tr><td colspan="6" class="table-cell text-center text-gray-500 py-8">No recent activity</td></tr>';
  } catch (e) {
    console.error('Load recent activity:', e);
  }
}

async function loadEarningsSummary() {
  // Would fetch from API - placeholder for now
}

// ============ REFERRALS ============
async function renderReferrals() {
  const content = $('#viewContent');
  if (!content) return;
  
  content.innerHTML = `
    <div class="flex flex-col gap-4">
      <div class="card-base flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h3 class="text-lg font-semibold">My Referrals</h3>
        <div class="flex gap-2 w-full sm:w-auto">
          <input type="text" id="refSearch" placeholder="Search referrals..." class="input-base w-full sm:w-64" oninput="filterReferrals()">
          <select id="refStatusFilter" class="input-base w-auto" onchange="filterReferrals()">
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="active">Active</option>
            <option value="qualified">Qualified</option>
          </select>
          <button class="btn-primary" onclick="refreshView()"><svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>Refresh</button>
        </div>
      </div>

      <div class="card-base overflow-hidden">
        <div class="scrollbar-thin overflow-x-auto">
          <table class="w-full min-w-[1000px]">
            <thead>
              <tr>
                <th class="table-header">Referral</th>
                <th class="table-header">Email</th>
                <th class="table-header">Status</th>
                <th class="table-header">Tier</th>
                <th class="table-header">Commission</th>
                <th class="table-header">Joined</th>
                <th class="table-header">Last Active</th>
                <th class="table-header text-right">Total Earned</th>
                <th class="table-header text-right">My Commission</th>
                <th class="table-header">Campaigns</th>
                <th class="table-header">Actions</th>
              </tr>
            </thead>
            <tbody id="referralsBody" class="divide-y divide-gray-800"></tbody>
          </table>
        </div>
        <div class="p-4 border-t border-gray-800 flex items-center justify-between">
          <span id="refPaginationInfo" class="text-sm text-gray-400">Loading...</span>
          <div class="flex gap-2">
            <button id="refPrevPage" class="btn-secondary text-sm" onclick="changeRefPage(-1)" disabled>Previous</button>
            <button id="refNextPage" class="btn-secondary text-sm" onclick="changeRefPage(1)" disabled>Next</button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  await loadReferralsTable();
}

async function loadReferralsTable() {
  try {
    const data = await api(`/affiliates/referrals?limit=50&offset=${(AffiliateState.referralPage - 1) * 50}&includeMultiLevel=true`);
    const referrals = data.referrals || [];
    const multilevel = data.multilevel || [];
    
    const body = $('#referralsBody');
    const info = $('#refPaginationInfo');
    const prevBtn = $('#refPrevPage');
    const nextBtn = $('#nextBtn');
    
    if (!body) return;
    
    if (referrals.length === 0) {
      body.innerHTML = '<tr><td colspan="11" class="table-cell text-center text-gray-500 py-8">No referrals yet. Share your referral code to start earning!</td></tr>';
      if (info) info.textContent = 'No referrals';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }
    
    body.innerHTML = referrals.map(ref => {
      const statusBadges = { pending: 'badge-warning', active: 'badge-active', qualified: 'badge-info' };
      const tierConfig = getTierConfig(ref.tier);
      
      return `
        <tr class="table-row" onclick="openReferralDetail('${ref.id}')">
          <td class="table-cell font-medium">${ref.referredUsername}</td>
          <td class="table-cell text-gray-400 truncate max-w-xs">${ref.referredEmail}</td>
          <td class="table-cell"><span class="badge ${statusBadges[ref.status] || 'badge-inactive'}">${ref.status}</span></td>
          <td class="table-cell"><span class="badge ${tierConfig.badge}">${tierConfig.name}</span></td>
          <td class="table-cell font-mono">${(ref.commissionRate * 100).toFixed(0)}%</td>
          <td class="table-cell text-gray-400">${timeAgo(ref.createdAt)}</td>
          <td class="table-cell text-gray-400">${ref.lastActivity ? timeAgo(ref.lastActivity) : 'Never'}</td>
          <td class="table-cell text-right font-mono text-acc-emerald">${fmtCurrency(ref.totalEarnings)}</td>
          <td class="table-cell text-right font-mono text-chaos-400">${fmtCurrency(ref.totalEarnings * ref.commissionRate)}</td>
          <td class="table-cell">${ref.campaigns?.length || 0}</td>
          <td class="table-cell">
            <button class="btn-ghost text-xs p-1" onclick="event.stopPropagation(); openReferralDetail('${ref.id}')">View</button>
          </td>
        </tr>
      `;
    }).join('');
    
    if (info) info.textContent = `Page ${data.page} of ${Math.ceil(data.total / data.pageSize)} (${data.total} total)`;
    if (prevBtn) prevBtn.disabled = AffiliateState.referralPage <= 1;
    if (nextBtn) nextBtn.disabled = AffiliateState.referralPage >= Math.ceil(data.total / data.pageSize);
    
  } catch (e) {
    console.error('Load referrals:', e);
    $('#referralsBody').innerHTML = '<tr><td colspan="11" class="table-cell text-center text-acc-rose py-8">Failed to load referrals</td></tr>';
  }
}

function changeRefPage(delta) {
  AffiliateState.referralPage += delta;
  loadReferralsTable();
}

function filterReferrals() {
  // Client-side filter for now
  const search = $('#refSearch')?.value?.toLowerCase() || '';
  const status = $('#refStatusFilter')?.value || '';
  const rows = $$('#referralsBody tr');
  
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    const rowStatus = row.querySelector('.badge')?.textContent?.toLowerCase() || '';
    const matchSearch = !search || text.includes(search);
    const matchStatus = !status || rowStatus === status;
    row.style.display = (matchSearch && matchStatus) ? '' : 'none';
  });
}

async function openReferralDetail(referralId) {
  try {
    const ref = await api(`/affiliates/referrals?id=${referralId}`);
    
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-overlay open" onclick="closeModal()">
        <div class="modal-panel w-full max-w-3xl" onclick="event.stopPropagation()">
          <div class="p-6 border-b border-gray-800 flex items-center justify-between">
            <h3 class="text-lg font-semibold">Referral Details</h3>
            <button class="btn-ghost p-1" onclick="closeModal()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
          </div>
          <div class="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div class="card-base p-4 text-center">
                <p class="text-xs text-gray-500">Status</p>
                <p class="font-semibold"><span class="badge ${['pending','active','qualified'].includes(ref.status) ? ['badge-warning','badge-active','badge-info'][['pending','active','qualified'].indexOf(ref.status)] : 'badge-inactive'}">${ref.status}</span></p>
              </div>
              <div class="card-base p-4 text-center">
                <p class="text-xs text-gray-500">Tier</p>
                <p class="font-semibold"><span class="badge ${getTierConfig(ref.tier).badge}">${getTierConfig(ref.tier).name}</span></p>
              </div>
              <div class="card-base p-4 text-center">
                <p class="text-xs text-gray-500">Commission Rate</p>
                <p class="font-semibold font-mono text-chaos-400">${(ref.commissionRate * 100).toFixed(0)}%</p>
              </div>
            </div>
            
            <div class="card-base p-4">
              <h4 class="font-medium mb-3">Referral Info</h4>
              <div class="grid grid-cols-2 gap-4 text-sm">
                <div><p class="text-gray-500">Username</p><p class="font-medium">${ref.referredUsername}</p></div>
                <div><p class="text-gray-500">Email</p><p class="font-medium">${ref.referredEmail}</p></div>
                <div><p class="text-gray-500">Joined</p><p class="font-medium">${fmtDate(ref.createdAt)}</p></div>
                <div><p class="text-gray-500">Qualified</p><p class="font-medium">${ref.qualifiedAt ? fmtDate(ref.qualifiedAt) : 'Not yet'}</p></div>
                <div><p class="text-gray-500">First Earning</p><p class="font-medium">${ref.firstEarningAt ? fmtDate(ref.firstEarningAt) : 'None yet'}</p></div>
                <div><p class="text-gray-500">Last Activity</p><p class="font-medium">${ref.lastActivity ? timeAgo(ref.lastActivity) : 'Never'}</p></div>
              </div>
            </div>
            
            <div class="card-base p-4">
              <h4 class="font-medium mb-3">Earnings Summary</h4>
              <div class="grid grid-cols-3 gap-4 text-center">
                <div class="p-3 rounded-lg bg-surface-800"><p class="text-xs text-gray-500">Total Referred Earnings</p><p class="font-mono text-lg text-acc-emerald">${fmtCurrency(ref.totalEarnings)}</p></div>
                <div class="p-3 rounded-lg bg-surface-800"><p class="text-xs text-gray-500">Your Commission</p><p class="font-mono text-lg text-chaos-400">${fmtCurrency(ref.totalEarnings * ref.commissionRate)}</p></div>
                <div class="p-3 rounded-lg bg-surface-800"><p class="text-xs text-gray-500">Campaigns Created</p><p class="font-mono text-lg text-acc-sky">${ref.campaigns?.length || 0}</p></div>
              </div>
            </div>
            
            ${ref.campaigns && ref.campaigns.length > 0 ? `
              <div class="card-base p-4">
                <h4 class="font-medium mb-3">Campaigns Created</h4>
                <div class="scrollbar-thin overflow-x-auto">
                  <table class="w-full">
                    <thead><tr><th class="table-header">Name</th><th class="table-header">Status</th><th class="table-header text-right">Infections</th><th class="table-header text-right">Files</th><th class="table-header text-right">Data</th><th class="table-header">Created</th></tr></thead>
                    <tbody class="divide-y divide-gray-800">
                      ${ref.campaigns.map(c => `
                        <tr class="table-row">
                          <td class="table-cell font-mono text-chaos-400">${c.name}</td>
                          <td class="table-cell"><span class="badge ${c.status === 'active' ? 'badge-active' : 'badge-inactive'}">${c.status}</span></td>
                          <td class="table-cell text-right font-mono">${fmtNumber(c.stats?.totalInfections)}</td>
                          <td class="table-cell text-right font-mono">${fmtNumber(c.stats?.totalFiles)}</td>
                          <td class="table-cell text-right font-mono">${fmtBytes(c.stats?.totalBytes)}</td>
                          <td class="table-cell text-gray-400">${timeAgo(c.createdAt)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            ` : ''}
            
            ${ref.earnings && ref.earnings.length > 0 ? `
              <div class="card-base p-4">
                <h4 class="font-medium mb-3">Recent Earnings</h4>
                <div class="scrollbar-thin overflow-x-auto">
                  <table class="w-full">
                    <thead><tr><th class="table-header">Date</th><th class="table-header">Action</th><th class="table-header">Campaign</th><th class="table-header text-right">Amount</th><th class="table-header text-right">Commission</th></tr></thead>
                    <tbody class="divide-y divide-gray-800">
                      ${ref.earnings.slice(0, 20).map(e => `
                        <tr class="table-row">
                          <td class="table-cell text-gray-400">${timeAgo(e.createdAt)}</td>
                          <td class="table-cell">${e.action}</td>
                          <td class="table-cell font-mono text-chaos-400">${e.campaignId || 'N/A'}</td>
                          <td class="table-cell text-right font-mono">${fmtCurrency(e.amount)}</td>
                          <td class="table-cell text-right font-mono text-chaos-400">${fmtCurrency(e.commission)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    showToast('Failed to load referral details', 'error');
  }
}

// ============ EARNINGS ============
async function renderEarnings() {
  const content = $('#viewContent');
  if (!content) return;
  
  content.innerHTML = `
    <div class="space-y-6">
      <!-- Summary Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" id="earningsSummary">
        <!-- Filled by loadEarningsSummary -->
      </div>
      
      <!-- Earnings Chart -->
      <article class="card-base">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold">Earnings History</h3>
          <select id="earningsTimeRange" class="input-base w-auto" onchange="AffiliateState.timeRange=this.value; refreshView()">
            <option value="7d" ${AffiliateState.timeRange === '7d' ? 'selected' : ''}>7 Days</option>
            <option value="30d" ${AffiliateState.timeRange === '30d' ? 'selected' : ''}>30 Days</option>
            <option value="90d" ${AffiliateState.timeRange === '90d' ? 'selected' : ''}>90 Days</option>
          </select>
        </div>
        <div class="chart-container-lg"><canvas id="earningsDetailChart"></canvas></div>
      </article>
      
      <!-- Earnings Breakdown Table -->
      <article class="card-base">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold">Earnings Breakdown</h3>
          <button class="btn-secondary" onclick="exportEarningsCSV()">Export CSV</button>
        </div>
        <div class="scrollbar-thin overflow-x-auto">
          <table class="w-full min-w-[900px]">
            <thead>
              <tr>
                <th class="table-header">Date</th>
                <th class="table-header">Referral</th>
                <th class="table-header">Campaign</th>
                <th class="table-header">Action</th>
                <th class="table-header">Level</th>
                <th class="table-header text-right">Amount</th>
                <th class="table-header text-right">Rate</th>
                <th class="table-header text-right">Commission</th>
              </tr>
            </thead>
            <tbody id="earningsBody" class="divide-y divide-gray-800"></tbody>
          </table>
        </div>
        <div class="p-4 border-t border-gray-800 flex items-center justify-between">
          <span id="earningsPaginationInfo" class="text-sm text-gray-400">Loading...</span>
          <div class="flex gap-2">
            <button id="earnPrevPage" class="btn-secondary text-sm" onclick="changeEarnPage(-1)" disabled>Previous</button>
            <button id="earnNextPage" class="btn-secondary text-sm" onclick="changeEarnPage(1)" disabled>Next</button>
          </div>
        </div>
      </article>
    </div>
  `;
  
  await loadEarningsTable();
  initEarningsChart();
}

async function loadEarningsTable() {
  try {
    // Get referral activity which contains earnings
    const data = await api(`/affiliates/referrals?limit=200&includeMultiLevel=true`);
    const referrals = data.referrals || [];
    const multilevel = data.multilevel || [];
    
    // Collect all earnings
    const allEarnings = [];
    for (const ref of referrals) {
      if (ref.recentEarnings) {
        for (const e of ref.recentEarnings) {
          allEarnings.push({
            ...e,
            referralName: ref.referredUsername,
            referralId: ref.id,
            level: 1
          });
        }
      }
    }
    
    // Add multi-level earnings
    for (const ml of multilevel) {
      // Would need to fetch earnings for each multilevel referral
    }
    
    // Sort by date
    allEarnings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Paginate
    const start = (AffiliateState.earningsPage - 1) * 50;
    const pageEarnings = allEarnings.slice(start, start + 50);
    
    const body = $('#earningsBody');
    const info = $('#earningsPaginationInfo');
    const prevBtn = $('#earnPrevPage');
    const nextBtn = $('#earnNextPage');
    
    if (!body) return;
    
    if (pageEarnings.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="table-cell text-center text-gray-500 py-8">No earnings yet</td></tr>';
      if (info) info.textContent = 'No earnings';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }
    
    body.innerHTML = pageEarnings.map(e => `
      <tr class="table-row">
        <td class="table-cell text-gray-400">${timeAgo(e.createdAt)}</td>
        <td class="table-cell">${e.referralName || 'Unknown'}</td>
        <td class="table-cell font-mono text-chaos-400">${e.campaignId || 'N/A'}</td>
        <td class="table-cell">${e.action}</td>
        <td class="table-cell"><span class="badge ${e.level === 1 ? 'badge-active' : e.level === 2 ? 'badge-info' : 'badge-warning'}">Level ${e.level}</span></td>
        <td class="table-cell text-right font-mono">${fmtCurrency(e.amount)}</td>
        <td class="table-cell text-right font-mono">${((e.commission / e.amount) * 100).toFixed(1)}%</td>
        <td class="table-cell text-right font-mono text-chaos-400">${fmtCurrency(e.commission)}</td>
      </tr>
    `).join('');
    
    if (info) info.textContent = `Showing ${start + 1}-${Math.min(start + 50, allEarnings.length)} of ${allEarnings.length}`;
    if (prevBtn) prevBtn.disabled = AffiliateState.earningsPage <= 1;
    if (nextBtn) nextBtn.disabled = AffiliateState.earningsPage >= Math.ceil(allEarnings.length / 50);
    
  } catch (e) {
    console.error('Load earnings:', e);
    $('#earningsBody').innerHTML = '<tr><td colspan="8" class="table-cell text-center text-acc-rose py-8">Failed to load earnings</td></tr>';
  }
}

function changeEarnPage(delta) {
  AffiliateState.earningsPage += delta;
  loadEarningsTable();
}

function initEarningsChart() {
  destroyChart('earningsDetailChart');
  const ctx = $('#earningsDetailChart')?.getContext('2d');
  if (!ctx) return;
  
  const days = AffiliateState.timeRange === '7d' ? 7 : AffiliateState.timeRange === '30d' ? 30 : 90;
  const labels = [];
  const dailyEarnings = [];
  const dailyReferrals = [];
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    labels.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    dailyEarnings.push(Math.random() * 300);
    dailyReferrals.push(Math.floor(Math.random() * 3));
  }
  
  AffiliateState.charts.earningsDetailChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Earnings (USD)',
          data: dailyEarnings,
          backgroundColor: chartColors.emeraldLight,
          borderColor: chartColors.emerald,
          borderWidth: 1,
          borderRadius: 4,
          yAxisID: 'y'
        },
        {
          label: 'New Referrals',
          data: dailyReferrals,
          backgroundColor: 'transparent',
          borderColor: chartColors.chaos,
          borderWidth: 2,
          borderRadius: 4,
          type: 'line',
          tension: 0.4,
          pointBackgroundColor: chartColors.chaos,
          pointRadius: 4,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, pointStyle: 'circle' } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 15 } },
        y: { type: 'linear', position: 'left', grid: { color: '#2d2d2d' }, beginAtZero: true, ticks: { callback: v => '$' + v } },
        y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, beginAtZero: true }
      }
    }
  });
}

function exportEarningsCSV() {
  // Implementation would generate CSV from earnings data
  showToast('CSV export coming soon', 'info');
}

// ============ PAYOUTS ============
async function renderPayouts() {
  const content = $('#viewContent');
  if (!content) return;
  
  const stats = AffiliateState.affiliate?.stats || {};
  const pending = parseFloat(stats.pendingEarnings || 0);
  const threshold = AffiliateState.affiliate?.settings?.payoutThreshold || 100;
  
  content.innerHTML = `
    <div class="space-y-6">
      <!-- Payout Summary -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <article class="card-base">
          <p class="stat-label">Pending Earnings</p>
          <p class="stat-value text-acc-emerald">${fmtCurrency(pending)}</p>
          <p class="text-xs text-gray-500 mt-1">Available for payout</p>
        </article>
        <article class="card-base">
          <p class="stat-label">Total Paid Out</p>
          <p class="stat-value text-chaos-400">${fmtCurrency(stats.paidOut)}</p>
          <p class="text-xs text-gray-500 mt-1">Lifetime payouts</p>
        </article>
        <article class="card-base">
          <p class="stat-label">Min Payout</p>
          <p class="stat-value text-acc-amber">${fmtCurrency(threshold)}</p>
          <p class="text-xs text-gray-500 mt-1">${pending >= threshold ? '<span class="text-acc-emerald">Eligible</span>' : '<span class="text-acc-rose">Not eligible</span>'}</p>
        </article>
      </div>
      
      <!-- Request Payout Button -->
      <div class="flex justify-center" id="payoutAction">
        ${pending >= threshold ? `
          <button class="btn-primary px-8 py-3 text-lg" onclick="openPayoutModal()">
            <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            Request Payout (${fmtCurrency(pending)} available)
          </button>
        ` : `
          <button class="btn-secondary px-8 py-3 text-lg" disabled>
            <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
            Minimum ${fmtCurrency(threshold)} required (${fmtCurrency(pending)} available)
          </button>
        `}
      </div>
      
      <!-- Payout History -->
      <article class="card-base">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold">Payout History</h3>
          <select id="payoutStatusFilter" class="input-base w-auto" onchange="filterPayouts()">
            <option value="">All Status</option>
            <option value="requested">Requested</option>
            <option value="processing">Processing</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div class="scrollbar-thin overflow-x-auto">
          <table class="w-full min-w-[1000px]">
            <thead>
              <tr>
                <th class="table-header">ID</th>
                <th class="table-header">Date</th>
                <th class="table-header">Amount</th>
                <th class="table-header">Net</th>
                <th class="table-header">Wallet</th>
                <th class="table-header">Type</th>
                <th class="table-header">Status</th>
                <th class="table-header">TX Hash</th>
                <th class="table-header">Actions</th>
              </tr>
            </thead>
            <tbody id="payoutsBody" class="divide-y divide-gray-800"></tbody>
          </table>
        </div>
        <div class="p-4 border-t border-gray-800 flex items-center justify-between">
          <span id="payoutsPaginationInfo" class="text-sm text-gray-400">Loading...</span>
          <div class="flex gap-2">
            <button id="poutPrevPage" class="btn-secondary text-sm" onclick="changePayoutPage(-1)" disabled>Previous</button>
            <button id="poutNextPage" class="btn-secondary text-sm" onclick="changePayoutPage(1)" disabled>Next</button>
          </div>
        </div>
      </article>
    </div>
  `;
  
  await loadPayoutsTable();
}

async function loadPayoutsTable() {
  try {
    const data = await api(`/affiliates/payouts?limit=50&offset=${(AffiliateState.payoutsPage - 1) * 50}`);
    const payouts = data.payouts || [];
    
    const body = $('#payoutsBody');
    const info = $('#payoutsPaginationInfo');
    const prevBtn = $('#poutPrevPage');
    const nextBtn = $('#poutNextPage');
    
    if (!body) return;
    
    if (payouts.length === 0) {
      body.innerHTML = '<tr><td colspan="9" class="table-cell text-center text-gray-500 py-8">No payouts yet</td></tr>';
      if (info) info.textContent = 'No payouts';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      return;
    }
    
    const statusBadges = {
      requested: 'badge-warning',
      processing: 'badge-info',
      completed: 'badge-active',
      failed: 'badge-danger',
      cancelled: 'badge-inactive'
    };
    
    body.innerHTML = payouts.map(p => `
      <tr class="table-row">
        <td class="table-cell font-mono text-xs">${p.id}</td>
        <td class="table-cell text-gray-400">${fmtDate(p.requestedAt)}</td>
        <td class="table-cell font-mono text-acc-emerald">${fmtCurrency(p.amount)}</td>
        <td class="table-cell font-mono text-chaos-400">${fmtCurrency(p.netAmount)}</td>
        <td class="table-cell font-mono text-xs truncate max-w-[150px]">${p.walletAddress}</td>
        <td class="table-cell"><span class="badge badge-info">${p.walletType}</span></td>
        <td class="table-cell"><span class="badge ${statusBadges[p.status] || 'badge-inactive'}">${p.status}</span></td>
        <td class="table-cell font-mono text-xs truncate max-w-[200px]">${p.txHash || '-'}</td>
        <td class="table-cell">
          ${p.status === 'requested' || p.status === 'processing' ? `
            <button class="btn-danger text-xs p-1" onclick="cancelPayout('${p.id}')">Cancel</button>
          ` : p.status === 'completed' && p.txHash ? `
            <button class="btn-ghost text-xs p-1" onclick="copyTxHash('${p.txHash}')">Copy TX</button>
          ` : '-'}
        </td>
      </tr>
    `).join('');
    
    if (info) info.textContent = `Page ${data.page} of ${Math.ceil(data.total / data.pageSize)} (${data.total} total)`;
    if (prevBtn) prevBtn.disabled = AffiliateState.payoutsPage <= 1;
    if (nextBtn) nextBtn.disabled = AffiliateState.payoutsPage >= Math.ceil(data.total / data.pageSize);
    
  } catch (e) {
    console.error('Load payouts:', e);
    $('#payoutsBody').innerHTML = '<tr><td colspan="9" class="table-cell text-center text-acc-rose py-8">Failed to load payouts</td></tr>';
  }
}

function changePayoutPage(delta) {
  AffiliateState.payoutsPage += delta;
  loadPayoutsTable();
}

function filterPayouts() {
  const status = $('#payoutStatusFilter')?.value || '';
  const rows = $$('#payoutsBody tr');
  
  rows.forEach(row => {
    const rowStatus = row.querySelector('.badge')?.textContent?.toLowerCase() || '';
    const match = !status || rowStatus === status;
    row.style.display = match ? '' : 'none';
  });
}

async function cancelPayout(payoutId) {
  if (!confirm('Cancel this payout? Amount will be returned to pending earnings.')) return;
  
  try {
    await api(`/affiliates/payouts?id=${payoutId}`, { method: 'DELETE' });
    showToast('Payout cancelled', 'success');
    refreshView();
  } catch (e) {
    showToast(e.message || 'Failed to cancel', 'error');
  }
}

function copyTxHash(hash) {
  navigator.clipboard.writeText(hash);
  showToast('Transaction hash copied', 'success');
}

// ============ CAMPAIGNS ============
async function renderCampaigns() {
  const content = $('#viewContent');
  if (!content) return;
  
  content.innerHTML = `
    <div class="flex flex-col gap-4">
      <div class="card-base flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h3 class="text-lg font-semibold">My Campaigns</h3>
        <div class="flex gap-2 w-full sm:w-auto">
          <button class="btn-primary" onclick="openCreateCampaignModal()">
            <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
            Create Campaign
          </button>
          <button class="btn-secondary" onclick="refreshView()">Refresh</button>
        </div>
      </div>

      <div class="card-base overflow-hidden">
        <div class="scrollbar-thin overflow-x-auto">
          <table class="w-full min-w-[1000px]">
            <thead>
              <tr>
                <th class="table-header">Campaign</th>
                <th class="table-header">Status</th>
                <th class="table-header">Infections</th>
                <th class="table-header">Files</th>
                <th class="table-header">Data Exfiltrated</th>
                <th class="table-header">Earnings</th>
                <th class="table-header">Created</th>
                <th class="table-header">Last Activity</th>
                <th class="table-header">Actions</th>
              </tr>
            </thead>
            <tbody id="campaignsBody" class="divide-y divide-gray-800"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  
  await loadCampaignsTable();
}

async function loadCampaignsTable() {
  try {
    // Get campaigns created by this affiliate
    const data = await api(`/affiliates?id=${AffiliateState.affiliate.id}&includeStats=true`);
    const campaigns = data.campaigns || [];
    
    const body = $('#campaignsBody');
    if (!body) return;
    
    if (campaigns.length === 0) {
      body.innerHTML = '<tr><td colspan="9" class="table-cell text-center text-gray-500 py-8">No campaigns yet. Create your first campaign to start earning!</td></tr>';
      return;
    }
    
    body.innerHTML = campaigns.map(c => {
      const stats = c.stats || {};
      const earnings = (stats.totalInfections || 0) * 50; // Simplified
      
      return `
        <tr class="table-row">
          <td class="table-cell font-mono text-chaos-400">${c.name}</td>
          <td class="table-cell"><span class="badge ${c.status === 'active' ? 'badge-active' : 'badge-inactive'}">${c.status}</span></td>
          <td class="table-cell text-right font-mono">${fmtNumber(stats.totalInfections)}</td>
          <td class="table-cell text-right font-mono">${fmtNumber(stats.totalFiles)}</td>
          <td class="table-cell text-right font-mono">${fmtBytes(stats.totalBytes)}</td>
          <td class="table-cell text-right font-mono text-acc-emerald">${fmtCurrency(earnings)}</td>
          <td class="table-cell text-gray-400">${timeAgo(c.createdAt)}</td>
          <td class="table-cell text-gray-400">${timeAgo(stats.lastActivity)}</td>
          <td class="table-cell">
            <div class="flex gap-1">
              <button class="btn-ghost text-xs p-1" onclick="viewCampaign('${c.id}')">View</button>
              <button class="btn-ghost text-xs p-1" onclick="copyCampaignLink('${c.id}')">Copy Link</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    
  } catch (e) {
    console.error('Load campaigns:', e);
    $('#campaignsBody').innerHTML = '<tr><td colspan="9" class="table-cell text-center text-acc-rose py-8">Failed to load campaigns</td></tr>';
  }
}

function openCreateCampaignModal() {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-overlay open" onclick="closeModal()">
      <div class="modal-panel w-full max-w-md" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-gray-800 flex items-center justify-between">
          <h3 class="text-lg font-semibold">Create Campaign</h3>
          <button class="btn-ghost p-1" onclick="closeModal()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
        </div>
        <div class="p-6 space-y-4">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Campaign Name</label>
            <input type="text" id="newCampName" class="input-base" placeholder="My Campaign">
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Description</label>
            <textarea id="newCampDesc" class="input-base" rows="3" placeholder="Optional description"></textarea>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">RSA Key Size</label>
            <select id="newCampKeySize" class="input-base">
              <option value="2048">2048 bits</option>
              <option value="4096" selected>4096 bits</option>
              <option value="8192">8192 bits</option>
            </select>
          </div>
          <button class="btn-primary w-full" onclick="createCampaign()">Create Campaign</button>
        </div>
      </div>
    </div>
  `;
}

async function createCampaign() {
  const name = $('#newCampName')?.value?.trim();
  const description = $('#newCampDesc')?.value?.trim();
  const rsaKeySize = parseInt($('#newCampKeySize')?.value || '4096');
  
  if (!name) return showToast('Enter campaign name', 'error');
  
  try {
    const data = await api('/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name, description, rsaKeySize })
    });
    
    showToast('Campaign created!', 'success');
    closeModal();
    refreshView();
    
    // Show API key modal
    showApiKeyModal(data.apiKey, data.id);
  } catch (e) {
    showToast(e.message || 'Failed to create campaign', 'error');
  }
}

function showApiKeyModal(apiKey, campaignId) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-overlay open" onclick="closeModal()">
      <div class="modal-panel w-full max-w-md" onclick="event.stopPropagation()">
        <div class="p-6 border-b border-gray-800 flex items-center justify-between">
          <h3 class="text-lg font-semibold">Campaign Created!</h3>
        </div>
        <div class="p-6 space-y-4">
          <div class="card-base p-4 border-acc-emerald">
            <p class="text-xs text-acc-emerald mb-2">Your API Key (save this - won't be shown again)</p>
            <div class="flex gap-2">
              <code class="flex-1 font-mono text-sm bg-surface-800 px-3 py-2 rounded-lg border border-gray-700 text-acc-emerald" id="newApiKey">${apiKey}</code>
              <button class="btn-secondary copy-btn" onclick="copyToClipboard('${apiKey}')">Copy</button>
            </div>
          </div>
          <p class="text-sm text-gray-500">Use this API key in your payload configuration to track infections under this campaign.</p>
          <div class="flex gap-2">
            <button class="btn-primary flex-1" onclick="closeModal(); refreshView()">Done</button>
            <button class="btn-secondary flex-1" onclick="copyToClipboard('${apiKey}')">Copy Key</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function viewCampaign(campaignId) {
  // Would open campaign detail view
  showToast('Campaign detail view coming soon', 'info');
}

function copyCampaignLink(campaignId) {
  const url = `${window.location.origin}/campaign/${campaignId}`;
  copyToClipboard(url);
}

// ============ SETTINGS ============
async function renderSettings() {
  const content = $('#viewContent');
  if (!content) return;
  
  const affiliate = AffiliateState.affiliate;
  
  content.innerHTML = `
    <div class="space-y-6 max-w-2xl">
      <!-- Profile -->
      <article class="card-base">
        <h3 class="text-lg font-semibold mb-4">Profile</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Username</label>
            <input type="text" id="setUsername" class="input-base" value="${affiliate.username}" disabled>
            <p class="text-xs text-gray-500 mt-1">Username cannot be changed</p>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Email</label>
            <input type="email" id="setEmail" class="input-base" value="${affiliate.email}" onchange="updateSetting('email', this.value)">
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Referral Code</label>
            <div class="flex gap-2">
              <code class="flex-1 font-mono text-sm bg-surface-800 px-3 py-2 rounded-lg border border-gray-700 text-chaos-400">${affiliate.refCode}</code>
              <button class="btn-secondary copy-btn" onclick="copyToClipboard('${affiliate.refCode}')">Copy</button>
            </div>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">API Key</label>
            <div class="flex gap-2">
              <code class="flex-1 font-mono text-sm bg-surface-800 px-3 py-2 rounded-lg border border-gray-700 text-chaos-400" id="apiKeyDisplay">${affiliate.apiKey}</code>
              <button class="btn-secondary copy-btn" onclick="copyToClipboard('${affiliate.apiKey}')">Copy</button>
              <button class="btn-ghost" onclick="regenerateApiKey()">Regenerate</button>
            </div>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">API Secret</label>
            <div class="flex gap-2">
              <code class="flex-1 font-mono text-sm bg-surface-800 px-3 py-2 rounded-lg border border-gray-700 text-chaos-400" id="apiSecretDisplay">${affiliate.apiSecret}</code>
              <button class="btn-secondary copy-btn" onclick="copyToClipboard('${affiliate.apiSecret}')">Copy</button>
              <button class="btn-ghost" onclick="regenerateApiSecret()">Regenerate</button>
            </div>
          </div>
        </div>
      </article>
      
      <!-- Wallet -->
      <article class="card-base">
        <h3 class="text-lg font-semibold mb-4">Wallet Settings</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Wallet Address</label>
            <input type="text" id="setWallet" class="input-base" value="${affiliate.walletAddress || ''}" placeholder="Enter your wallet address" onchange="updateSetting('walletAddress', this.value)">
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Wallet Type</label>
            <select id="setWalletType" class="input-base" onchange="updateSetting('walletType', this.value)">
              <option value="BTC" ${affiliate.walletType === 'BTC' ? 'selected' : ''}>Bitcoin (BTC)</option>
              <option value="ETH" ${affiliate.walletType === 'ETH' ? 'selected' : ''}>Ethereum (ETH)</option>
              <option value="USDT" ${affiliate.walletType === 'USDT' ? 'selected' : ''}>Tether (USDT)</option>
              <option value="XMR" ${affiliate.walletType === 'XMR' ? 'selected' : ''}>Monero (XMR)</option>
            </select>
          </div>
        </div>
      </article>
      
      <!-- Payout Settings -->
      <article class="card-base">
        <h3 class="text-lg font-semibold mb-4">Payout Settings</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Minimum Payout Threshold</label>
            <input type="number" id="setThreshold" class="input-base" value="${affiliate.settings?.payoutThreshold || 100}" min="10" step="10" onchange="updateSetting('payoutThreshold', parseInt(this.value))">
          </div>
          <div class="flex items-center gap-3">
            <input type="checkbox" id="setAutoPayout" class="w-4 h-4 rounded border-gray-600 bg-surface-800 text-chaos-500 focus:ring-chaos-500" ${affiliate.settings?.autoPayout ? 'checked' : ''} onchange="updateSetting('autoPayout', this.checked)">
            <label for="setAutoPayout" class="text-sm">Enable Auto Payout (when threshold reached)</label>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Preferred Currency</label>
            <select id="setCurrency" class="input-base" onchange="updateSetting('preferredCurrency', this.value)">
              <option value="USD" ${affiliate.settings?.preferredCurrency === 'USD' ? 'selected' : ''}>USD</option>
              <option value="EUR" ${affiliate.settings?.preferredCurrency === 'EUR' ? 'selected' : ''}>EUR</option>
              <option value="BTC" ${affiliate.settings?.preferredCurrency === 'BTC' ? 'selected' : ''}>BTC</option>
            </select>
          </div>
        </div>
      </article>
      
      <!-- Security -->
      <article class="card-base">
        <h3 class="text-lg font-semibold mb-4">Security</h3>
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium">Two-Factor Authentication</p>
              <p class="text-xs text-gray-500">Add an extra layer of security</p>
            </div>
            ${affiliate.twoFAEnabled ? `
              <span class="badge badge-active">Enabled</span>
            ` : `
              <button class="btn-primary" onclick="enable2FA()">Enable 2FA</button>
            `}
          </div>
          <div class="pt-4 border-t border-gray-800">
            <p class="font-medium mb-2">Change Password</p>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <input type="password" id="currentPass" class="input-base" placeholder="Current password">
              <input type="password" id="newPass" class="input-base" placeholder="New password (min 8 chars)">
            </div>
            <input type="password" id="confirmPass" class="input-base mt-4" placeholder="Confirm new password">
            <button class="btn-secondary mt-4" onclick="changePassword()">Update Password</button>
          </div>
        </div>
      </article>
      
      <!-- Notifications -->
      <article class="card-base">
        <h3 class="text-lg font-semibold mb-4">Notifications</h3>
        <div class="space-y-3">
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 rounded border-gray-600 bg-surface-800 text-chaos-500 focus:ring-chaos-500" ${affiliate.settings?.emailNotifications ? 'checked' : ''} onchange="updateSetting('emailNotifications', this.checked)">
            <span class="text-sm">Email notifications for earnings and payouts</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 rounded border-gray-600 bg-surface-800 text-chaos-500 focus:ring-chaos-500" ${affiliate.settings?.telegramNotifications ? 'checked' : ''} onchange="updateSetting('telegramNotifications', this.checked)">
            <span class="text-sm">Telegram notifications (coming soon)</span>
          </label>
        </div>
      </article>
      
      <!-- Danger Zone -->
      <article class="card-base border-acc-rose">
        <h3 class="text-lg font-semibold mb-4 text-acc-rose">Danger Zone</h3>
        <div class="space-y-3">
          <button class="btn-danger w-full" onclick="confirmDeleteAccount()">Delete Account</button>
          <p class="text-xs text-gray-500 text-center">This action is irreversible. All data, referrals, and earnings will be permanently lost.</p>
        </div>
      </article>
    </div>
  `;
}

async function updateSetting(key, value) {
  try {
    await api('/affiliates', {
      method: 'PUT',
      body: JSON.stringify({ id: AffiliateState.affiliate.id, [key]: value })
    });
    AffiliateState.affiliate[key] = value;
    if (key.startsWith('settings.')) {
      const settingKey = key.replace('settings.', '');
      AffiliateState.affiliate.settings[settingKey] = value;
    }
    showToast('Settings updated', 'success');
  } catch (e) {
    showToast(e.message || 'Failed to update', 'error');
  }
}

async function regenerateApiKey() {
  if (!confirm('Regenerate API key? Old key will be invalidated.')) return;
  try {
    await api('/affiliates', {
      method: 'PUT',
      body: JSON.stringify({ id: AffiliateState.affiliate.id, regenerateApiKey: true })
    });
    showToast('API key regenerated', 'success');
    refreshView();
  } catch (e) {
    showToast(e.message || 'Failed', 'error');
  }
}

async function regenerateApiSecret() {
  if (!confirm('Regenerate API secret? Old secret will be invalidated.')) return;
  try {
    await api('/affiliates', {
      method: 'PUT',
      body: JSON.stringify({ id: AffiliateState.affiliate.id, regenerateApiSecret: true })
    });
    showToast('API secret regenerated', 'success');
    refreshView();
  } catch (e) {
    showToast(e.message || 'Failed', 'error');
  }
}

async function enable2FA() {
  try {
    const data = await api('/affiliates/auth', { 
      method: 'POST', 
      body: JSON.stringify({ action: '2fa_enable' }) 
    });
    
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-overlay open" onclick="closeModal()">
        <div class="modal-panel w-full max-w-md" onclick="event.stopPropagation()">
          <div class="p-6 border-b border-gray-800 flex items-center justify-between">
            <h3 class="text-lg font-semibold">Enable 2FA</h3>
            <button class="btn-ghost p-1" onclick="closeModal()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
          </div>
          <div class="p-6 space-y-4">
            <p class="text-sm text-gray-400">Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)</p>
            <div class="flex justify-center">
              <img src="${data.qrCode}" alt="2FA QR Code" class="rounded-lg bg-white p-4">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">Or enter this secret manually</label>
              <code class="font-mono text-sm bg-surface-800 px-3 py-2 rounded-lg border border-gray-700 block text-center break-all">${data.secret}</code>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">Enter 6-digit code from app</label>
              <input type="text" id="twofaCode" class="input-base" placeholder="123456" maxlength="6" pattern="[0-9]*">
            </div>
            <button class="btn-primary w-full" onclick="verify2FASetup('${data.secret}')">Verify & Enable</button>
            <p class="text-xs text-gray-500 text-center">Save your backup codes!</p>
            <div class="grid grid-cols-5 gap-2 text-xs">
              ${data.backupCodes.map(c => `<code class="font-mono bg-surface-800 px-2 py-1 rounded text-center">${c}</code>`).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    showToast(e.message || 'Failed to enable 2FA', 'error');
  }
}

async function verify2FASetup(secret) {
  const code = $('#twofaCode')?.value;
  if (!code || code.length !== 6) return showToast('Enter 6-digit code', 'error');
  
  try {
    await api('/affiliates/auth', { 
      method: 'POST', 
      body: JSON.stringify({ action: '2fa_verify', code }) 
    });
    showToast('2FA enabled successfully!', 'success');
    closeModal();
    refreshView();
  } catch (e) {
    showToast(e.message || 'Invalid code', 'error');
  }
}

async function changePassword() {
  const current = $('#currentPass')?.value;
  const newPass = $('#newPass')?.value;
  const confirm = $('#confirmPass')?.value;
  
  if (!current || !newPass || !confirm) return showToast('Fill all fields', 'error');
  if (newPass !== confirm) return showToast('Passwords do not match', 'error');
  if (newPass.length < 8) return showToast('Password must be at least 8 characters', 'error');
  
  // Would need a change password endpoint
  showToast('Password change coming soon', 'info');
}

function confirmDeleteAccount() {
  const confirm1 = prompt('Type "DELETE" to confirm account deletion:');
  if (confirm1 !== 'DELETE') return showToast('Deletion cancelled', 'info');
  
  const confirm2 = prompt('Are you absolutely sure? Type your username to confirm:');
  if (confirm2 !== AffiliateState.affiliate.username) return showToast('Deletion cancelled', 'info');
  
  // Would call delete endpoint
  showToast('Account deletion coming soon', 'info');
}

// ============ UTILITY FUNCTIONS ============
function copyToClipboard(text) {
  navigator.clipboard.writeText(text);
  showToast('Copied to clipboard!', 'success');
}

function copyReferralCode() {
  copyToClipboard(AffiliateState.affiliate?.refCode || '');
}

function copyReferralLink() {
  const url = `${window.location.origin}/affiliate/${AffiliateState.affiliate?.refCode}`;
  copyToClipboard(url);
}

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// ============ POLLING ============
function startPolling() {
  stopPolling();
  AffiliateState.pollingInterval = setInterval(() => {
    if (AffiliateState.affiliate) {
      refreshAffiliateData();
    }
  }, 30000); // Every 30 seconds
}

function stopPolling() {
  if (AffiliateState.pollingInterval) {
    clearInterval(AffiliateState.pollingInterval);
    AffiliateState.pollingInterval = null;
  }
}

async function refreshAffiliateData() {
  try {
    const data = await api('/affiliates/auth', { 
      method: 'POST', 
      body: JSON.stringify({ action: 'verify' }) 
    });
    if (data.valid) {
      AffiliateState.affiliate = data.affiliate;
      updateAuthUI(true);
      // Update dashboard stats if on dashboard
      if (AffiliateState.currentView === 'dashboard') {
        updateDashboardStats();
      }
    }
  } catch (e) {
    console.warn('Polling refresh failed:', e);
  }
}

function updateDashboardStats() {
  const stats = AffiliateState.affiliate?.stats || {};
  $('#dashPending')?.textContent?.(fmtCurrency(stats.pendingEarnings));
  $('#dashTotal')?.textContent?.(fmtCurrency(stats.totalEarnings));
  $('#dashActiveRefs')?.textContent?.(fmtNumber(stats.activeReferrals));
  $('#dashInfections')?.textContent?.(fmtNumber(stats.totalInfectionsReferred));
  $('#dashCampaigns')?.textContent?.(fmtNumber(stats.totalCampaignsCreated));
}

// ============ NAVIGATION ============
function showView(view) {
  // Close sidebar on mobile
  $('#sidebar')?.classList?.add('-translate-x-full');
  $('#sidebarOverlay')?.classList?.add('hidden');
  
  renderView(view);
}

function toggleSidebar() {
  $('#sidebar')?.classList?.toggle('-translate-x-full');
  $('#sidebarOverlay')?.classList?.toggle('hidden');
}

// ============ INITIALIZATION ============
document.addEventListener('DOMContentLoaded', async () => {
  // Check for session in URL (for email verification, etc.)
  const urlParams = new URLSearchParams(window.location.search);
  const sessionToken = urlParams.get('session');
  if (sessionToken) {
    AffiliateState.sessionToken = sessionToken;
    localStorage.setItem('affiliate_session', sessionToken);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  
  await checkSession();
});

// Handle login form
async function handleLogin() {
  const identifier = $('#loginIdentifier')?.value?.trim();
  const password = $('#loginPassword')?.value;
  const twoFACode = $('#twofaCode')?.value;
  
  if (!identifier || !password) return showToast('Fill all fields', 'error');
  
  const btn = $('#authSubmitBtn');
  if (btn) { btn.disabled = true; $('#authBtnText').classList.add('hidden'); $('#authBtnSpinner').classList.remove('hidden'); }
  
  const result = await login(identifier, password, twoFACode);
  
  if (btn) { btn.disabled = false; $('#authBtnText').classList.remove('hidden'); $('#authBtnSpinner').classList.add('hidden'); }
  
  if (result.requires2FA) {
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay open" onclick="closeModal()">
        <div class="modal-panel w-full max-w-md" onclick="event.stopPropagation()">
          <div class="p-6 border-b border-gray-800 flex items-center justify-between">
            <h3 class="text-lg font-semibold">Two-Factor Authentication</h3>
            <button class="btn-ghost p-1" onclick="closeModal(); handleLogin()"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
          </div>
          <div class="p-6 space-y-4">
            <p class="text-sm text-gray-400">Enter the 6-digit code from your authenticator app</p>
            <input type="text" id="login2faCode" class="input-base text-center text-2xl tracking-widest" placeholder="123456" maxlength="6" pattern="[0-9]*">
            <button class="btn-primary w-full" onclick="submit2FALogin('${result.tempToken}')">Verify</button>
            <p class="text-xs text-gray-500 text-center">Don't have access? <button class="btn-ghost text-chaos-400" onclick="useBackupCode('${result.tempToken}')">Use backup code</button></p>
          </div>
        </div>
      </div>
    `;
  }
}

async function submit2FALogin(tempToken) {
  const code = $('#login2faCode')?.value;
  if (!code || code.length !== 6) return showToast('Enter 6-digit code', 'error');
  
  try {
    const data = await api('/affiliates/auth', { 
      method: 'POST', 
      body: JSON.stringify({ action: 'login', twoFACode: code, tempToken }) 
    });
    
    AffiliateState.sessionToken = data.sessionToken;
    AffiliateState.refreshToken = data.refreshToken;
    AffiliateState.affiliate = data.affiliate;
    localStorage.setItem('affiliate_session', data.sessionToken);
    localStorage.setItem('affiliate_refresh', data.refreshToken);
    
    updateAuthUI(true);
    showToast('Welcome back!', 'success');
    closeModal();
    showView('dashboard');
    startPolling();
  } catch (e) {
    showToast(e.message || 'Invalid 2FA code', 'error');
  }
}

async function useBackupCode(tempToken) {
  const code = prompt('Enter backup code:');
  if (!code) return;
  
  try {
    const data = await api('/affiliates/auth', { 
      method: 'POST', 
      body: JSON.stringify({ action: 'login', twoFACode: code, tempToken }) 
    });
    
    AffiliateState.sessionToken = data.sessionToken;
    AffiliateState.refreshToken = data.refreshToken;
    AffiliateState.affiliate = data.affiliate;
    localStorage.setItem('affiliate_session', data.sessionToken);
    localStorage.setItem('affiliate_refresh', data.refreshToken);
    
    updateAuthUI(true);
    showToast('Welcome back!', 'success');
    closeModal();
    showView('dashboard');
    startPolling();
  } catch (e) {
    showToast(e.message || 'Invalid backup code', 'error');
  }
}

// Handle register form
async function handleRegister() {
  const username = $('#regUsername')?.value?.trim();
  const email = $('#regEmail')?.value?.trim();
  const password = $('#regPassword')?.value;
  const confirmPassword = $('#regConfirmPassword')?.value;
  const referralCode = $('#regReferralCode')?.value?.trim();
  const walletAddress = $('#regWalletAddress')?.value?.trim();
  const walletType = $('#regWalletType')?.value;
  
  if (!username || !email || !password) return showToast('Fill all required fields', 'error');
  if (password !== confirmPassword) return showToast('Passwords do not match', 'error');
  if (password.length < 8) return showToast('Password must be at least 8 characters', 'error');
  if (username.length < 3) return showToast('Username must be at least 3 characters', 'error');
  
  const btn = $('#authSubmitBtn');
  if (btn) { btn.disabled = true; $('#authBtnText').classList.add('hidden'); $('#authBtnSpinner').classList.remove('hidden'); }
  
  const result = await register({ username, email, password, referralCode, walletAddress, walletType });
  
  if (btn) { btn.disabled = false; $('#authBtnText').classList.remove('hidden'); $('#authBtnSpinner').classList.add('hidden'); }
}

// Make functions globally available
window.showView = showView;
window.toggleSidebar = toggleSidebar;
window.refreshView = refreshView;
window.openAuthModal = openAuthModal;
window.openPayoutModal = openPayoutModal;
window.closeModal = closeModal;
window.handleLogin = handleLogin;
window.handleRegister = handleRegister;
window.submit2FALogin = submit2FALogin;
window.useBackupCode = useBackupCode;
window.logout = logout;
window.copyToClipboard = copyToClipboard;
window.copyReferralCode = copyReferralCode;
window.copyReferralLink = copyReferralLink;
window.submitPayout = submitPayout;
window.cancelPayout = cancelPayout;
window.copyTxHash = copyTxHash;
window.openCreateCampaignModal = openCreateCampaignModal;
window.createCampaign = createCampaign;
window.viewCampaign = viewCampaign;
window.copyCampaignLink = copyCampaignLink;
window.updateSetting = updateSetting;
window.regenerateApiKey = regenerateApiKey;
window.regenerateApiSecret = regenerateApiSecret;
window.enable2FA = enable2FA;
window.verify2FASetup = verify2FASetup;
window.changePassword = changePassword;
window.confirmDeleteAccount = confirmDeleteAccount;
window.filterReferrals = filterReferrals;
window.changeRefPage = changeRefPage;
window.openReferralDetail = openReferralDetail;
window.changeEarnPage = changeEarnPage;
window.filterPayouts = filterPayouts;
window.changePayoutPage = changePayoutPage;
window.exportEarningsCSV = exportEarningsCSV;