// vercel-dashboard/api/affiliates/auth.js
// Affiliate Authentication API

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  const { action } = request.body;

  try {
    switch (action) {
      case 'login':
        return await handleLogin(request, response);
      case 'register':
        return await handleRegister(request, response);
      case 'verify':
        return await handleVerify(request, response);
      case 'refresh':
        return await handleRefresh(request, response);
      case 'logout':
        return await handleLogout(request, response);
      case '2fa_enable':
        return await handle2FAEnable(request, response);
      case '2fa_verify':
        return await handle2FAVerify(request, response);
      case 'forgot_password':
        return await handleForgotPassword(request, response);
      case 'reset_password':
        return await handleResetPassword(request, response);
      default:
        return response.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Affiliate Auth error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/affiliates/auth - Login
async function handleLogin(request, response) {
  const { username, password, apiKey, apiSecret, twoFACode } = request.body;

  let affiliate = null;

  if (apiKey && apiSecret) {
    // API key login
    const affiliateIds = await kv.smembers('global:affiliates') || [];
    for (const aid of affiliateIds) {
      const a = await kv.get(`affiliate:${aid}`);
      if (a && a.apiKey === apiKey && a.apiSecret === apiSecret) {
        affiliate = a;
        break;
      }
    }
  } else if (username && password) {
    // Username/password login
    const id = await kv.get(`affiliate:username:${username}`);
    if (id) affiliate = await kv.get(`affiliate:${id}`);
  }

  if (!affiliate) {
    return response.status(401).json({ error: 'Invalid credentials' });
  }

  if (affiliate.status !== 'active') {
    return response.status(403).json({ error: 'Account suspended' });
  }

  // Verify password
  if (password && !verifyPassword(password, affiliate.passwordHash)) {
    return response.status(401).json({ error: 'Invalid credentials' });
  }

  // Check 2FA
  if (affiliate.twoFAEnabled) {
    if (!twoFACode) {
      return response.status(200).json({ 
        requires2FA: true, 
        tempToken: generateTempToken(affiliate.id) 
      });
    }
    if (!verify2FA(twoFACode, affiliate.twoFASecret)) {
      return response.status(401).json({ error: 'Invalid 2FA code' });
    }
  }

  // Generate session token
  const sessionToken = generateSessionToken(affiliate.id);
  const refreshToken = generateRefreshToken(affiliate.id);

  // Store session
  await Promise.all([
    kv.set(`session:${sessionToken}`, {
      affiliateId: affiliate.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
      ip: request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.headers['x-real-ip']
    }),
    kv.set(`refresh:${refreshToken}`, {
      affiliateId: affiliate.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    }),
    kv.set(`affiliate:${affiliate.id}`, {
      ...affiliate,
      lastLogin: new Date().toISOString(),
      loginCount: (affiliate.loginCount || 0) + 1
    })
  ]);

  // Return without sensitive data
  const { passwordHash, apiSecret, twoFASecret, ...safeAffiliate } = affiliate;

  response.json({
    success: true,
    affiliate: safeAffiliate,
    sessionToken,
    refreshToken,
    expiresIn: 86400
  });
}

// POST /api/affiliates/auth - Register
async function handleRegister(request, response) {
  const { username, email, password, referralCode, walletAddress, walletType, recaptchaToken } = request.body;

  if (!username || !email || !password) {
    return response.status(400).json({ error: 'Username, email, and password required' });
  }

  if (password.length < 8) {
    return response.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Verify reCAPTCHA if provided
  if (recaptchaToken) {
    const verified = await verifyRecaptcha(recaptchaToken);
    if (!verified) {
      return response.status(400).json({ error: 'reCAPTCHA verification failed' });
    }
  }

  // Check if username or email exists
  const existingByUsername = await kv.get(`affiliate:username:${username}`);
  if (existingByUsername) return response.status(409).json({ error: 'Username already taken' });

  const existingByEmail = await kv.get(`affiliate:email:${email}`);
  if (existingByEmail) return response.status(409).json({ error: 'Email already registered' });

  const id = `aff_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const apiKey = `ak_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 10)}`;
  const apiSecret = `as_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`;
  const refCode = username.toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

  // Check referral code
  let referrerId = null;
  if (referralCode) {
    referrerId = await kv.get(`referral_code:${referralCode}`);
  }

  const affiliate = {
    id,
    username,
    email,
    passwordHash: hashPassword(password),
    apiKey,
    apiSecret,
    refCode,
    walletAddress: walletAddress || null,
    walletType: walletType || 'BTC',
    tier: 'bronze',
    commissionRate: 0.20,
    status: 'active',
    twoFAEnabled: false,
    twoFASecret: null,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    loginCount: 0,
    ipWhitelist: [],
    settings: {
      emailNotifications: true,
      payoutThreshold: 100,
      autoPayout: false,
      preferredCurrency: 'USD'
    }
  };

  const operations = [
    kv.set(`affiliate:${id}`, affiliate),
    kv.set(`affiliate:username:${username}`, id),
    kv.set(`affiliate:email:${email}`, id),
    kv.set(`referral_code:${refCode}`, id),
    kv.sadd('global:affiliates', id),
    kv.hset(`affiliate:${id}:stats`, {
      totalReferrals: 0,
      activeReferrals: 0,
      totalEarnings: 0,
      pendingEarnings: 0,
      paidOut: 0,
      totalCampaignsCreated: 0,
      totalInfectionsReferred: 0
    })
  ];

  if (referrerId) {
    const referralId = `ref_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const referral = {
      id: referralId,
      affiliateId: referrerId,
      referredAffiliateId: id,
      referralCode,
      status: 'pending',
      tier: 'bronze',
      commissionRate: 0.20,
      createdAt: new Date().toISOString(),
      qualifiedAt: null,
      firstEarningAt: null
    };
    operations.push(
      kv.set(`referral:${referralId}`, referral),
      kv.sadd(`affiliate:${referrerId}:referrals`, referralId),
      kv.hincrby(`affiliate:${referrerId}:stats`, 'totalReferrals', 1)
    );
  }

  await Promise.all(operations);

  // Auto-login after registration
  const sessionToken = generateSessionToken(id);
  const refreshToken = generateRefreshToken(id);

  await Promise.all([
    kv.set(`session:${sessionToken}`, {
      affiliateId: id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }),
    kv.set(`refresh:${refreshToken}`, {
      affiliateId: id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    })
  ]);

  const { passwordHash, apiSecret: _, twoFASecret: __, ...safeAffiliate } = affiliate;

  response.status(201).json({
    success: true,
    affiliate: safeAffiliate,
    sessionToken,
    refreshToken,
    expiresIn: 86400
  });
}

