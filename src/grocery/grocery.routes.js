/**
 * src/grocery/grocery.routes.js
 *
 * Grocery MVP Demo Mode B routes.
 * POST /grocery/validate — UPC validation + subsidy check
 * POST /grocery/complete — finalize transaction, record events
 * GET  /grocery/promos   — list configured UPC promotions (admin/debug)
 */

"use strict";

const express = require("express");
const crypto = require("crypto");
const { lookupUpc, getAllPromos } = require("./grocery.config");
const { recordPaymentEvent } = require("../payments/paymentEvent.service");

function buildGroceryRouter({ sendError, emitPvHook }) {
  const router = express.Router();

  // In-memory basket store (demo only — not for production)
  const baskets = new Map();

  /**
   * Validate phone: must be exactly 10 digits.
   */
  function isValidPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return digits.length === 10;
  }

  /**
   * POST /grocery/validate
   * Input: { upc, quantity, phone, storeId }
   * Output: { eligible, subsidyAmount, promotionId, productName }
   */
  router.post("/grocery/validate", (req, res) => {
    try {
      const { upc, quantity, phone, storeId } = req.body || {};

      if (!upc) return sendError(res, 400, "VALIDATION_ERROR", "upc is required");
      if (!phone) return sendError(res, 400, "VALIDATION_ERROR", "phone is required");
      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "storeId is required");

      const qty = Math.max(1, parseInt(quantity, 10) || 1);

      // Identity gate
      if (!isValidPhone(phone)) {
        emitPvHook("grocery.validate.phone_invalid", {
          tc: "TC-GRO-01",
          sev: "warn",
          stable: "grocery:validate",
          phone: String(phone).slice(0, 4) + "***",
          upc,
          storeId,
        });
        return res.json({
          eligible: false,
          subsidyAmount: 0,
          promotionId: null,
          productName: null,
          reason: "invalid_phone",
        });
      }

      // UPC lookup
      const promo = lookupUpc(upc);
      if (!promo) {
        emitPvHook("grocery.validate.upc_unknown", {
          tc: "TC-GRO-02",
          sev: "info",
          stable: "grocery:validate",
          upc,
          storeId,
        });
        return res.json({
          eligible: false,
          subsidyAmount: 0,
          promotionId: null,
          productName: null,
          reason: "unknown_upc",
        });
      }

      const subsidyAmount = (promo.subsidyAmountCents * qty) / 100;

      emitPvHook("grocery.validate.eligible", {
        tc: "TC-GRO-03",
        sev: "info",
        stable: "grocery:validate",
        upc,
        productName: promo.productName,
        subsidyAmountCents: promo.subsidyAmountCents * qty,
        quantity: qty,
        promotionId: promo.promotionId,
        storeId,
      });

      return res.json({
        eligible: true,
        subsidyAmount,
        subsidyAmountCents: promo.subsidyAmountCents * qty,
        promotionId: promo.promotionId,
        productName: promo.productName,
        quantity: qty,
      });
    } catch (err) {
      emitPvHook("grocery.validate.error", {
        tc: "TC-GRO-04",
        sev: "error",
        stable: "grocery:validate",
        error: err?.message,
      });
      return sendError(res, 500, "SERVER_ERROR", "Validation failed");
    }
  });

  /**
   * POST /grocery/complete
   * Finalize a grocery transaction. Records subsidy events to the PaymentEvent ledger.
   *
   * Input: { phone, storeId, merchantId, items: [{ upc, quantity, priceCents, subsidyCents }] }
   * Output: { transactionId, totalCents, totalSubsidyCents, finalCents, eventCount }
   */
  router.post("/grocery/complete", async (req, res) => {
    try {
      const { phone, storeId, merchantId, items } = req.body || {};

      if (!phone) return sendError(res, 400, "VALIDATION_ERROR", "phone is required");
      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "storeId is required");
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
      if (!Array.isArray(items) || items.length === 0) {
        return sendError(res, 400, "VALIDATION_ERROR", "items array is required");
      }

      if (!isValidPhone(phone)) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid phone number");
      }

      const transactionId = "txn-" + crypto.randomBytes(8).toString("hex");
      const phoneDigits = String(phone).replace(/\D/g, "");

      let totalCents = 0;
      let totalSubsidyCents = 0;
      let eventCount = 0;

      for (const item of items) {
        const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
        const priceCents = Number(item.priceCents) || 0;
        totalCents += priceCents * qty;

        const subsidyCents = Number(item.subsidyCents) || 0;
        if (subsidyCents > 0) {
          totalSubsidyCents += subsidyCents;

          await recordPaymentEvent({
            eventType: "subsidy_applied",
            source: "grocery",
            merchantId: Number(merchantId),
            storeId: Number(storeId),
            phone: phoneDigits,
            amountCents: subsidyCents,
            transactionId,
            upc: item.upc,
            productName: item.productName || null,
            promotionId: null,
            metadata: { quantity: qty, priceCents },
            emitHook: emitPvHook,
          });
          eventCount++;
        }
      }

      // Record the transaction completion event
      await recordPaymentEvent({
        eventType: "payment_completed",
        source: "grocery",
        merchantId: Number(merchantId),
        storeId: Number(storeId),
        phone: phoneDigits,
        amountCents: totalCents - totalSubsidyCents,
        transactionId,
        metadata: {
          totalCents,
          totalSubsidyCents,
          finalCents: totalCents - totalSubsidyCents,
          itemCount: items.length,
        },
        emitHook: emitPvHook,
      });

      emitPvHook("grocery.transaction.completed", {
        tc: "TC-GRO-05",
        sev: "info",
        stable: "grocery:transaction:" + transactionId,
        transactionId,
        merchantId,
        storeId,
        totalCents,
        totalSubsidyCents,
        finalCents: totalCents - totalSubsidyCents,
        eventCount,
      });

      return res.status(201).json({
        transactionId,
        totalCents,
        totalSubsidyCents,
        finalCents: totalCents - totalSubsidyCents,
        eventCount,
      });
    } catch (err) {
      emitPvHook("grocery.transaction.error", {
        tc: "TC-GRO-06",
        sev: "error",
        stable: "grocery:transaction",
        error: err?.message,
      });
      return sendError(res, 500, "SERVER_ERROR", "Transaction failed");
    }
  });

  /**
   * GET /grocery/promos
   * List all configured UPC promotions (admin/debug).
   */
  router.get("/grocery/promos", (_req, res) => {
    return res.json({ promos: getAllPromos() });
  });

  return router;
}

module.exports = { buildGroceryRouter };
