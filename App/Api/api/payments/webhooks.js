// vercel-dashboard/api/payments/webhooks.js
// Payment Webhooks Handler - Receives notifications from payment providers

import { kv } from '../../lib/kv.js';

export default async function handler(request, response) {
  // Allow all origins for webhooks
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Stripe-Signature, X-Coinbase-Signature');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  try {
    const provider = request.query.provider || 'unknown';
    
    switch (provider) {
      case 'stripe':
        return await handleStripeWebhook(request, response);
      case 'coinbase':
        return await handleCoinbaseWebhook(request, response);
      case 'blockcypher':
        return await handleBlockcypherWebhook(request, response);
      case 'blocknative':
        return await handleBlocknativeWebhook(request, response);
      case 'nowpayments':
        return await handleNowPaymentsWebhook(request, response);
      case 'coingate':
        return await handleCoinGateWebhook(request, response);
      case 'btcpay':
        return await handleBTCPayWebhook(request, response);
      case 'generic':
        return await handleGenericWebhook(request, response);
      default:
        return await handleGenericWebhook(request, response);
    }
  } catch (error) {
    console.error(`Webhook error (${request.query.provider}):`, error);
    return response.status(500).json({ error: 'Webhook processing failed' });
  }
}

// ============ STRIPE WEBHOOK ============
async function handleStripeWebhook(request, response) {
  const signature = request.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  // Verify signature (in production, use stripe.webhooks.constructEvent)
  // For now, we'll parse the body
  let event;
  try {
    event = request.body;
  } catch (e) {
    return response.status(400).json({ error: 'Invalid payload' });
  }

  const paymentIntentId = event.data?.object?.id;
  if (!paymentIntentId) return response.status(400).json({ error: 'No payment intent ID' });

  // Find payment by paymentIntentId
  const paymentIds = await kv.smembers('global:payments') || [];
  let payment = null;
  let paymentId = null;

  for (const pid of paymentIds) {
    const p = await kv.get(`payment:${pid}`);
    if (p && p.paymentIntentId === paymentIntentId) {
      payment = p;
      paymentId = pid;
      break;
    }
  }

  if (!payment) return response.status(404).json({ error: 'Payment not found' });

  const now = new Date().toISOString();
  let newStatus = payment.status;

  switch (event.type) {
    case 'payment_intent.succeeded':
      newStatus = 'completed';
      break;
    case 'payment_intent.payment_failed':
      newStatus = 'failed';
      break;
    case 'payment_intent.canceled':
      newStatus = 'cancelled';
      break;
    case 'payment_intent.processing':
      newStatus = 'processing';
      break;
    default:
      return response.json({ received: true });
  }

  if (newStatus !== payment.status) {
    await kv.set(`payment:${paymentId}`, {
      ...payment,
      status: newStatus,
      updatedAt: now,
      completedAt: newStatus === 'completed' ? now : payment.completedAt,
      failedAt: newStatus === 'failed' ? now : payment.failedAt,
      failureReason: event.data?.object?.last_payment_error?.message || payment.failureReason,
      stripeEvent: event
    });

    // Credit account if deposit
    if (payment.type === 'deposit' && newStatus === 'completed') {
      await creditAccount(payment);
    }

    // Trigger tenant/affiliate webhook
    if (payment.webhookUrl) {
      await triggerWebhook(payment.webhookUrl, {
        event: `payment.${newStatus}`,
        payment: { ...payment, status: newStatus }
      });
    }
  }

  response.json({ received: true });
}

// ============ COINBASE COMMERCE WEBHOOK ============
async function handleCoinbaseWebhook(request, response) {
  const signature = request.headers['x-coinbase-signature'];
  const secret = process.env.COINBASE_WEBHOOK_SECRET;
  
  // Verify signature (in production)
  let event;
  try {
    event = request.body;
  } catch (e) {
    return response.status(400).json({ error: 'Invalid payload' });
  }

  const chargeId = event.data?.id;
  if (!chargeId) return response.status(400).json({ error: 'No charge ID' });

  // Find payment by charge ID
  const paymentIds = await kv.smembers('global:payments') || [];
  let payment = null;
  let paymentId = null;

  for (const pid of paymentIds) {
    const p = await kv.get(`payment:${pid}`);
    if (p && p.metadata?.coinbaseChargeId === chargeId) {
      payment = p;
      paymentId = pid;
      break;
    }
  }

  if (!payment) return response.status(404).json({ error: 'Payment not found' });

  const now = new Date().toISOString();
  let newStatus = payment.status;

  switch (event.type) {
    case 'charge:confirmed':
      newStatus = 'completed';
      break;
    case 'charge:failed':
      newStatus = 'failed';
      break;
    case 'charge:pending':
      newStatus = 'processing';
      break;
    default:
      return response.json({ received: true });
  }

  if (newStatus !== payment.status) {
    await kv.set(`payment:${paymentId}`, {
      ...payment,
      status: newStatus,
      updatedAt: now,
      completedAt: newStatus === 'completed' ? now : payment.completedAt,
      coinbaseEvent: event
    });

    if (payment.type === 'deposit' && newStatus === 'completed') {
      await creditAccount(payment);
    }

    if (payment.webhookUrl) {
      await triggerWebhook(payment.webhookUrl, {
        event: `payment.${newStatus}`,
        payment: { ...payment, status: newStatus }
      });
    }
  }

  response.json({ received: true });
}

