// src/billing/billing.service.js

function createBillingPolicyStore({ fs, path, baseDir }) {
  const BILLING_POLICY_FILE = path.join(baseDir, ".billing-policy.json");

  const DEFAULT_BILLING_POLICY = {
    graceDays: 5,
    lateFeeCents: 1500,
    lateFeeNetDays: 7,
    guestPayTokenDays: 7,
    allowedNetTermsDays: [15, 30, 45],
    defaultNetTermsDays: 30,
    updatedAt: new Date().toISOString(),
  };

  function sanitizeInt(n) {
    return Number.isInteger(n) ? n : null;
  }

  function isIsoString(s) {
    return typeof s === "string" && !Number.isNaN(new Date(s).getTime());
  }

  function validateBillingPolicy(body) {
    const graceDays = sanitizeInt(body.graceDays);
    const lateFeeCents = sanitizeInt(body.lateFeeCents);
    const lateFeeNetDays = sanitizeInt(body.lateFeeNetDays);
    const guestPayTokenDays = sanitizeInt(body.guestPayTokenDays);
    const allowedNetTermsDays = Array.isArray(body.allowedNetTermsDays)
      ? body.allowedNetTermsDays.map((x) => sanitizeInt(x)).filter((x) => x != null)
      : null;
    const defaultNetTermsDays = sanitizeInt(body.defaultNetTermsDays);

    if (graceDays == null || graceDays < 0) return { ok: false, msg: "graceDays must be an integer >= 0" };
    if (lateFeeCents == null || lateFeeCents < 0) return { ok: false, msg: "lateFeeCents must be an integer >= 0" };
    if (lateFeeNetDays == null || lateFeeNetDays < 1) return { ok: false, msg: "lateFeeNetDays must be an integer >= 1" };
    if (guestPayTokenDays == null || guestPayTokenDays < 1) return { ok: false, msg: "guestPayTokenDays must be an integer >= 1" };

    if (!allowedNetTermsDays || !allowedNetTermsDays.length) {
      return { ok: false, msg: "allowedNetTermsDays must be a non-empty array of integers" };
    }

    const uniq = Array.from(new Set(allowedNetTermsDays)).sort((a, b) => a - b);
    if (uniq.some((x) => x < 1)) return { ok: false, msg: "allowedNetTermsDays values must be >= 1" };

    if (defaultNetTermsDays == null) return { ok: false, msg: "defaultNetTermsDays must be an integer" };
    if (!uniq.includes(defaultNetTermsDays)) {
      return { ok: false, msg: "defaultNetTermsDays must be a member of allowedNetTermsDays" };
    }

    return {
      ok: true,
      policy: {
        graceDays,
        lateFeeCents,
        lateFeeNetDays,
        guestPayTokenDays,
        allowedNetTermsDays: uniq,
        defaultNetTermsDays,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  function normalizeLoadedBillingPolicy(raw) {
    if (!raw || typeof raw !== "object") return DEFAULT_BILLING_POLICY;

    const merged = {
      graceDays: raw.graceDays ?? DEFAULT_BILLING_POLICY.graceDays,
      lateFeeCents: raw.lateFeeCents ?? DEFAULT_BILLING_POLICY.lateFeeCents,
      lateFeeNetDays: raw.lateFeeNetDays ?? DEFAULT_BILLING_POLICY.lateFeeNetDays,
      guestPayTokenDays: raw.guestPayTokenDays ?? DEFAULT_BILLING_POLICY.guestPayTokenDays,
      allowedNetTermsDays: raw.allowedNetTermsDays ?? DEFAULT_BILLING_POLICY.allowedNetTermsDays,
      defaultNetTermsDays: raw.defaultNetTermsDays ?? DEFAULT_BILLING_POLICY.defaultNetTermsDays,
      updatedAt: isIsoString(raw.updatedAt) ? raw.updatedAt : DEFAULT_BILLING_POLICY.updatedAt,
    };

    const v = validateBillingPolicy(merged);
    if (!v.ok) {
      console.warn("?? Invalid billing policy on disk; using defaults:", v.msg);
      return DEFAULT_BILLING_POLICY;
    }

    return { ...v.policy, updatedAt: merged.updatedAt };
  }

  function loadBillingPolicyFromDisk() {
    try {
      if (!fs.existsSync(BILLING_POLICY_FILE)) return DEFAULT_BILLING_POLICY;
      const raw = fs.readFileSync(BILLING_POLICY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return normalizeLoadedBillingPolicy(parsed && typeof parsed === "object" ? parsed : null);
    } catch (e) {
      console.warn("?? Failed to load billing policy from disk:", e?.message || e);
      return DEFAULT_BILLING_POLICY;
    }
  }

  function saveBillingPolicyToDisk(policyObj) {
    try {
      fs.writeFileSync(BILLING_POLICY_FILE, JSON.stringify(policyObj, null, 2), "utf-8");
      return true;
    } catch (e) {
      console.warn("?? Failed to save billing policy to disk:", e?.message || e);
      return false;
    }
  }

  return {
    BILLING_POLICY_FILE,
    DEFAULT_BILLING_POLICY,
    validateBillingPolicy,
    loadBillingPolicyFromDisk,
    saveBillingPolicyToDisk,
  };
}

module.exports = { createBillingPolicyStore };
