// backend/src/merchant/merchant.authz.js

function isPosOnlyMerchantUser(user) {
  const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
  if (!mus.length) return false;

  const roles = mus.map((m) => m?.role).filter(Boolean);
  if (!roles.length) return false;

  return roles.every((r) => r === "merchant_employee");
}

function canManageUsersForMerchant(user, merchantId) {
  const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
  const m = mus.find((x) => x.status === "active" && x.merchantId === merchantId);
  if (!m) return false;
  return m.role === "owner" || m.role === "merchant_admin";
}

function canAccessInvoicesForMerchant(user, merchantId) {
  const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
  const m = mus.find((x) => x.status === "active" && x.merchantId === merchantId);
  if (!m) return false;
  return m.role === "owner" || m.role === "merchant_admin" || m.role === "ap_clerk";
}

function normalizeRole(role) {
  const r = String(role || "").trim();
  const allowed = ["owner", "merchant_admin", "ap_clerk", "merchant_employee", "store_admin", "store_subadmin"];
  return allowed.includes(r) ? r : null;
}

function normalizeMemberStatus(status) {
  const s = String(status || "").trim();
  const allowed = ["active", "suspended"];
  return allowed.includes(s) ? s : null;
}

function buildRequireMerchantUserManager({ prisma, sendError }) {
  return async function requireMerchantUserManager(req, res, merchantId) {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        systemRole: true,
        merchantUsers: {
          where: { status: "active" },
          select: { merchantId: true, role: true, status: true },
        },
      },
    });

    if (!user) {
      sendError(res, 404, "NOT_FOUND", "User not found");
      return null;
    }
    if (user.systemRole === "pv_admin") {
      sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");
      return null;
    }
    if (isPosOnlyMerchantUser(user)) {
      sendError(res, 403, "FORBIDDEN", "POS associates cannot manage users");
      return null;
    }
    if (!canManageUsersForMerchant(user, merchantId)) {
      sendError(res, 403, "FORBIDDEN", "Not authorized to manage users for this merchant");
      return null;
    }

    return user;
  };
}

module.exports = {
  isPosOnlyMerchantUser,
  canManageUsersForMerchant,
  canAccessInvoicesForMerchant,
  normalizeRole,
  normalizeMemberStatus,
  buildRequireMerchantUserManager,
};