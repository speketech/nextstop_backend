'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * NextStop — Consolidated Interswitch Integration Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * * CREDENTIAL SETS:
 * - SET A: Quickteller Business (QTB) — Payments, Verification, Webhooks
 * - SET B: API Marketplace (MKT) — KYC (NIN, DL, BVN), Bank Verify, WhatsApp
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const crypto         = require('crypto');
const axios          = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../config/logger');
const db             = require('../config/database');

// ─── SECTION 0: CONFIGURATION ────────────────────────────────────────────────

const QTB = {
  CLIENT_ID:     process.env.QTB_CLIENT_ID,
  CLIENT_SECRET: process.env.QTB_CLIENT_SECRET,
  PRODUCT_ID:    process.env.QTB_PRODUCT_ID,
  PAY_ITEM_ID:   process.env.QTB_PAY_ITEM_ID,
  HASH_KEY:      process.env.QTB_HASH_KEY,
  // Signature secret for incoming webhooks
  WEBHOOK_SECRET: process.env.QTB_WEBHOOK_SECRET, 
  PASSPORT_URL:  process.env.QTB_PASSPORT_URL || 'https://sandbox.interswitchng.com',
  BASE_URL:      process.env.QTB_BASE_URL     || 'https://sandbox.interswitchng.com',
  VERIFY_URL:    process.env.QTB_VERIFY_URL   || 'https://sandbox.interswitchng.com/collections/api/v1/gettransaction.json'
};

const MKT = {
  CLIENT_ID:     process.env.MKT_CLIENT_ID,
  CLIENT_SECRET: process.env.MKT_CLIENT_SECRET,
  PASSPORT_URL:  process.env.MKT_PASSPORT_URL || 'https://qa.interswitchng.com',
  
  // KYC Endpoint URLs
  NIN_URL:          process.env.MKT_NIN_URL          || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v2/customers/nin',
  DL_URL:           process.env.MKT_DL_URL           || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v2/customers/dl',
  WHATSAPP_OTP_URL: process.env.MKT_WHATSAPP_OTP_URL || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/whatsapp/auth/send',
  BANK_RESOLVE_URL: process.env.MKT_BANK_RESOLVE_URL || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/verify/identity/account-number/resolve',
  BANK_LIST_URL:    process.env.MKT_BANK_LIST_URL    || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/verify/identity/account-number/bank-list',
  SAFETOKEN_SEND_URL:   process.env.MKT_SAFETOKEN_SEND_URL   || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/soft-token/send',
  SAFETOKEN_VERIFY_URL: process.env.MKT_SAFETOKEN_VERIFY_URL || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/soft-token/verify',
  ADDRESS_URL:          process.env.MKT_ADDRESS_URL          || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/addresses'
};

// ─── SECTION 1: TOKEN MANAGEMENT ─────────────────────────────────────────────

const _tokenCache = {
  qtb: { token: null, expiresAt: 0 },
  mkt: { token: null, expiresAt: 0 }
};

