/**
 * adapters/clover.adapter.js — Clover POS adapter
 *
 * Implements PVPosAdapter interface for Clover POS.
 * Uses Clover REST API v3 (sandbox: apisandbox.dev.clover.com, prod: api.clover.com).
 *
 * Token management: access token stored encrypted in PosConnection.
 */

"use strict";

const { PVPosAdapter } = require("../pos.adapter.interface");
const { prisma } = require("../../db/prisma");
const { decrypt } = require("../../utils/encrypt");
const { processRewardGrant } = require("../pos.reward");
const { writeEventLog } = require("../../eventlog/eventlog");

// Clover API base URLs
const CLOVER_API_BASE = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";

class CloverAdapter extends PVPosAdapter {
  constructor(posConnection) {
    super();
    this.conn = posConnection;
    this.merchantId = posConnection.merchantId;
    this.cloverMerchantId = posConnection.externalMerchantId;
  }

  /**
   * Get the access token (decrypt if needed).
   * For sandbox, tokens are stored as-is. For production, decrypt.
   */
  _accessToken() {
    return decrypt(this.conn.accessTokenEnc);
  }

  /**
   * Shared Clover API fetch wrapper.
   */
  async _cloverFetch(path, opts = {}) {
    const token = this._accessToken();
    const url = `${CLOVER_API_BASE}/v3/merchants/${this.cloverMerchantId}${path}`;

    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...opts.headers,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Clover API ${res.status}: ${text.slice(0, 200)}`);
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
      posType: "clover",
      locationId: locationMap?.externalLocationId || null,
    };
  }

  async getRecentVisits(storeId, opts = {}) {
    const limit = opts.limit || 25;
    return prisma.visit.findMany({
      where: { storeId, source: "clover_webhook" },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async getVisitById(visitId) {
    return prisma.visit.findUnique({ where: { id: visitId } });
  }

  async validatePromotion(visit, promotion) {
    // Basic validation — promotion must be active and belong to same merchant
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
      source: "clover_webhook",
      outcome: "success",
      payloadJson: { redemptionId: result.redemptionId, discountAmount, metadata },
    });

    return { success: true, redemptionId: result.redemptionId };
  }

  // ── Catalog ──────────────────────────────────────────

  async listCatalog() {
    const itemsData = await this._cloverFetch("/items?expand=categories");
    const items = (itemsData.elements || []).map(item => ({
      externalId: item.id,
      name: item.name || "",
      description: item.description || "",
      sku: item.sku || "",
      upc: item.upc || "",
      priceCents: item.price || 0,
      currency: "usd",
      categoryExternalId: item.categories?.elements?.[0]?.id || null,
      categoryName: item.categories?.elements?.[0]?.name || null,
      imageUrl: null,
      variations: [],
    }));

    const catsData = await this._cloverFetch("/categories");
    const categories = (catsData.elements || []).map(cat => ({
      externalId: cat.id,
      name: cat.name || "",
    }));

    return { categories, items };
  }

  async pushProduct(product) {
    const body = {
      name: product.name,
      price: product.priceCents || 0,
      sku: product.sku || undefined,
    };

    if (product.externalCatalogId) {
      // Update existing
      await this._cloverFetch(`/items/${product.externalCatalogId}`, {
        method: "POST",
        body,
      });
      return { externalId: product.externalCatalogId };
    }

    // Create new
    const result = await this._cloverFetch("/items", {
      method: "POST",
      body,
    });
    return { externalId: result.id };
  }

  async pushCategory(category) {
    const body = { name: category.name };

    if (category.externalCatalogId) {
      await this._cloverFetch(`/categories/${category.externalCatalogId}`, {
        method: "POST",
        body,
      });
      return { externalId: category.externalCatalogId };
    }

    const result = await this._cloverFetch("/categories", {
      method: "POST",
      body,
    });
    return { externalId: result.id };
  }

  // ── Clover-specific helpers ──────────────────────────

  /**
   * List Clover merchant locations (for location mapping UI).
   */
  async listLocations() {
    // Clover doesn't have "locations" like Square — each merchant is a location.
    // Some merchants have multiple "devices" but the merchant ID IS the location.
    return [{
      id: this.cloverMerchantId,
      name: this.conn.externalMerchantId,
      address: null,
    }];
  }

  /**
   * Resolve a Clover customer to a PV consumer.
   * Matches by phone number from the Clover customer record.
   */
  async resolveConsumer(cloverOrder) {
    if (!cloverOrder?.customers?.elements?.length) return null;

    const customer = cloverOrder.customers.elements[0];

    // Phone may not be expanded on the order — fetch customer directly if needed
    let phone = customer.phoneNumbers?.elements?.[0]?.phoneNumber;
    if (!phone && customer.id) {
      try {
        const fullCustomer = await this._cloverFetch(`/customers/${customer.id}?expand=phoneNumbers`);
        phone = fullCustomer?.phoneNumbers?.elements?.[0]?.phoneNumber;
      } catch (e) {
        console.warn("[clover.adapter] could not fetch customer phone:", e?.message);
      }
    }

    if (!phone) return null;

    // Normalize phone and look up in PV
    const digits = phone.replace(/\D/g, "");
    const e164 = digits.length === 10 ? "+1" + digits : digits.length === 11 && digits[0] === "1" ? "+" + digits : null;

    if (!e164) return null;

    const consumer = await prisma.consumer.findFirst({
      where: { phoneE164: e164, status: "active" },
      select: { id: true },
    });

    return consumer?.id || null;
  }

  /**
   * Fetch a specific order with line items and customers.
   */
  async getOrder(orderId) {
    return this._cloverFetch(`/orders/${orderId}?expand=lineItems,customers`);
  }

  /**
   * Fetch a specific payment.
   */
  async getPayment(paymentId) {
    return this._cloverFetch(`/payments/${paymentId}`);
  }
}

module.exports = { CloverAdapter };