// ============ BLOCKCYPHER WEBHOOK (BTC/ETH/USDT) ============
async function handleBlockcypherWebhook(request, response) {
  // BlockCypher sends transaction notifications
  const data = request.body;
  
  const address = data.addresses?.[0];
  const txHash = data.hash;
  const confirmations = data.confirmations || 0;
  const value = data.total || 0; // In satoshis/wei
  const currency = data.currency || 'btc';

  if (!address || !txHash) return response.status(400).json({ error: 'Missing address or tx hash' });

  // Find payment by deposit address
  const paymentIds = await kv.smembers('global:payments') || [];
  let payment = null;
  let paymentId = null;

  for (const pid of paymentIds) {
    const p = await kv.get(`payment:${pid}`);
    if (p && p.depositAddress === address && p.status === 'pending') {
      payment = p;
      paymentId = pid;
      break;
    }
  }

  if (!payment) {
    // Check if it's a known address for a tenant
    const tenantIds = await kv.smembers('global:tenants') || [];
    for (const tid of tenantIds) {
      const tenantAddresses = await kv.smembers(`tenant:${tid}:deposit_addresses`) || [];
      if (tenantAddresses.includes(address)) {
        // Create payment record for unexpected deposit
        paymentId = await createUnexpectedDeposit(tid, address, txHash, value, currency);
        break;
      }
    }
    
    if (!paymentId) {
      return response.json({ received: true, message: 'Address not monitored' });
    }
    payment = await kv.get(`payment:${paymentId}`);
  }

  const required = payment.requiredConfirmations || getRequiredConfirmations(payment.method);
  
  if (confirmations >= required && payment.status !== 'completed') {
    const now = new Date().toISOString();
    await kv.set(`payment:${paymentId}`, {
      ...payment,
      status: 'completed',
      txHash,
      confirmations,
      completedAt: now,
      updatedAt: now,
      blockcypherEvent: data
    });

    if (payment.type === 'deposit') {
      await creditAccount(payment);
    }

    if (payment.webhookUrl) {
      await triggerWebhook(payment.webhookUrl, {
        event: 'payment.completed',
        payment: { ...payment, status: 'completed', txHash, confirmations }
      });
    }
  } else if (confirmations > 0 && payment.status === 'pending') {
    // Update confirmations
    await kv.set(`payment:${paymentId}`, {
      ...payment,
      confirmations,
      updatedAt: new Date().toISOString()
    });
  }

  response.json({ received: true });
}

// ============ BLOCKNATIVE WEBHOOK ============
async function handleBlocknativeWebhook(request, response) {
  const events = request.body?.events || [];
  
  for (const event of events) {
    const txHash = event.hash;
    const status = event.status; // 'pending', 'confirmed', 'failed'
    const confirmations = event.confirmations || 0;
    const toAddress = event.to;
    const value = event.value;
    
    if (!txHash || !toAddress) continue;

    const paymentIds = await kv.smembers('global:payments') || [];
    for (const pid of paymentIds) {
      const p = await kv.get(`payment:${pid}`);
      if (p && p.depositAddress === toAddress) {
        const now = new Date().toISOString();
        let newStatus = p.status;

        if (status === 'confirmed' && confirmations >= (p.requiredConfirmations || 1)) {
          newStatus = 'completed';
        } else if (status === 'failed') {
          newStatus = 'failed';
        } else if (status === 'pending') {
          newStatus = 'processing';
        }

        if (newStatus !== p.status) {
          await kv.set(`payment:${pid}`, {
            ...p,
            status: newStatus,
            txHash,
            confirmations,
            updatedAt: now,
            completedAt: newStatus === 'completed' ? now : p.completedAt,
            blocknativeEvent: event
          });

          if (p.type === 'deposit' && newStatus === 'completed') {
            await creditAccount(p);
          }

          if (p.webhookUrl) {
            await triggerWebhook(p.webhookUrl, {
              event: `payment.${newStatus}`,
              payment: { ...p, status: newStatus, txHash, confirmations }
            });
          }
        }
        break;
      }
    }
  }

  response.json({ received: true });
}

