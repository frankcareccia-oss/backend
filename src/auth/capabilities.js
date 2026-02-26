// backend/src/auth/capabilities.js
// Phase 0 Capability Engine (Role → Capability Mapping)

const ROLE_CAPABILITIES = {
  // PV Org roles
  pv_admin: ["org.team.view", "merchant.view", "invoice.view"],
  pv_ar_clerk: ["invoice.issue", "invoice.void", "invoice.regenerate_link"],

  // Merchant roles
  owner: [
    "merchant.user.view",
    "merchant.user.invite",
    "merchant.user.edit",
    "merchant.user.remove",
    "invoice.view",
    "invoice.pay",
  ],

  merchant_admin: [
    "merchant.user.view",
    "merchant.user.invite",
    "merchant.user.edit",
    "merchant.user.remove",
    "invoice.view",
  ],

  // AP clerk: can VIEW users + invoices, can PAY invoices, cannot manage users
  merchant_ap_clerk: ["merchant.user.view", "invoice.view", "invoice.pay"],

  store_admin: ["store.settings.edit", "store.staff.manage"],
  pos_employee: [],
};

function getMerchantRolesForScope(req, merchantId) {
  if (!req || !Array.isArray(req.memberships)) return [];
  return req.memberships
    .filter((m) => Number(m.merchantId) === Number(merchantId))
    .map((m) => m.role)
    .filter(Boolean);
}

function can(req, capability, scope = {}) {
  if (!req) return false;

  const { global, merchantId } = scope || {};

  // Global PV roles
  if (global && req.systemRole) {
    const caps = ROLE_CAPABILITIES[req.systemRole] || [];
    if (caps.includes(capability)) return true;
  }

  // Merchant-scoped roles
  if (merchantId != null) {
    const roles = getMerchantRolesForScope(req, merchantId);
    for (const role of roles) {
      const caps = ROLE_CAPABILITIES[role] || [];
      if (caps.includes(capability)) return true;
    }
  }

  return false;
}

module.exports = {
  can,
  ROLE_CAPABILITIES,
};
