'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * NextStop — Interswitch Integration Service  (v2 — docs-accurate)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ╔═════════════════════════════════════════════════════════════════════════════╗
 * ║  ⚠️  TWO SEPARATE CREDENTIAL SETS — NEVER MIX THEM                         ║
 * ╠═════════════════════════════════════════════════════════════════════════════╣
 * ║                                                                             ║
 * ║  SET A │ Quickteller Business (QTB)  — PAYMENTS ONLY                       ║
 * ║        │ Where: business.quickteller.com → Developer Tools → Integrations  ║
 * ║        │ Env:   QTB_CLIENT_ID, QTB_CLIENT_SECRET, QTB_PRODUCT_ID ...       ║
 * ║        │ Used:  initiatePayment, verifyTransaction, webhooks                ║
 * ║                                                                             ║
 * ║  SET B │ API Marketplace (MKT)  — KYC & OTP ONLY                           ║
 * ║        │ Where: developer.interswitchgroup.com → NextStop project           ║
 * ║        │        → Test API keys section                                     ║
 * ║        │ Env:   MKT_CLIENT_ID, MKT_CLIENT_SECRET                           ║
 * ║        │ Used:  NIN, Driver's Licence, BVN, Bank Verify, WhatsApp OTP      ║
 * ║                                                                             ║
 * ╚═════════════════════════════════════════════════════════════════════════════╝
 *
 * APIs visible in the Marketplace screenshot (Image 1):
 *  ✅ NIN API                       — implemented (verifyDriverNIN)
 *  ✅ Driver's License API          — implemented (verifyDriversLicense)
 *  ✅ WhatsApp OTP API              — implemented (sendWhatsAppOTP) — docs-accurate
 *  🔲 Bank Account Verification API — placeholder (verifyBankAccount)
 *  🔲 BVN Full Details API          — placeholder (verifyBVN)
 *  🔲 Generate Safetoken OTP API    — placeholder (generateSafetoken)
 *  🔲 Bank Accounts Lookup API      — placeholder (bankAccountsLookup)
 *
 * Webhook setup (Image 2):
 *  - Go to: business.quickteller.com → Developer Tools → Webhooks tab
 *  - Enter your public URL: https://api.nextstop.ng/webhooks/interswitch
 *  - Click "Save changes" — Quickteller Business then displays your signing secret
 *  - Copy that secret into QTB_WEBHOOK_SECRET in your .env file
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const crypto         = require('crypto');
const axios          = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger         = require('../config/logger');
const db             = require('../config/database');


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 0 — CREDENTIAL & URL CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SET A: Quickteller Business  (Payments, Transaction Verify, Webhooks)
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO GET THESE:
 *   1. Go to https://business.quickteller.com → log in
 *   2. In the LEFT SIDEBAR (Image 3), click "Developer Tools"
 *   3. Go to the "Integrations" sub-tab
 *   4. Copy: Client ID, Client Secret, Product ID, Pay Item ID
 *
 * HOW TO GET THE WEBHOOK SECRET:
 *   1. Same sidebar → Developer Tools → "Webhooks" sub-tab
 *   2. In the "Add a webhook endpoint" form (Image 2), type your server URL:
 *      https://api.nextstop.ng/webhooks/interswitch
 *   3. Click "Save changes"
 *   4. Quickteller Business will then REVEAL your webhook signing secret
 *   5. Copy it into QTB_WEBHOOK_SECRET in your .env
 *
 * OTHER SERVICES TO ENABLE (from Image 3 sidebar):
 *   - Settlements      → configure your NGN settlement bank account
 *   - Split-Settlements→ set up the driver/platform payout split rules
 *   - Transactions     → view and search payment records
 * ─────────────────────────────────────────────────────────────────────────────
 */
