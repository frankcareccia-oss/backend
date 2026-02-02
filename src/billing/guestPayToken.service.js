// backend/src/billing/guestPayToken.service.js
// NEW FILE — Mail-Flow-2 prerequisite
// Behavior-preserving extraction of Guest Pay Token mint/ensure logic from payments.routes.js.
// NOTE: This helper emits NO pvHook events; callers keep existing hook emissions.
//
// Contract:
//   ensureActiveGuestPayToken({ prisma, invoiceId, publicBaseUrl, forceRotate=false }) ->
//     - idempotent return: { invoiceId, tokenId, payUrl, expiresAt, idempotent:true }
//     - mint return:      { invoiceId, tokenId, token, payUrl, expiresAt, idempotent:false, payUrlKind }
//     - rotate return:    mint return + { regenerated:true, revokedCount }
//
// Throws with err.status where relevant (400/404/409), otherwise throws.

const { mintRawToken, sha256Hex, computeGuestTokenExpiry, now } = require("../payments/guestToken");

function isActiveGuestPayToken(tok) {
  if (!tok) return false;
  if (tok.usedAt) return false;
  if (tok.expiresAt && tok.expiresAt.getTime() < Date.now()) return false;
  return true;
}

function amountDueCents(inv) {
  const due = (inv.totalCents || 0) - (inv.amountPaidCents || 0);
  return Math.max(0, due);
}

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/$/, "");
}

function buildShortPayUrlFromTokenId({ tokenId, publicBaseUrl }) {
  // Mirror payments.routes.js: prefer /p/:code if SHORTPAY_SECRET exists; otherwise return "".
  const crypto = require("crypto");
  const SHORTPAY_SECRET = String(process.env.SHORTPAY_SECRET || "").trim();
  if (!SHORTPAY_SECRET) return "";

  const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

  function base62Encode(num) {
    const n0 = Number(num);
    if (!Number.isFinite(n0) || n0 < 0) throw new Error("bad_num");
    if (n0 === 0) return "0";
    let n = Math.floor(n0);
    let out = "";
    while (n > 0) {
      out = BASE62[n % 62] + out;
      n = Math.floor(n / 62);
    }
    return out;
  }

  function hmacSig6(idPart, secret) {
    const h = crypto.createHmac("sha256", Buffer.from(String(secret || ""), "utf8"));
    h.update(Buffer.from(String(idPart || ""), "utf8"));
    const digest = h.digest();
    const u = (((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0) >>> 0;
    return base62Encode(u).slice(-6).padStart(6, "0");
  }

  const idNum = Number(tokenId);
  if (!Number.isInteger(idNum) || idNum <= 0) return "";
  const idPart = base62Encode(idNum);
  const sig = hmacSig6(idPart, SHORTPAY_SECRET);
  const code = `${idPart}${sig}`;
  return `${stripTrailingSlash(publicBaseUrl)}/p/${encodeURIComponent(code)}`;
}

async function ensureActiveGuestPayToken({ prisma, invoiceId, publicBaseUrl, forceRotate = false }) {
  if (!prisma) throw new Error("ensureActiveGuestPayToken: prisma required");

  const id = Number(invoiceId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error("Invalid invoiceId");
    err.status = 400;
    throw err;
  }

  const inv = await prisma.invoice.findUnique({
    where: { id },
    select: { id: true, status: true, dueAt: true, totalCents: true, amountPaidCents: true },
  });

  if (!inv) {
    const err = new Error("Invoice not found");
    err.status = 404;
    throw err;
  }

  // Only for payable, issued invoices (same as routes)
  if (!(inv.status === "issued" || inv.status === "past_due")) {
    const err = new Error("Token can be minted only for issued or past_due invoices");
    err.status = 409;
    throw err;
  }

  if (amountDueCents(inv) <= 0) {
    const err = new Error("Invoice is not payable");
    err.status = 409;
    throw err;
  }

  // Idempotent return if existing active token (unless rotate requested)
  if (!forceRotate) {
    const existing = await prisma.guestPayToken.findFirst({
      where: { invoiceId: inv.id, usedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, expiresAt: true, usedAt: true },
    });

    if (existing && isActiveGuestPayToken(existing)) {
      const payUrl = buildShortPayUrlFromTokenId({ tokenId: existing.id, publicBaseUrl }) || null;
      return {
        invoiceId: inv.id,
        tokenId: existing.id,
        payUrl,
        expiresAt: existing.expiresAt ? existing.expiresAt.toISOString() : null,
        idempotent: true,
      };
    }
  }

  // Rotate any unused tokens (safety) — routes do this for mint and regenerate.
  const revoked = await prisma.guestPayToken.updateMany({
    where: { invoiceId: inv.id, usedAt: null },
    data: { usedAt: now() },
  });

  const raw = mintRawToken(32);
  const tokenHash = sha256Hex(raw);
  const expiresAt = computeGuestTokenExpiry({ dueAt: inv.dueAt });

  const created = await prisma.guestPayToken.create({
    data: { invoiceId: inv.id, tokenHash, expiresAt },
    select: { id: true, expiresAt: true },
  });

  const shortUrl = buildShortPayUrlFromTokenId({ tokenId: created.id, publicBaseUrl });
  const legacyUrl = `${stripTrailingSlash(publicBaseUrl)}/pay/${encodeURIComponent(raw)}`;
  const payUrl = shortUrl || legacyUrl;

  const out = {
    invoiceId: inv.id,
    tokenId: created.id,
    token: raw, // legacy/dev convenience only
    payUrl,
    expiresAt: (created.expiresAt || expiresAt).toISOString(),
    idempotent: false,
    payUrlKind: shortUrl ? "shortpay" : "legacy",
  };

  if (forceRotate) {
    out.regenerated = true;
    out.revokedCount = revoked?.count || 0;
  }

  return out;
}

module.exports = {
  ensureActiveGuestPayToken,
};