// ============ NOWPAYMENTS WEBHOOK ============
async function handleNowPaymentsWebhook(request, response) {
  const data = request.body;
  const paymentId = data.payment_id;
  const status = data.payment_status;
  const txHash = data.txn_id;
  const currency = data.pay_currency;
  const amount = data.pay_amount;

  if (!paymentId) return response.status(400).json({ error: 'No payment ID' });

  // Find our payment record
  const ourPaymentIds = await kv.smembers('global:payments') || [];
  let payment = null;
  let ourPaymentId = null;

  for (const pid of ourPaymentIds) {
    const p = await kv.get(`payment:${pid}`);
    if (p && p.metadata?.nowpaymentsId === paymentId) {
      payment = p;
      ourPaymentId = pid;
      break;
    }
  }

  if (!payment) return response.status(404).json({ error: 'Payment not found' });

  const now = new Date().toISOString();
  let newStatus = payment.status;

  switch (status) {
    case 'finished':
    case 'confirmed':
      newStatus = 'completed';
      break;
    case 'failed':
    case 'expired':
      newStatus = 'failed';
      break;
    case 'waiting':
    case 'confirming':
      newStatus = 'processing';
      break;
    default:
      return response.json({ received: true });
  }

  if (newStatus !== payment.status) {
    await kv.set(`payment:${ourPaymentId}`, {
      ...payment,
      status: newStatus,
      txHash,
      updatedAt: now,
      completedAt: newStatus === 'completed' ? now : payment.completedAt,
      nowpaymentsEvent: data
    });

    if (payment.type === 'deposit' && newStatus === 'completed') {
      await creditAccount(payment);
    }

    if (payment.webhookUrl) {
      await triggerWebhook(payment.webhookUrl, {
        event: `payment.${newStatus}`,
        payment: { ...payment, status: newStatus }
      });
    }
  }

  response.json({ received: true });
}

// ============ COINGATE WEBHOOK ============
async function handleCoinGateWebhook(request, response) {
  const data = request.body;
  const orderId = data.id;
  const status = data.status;
  const txHash = data.tx_id;

  // Similar to NowPayments
  const paymentIds = await kv.smembers('global:payments') || [];
  let payment = null;
  let paymentId = null;

  for (const pid of paymentIds) {
    const p = await kv.get(`payment:${pid}`);
    if (p && p.metadata?.coingateOrderId === orderId) {
      payment = p;
      paymentId = pid;
      break;
    }
  }

  if (!payment) return response.status(404).json({ error: 'Payment not found' });

  const now = new Date().toISOString();
  let newStatus = payment.status;

  switch (status) {
    case 'paid':
    case 'confirmed':
      newStatus = 'completed';
      break;
    case 'canceled':
    case 'expired':
    case 'invalid':
      newStatus = 'failed';
      break;
    case 'new':
    case 'pending':
      newStatus = 'processing';
      break;
  }

  if (newStatus !== payment.status) {
    await kv.set(`payment:${paymentId}`, {
      ...payment,
      status: newStatus,
      txHash,
      updatedAt: now,
      completedAt: newStatus === 'completed' ? now : payment.completedAt,
      coingateEvent: data
    });

    if (payment.type === 'deposit' && newStatus === 'completed') {
      await creditAccount(payment);
    }
  }

  response.json({ received: true });
}

// ============ BTCPAY SERVER WEBHOOK ============
async function handleBTCPayWebhook(request, response) {
  const data = request.body;
  const invoiceId = data.invoiceId;
  const status = data.status;
  const txHash = data.transactionId;

  const paymentIds = await kv.smembers('global:payments') || [];
  let payment = null;
  let paymentId = null;

  for (const pid of paymentIds) {
    const p = await kv.get(`payment:${pid}`);
    if (p && p.metadata?.btcpayInvoiceId === invoiceId) {
      payment = p;
      paymentId = pid;
      break;
    }
  }

  if (!payment) return response.status(404).json({ error: 'Payment not found' });

  const now = new Date().toISOString();
  let newStatus = payment.status;

  switch (status) {
    case 'Complete':
    case 'Confirmed':
      newStatus = 'completed';
      break;
    case 'Expired':
    case 'Invalid':
      newStatus = 'failed';
      break;
    case 'Processing':
      newStatus = 'processing';
      break;
  }

  if (newStatus !== payment.status) {
    await kv.set(`payment:${paymentId}`, {
      ...payment,
      status: newStatus,
      txHash,
      updatedAt: now,
      completedAt: newStatus === 'completed' ? now : payment.completedAt,
      btcpayEvent: data
    });

    if (payment.type === 'deposit' && newStatus === 'completed') {
      await creditAccount(payment);
    }
  }

  response.json({ received: true });
}