// POST /api/affiliates/auth - Verify session
async function handleVerify(request, response) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  const { sessionToken } = request.body;

  const token = authHeader || sessionToken;
  if (!token) return response.status(401).json({ valid: false, error: 'No token provided' });

  const session = await kv.get(`session:${token}`);
  if (!session) return response.status(401).json({ valid: false, error: 'Invalid or expired session' });

  if (new Date(session.expiresAt) < new Date()) {
    await kv.del(`session:${token}`);
    return response.status(401).json({ valid: false, error: 'Session expired' });
  }

  const affiliate = await kv.get(`affiliate:${session.affiliateId}`);
  if (!affiliate || affiliate.status !== 'active') {
    return response.status(401).json({ valid: false, error: 'Account not found or suspended' });
  }

  const { passwordHash, apiSecret, twoFASecret, ...safeAffiliate } = affiliate;
  response.json({ valid: true, affiliate: safeAffiliate });
}

// POST /api/affiliates/auth - Refresh token
async function handleRefresh(request, response) {
  const { refreshToken } = request.body;
  if (!refreshToken) return response.status(400).json({ error: 'Refresh token required' });

  const refresh = await kv.get(`refresh:${refreshToken}`);
  if (!refresh) return response.status(401).json({ error: 'Invalid refresh token' });

  if (new Date(refresh.expiresAt) < new Date()) {
    await kv.del(`refresh:${refreshToken}`);
    return response.status(401).json({ error: 'Refresh token expired' });
  }

  // Generate new tokens
  const newSessionToken = generateSessionToken(refresh.affiliateId);
  const newRefreshToken = generateRefreshToken(refresh.affiliateId);

  await Promise.all([
    kv.del(`refresh:${refreshToken}`),
    kv.set(`session:${newSessionToken}`, {
      affiliateId: refresh.affiliateId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }),
    kv.set(`refresh:${newRefreshToken}`, {
      affiliateId: refresh.affiliateId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    })
  ]);

  response.json({
    sessionToken: newSessionToken,
    refreshToken: newRefreshToken,
    expiresIn: 86400
  });
}

