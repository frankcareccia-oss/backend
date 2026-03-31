// src/utils/helpers.js

function parseIntParam(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function getClientIp(req) {
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function assertActiveMerchant(merchant) {
  if (!merchant) return { code: "MERCHANT_NOT_FOUND", message: "Merchant not found", http: 404 };
  if (merchant.status !== "active") {
    return { code: "MERCHANT_NOT_ACTIVE", message: `Merchant is ${merchant.status}`, http: 409 };
  }
  return null;
}

function assertActiveStore(store) {
  if (!store) return { code: "STORE_NOT_FOUND", message: "Store not found", http: 404 };
  if (store.status !== "active") {
    return { code: "STORE_NOT_ACTIVE", message: `Store is ${store.status}`, http: 409 };
  }
  return null;
}

function enforceStoreAndMerchantActive(storeWithMerchant) {
  const storeErr = assertActiveStore(storeWithMerchant);
  if (storeErr) return storeErr;
  const merchantErr = assertActiveMerchant(storeWithMerchant.merchant);
  if (merchantErr) return merchantErr;
  return null;
}

module.exports = {
  parseIntParam,
  getClientIp,
  assertActiveMerchant,
  assertActiveStore,
  enforceStoreAndMerchantActive,
};