// ============ GENERIC WEBHOOK ============
async function handleGenericWebhook(request, response) {
  const { paymentId, status, txHash, confirmations, amount, currency, metadata } = request.body;

  if (!paymentId) {
    // Try to find by txHash
    if (!txHash) return response.status(400).json({ error: 'paymentId or txHash required' });
    
    const paymentIds = await kv.smembers('global:payments') || [];
    for (const pid of paymentIds) {
      const p = await kv.get(`payment:${pid}`);
      if (p && p.txHash === txHash) {
        return await updatePaymentStatus(pid, status, txHash, confirmations);
      }
    }
    return response.status(404).json({ error: 'Payment not found' });
  }

  return await updatePaymentStatus(paymentId, status, txHash, confirmations);
}

async function updatePaymentStatus(paymentId, status, txHash, confirmations) {
  const payment = await kv.get(`payment:${paymentId}`);
  if (!payment) return response.status(404).json({ error: 'Payment not found' });

  const now = new Date().toISOString();
  const newStatus = status || payment.status;

  await kv.set(`payment:${paymentId}`, {
    ...payment,
    status: newStatus,
    txHash: txHash || payment.txHash,
    confirmations: confirmations || payment.confirmations,
    updatedAt: now,
    completedAt: newStatus === 'completed' ? now : payment.completedAt,
    genericWebhook: { status, txHash, confirmations, timestamp: now }
  });

  if (payment.type === 'deposit' && newStatus === 'completed') {
    await creditAccount(payment);
  }

  if (payment.webhookUrl) {
    await triggerWebhook(payment.webhookUrl, {
      event: `payment.${newStatus}`,
      payment: { ...payment, status: newStatus }
    });
  }

  return response.json({ success: true, paymentId, status: newStatus });
}

// ============ HELPER FUNCTIONS ============
async function createUnexpectedDeposit(tenantId, address, txHash, value, currency) {
  const id = `pay_deposit_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date().toISOString();
  
  // Convert value based on currency
  let amount = value;
  if (currency === 'btc') amount = value / 1e8; // satoshis to BTC
  else if (currency === 'eth') amount = value / 1e18; // wei to ETH

  const payment = {
    id,
    tenantId,
    affiliateId: null,
    amount,
    currency: currency.toUpperCase(),
    type: 'deposit',
    method: currency,
    status: 'completed',
    fee: 0,
    netAmount: amount,
    walletAddress: address,
    walletType: currency.toUpperCase(),
    description: 'Unexpected deposit',
    metadata: { unexpected: true },
    txHash,
    confirmations: 999,
    requiredConfirmations: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: now
  };

  await Promise.all([
    kv.set(`payment:${id}`, payment),
    kv.sadd('global:payments', id),
    kv.sadd(`tenant:${tenantId}:payments`, id)
  ]);

  await creditAccount(payment);
  return id;
}

async function creditAccount(payment) {
  const { tenantId, affiliateId, amount, currency, netAmount, type } = payment;
  
  if (affiliateId && (type === 'commission' || type === 'deposit')) {
    await kv.hincrbyfloat(`affiliate:${affiliateId}:stats`, 'pendingEarnings', netAmount);
    await kv.hincrbyfloat(`affiliate:${affiliateId}:stats`, 'totalEarnings', netAmount);
  }
  
  if (tenantId && type === 'deposit') {
    await kv.hincrbyfloat(`tenant:${tenantId}:balance`, currency.toLowerCase(), netAmount);
  }
}

async function triggerWebhook(url, payload) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Webhook failed:', e);
  }
}

function getRequiredConfirmations(method) {
  const confirmations = {
    btc: 3, eth: 12, usdt: 12, xmr: 10, ltc: 6, bch: 6,
    stripe: 0, coinbase: 0, manual: 0, nowpayments: 0, coingate: 0, btcpay: 0
  };
  return confirmations[method] || 0;
}