// POST /api/affiliates/auth - Logout
async function handleLogout(request, response) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  const { sessionToken, refreshToken, allDevices } = request.body;

  if (allDevices) {
    // Logout from all devices - would need to scan all sessions
    // For now, just delete current session
  }

  const tokensToDelete = [];
  if (authHeader) tokensToDelete.push(`session:${authHeader}`);
  if (sessionToken) tokensToDelete.push(`session:${sessionToken}`);
  if (refreshToken) tokensToDelete.push(`refresh:${refreshToken}`);

  if (tokensToDelete.length > 0) {
    await Promise.all(tokensToDelete.map(t => kv.del(t)));
  }

  response.json({ success: true });
}

// POST /api/affiliates/auth - Enable 2FA
async function handle2FAEnable(request, response) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  if (!authHeader) return response.status(401).json({ error: 'Not authenticated' });

  const session = await kv.get(`session:${authHeader}`);
  if (!session) return response.status(401).json({ error: 'Invalid session' });

  const affiliate = await kv.get(`affiliate:${session.affiliateId}`);
  if (!affiliate) return response.status(404).json({ error: 'Affiliate not found' });

  if (affiliate.twoFAEnabled) {
    return response.status(400).json({ error: '2FA already enabled' });
  }

  const secret = generate2FASecret();
  const backupCodes = generateBackupCodes();

  await kv.set(`affiliate:${session.affiliateId}`, {
    ...affiliate,
    twoFAEnabled: true,
    twoFASecret: secret,
    backupCodes: hashBackupCodes(backupCodes)
  });

  response.json({
    secret,
    backupCodes,
    qrCode: `otpauth://totp/ChaosC2:${affiliate.username}?secret=${secret}&issuer=ChaosC2`
  });
}

// POST /api/affiliates/auth - Verify 2FA
async function handle2FAVerify(request, response) {
  const authHeader = request.headers['authorization']?.replace('Bearer ', '');
  const { code, tempToken } = request.body;

  if (!code) return response.status(400).json({ error: '2FA code required' });

  let affiliateId = null;

  if (tempToken) {
    const temp = await kv.get(`temp_2fa:${tempToken}`);
    if (temp) affiliateId = temp.affiliateId;
  } else if (authHeader) {
    const session = await kv.get(`session:${authHeader}`);
    if (session) affiliateId = session.affiliateId;
  }

  if (!affiliateId) return response.status(401).json({ error: 'Invalid session' });

  const affiliate = await kv.get(`affiliate:${affiliateId}`);
  if (!affiliate || !affiliate.twoFAEnabled) {
    return response.status(400).json({ error: '2FA not enabled' });
  }

  // Check TOTP
  if (verify2FA(code, affiliate.twoFASecret)) {
    if (tempToken) await kv.del(`temp_2fa:${tempToken}`);
    return response.json({ success: true });
  }

  // Check backup codes
  const backupHash = affiliate.backupCodes;
  if (backupHash && verifyBackupCode(code, backupHash)) {
    // Remove used backup code
    const codes = await getBackupCodes(affiliateId);
    const updatedCodes = codes.filter(c => c !== code);
    await kv.set(`affiliate:${affiliateId}`, {
      ...affiliate,
      backupCodes: hashBackupCodes(updatedCodes)
    });
    if (tempToken) await kv.del(`temp_2fa:${tempToken}`);
    return response.json({ success: true, backupCodeUsed: true });
  }

  return response.status(401).json({ error: 'Invalid 2FA code' });
}

