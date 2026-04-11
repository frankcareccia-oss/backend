/**
 * src/payments/paymentEvent.routes.js
 *
 * Admin API for the payment event ledger.
 * Read-only views + settlement report.
 */

"use strict";

const express = require("express");
const { queryPaymentEvents, getSettlementReport } = require("./paymentEvent.service");

function buildPaymentEventRouter({ requireJwt, requireAdmin, sendError, emitPvHook }) {
  const router = express.Router();

  /**
   * GET /admin/payment-events
   * Query the immutable payment event ledger.
   */
  router.get("/admin/payment-events", requireJwt, requireAdmin, async (req, res) => {
    try {
      const { source, merchantId, storeId, eventType, transactionId, startDate, endDate, limit } = req.query;

      const events = await queryPaymentEvents({
        source: source || undefined,
        merchantId: merchantId ? Number(merchantId) : undefined,
        storeId: storeId ? Number(storeId) : undefined,
        eventType: eventType || undefined,
        transactionId: transactionId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit: limit ? Math.min(Number(limit), 500) : 200,
      });

      emitPvHook("payment.events.queried", {
        tc: "TC-PE-02",
        sev: "info",
        stable: "payment_events:query",
        userId: req.userId,
        source: source || "all",
        count: events.length,
      });

      return res.json({ items: events });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Query failed");
    }
  });

  /**
   * GET /admin/settlement-report
   * Aggregate subsidy events by merchant and promotion.
   */
  router.get("/admin/settlement-report", requireJwt, requireAdmin, async (req, res) => {
    try {
      const { merchantId, startDate, endDate } = req.query;

      const report = await getSettlementReport({
        merchantId: merchantId ? Number(merchantId) : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });

      emitPvHook("payment.settlement.report_generated", {
        tc: "TC-PE-03",
        sev: "info",
        stable: "settlement:report",
        userId: req.userId,
        merchantId: merchantId || "all",
        eventCount: report.eventCount,
        totalSubsidyCents: report.totalSubsidyCents,
      });

      // CSV export if requested
      if (req.query.format === "csv") {
        let csv = "type,id,totalCents\n";
        for (const m of report.byMerchant) {
          csv += "merchant," + m.merchantId + "," + m.totalCents + "\n";
        }
        for (const p of report.byPromotion) {
          csv += "promotion," + (p.promotionId || "none") + "," + p.totalCents + "\n";
        }
        res.set("Content-Type", "text/csv");
        res.set("Content-Disposition", "attachment; filename=settlement-report.csv");
        return res.send(csv);
      }

      return res.json(report);
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Report failed");
    }
  });

  return router;
}

module.exports = { buildPaymentEventRouter };