const QTB = {
  // TODO: Paste from: Quickteller Business → Developer Tools → Integrations → "Client ID"
  CLIENT_ID: process.env.QTB_CLIENT_ID || 'QTB_CLIENT_ID_PLACEHOLDER',

  // TODO: Paste from: Quickteller Business → Developer Tools → Integrations → "Client Secret"
  CLIENT_SECRET: process.env.QTB_CLIENT_SECRET || 'QTB_CLIENT_SECRET_PLACEHOLDER',

  // TODO: Paste from: Quickteller Business → Developer Tools → Integrations → "Product ID"
  PRODUCT_ID: process.env.QTB_PRODUCT_ID || 'QTB_PRODUCT_ID_PLACEHOLDER',

  // TODO: Paste from: Quickteller Business → Developer Tools → Integrations → "Pay Item ID"
  PAY_ITEM_ID: process.env.QTB_PAY_ITEM_ID || 'QTB_PAY_ITEM_ID_PLACEHOLDER',

  // TODO: Paste from: Quickteller Business → Developer Tools → Webhooks
  //       Enter your URL first, click Save, then copy the revealed secret here
  WEBHOOK_SECRET: process.env.QTB_WEBHOOK_SECRET || 'QTB_WEBHOOK_SECRET_PLACEHOLDER',

  // OAuth2 token endpoint for Quickteller Business
  // Sandbox:    https://sandbox.interswitchng.com
  // Production: https://passport.interswitchng.com
  PASSPORT_URL: process.env.QTB_PASSPORT_URL || 'https://sandbox.interswitchng.com',

  // Webpay redirect URL base
  // Sandbox:    https://sandbox.interswitchng.com
  // Production: https://api.interswitchng.com
  BASE_URL: process.env.QTB_BASE_URL || 'https://sandbox.interswitchng.com',

  // Transaction status verification
  // Sandbox:    https://sandbox.interswitchng.com/collections/api/v1/gettransaction.json
  // Production: https://api.interswitchng.com/collections/api/v1/gettransaction.json
  VERIFY_URL: process.env.QTB_VERIFY_URL
    || 'https://sandbox.interswitchng.com/collections/api/v1/gettransaction.json',
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SET B: API Marketplace  (KYC APIs + WhatsApp OTP + Safetoken OTP)
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO GET THESE:
 *   1. Go to https://developer.interswitchgroup.com → log in
 *   2. Create a project named "NextStop" (if not done)
 *   3. Inside NextStop project, subscribe to each API you need (Image 1):
 *        ✅ NIN API
 *        ✅ Driver's License Verification API
 *        ✅ WhatsApp OTP API
 *        🔲 Bank Account Verification API   (subscribe when ready)
 *        🔲 BVN Full Details API            (subscribe when ready)
 *        🔲 Generate Safetoken OTP API      (subscribe when ready)
 *        🔲 Bank Accounts Lookup API        (subscribe when ready)
 *   4. Go to "Test API keys" section inside the NextStop project
 *   5. Copy Client ID and Client Secret shown there
 *
 * TOKEN ENDPOINT (confirmed from Image 6 & 7):
 *   POST https://qa.interswitchng.com/passport/oauth/token
 *   Header: Authorization: Basic Base64(CLIENT_ID:SECRET_KEY)
 *   Header: Content-Type: application/x-www-form-urlencoded
 *   Body:   grant_type=client_credentials&scope=profile
 *
 * WhatsApp OTP base URL (confirmed from Image 4 & 5):
 *   https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/whatsapp/auth/send
 * ─────────────────────────────────────────────────────────────────────────────
 */
const MKT = {
  // TODO: Paste from: API Marketplace → NextStop Project → Test API keys → "Client ID"
  CLIENT_ID: process.env.MKT_CLIENT_ID || 'MKT_CLIENT_ID_PLACEHOLDER',

  // TODO: Paste from: API Marketplace → NextStop Project → Test API keys → "Client Secret"
  CLIENT_SECRET: process.env.MKT_CLIENT_SECRET || 'MKT_CLIENT_SECRET_PLACEHOLDER',

  // Confirmed from Image 6 & 7 — Marketplace uses qa.interswitchng.com for sandbox token
  // Sandbox:    https://qa.interswitchng.com
  // Production: https://passport.k8.isw.la
  PASSPORT_URL: process.env.MKT_PASSPORT_URL || 'https://qa.interswitchng.com',

  // ── KYC API URLs ───────────────────────────────────────────────────────────
  // TODO: Confirm exact sandbox URL from API Marketplace → NIN API → Endpoints tab
  NIN_URL: process.env.MKT_NIN_URL
    || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v2/customers/nin',

  // TODO: Confirm exact sandbox URL from API Marketplace → Driver's License API → Endpoints tab
  DL_URL: process.env.MKT_DL_URL
    || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v2/customers/dl',

  // Confirmed from Images 4 & 5 — exact URL visible in code snippet
  // POST /v1/whatsapp/auth/send
  WHATSAPP_OTP_URL: process.env.MKT_WHATSAPP_OTP_URL
    || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/whatsapp/auth/send',

  // TODO: Confirm URL from API Marketplace → Bank Account Verification API → Endpoints tab
  BANK_VERIFY_URL: process.env.MKT_BANK_VERIFY_URL
    || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v2/bank/account/verify',

  // TODO: Confirm URL from API Marketplace → BVN Full Details API → Endpoints tab
  BVN_URL: process.env.MKT_BVN_URL
    || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v2/customers/bvn',

  // TODO: Confirm URL from API Marketplace → Generate Safetoken OTP API → Endpoints tab
  SAFETOKEN_URL: process.env.MKT_SAFETOKEN_URL
    || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/safetoken/generate',

  // TODO: Confirm URL from API Marketplace → Bank Accounts Lookup API → Endpoints tab
  BANK_LOOKUP_URL: process.env.MKT_BANK_LOOKUP_URL
    || 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v2/bank/accounts/lookup',
};


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — DUAL TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Two isolated in-memory token caches.
 * Each credential set gets its own cache — tokens are NEVER shared.
 *
 * Production upgrade: Move both caches to Redis:
 *   SET nextstop:token:qtb  {token, expiresAt}  EX 3600
 *   SET nextstop:token:mkt  {token, expiresAt}  EX 3600
 * This allows all Node.js instances / pods to share tokens without
 * hammering the ISW Passport endpoint on every cold start.
 */
const _tokenCache = {
  qtb: { token: null, expiresAt: 0 },
  mkt: { token: null, expiresAt: 0 },
};

/**
 * Internal token factory.
 *
 * Auth mechanism confirmed from Images 6 & 7:
 *  POST {PASSPORT_URL}/passport/oauth/token
 *  Header: Authorization: Basic Base64(CLIENT_ID:SECRET_KEY)
 *  Header: Content-Type: application/x-www-form-urlencoded
 *  Body:   grant_type=client_credentials&scope=profile
 *
 * @param {'qtb'|'mkt'} set - Which credential set to authenticate
 * @returns {Promise<string>} Bearer token
 */
async function _fetchToken(set) {
  const now   = Date.now();
  const cache = _tokenCache[set];

  // Return cached token with a 60-second expiry buffer
  if (cache.token && now < cache.expiresAt - 60_000) {
    return cache.token;
  }

  const creds = set === 'qtb' ? QTB : MKT;

  // Basic Auth: base64(CLIENT_ID:SECRET_KEY) — confirmed from Image 7
  const basicAuth = Buffer
    .from(`${creds.CLIENT_ID}:${creds.CLIENT_SECRET}`)
    .toString('base64');

  logger.info(`[ISW-Token] Refreshing token for credential set [${set}]`);

  try {
    const resp = await axios.post(
      `${creds.PASSPORT_URL}/passport/oauth/token`,
      // scope=profile and grant_type=client_credentials confirmed from Image 6
      'grant_type=client_credentials&scope=profile',
      {
        headers: {
          Authorization:  `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10_000,
      }
    );

    const { access_token, expires_in } = resp.data;
    _tokenCache[set] = { token: access_token, expiresAt: now + expires_in * 1_000 };

    logger.info(`[ISW-Token] Token cached for [${set}]`, { expiresIn: expires_in });
    return access_token;

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error_description || err.message;
    if (status === 401) {
      logger.error(`[ISW-Token] 401 for [${set}] — wrong CLIENT_ID or CLIENT_SECRET in .env`);
    }
    throw new Error(`ISW token failed for [${set}]: ${detail}`);
  }
}

/** Bearer token for payment operations — uses QTB credentials */
async function getPaymentToken()     { return _fetchToken('qtb'); }

/** Bearer token for KYC & OTP operations — uses MKT credentials */
async function getMarketplaceToken() { return _fetchToken('mkt'); }


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — PAYMENT OPERATIONS  (QTB credentials)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds an Interswitch Webpay redirect URL and saves a PENDING transaction.
 *
 * @param {Object} p
 * @param {string} p.rideId
 * @param {string} p.payerId
 * @param {string} p.payerType      'INITIATOR' | 'JOINER'
 * @param {number} p.amountNaira
 * @param {string} p.customerEmail
 * @param {string} p.customerName
 * @returns {Promise<{txRef:string, paymentUrl:string}>}
 */
async function initiatePayment({ rideId, payerId, payerType, amountNaira, customerEmail, customerName }) {
  const txRef      = `NSP-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
  const amountKobo = Math.round(amountNaira * 100);

  // SHA512 hash: ProductID + PayItemID + txRef + kobo + redirectURL + ClientSecret
  // Uses QTB.CLIENT_SECRET — NOT MKT.CLIENT_SECRET
  const hash = crypto.createHash('sha512')
    .update([QTB.PRODUCT_ID, QTB.PAY_ITEM_ID, txRef, amountKobo, process.env.PAYMENT_REDIRECT_URL, QTB.CLIENT_SECRET].join(''))
    .digest('hex');

  // Persist PENDING row BEFORE redirecting — enables reconciliation on app crashes
  await db('transactions').insert({
    id: uuidv4(), ride_id: rideId, payer_id: payerId,
    payer_type: payerType, tx_ref: txRef,
    amount_kobo: amountKobo, amount_naira: amountNaira, status: 'PENDING',
  });

  const qs = new URLSearchParams({
    productid: QTB.PRODUCT_ID, pay_item_id: QTB.PAY_ITEM_ID,
    transactionreference: txRef, amount: amountKobo,
    site_redirect_url: process.env.PAYMENT_REDIRECT_URL,
    currency: '566', txn_ref: txRef, hash,
    cust_id: payerId, cust_name: customerName, cust_email: customerEmail,
  });

  const paymentUrl = `${QTB.BASE_URL}/collections/w/pay?${qs.toString()}`;
  logger.info('[ISW-Payment] Initiated', { txRef, rideId, amountNaira });
  return { txRef, paymentUrl };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CRITICAL: Server-to-Server Transaction Verification
 * ─────────────────────────────────────────────────────────────────────────────
 * ISW explicitly warns: never rely on client-side redirect alone.
 * This performs TWO server-side checks before marking any ride as paid:
 *   ✅ Check 1 — ResponseCode === "00"  (ISW approved)
 *   ✅ Check 2 — Amount matches kobo-for-kobo (anti-fraud)
 *
 * Uses QTB credentials — NOT Marketplace credentials.
 *
 * @param {string} txRef
 * @returns {Promise<{verified:boolean, transaction:Object, iswData:Object|null}>}
 */
async function verifyTransaction(txRef) {
  const [storedTx] = await db('transactions').where({ tx_ref: txRef }).limit(1);
  if (!storedTx) throw new Error(`No DB record for txRef: ${txRef}`);

  // Idempotency — skip ISW call if already verified
  if (storedTx.status === 'SUCCESS') {
    logger.warn('[ISW-Verify] Already SUCCESS, skipping re-verify', { txRef });
    return { verified: true, transaction: storedTx, iswData: null };
  }

  // ⚠️  MUST use getPaymentToken() — NOT getMarketplaceToken()
  const token = await getPaymentToken();

  // Verification hash formula: SHA512(ProductID + txRef + ClientSecret)
  // Different formula from payment initiation hash
  const verifyHash = crypto.createHash('sha512')
    .update(`${QTB.PRODUCT_ID}${txRef}${QTB.CLIENT_SECRET}`)
    .digest('hex');

  let iswData;
  try {
    const resp = await axios.get(QTB.VERIFY_URL, {
      params: { productid: QTB.PRODUCT_ID, transactionreference: txRef, amount: storedTx.amount_kobo },
      headers: { Authorization: `Bearer ${token}`, Hash: verifyHash },
      timeout: 15_000,
    });
    iswData = resp.data;
  } catch (err) {
    logger.error('[ISW-Verify] HTTP call failed', { txRef, error: err.message });
    throw new Error('ISW verification request failed — tx left as PENDING');
  }

  const isApproved    = iswData.ResponseCode === '00';
  const iswKobo       = Number(iswData.Amount);
  const amountMatches = iswKobo === storedTx.amount_kobo;

  if (isApproved && !amountMatches) {
    logger.error('[ISW-Verify] ⚠️ AMOUNT MISMATCH — possible fraud', {
      txRef, expected: storedTx.amount_kobo, received: iswKobo,
    });
  }

  const verified  = isApproved && amountMatches;
  const newStatus = verified ? 'SUCCESS' : 'FAILED';

  await db('transactions').where({ tx_ref: txRef }).update({
    status: newStatus,
    interswitch_tx_ref: iswData.TransactionReference || null,
    isw_response_code:  iswData.ResponseCode,
    isw_response_desc:  iswData.ResponseDescription,
    isw_raw_response:   JSON.stringify(iswData),   // full audit trail — never discard
    payment_method:     iswData.PaymentMethodType || null,
    updated_at:         new Date(),
  });

  if (verified) {
    await db('rides').where({ id: storedTx.ride_id })
      .update({ status: 'ACCEPTED', updated_at: new Date() });
    logger.info('[ISW-Verify] ✅ Verified — ride → ACCEPTED', { txRef, rideId: storedTx.ride_id });
  } else {
    logger.warn('[ISW-Verify] ❌ Failed', { txRef, code: iswData.ResponseCode });
  }

  return { verified, transaction: { ...storedTx, status: newStatus }, iswData };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — WEBHOOK SIGNATURE VALIDATION  (QTB webhook secret)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates the HMAC-SHA512 signature on incoming Interswitch webhooks.
 *
 * HOW THE WEBHOOK SECRET IS OBTAINED (Image 2):
 *   1. Go to business.quickteller.com → Developer Tools → Webhooks tab
 *   2. Enter your server URL: https://api.nextstop.ng/webhooks/interswitch
 *   3. Click "Save changes"
 *   4. ISW displays your HMAC signing secret — copy into QTB_WEBHOOK_SECRET
 *
 * ⚠️  This MUST receive the RAW Buffer body — not JSON-parsed.
 *     See webhooks.js for the express.raw() middleware setup.
 *
 * @param {Buffer|string} rawBody
 * @param {string}        signatureHeader  value of 'x-interswitch-signature'
 * @returns {boolean}
 */
function validateWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) {
    logger.warn('[ISW-Webhook] Missing x-interswitch-signature header');
    return false;
  }

  const expected = crypto
    .createHmac('sha512', QTB.WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    const rcvBuf = Buffer.from(signatureHeader, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    // timingSafeEqual prevents timing side-channel attacks
    if (rcvBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(rcvBuf, expBuf);
  } catch {
    logger.warn('[ISW-Webhook] Non-hex characters in signature header');
    return false;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — KYC & OTP OPERATIONS  (MKT credentials only)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 4a. NIN Verification ─────────────────────────────────────────────────────
/**
 * Verifies a driver's National Identification Number via ISW Marketplace NIN API.
 *
 * ⚠️  MUST use getMarketplaceToken() — QTB token will return "access denied".
 *
 * On success: sets users.nin_verified = TRUE in MySQL.
 *
 * @param {string} nin    11-digit NIN string
 * @param {string} userId users.id UUID
 * @returns {Promise<{verified:boolean, reason?:string, kycData:Object|null}>}
 */
async function verifyDriverNIN(nin, userId) {
  // ⚠️  Marketplace token — NOT payment token
  const token = await getMarketplaceToken();

  let kycData;
  try {
    const resp = await axios.get(MKT.NIN_URL, {
      params: { nin },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20_000,
    });
    kycData = resp.data;
  } catch (err) {
    const s = err.response?.status;
    if (s === 404) return { verified: false, reason: 'NIN_NOT_FOUND', kycData: null };
    if (s === 401 || s === 403) {
      logger.error('[ISW-NIN] Auth error — confirm MKT_CLIENT_ID/SECRET, not QTB creds', { userId });
    }
    logger.error('[ISW-NIN] Request failed', { userId, error: err.message });
    throw new Error('NIN verification service unavailable');
  }

  const verified = kycData?.responseCode === '00';
  if (verified) {
    await db.transaction(async trx => {
      await trx('users').where({ id: userId })
        .update({ nin, nin_verified: true, updated_at: new Date() });
      // TODO: Persist kycData.firstName, kycData.lastName, kycData.dateOfBirth
      //       into a driver_kyc_details table for compliance records
    });
    logger.info('[ISW-NIN] ✅ NIN verified', { userId });
  }
  return { verified, kycData };
}

// ─── 4b. Driver's Licence Verification ────────────────────────────────────────
/**
 * Verifies a driver's licence via ISW Marketplace Driver's License API.
 * Checks FRSC (Federal Road Safety Corps) database.
 *
 * ⚠️  MUST use getMarketplaceToken() — NOT QTB token.
 *
 * @param {string} licenseNumber  e.g. "ABC123456789"
 * @param {string} userId
 * @returns {Promise<{verified:boolean, reason?:string, licenseData:Object|null}>}
 */
async function verifyDriversLicense(licenseNumber, userId) {
  // ⚠️  Marketplace token — NOT payment token
  const token = await getMarketplaceToken();

  let licenseData;
  try {
    const resp = await axios.get(MKT.DL_URL, {
      params: { licenseNumber },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20_000,
    });
    licenseData = resp.data;
  } catch (err) {
    if (err.response?.status === 404) {
      return { verified: false, reason: 'LICENSE_NOT_FOUND', licenseData: null };
    }
    logger.error("[ISW-DL] Request failed", { userId, error: err.message });
    throw new Error("Driver's licence verification unavailable");
  }

  const verified = licenseData?.responseCode === '00';
  if (verified) {
    // TODO: Store licenseData.expiryDate, licenseData.licenceClass, licenseData.state
    //       in a driver_documents table for compliance and annual renewal reminders
    logger.info("[ISW-DL] ✅ Driver's licence verified", { userId });
  }
  return { verified, licenseData };
}

// ─── 4c. WhatsApp OTP ─────────────────────────────────────────────────────────
/**
 * Sends a WhatsApp OTP to a driver's phone number.
 *
 * ENDPOINT confirmed from Images 4 & 5:
 *   POST https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/whatsapp/auth/send
 *
 * REQUEST BODY (confirmed from Image 4):
 *   {
 *     "phoneNumber": "+234706XXXXXXX",   ← E.164 format
 *     "code":        "919456",           ← The OTP you generate server-side
 *     "action":      "verifying",        ← "verifying" | "validating"
 *     "service":     "NextStop",         ← Your app/service name
 *     "channel":     "phone"             ← always "phone" for WhatsApp
 *   }
 *
 * KEY INSIGHT from Image 4:
 *   YOU generate the OTP code on your backend and pass it IN the request body.
 *   ISW does NOT generate the OTP — it just DELIVERS it to the user's WhatsApp.
 *   This means you must:
 *     1. Generate a random 6-digit code server-side
 *     2. Store it in otp_store with an expiry
 *     3. Pass it to ISW which sends it via WhatsApp
 *     4. When user submits code, validate against otp_store — no second ISW call needed
 *
 * ⚠️  MUST use getMarketplaceToken() — NOT QTB token.
 *
 * @param {string} phoneNumber  E.164 format: +2348012345678
 * @param {string} userId
 * @returns {Promise<{sent:boolean}>}
 */
async function sendWhatsAppOTP(phoneNumber, userId) {
  // ⚠️  Marketplace token — NOT payment token
  const token = await getMarketplaceToken();

  // Generate a cryptographically random 6-digit OTP on our side
  // ISW delivers this code to the user's WhatsApp — we own the OTP
  const otpCode = String(Math.floor(100000 + crypto.randomInt(900000))).padStart(6, '0');

  try {
    const resp = await axios.post(
      MKT.WHATSAPP_OTP_URL,
      {
        phoneNumber,            // E.164 format confirmed from Image 4
        code:    otpCode,       // WE supply the code — ISW just delivers it
        action:  'verifying',   // "verifying" | "validating" — confirmed from Image 4
        service: 'NextStop',    // Your app name — confirmed from Image 4 (was "SportyBet")
        channel: 'phone',       // always "phone" — confirmed from Image 4
      },
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',  // confirmed from Image 5
        },
        timeout: 15_000,
      }
    );

    const sent = resp.data?.responseCode === '00' || resp.status === 200;

    if (sent) {
      // Store the OTP we generated — this is what we validate against later
      // The user types what they see on WhatsApp; we compare to what we stored here
      await db('otp_store').insert({
        id:         uuidv4(),
        user_id:    userId,
        purpose:    'PHONE_VERIFY',
        code:       otpCode,                              // store the actual OTP code
        expires_at: new Date(Date.now() + 5 * 60_000),   // 5 min — per ISW docs (Image 4)
      });
      logger.info('[ISW-OTP] ✅ WhatsApp OTP sent', { userId, phoneNumber });
    }

    return { sent };

  } catch (err) {
    logger.error('[ISW-OTP] WhatsApp send failed', { userId, error: err.message });
    throw new Error('WhatsApp OTP service unavailable — please try again');
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — MARKETPLACE PLACEHOLDERS (subscribe in your ISW project first)
// ═══════════════════════════════════════════════════════════════════════════════
// The APIs below are visible in the Marketplace screenshot (Image 1).
// To activate each one:
//   1. Go to developer.interswitchgroup.com → NextStop Project
//   2. Find the API in the catalogue and click "Subscribe"
//   3. Replace the TODO body with the actual request structure from
//      the API's "Endpoints" tab in the Marketplace (same as Images 4-7)
//   4. Update the URL constant in MKT config above if the path differs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bank Account Verification API — Image 1 (top-left, row 2)
 * Use case: Verify driver's payout bank account before first settlement
 *
 * TODO:
 *   1. Subscribe to "Bank Account Verification API" in your NextStop Marketplace project
 *   2. Open the API → Endpoints tab → read exact request body fields
 *   3. Replace the request body below with the real fields
 *   4. Confirm MKT_BANK_VERIFY_URL is correct from the Endpoints tab
 *
 * @param {string} accountNumber  e.g. "0123456789"
 * @param {string} bankCode       e.g. "044" (Access Bank)
 * @param {string} userId
 */
async function verifyBankAccount(accountNumber, bankCode, userId) {
  // ⚠️  Marketplace token — NOT payment token
  const token = await getMarketplaceToken();

  // TODO: Replace this request body with the real fields from the Marketplace
  //       Endpoints tab for "Bank Account Verification API"
  const resp = await axios.post(
    MKT.BANK_VERIFY_URL,
    {
      accountNumber,  // TODO: confirm field name in API docs
      bankCode,       // TODO: confirm field name in API docs
      // TODO: add any other required fields shown in the Endpoints tab
    },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20_000,
    }
  );

  // TODO: Map actual response fields — check "Success Response" tab in Marketplace
  const verified = resp.data?.responseCode === '00';
  return {
    verified,
    accountName: resp.data?.accountName || null,  // TODO: confirm field name
    rawData: resp.data,
  };
}

/**
 * BVN Full Details API — Image 1 (top-right, row 2)
 * Use case: Premium KYC — verify BVN and get full profile for high-value drivers
 *
 * TODO:
 *   1. Subscribe to "BVN Full Details API" in your NextStop Marketplace project
 *   2. Open the API → Endpoints tab → read exact request body and URL
 *   3. Replace the stub below with real implementation
 *   4. Update MKT_BVN_URL if the path in docs differs from the placeholder
 *
 * @param {string} bvn     11-digit BVN
 * @param {string} userId
 */
async function verifyBVN(bvn, userId) {
  // ⚠️  Marketplace token — NOT payment token
  const token = await getMarketplaceToken();

  // TODO: Replace with actual request structure from BVN Full Details API docs
  const resp = await axios.get(MKT.BVN_URL, {
    params: { bvn },           // TODO: confirm param name from Endpoints tab
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 20_000,
  });

  // TODO: Map actual response fields from "Success Response" tab
  const verified = resp.data?.responseCode === '00';
  if (verified) {
    // TODO: Store BVN-returned fields (firstName, lastName, dateOfBirth, phone)
    //       in driver_kyc_details table for compliance records
    logger.info('[ISW-BVN] ✅ BVN verified', { userId });
  }
  return { verified, bvnData: resp.data };
}

/**
 * Generate Safetoken OTP API — Image 1 (bottom-left, row 3)
 * Use case: Two-factor authentication for high-value ride payments or driver login
 *
 * NOTE: Unlike the WhatsApp OTP above, Safetoken OTPs are generated BY ISW.
 *       You request a token generation; ISW sends via its own channel.
 *
 * TODO:
 *   1. Subscribe to "Generate Safetoken OTP API" in your NextStop Marketplace project
 *   2. Open the API → Endpoints tab → check whether it's GET or POST and body fields
 *   3. Replace the stub below with real implementation
 *   4. Update MKT_SAFETOKEN_URL if the path in docs differs
 *
 * @param {string} userId
 * @param {string} phoneNumber
 */
async function generateSafetoken(userId, phoneNumber) {
  // ⚠️  Marketplace token — NOT payment token
  const token = await getMarketplaceToken();

  // TODO: Replace with actual request body from Safetoken OTP API Endpoints tab
  //       Check if the API is GET or POST (WhatsApp OTP was POST — this may differ)
  const resp = await axios.post(
    MKT.SAFETOKEN_URL,
    {
      phoneNumber,     // TODO: confirm field name
      // TODO: add any other required fields (e.g. userId, transactionRef)
    },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15_000,
    }
  );

  // TODO: Map actual response — check "Success Response" tab in Marketplace
  return { sent: resp.data?.responseCode === '00', rawData: resp.data };
}

/**
 * Bank Accounts Lookup API — Image 1 (bottom-right, row 3)
 * Use case: Given a driver's BVN, retrieve ALL linked bank accounts for
 *           payout account selection in the driver onboarding flow
 *
 * TODO:
 *   1. Subscribe to "Bank Accounts Lookup API" in your NextStop Marketplace project
 *   2. Open the API → Endpoints tab → confirm request structure
 *   3. Replace the stub below
 *   4. Update MKT_BANK_LOOKUP_URL if the path in docs differs
 *
 * @param {string} bvn
 * @param {string} userId
 */
async function bankAccountsLookup(bvn, userId) {
  // ⚠️  Marketplace token — NOT payment token
  const token = await getMarketplaceToken();

  // TODO: Replace with actual request params/body from Bank Accounts Lookup API docs
  const resp = await axios.get(MKT.BANK_LOOKUP_URL, {
    params: { bvn },           // TODO: confirm param name
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 20_000,
  });

  // TODO: Map actual response shape — likely an array of {bankName, accountNumber, accountName}
  return {
    accounts: resp.data?.accounts || [],   // TODO: confirm field name from Success Response tab
    rawData:  resp.data,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Token helpers (exported for tests / debugging)
  getPaymentToken,            // QTB creds → before any payment call
  getMarketplaceToken,        // MKT creds → before any KYC/OTP call

  // ── SET A: Payment operations (QTB) ────────────────────────────────────────
  initiatePayment,            // builds Webpay URL + saves PENDING tx
  verifyTransaction,          // server-to-server ISW check — ALWAYS call after payment
  validateWebhookSignature,   // HMAC-SHA512 check on incoming ISW webhook POSTs

  // ── SET B: KYC — fully implemented (MKT) ───────────────────────────────────
  verifyDriverNIN,            // NIN Verification API
  verifyDriversLicense,       // Driver's License Verification API

  // ── SET B: OTP — fully implemented (MKT) ───────────────────────────────────
  sendWhatsAppOTP,            // WhatsApp OTP API (you generate code; ISW delivers)

  // ── SET B: Placeholders — subscribe in ISW project first (MKT) ─────────────
  verifyBankAccount,          // Bank Account Verification API  → see TODO inside
  verifyBVN,                  // BVN Full Details API           → see TODO inside
  generateSafetoken,          // Generate Safetoken OTP API     → see TODO inside
  bankAccountsLookup,         // Bank Accounts Lookup API       → see TODO inside
};