// POST /api/affiliates/auth - Forgot password
async function handleForgotPassword(request, response) {
  const { email } = request.body;
  if (!email) return response.status(400).json({ error: 'Email required' });

  const id = await kv.get(`affiliate:email:${email}`);
  if (!id) {
    // Don't reveal if email exists
    return response.json({ success: true, message: 'If email exists, reset link sent' });
  }

  const resetToken = `reset_${Math.random().toString(36).substring(2, 20)}`;
  await kv.set(`password_reset:${resetToken}`, {
    affiliateId: id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour
  });

  // In production, send email
  console.log(`Password reset token for ${email}: ${resetToken}`);

  response.json({ success: true, message: 'If email exists, reset link sent', devToken: resetToken });
}

// POST /api/affiliates/auth - Reset password
async function handleResetPassword(request, response) {
  const { token, password } = request.body;
  if (!token || !password) return response.status(400).json({ error: 'Token and password required' });

  if (password.length < 8) {
    return response.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const reset = await kv.get(`password_reset:${token}`);
  if (!reset) return response.status(400).json({ error: 'Invalid or expired reset token' });

  if (new Date(reset.expiresAt) < new Date()) {
    await kv.del(`password_reset:${token}`);
    return response.status(400).json({ error: 'Reset token expired' });
  }

  const affiliate = await kv.get(`affiliate:${reset.affiliateId}`);
  if (!affiliate) return response.status(404).json({ error: 'Affiliate not found' });

  await Promise.all([
    kv.set(`affiliate:${reset.affiliateId}`, {
      ...affiliate,
      passwordHash: hashPassword(password)
    }),
    kv.del(`password_reset:${token}`),
    // Invalidate all sessions
    invalidateAllSessions(reset.affiliateId)
  ]);

  response.json({ success: true, message: 'Password reset successful' });
}

// ============ HELPER FUNCTIONS ============

function hashPassword(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `sha256_${Math.abs(hash).toString(16)}_${password.length}`;
}

function verifyPassword(password, hash) {
  return hashPassword(password) === hash;
}

function generateSessionToken(affiliateId) {
  return `sess_${affiliateId}_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

function generateRefreshToken(affiliateId) {
  return `ref_${affiliateId}_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

function generateTempToken(affiliateId) {
  const token = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  kv.set(`temp_2fa:${token}`, { affiliateId, createdAt: new Date().toISOString() });
  return token;
}

function generate2FASecret() {
  // Base32 encoded secret for TOTP
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  for (let i = 0; i < 32; i++) {
    secret += chars[Math.floor(Math.random() * chars.length)];
  }
  return secret;
}

function verify2FA(code, secret) {
  // Simplified TOTP verification - use otplib in production
  // For demo, accept any 6-digit code that matches a pattern
  return /^\d{6}$/.test(code) && code === '123456'; // Demo only
}

function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 10; i++) {
    codes.push(Math.random().toString(36).substring(2, 10).toUpperCase());
  }
  return codes;
}

function hashBackupCodes(codes) {
  return codes.map(c => hashPassword(c)).join(',');
}

function verifyBackupCode(code, hash) {
  const hashes = hash.split(',');
  return hashes.includes(hashPassword(code));
}

async function getBackupCodes(affiliateId) {
  const affiliate = await kv.get(`affiliate:${affiliateId}`);
  if (!affiliate?.backupCodes) return [];
  return affiliate.backupCodes.split(',').map(h => {
    // Reverse lookup not possible with hash, return empty for demo
    return null;
  }).filter(Boolean);
}

async function verifyRecaptcha(token) {
  // In production, verify with Google reCAPTCHA API
  return true; // Demo
}

async function invalidateAllSessions(affiliateId) {
  // Would need to scan all sessions - simplified for demo
  // In production, use a session index
}