/** Isolated token factory for dual-credential support */
async function _fetchToken(set) {
  const now   = Date.now();
  const cache = _tokenCache[set];

  if (cache.token && now < cache.expiresAt - 60000) return cache.token;

  const creds = set === 'qtb' ? QTB : MKT;
  const basicAuth = Buffer.from(`${creds.CLIENT_ID}:${creds.CLIENT_SECRET}`).toString('base64');

  try {
    const resp = await axios.post(
      `${creds.PASSPORT_URL}/passport/oauth/token`,
      'grant_type=client_credentials&scope=profile',
      {
        headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );

    const { access_token, expires_in } = resp.data;
    _tokenCache[set] = { token: access_token, expiresAt: now + expires_in * 1000 };
    return access_token;
  } catch (err) {
    logger.error(`[ISW-Token] Failed for [${set}]: ${err.message}`);
    throw new Error(`Authentication with Interswitch [${set}] failed`);
  }
}

const getPaymentToken = () => _fetchToken('qtb');
const getMarketplaceToken = () => _fetchToken('mkt');

// ─── SECTION 2: PAYMENT OPERATIONS (QTB) ─────────────────────────────────────

async function initiatePayment({ rideId, payerId, payerType, amountNaira, customerEmail, customerName, splits = [] }) {
  const txRef      = `NSP-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
  const amountKobo = Math.round(amountNaira * 100);

  // Formula: txRef + ProductID + PayItemID + AmountKobo + RedirectURL + HashKey
  const hashString = txRef + QTB.PRODUCT_ID + QTB.PAY_ITEM_ID + amountKobo + process.env.PAYMENT_REDIRECT_URL + QTB.HASH_KEY;
  const hash = crypto.createHash('sha512').update(hashString).digest('hex');

  await db('transactions').insert({
    id: uuidv4(), ride_id: rideId, payer_id: payerId, payer_type: payerType,
    tx_ref: txRef, amount_kobo: amountKobo, amount_naira: amountNaira, status: 'PENDING'
  });

  const bodyData = {
    merchantcode: QTB.PRODUCT_ID, payableid: QTB.PAY_ITEM_ID, transactionreference: txRef,
    amount: amountKobo, redirecturl: process.env.PAYMENT_REDIRECT_URL, hash: hash
  };

  const qs = new URLSearchParams(bodyData);
  if (splits.length > 0) qs.append('splits', JSON.stringify(splits));

  return { txRef, paymentUrl: `${QTB.BASE_URL}/collections/w/pay?${qs.toString()}`, amountKobo };
}

async function verifyTransaction(txRef) {
  const [storedTx] = await db('transactions').where({ tx_ref: txRef }).limit(1);
  if (!storedTx) throw new Error(`Transaction ${txRef} not found`);
  if (storedTx.status === 'SUCCESS') return { verified: true, transaction: storedTx };

  const token = await getPaymentToken();
  // Formula: SHA512(ProductID + txRef + HashKey)
  const verifyHash = crypto.createHash('sha512').update(`${QTB.PRODUCT_ID}${txRef}${QTB.HASH_KEY}`).digest('hex');

  const resp = await axios.get(QTB.VERIFY_URL, {
    params: { productid: QTB.PRODUCT_ID, transactionreference: txRef, amount: storedTx.amount_kobo },
    headers: { Authorization: `Bearer ${token}`, Hash: verifyHash },
    timeout: 15000
  });

  const verified = resp.data.ResponseCode === '00' && Number(resp.data.Amount) === storedTx.amount_kobo;
  const newStatus = verified ? 'SUCCESS' : 'FAILED';

  await db('transactions').where({ tx_ref: txRef }).update({
    status: newStatus, interswitch_tx_ref: resp.data.TransactionReference,
    isw_response_code: resp.data.ResponseCode, isw_raw_response: JSON.stringify(resp.data),
    updated_at: new Date()
  });

  return { verified, transaction: { ...storedTx, status: newStatus } };
}

/** HMAC-SHA512 Webhook Validation */
function validateWebhookSignature(signatureHeader, rawBody) {
  if (!signatureHeader || !rawBody) return false;

  const expected = crypto.createHmac('sha512', QTB.WEBHOOK_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ─── SECTION 3: KYC & OTP (MKT) ──────────────────────────────────────────────

async function verifyNIN(nin, userId) {
  const token = await getMarketplaceToken();
  try {
    const resp = await axios.post(MKT.NIN_URL, { id: nin }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000
    });
    const verified = resp.data.responseCode === '00' || resp.data.verified === true;
    if (verified && userId) {
      await db('users').where({ id: userId }).update({ nin, nin_verified: true, updated_at: new Date() });
    }
    return { verified, data: resp.data };
  } catch (err) { return { verified: false, message: 'NIN Service Error' }; }
}

async function verifyDriversLicense(licenseNumber, userId) {
  const token = await getMarketplaceToken();
  try {
    const resp = await axios.post(MKT.DL_URL, { id: licenseNumber }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000
    });
    const verified = resp.data.responseCode === '00' || resp.status === 200;
    if (verified && userId) {
      await db('users').where({ id: userId }).update({ license_verified: true });
    }
    return { verified, data: resp.data };
  } catch (err) { return { verified: false, message: 'License Service Error' }; }
}

/** Unified WhatsApp OTP: Generates, Sends, and Stores */
async function sendWhatsAppOTP(phoneNumber, userId) {
  const token = await getMarketplaceToken();
  const otpCode = String(Math.floor(100000 + crypto.randomInt(900000))).padStart(6, '0');

  try {
    await axios.post(MKT.WHATSAPP_OTP_URL, {
      phoneNumber, code: otpCode, action: 'verifying', service: 'NextStop', channel: 'phone'
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    await db('otp_store').insert({
      id: uuidv4(), user_id: userId, purpose: 'PHONE_VERIFY', code: otpCode,
      expires_at: new Date(Date.now() + 5 * 60000)
    });

    return { success: true };
  } catch (err) { throw new Error('WhatsApp delivery failed'); }
}

async function verifyBankAccount(accountNumber, bankCode) {
  const token = await getMarketplaceToken();
  const resp = await axios.post(MKT.BANK_RESOLVE_URL, { accountNumber, bankCode }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 20000
  });
  return { success: true, data: resp.data };
}

async function getBankList() {
  const token = await getMarketplaceToken();
  const resp = await axios.get(MKT.BANK_LIST_URL, { headers: { Authorization: `Bearer ${token}` } });
  return { success: true, data: resp.data };
}

// ─── SECTION 4: SETTLEMENTS ──────────────────────────────────────────────────

async function createSubAccount(driverData) {
  const token = await getPaymentToken();
  const resp = await axios.post(`${QTB.BASE_URL}/collections/api/v1/subaccounts`, {
    accountNumber: driverData.bankAccount, bankCode: driverData.bankCode,
    accountName: driverData.fullName, splitPercentage: 85.0
  }, { headers: { Authorization: `Bearer ${token}` } });
  return resp.data.subAccountCode;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  getPaymentToken, getMarketplaceToken,
  initiatePayment, verifyTransaction, validateWebhookSignature,
  verifyNIN, verifyDriversLicense, sendWhatsAppOTP,
  getBankList, verifyBankAccount, createSubAccount
};