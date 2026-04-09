// backend/src/payments/shortpay.routes.js
const crypto = require("crypto");

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function base62Encode(num) {
  if (!Number.isSafeInteger(num) || num < 0) throw new Error("base62Encode: bad num");
  if (num === 0) return "0";

  let n = num;
  let out = "";
  while (n > 0) {
    out = BASE62[n % 62] + out;
    n = Math.floor(n / 62);
  }
  return out;
}

function base62Decode(str) {
  if (!str || typeof str !== "string") throw new Error("base62Decode: bad str");

  let n = 0;
  for (const ch of str) {
    const i = BASE62.indexOf(ch);
    if (i === -1) throw new Error("base62Decode: invalid char");
    n = n * 62 + i;
  }
  return n;
}

function buildShortPayRouter(deps) {
  const {
    express,
    prisma,
    sendError,
    emitPvHook,
    paymentsReg,
    jwtSecret,
  } = deps;

  if (!express) throw new Error("buildShortPayRouter: express is required");
  if (!prisma) throw new Error("buildShortPayRouter: prisma is required");
  if (!sendError) throw new Error("buildShortPayRouter: sendError is required");
  if (!paymentsReg) throw new Error("buildShortPayRouter: paymentsReg is required");

  const router = express.Router();

  function shortpaySecret() {
    return process.env.SHORTPAY_SECRET || jwtSecret || "dev-secret-change-me";
  }

  function shortpaySign(idBase62) {
    const h = crypto.createHmac("sha256", shortpaySecret()).update(idBase62).digest();
    const n = h.readUInt32BE(0);
    return base62Encode(n).slice(-6).padStart(6, "0");
  }

  function shortpayDecode(codeRaw) {
    const code = String(codeRaw || "").trim();
    if (code.length < 7 || code.length > 24) throw new Error("bad_code_length");

    const sig = code.slice(-6);
    const idPart = code.slice(0, -6);
    if (!idPart) throw new Error("bad_code_format");

    const expected = shortpaySign(idPart);
    if (sig !== expected) throw new Error("bad_code_sig");

    const tokenId = base62Decode(idPart);
    if (!Number.isSafeInteger(tokenId) || tokenId <= 0) throw new Error("bad_code_id");

    return tokenId;
  }

  async function loadGuestPayTokenByIdOrRespond(res, tokenId) {
    const token = await prisma.guestPayToken.findUnique({
      where: { id: tokenId },
      include: {
        invoice: {
          include: {
            merchant: true,
            payments: true,
            lineItems: true,
          },
        },
      },
    });

    if (!token) {
      sendError(res, 404, "NOT_FOUND", "Pay link not found.");
      return null;
    }

    if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
      sendError(res, 410, "EXPIRED", "This pay link has expired.", { expiresAt: token.expiresAt });
      return null;
    }

    return token;
  }

  function isInvoicePaid(inv) {
    const s = String(inv?.status || "").toLowerCase();
    if (s === "paid") return true;

    if (Array.isArray(inv?.payments)) {
      return inv.payments.some((p) => String(p?.status || "").toLowerCase() === "succeeded");
    }

    return false;
  }

  function buildShortPaySummary(token) {
    const inv = token.invoice;

    const amountCents =
      Number.isInteger(inv?.totalCents)
        ? inv.totalCents
        : Number.isInteger(inv?.amountCents)
          ? inv.amountCents
          : null;

    const amountPaidCents = Number.isInteger(inv?.amountPaidCents) ? inv.amountPaidCents : 0;

    return {
      token: {
        id: token.id,
        expiresAt: token.expiresAt || null,
        consumedAt: token.consumedAt || null,
      },
      invoice: {
        id: inv.id,
        status: inv.status || null,
        currency: inv.currency || "usd",
        totalCents: amountCents,
        amountPaidCents,
        merchantName: inv?.merchant?.name || null,
        paid: isInvoicePaid(inv),
        issuedAt: inv.issuedAt || null,
        dueAt: inv.dueAt || null,
        lineItems: Array.isArray(inv?.lineItems)
          ? inv.lineItems.map((li) => ({
              id: li.id,
              description: li.description || li.name || null,
              amountCents: li.amountCents ?? null,
              quantity: li.quantity ?? null,
            }))
          : [],
      },
    };
  }

  function pickIntentCreator() {
    const candidates = [
      paymentsReg?.createGuestPayIntent,
      paymentsReg?.guestPayCreateIntent,
      paymentsReg?.createPayIntent,
      paymentsReg?.publicCreateIntent,
      paymentsReg?.handlers?.createGuestPayIntent,
      paymentsReg?.handlers?.guestPayCreateIntent,
    ];

    return candidates.find((fn) => typeof fn === "function") || null;
  }

  router.get("/p/:code", async (req, res) => {
    // Public route — reject if caller sends an auth header
    const authHeader = req.headers.authorization || "";
    if (authHeader) {
      emitPvHook?.("billing.public_route.auth_rejected", {
        tc: "TC-BE-PUB-01",
        sev: "warn",
        stable: `shortpay:${req.params.code}`,
        code: req.params.code,
        reason: "auth_header_present",
      });
      return sendError(res, 400, "PUBLIC_ROUTE_AUTH_PRESENT", "Public pay links must not include authentication.");
    }

    emitPvHook?.("shortpay.loaded", { code: req.params.code });

    let tokenId;
    try {
      tokenId = shortpayDecode(req.params.code);
    } catch {
      return sendError(res, 404, "NOT_FOUND", "Pay link not found.");
    }

    try {
      const token = await loadGuestPayTokenByIdOrRespond(res, tokenId);
      if (!token) return;

      emitPvHook?.("billing.public_route.ok", {
        tc: "TC-S-PUB-01",
        sev: "info",
        stable: `shortpay:${req.params.code}`,
        code: req.params.code,
        invoiceId: token.invoiceId,
      });

      return res.json(buildShortPaySummary(token));
    } catch (e) {
      console.error("GET /p/:code failed:", e);
      return sendError(res, 500, "SERVER_ERROR", "Unable to load pay link.");
    }
  });

  router.post("/p/:code/intent", async (req, res) => {
    let tokenId;
    try {
      tokenId = shortpayDecode(req.params.code);
    } catch {
      return sendError(res, 404, "NOT_FOUND", "Pay link not found.");
    }

    try {
      const token = await loadGuestPayTokenByIdOrRespond(res, tokenId);
      if (!token) return;

      const summary = buildShortPaySummary(token);

      if (isInvoicePaid(token.invoice)) {
        emitPvHook?.("shortpay.intent_exists", { invoiceId: token.invoice.id, reason: "already_paid" });
        return sendError(res, 409, "ALREADY_PAID", "Invoice is already paid.");
      }

      const { amountCents: amountCentsRaw, payerEmail } = req.body || {};

      const invoiceTotal = summary.invoice.totalCents ?? summary.invoice.amountCents ?? null;
      const invoicePaid = summary.invoice.amountPaidCents ?? 0;
      const balanceDue = Number.isInteger(invoiceTotal)
        ? Math.max(0, invoiceTotal - (Number.isInteger(invoicePaid) ? invoicePaid : 0))
        : null;

      if (!Number.isInteger(balanceDue) || balanceDue <= 0) {
        emitPvHook?.("shortpay.intent_exists", { invoiceId: summary.invoice.id, reason: "no_balance_due" });
        return sendError(res, 409, "already_paid", "Invoice has no balance due.");
      }

      if (amountCentsRaw != null) {
        if (!Number.isInteger(amountCentsRaw) || amountCentsRaw <= 0) {
          return sendError(res, 400, "bad_request", "amountCents must be a positive integer when provided.");
        }
        if (amountCentsRaw !== balanceDue) {
          return sendError(res, 400, "bad_request", "amountCents does not match invoice balance due.");
        }
      }

      const amountCents = balanceDue;

      const createIntent = pickIntentCreator();
      if (!createIntent) {
        console.error("ShortPay: no intent creator found on paymentsReg");
        return sendError(
          res,
          500,
          "SERVER_MISCONFIG",
          "Payments module does not expose a guest-pay intent creator. Add an exported helper in src/payments/payments.routes."
        );
      }

      const result = await createIntent({
        token,
        amountCents,
        payerEmail,
        req,
      });

      emitPvHook?.("shortpay.intent_created", {
        invoiceId: token.invoice.id,
        paymentId: result?.paymentId || null,
      });

      return res.json(result);
    } catch (e) {
      const status = e?.status || e?.httpStatus || e?.http;
      const code = String(e?.code || "").toLowerCase();

      if (status === 409 || code.includes("intent_exists")) {
        emitPvHook?.("shortpay.intent_exists", { code: req.params.code });
        return sendError(res, 409, "INTENT_EXISTS", "Payment intent already exists.");
      }

      console.error("POST /p/:code/intent failed:", e);
      return sendError(res, 500, "SERVER_ERROR", "Unable to create payment intent.");
    }
  });

  return router;
}

module.exports = {
  buildShortPayRouter,
};