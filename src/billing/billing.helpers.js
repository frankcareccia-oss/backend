// backend/src/billing/billing.helpers.js

function buildBillingHelpers({ prisma, getGlobalBillingPolicy }) {
  function sanitizeInt(n) {
    return Number.isInteger(n) ? n : null;
  }

  function generatePvAccountNumber(merchantId) {
    const year = new Date().getFullYear();
    const padded = String(merchantId).padStart(5, "0");
    return `PV-${year}-${padded}`;
  }

  async function ensureBillingAccountForMerchant(merchantId) {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      include: {
        merchantUsers: {
          include: { user: true },
        },
      },
    });

    const derivedEmail =
      merchant?.merchantUsers?.find((mu) => mu.role === "owner" && mu.user?.email)?.user?.email ||
      merchant?.merchantUsers?.find((mu) => mu.role === "merchant_admin" && mu.user?.email)?.user?.email ||
      merchant?.merchantUsers?.find((mu) => mu.user?.email)?.user?.email ||
      `billing+merchant${merchantId}@example.com`;

    const pvAccountNumber = generatePvAccountNumber(merchantId);

    return prisma.billingAccount.upsert({
      where: { merchantId },
      update: {},
      create: {
        merchantId,
        billingEmail: derivedEmail,
        pvAccountNumber,
      },
    });
  }

  function pickOverrideInt(overrides, key) {
    if (!overrides || typeof overrides !== "object") return null;
    const v = overrides[key];
    return Number.isInteger(v) ? v : null;
  }

  async function getMerchantPolicyBundle(merchantId) {
    const global = getGlobalBillingPolicy();

    const acct = await prisma.billingAccount.findUnique({
      where: { merchantId },
      select: { id: true, merchantId: true, policyOverridesJson: true },
    });

    if (!acct) {
      return {
        error: {
          http: 404,
          code: "BILLING_ACCOUNT_NOT_FOUND",
          message: "BillingAccount not found",
        },
      };
    }

    const overrides = acct.policyOverridesJson || null;

    const effective = {
      ...global,
      graceDays: pickOverrideInt(overrides, "graceDays") ?? global.graceDays,
      lateFeeCents: pickOverrideInt(overrides, "lateFeeCents") ?? global.lateFeeCents,
      lateFeeNetDays: pickOverrideInt(overrides, "lateFeeNetDays") ?? global.lateFeeNetDays,
      guestPayTokenDays: pickOverrideInt(overrides, "guestPayTokenDays") ?? global.guestPayTokenDays,
      defaultNetTermsDays:
        pickOverrideInt(overrides, "defaultNetTermsDays") ?? global.defaultNetTermsDays,
    };

    if (!global.allowedNetTermsDays.includes(effective.defaultNetTermsDays)) {
      effective.defaultNetTermsDays = global.defaultNetTermsDays;
    }

    return {
      accountId: acct.id,
      merchantId: acct.merchantId,
      global,
      overrides,
      effective,
    };
  }

  function validateOverrides(body, global) {
    if (body == null || typeof body !== "object") {
      return { ok: false, msg: "Body must be an object" };
    }

    if (body.clear === true) {
      return { ok: true, overrides: null, clear: true };
    }

    const o = {};
    const keys = [
      "graceDays",
      "lateFeeCents",
      "lateFeeNetDays",
      "guestPayTokenDays",
      "defaultNetTermsDays",
    ];

    for (const k of keys) {
      if (body[k] === undefined || body[k] === null || body[k] === "") continue;

      const v = sanitizeInt(body[k]);
      if (v == null) return { ok: false, msg: `${k} must be an integer` };
      if (k === "graceDays" && v < 0) return { ok: false, msg: "graceDays must be >= 0" };
      if (k !== "graceDays" && v < 0) return { ok: false, msg: `${k} must be >= 0` };
      if (k === "lateFeeNetDays" && v < 1) {
        return { ok: false, msg: "lateFeeNetDays must be >= 1" };
      }
      if (k === "guestPayTokenDays" && v < 1) {
        return { ok: false, msg: "guestPayTokenDays must be >= 1" };
      }
      if (k === "defaultNetTermsDays" && !global.allowedNetTermsDays.includes(v)) {
        return {
          ok: false,
          msg: "defaultNetTermsDays must be one of allowedNetTermsDays (global)",
        };
      }
      o[k] = v;
    }

    return { ok: true, overrides: o };
  }

  function addDays(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }

  async function findExistingLateFeeInvoice(originalInvoiceId) {
    return prisma.invoice.findFirst({
      where: {
        relatedToInvoiceId: originalInvoiceId,
        lineItems: {
          some: {
            sourceType: "late_fee",
            sourceRefId: String(originalInvoiceId),
          },
        },
      },
      select: { id: true, status: true },
    });
  }

  function lateFeeEligibility(original, now, effectivePolicy) {
    if (!original) return { eligible: false, reason: "INVOICE_NOT_FOUND" };

    if (!(original.status === "issued" || original.status === "past_due")) {
      return { eligible: false, reason: "NOT_ISSUED_OR_PAST_DUE" };
    }

    if (!original.dueAt) {
      return { eligible: false, reason: "MISSING_DUE_AT" };
    }

    if (original.status === "paid" || original.status === "void") {
      return { eligible: false, reason: "INVOICE_NOT_ELIGIBLE_STATUS" };
    }

    if ((original.amountPaidCents || 0) >= (original.totalCents || 0)) {
      return { eligible: false, reason: "ALREADY_PAID" };
    }

    const graceMs = (effectivePolicy.graceDays || 0) * 24 * 60 * 60 * 1000;
    if (now.getTime() <= new Date(original.dueAt).getTime() + graceMs) {
      return { eligible: false, reason: "NOT_PAST_GRACE_PERIOD" };
    }

    return { eligible: true };
  }

  function isLateFeeInvoice(inv) {
    return (
      Boolean(inv?.relatedToInvoiceId) &&
      Array.isArray(inv?.lineItems) &&
      inv.lineItems.some((li) => li.sourceType === "late_fee")
    );
  }

  return {
    ensureBillingAccountForMerchant,
    getMerchantPolicyBundle,
    validateOverrides,
    addDays,
    findExistingLateFeeInvoice,
    lateFeeEligibility,
    isLateFeeInvoice,
  };
}

module.exports = { buildBillingHelpers };