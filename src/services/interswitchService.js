'use strict';

const crypto = require('crypto');
const axios  = require('axios');
const db     = require('../config/database');

const QTB = {
  CLIENT_ID: process.env.QTB_CLIENT_ID,
  CLIENT_SECRET: process.env.QTB_CLIENT_SECRET,
  PRODUCT_ID: process.env.QTB_PRODUCT_ID,
  HASH_KEY: process.env.QTB_HASH_KEY,
  WEBHOOK_SECRET: process.env.QTB_WEBHOOK_SECRET,
  BASE_URL: process.env.QTB_BASE_URL || 'https://sandbox.interswitchng.com'
};

const MKT = {
  CLIENT_ID: process.env.MKT_CLIENT_ID,
  CLIENT_SECRET: process.env.MKT_CLIENT_SECRET,
  PASSPORT_URL: process.env.MKT_PASSPORT_URL || 'https://qa.interswitchng.com',
  BANK_RESOLVE_URL: 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/verify/identity/account-number/resolve',
  BANK_LIST_URL: 'https://api-marketplace-routing.k8.isw.la/marketplace-routing/api/v1/verify/identity/account-number/bank-list'
};

async function _getToken(creds, url) {
  const auth = Buffer.from(`${creds.CLIENT_ID}:${creds.CLIENT_SECRET}`).toString('base64');
  const resp = await axios.post(`${url}/passport/oauth/token`, 'grant_type=client_credentials&scope=profile', {
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return resp.data.access_token;
}

/** Validates HMAC-SHA512 */
function validateWebhookSignature(signature, rawBody) {
  const expected = crypto.createHmac('sha512', QTB.WEBHOOK_SECRET).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

/** Verifies Bank Account */
async function verifyBankAccount(accountNumber, bankCode) {
  const token = await _getToken(MKT, MKT.PASSPORT_URL);
  const resp = await axios.post(MKT.BANK_RESOLVE_URL, { accountNumber, bankCode }, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return { success: true, data: resp.data };
}

/** Creates Sub-account */
async function createSubAccount(driver) {
  const token = await _getToken(QTB, 'https://sandbox.interswitchng.com');
  const resp = await axios.post(`${QTB.BASE_URL}/collections/api/v1/subaccounts`, {
    accountNumber: driver.bankAccount,
    bankCode: driver.bankCode,
    accountName: driver.fullName,
    splitPercentage: 85.0
  }, { headers: { 'Authorization': `Bearer ${token}` } });
  return resp.data.subAccountCode;
}

module.exports = { validateWebhookSignature, verifyBankAccount, createSubAccount, getBankList: async () => ({}) };