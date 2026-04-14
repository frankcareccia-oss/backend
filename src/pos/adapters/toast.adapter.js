/**
 * adapters/toast.adapter.js — Toast POS adapter
 *
 * Implements PVPosAdapter interface for Toast POS.
 * Uses Toast REST API (sandbox: https://ws-sandbox-api.eng.toasttab.com, prod: https://ws-api.toasttab.com).
 *
 * Toast uses client-credentials OAuth — no redirect flow.
 * Bearer tokens expire and must be refreshed via client ID + secret.
 */

"use strict";

const { PVPosAdapter } = require("../pos.adapter.interface");
const { prisma } = require("../../db/prisma");
const { decrypt } = require("../../utils/encrypt");
const { processRewardGrant } = require("../pos.reward");
const { writeEventLog } = require("../../eventlog/eventlog");

const TOAST_API_BASE = process.env.TOAST_API_BASE || "https://ws-sandbox-api.eng.toasttab.com";

class ToastAdapter extends PVPosAdapter {
  constructor(posConnection) {
    super();
    this.conn = posConnection;
    this.merchantId = posConnection.merchantId;
    this.toastRestaurantGuid = posConnection.externalMerchantId;
  }

  /**
   * Get the access token (decrypt from PosConnection).
   */
  _accessToken() {
    return decrypt(this.conn.accessTokenEnc);
  }

  /**
   * Shared Toast API fetch wrapper.
   */
  async _toastFetch(path, opts = {}) {
    const token = this._accessToken();
    const url = `${TOAST_API_BASE}${path}`;

    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Toast-Restaurant-External-ID": this.toastRestaurantGuid,
        ...opts.headers,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Toast API ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  // ── PVPosAdapter Interface ──────────────────────────

  async getStoreContext(storeId) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, merchantId: true, name: true },
    });
    if (!store) return null;

    const locationMap = await prisma.posLocationMap.findFirst({
      where: { pvStoreId: storeId, active: true },
      select: { externalLocationId: true },
    });

    return {
      storeId: store.id,
      merchantId: store.merchantId,
      name: store.name,
      posType: "toast",
      locationId: locationMap?.externalLocationId || null,
    };
  }

  async getRecentVisits(storeId, opts = {}) {
    const limit = opts.limit || 25;
    return prisma.visit.findMany({
      where: { storeId, source: "toast_webhook" },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async getVisitById(visitId) {
    return prisma.visit.findUnique({ where: { id: visitId } });
  }

  async validatePromotion(visit, promotion) {
    if (!promotion || promotion.status !== "active") {
      return { valid: false, reason: "Promotion is not active" };
    }
    if (promotion.merchantId !== visit.merchantId) {
      return { valid: false, reason: "Promotion does not belong to this merchant" };
    }
    return { valid: true };
  }

  async recordRedemption({ visitId, promotionId, discountAmount, metadata }) {
    const visit = await prisma.visit.findUnique({
      where: { id: visitId },
      select: { consumerId: true, storeId: true, merchantId: true },
    });
    if (!visit) throw new Error(`Visit not found: ${visitId}`);
    if (!visit.consumerId) throw new Error("Cannot redeem on unidentified visit");

    const result = await processRewardGrant(prisma, {
      consumerId: visit.consumerId,
      merchantId: visit.merchantId,
      storeId: visit.storeId,
      associateUserId: null,
    });

    if (result.error) throw new Error(`Redemption failed: ${result.error}`);

    writeEventLog(prisma, {
      eventType: "redemption.recorded",
      merchantId: visit.merchantId,
      storeId: visit.storeId,
      consumerId: visit.consumerId,
      visitId,
      source: "toast_webhook",
      outcome: "success",
      payloadJson: { redemptionId: result.redemptionId, discountAmount, metadata },
    });

    return { success: true, redemptionId: result.redemptionId };
  }

  // ── Catalog ──────────────────────────────────────────

  async listCatalog() {
    const menuData = await this._toastFetch(`/menus/v2/menus`);
    const items = [];
    const categoryMap = {};

    // Toast menus have groups (categories) containing items
    const menus = Array.isArray(menuData) ? menuData : [menuData];
    for (const menu of menus) {
      for (const group of (menu.groups || [])) {
        const catId = group.guid;
        categoryMap[catId] = { externalId: catId, name: group.name || "" };

        for (const item of (group.items || [])) {
          items.push({
            externalId: item.guid,
            name: item.name || "",
            description: item.description || "",
            sku: item.sku || "",
            upc: item.upc || "",
            priceCents: item.price ? Math.round(item.price * 100) : 0,
            currency: "usd",
            categoryExternalId: catId,
            categoryName: group.name || null,
            imageUrl: item.imageUrl || null,
            variations: [],
          });
        }
      }
    }

    const categories = Object.values(categoryMap);
    return { categories, items };
  }

  async pushProduct(product) {
    // Toast menu management is typically done through the Toast portal
    // API write access requires specific partner permissions
    throw new Error("Toast menu write not supported — manage items via Toast portal");
  }

  async pushCategory(category) {
    throw new Error("Toast menu write not supported — manage categories via Toast portal");
  }

  // ── Toast-specific helpers ──────────────────────────

  /**
   * List Toast restaurant locations (for location mapping).
   * Each Toast restaurant GUID is a location.
   */
  async listLocations() {
    return [{
      id: this.toastRestaurantGuid,
      name: this.conn.externalMerchantId,
      address: null,
    }];
  }

  /**
   * Resolve a Toast order's guest to a PV consumer.
   * Matches by phone number or email.
   */
  async resolveConsumer(toastOrder) {
    // Toast orders may have customer info in the "customer" field
    const customer = toastOrder?.customer || toastOrder?.guest || null;
    if (!customer) return null;

    // Try phone first
    const phone = customer.phone || customer.phoneNumber || null;
    if (phone) {
      const digits = phone.replace(/\D/g, "");
      const e164 = digits.length === 10 ? "+1" + digits : digits.length === 11 && digits[0] === "1" ? "+" + digits : null;

      if (e164) {
        const consumer = await prisma.consumer.findFirst({
          where: { phoneE164: e164, status: "active" },
          select: { id: true },
        });
        if (consumer) return consumer.id;
      }
    }

    // Fallback to email
    const email = customer.email || null;
    if (email) {
      const user = await prisma.user.findFirst({
        where: { email: email.toLowerCase() },
        select: { id: true },
      });
      if (user) {
        const consumer = await prisma.consumer.findFirst({
          where: { userId: user.id, status: "active" },
          select: { id: true },
        });
        if (consumer) return consumer.id;
      }
    }

    return null;
  }

  /**
   * Fetch a specific order.
   */
  async getOrder(orderGuid) {
    return this._toastFetch(`/orders/v2/orders/${orderGuid}`);
  }

  /**
   * Fetch payment details from an order.
   */
  async getPayment(orderGuid, paymentGuid) {
    const order = await this.getOrder(orderGuid);
    if (!order?.checks) return null;

    for (const check of order.checks) {
      for (const payment of (check.payments || [])) {
        if (payment.guid === paymentGuid) return payment;
      }
    }
    return null;
  }
}

module.exports = { ToastAdapter };
