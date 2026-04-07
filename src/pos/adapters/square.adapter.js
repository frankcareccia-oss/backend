/**
 * square.adapter.js — Square implementation of PVPosAdapter
 *
 * Depends on:
 *   - PosConnection row (passed in constructor) with encrypted tokens
 *   - SQUARE_APP_ID, SQUARE_APP_SECRET env vars
 *   - TOKEN_ENCRYPTION_KEY env var (for decrypt)
 *
 * Square SDK: uses plain fetch against Square API v2 to avoid heavy SDK dep.
 * API base: https://connect.squareup.com/v2
 */

const { PVPosAdapter } = require("../pos.adapter.interface");
const { decrypt } = require("../../utils/encrypt");
const { prisma } = require("../../db/prisma");
const { accumulateStamps } = require("../pos.stamps");
const { processRewardGrant } = require("../pos.reward");
const { writeEventLog } = require("../../eventlog/eventlog");

const IS_SANDBOX = (process.env.SQUARE_APP_ID || "").startsWith("sandbox-");
const SQUARE_API_BASE = IS_SANDBOX ? "https://connect.squareupsandbox.com/v2" : "https://connect.squareup.com/v2";

class SquareAdapter extends PVPosAdapter {
  /**
   * @param {import('@prisma/client').PosConnection} connection
   */
  constructor(connection) {
    super();
    this.connection = connection;
  }

  /** Decrypt and return the access token for API calls. */
  _accessToken() {
    return decrypt(this.connection.accessTokenEnc);
  }

  /** Shared fetch wrapper for Square API. */
  async _squareFetch(path, opts = {}) {
    const url = `${SQUARE_API_BASE}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        "Authorization": `Bearer ${this._accessToken()}`,
        "Square-Version": "2024-01-18",
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Square API ${path} → ${res.status}: ${body}`);
    }

    return res.json();
  }

  // ─────────────────────────────────────────────────────────────
  // Interface implementation
  // ─────────────────────────────────────────────────────────────

  /**
   * Return PerkValet store context by pvStoreId.
   * Looks up the PosLocationMap to find the mapped Square location_id.
   */
  async getStoreContext(storeId) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, merchantId: true, name: true },
    });
    if (!store) throw new Error(`Store not found: ${storeId}`);

    const locationMap = await prisma.posLocationMap.findFirst({
      where: {
        pvStoreId: storeId,
        posConnectionId: this.connection.id,
        active: true,
      },
    });

    return {
      storeId: store.id,
      merchantId: store.merchantId,
      name: store.name,
      posType: "square",
      locationId: locationMap?.externalLocationId || null,
    };
  }

  /**
   * Return recent visits for a store (pulled from PerkValet DB, not Square).
   * Square is push-based (webhooks); this serves the adapter pull contract.
   */
  async getRecentVisits(storeId, opts = {}) {
    const { limit = 50, since } = opts;
    const where = {
      storeId,
      source: "square_webhook",
    };
    if (since) where.createdAt = { gte: since };

    const visits = await prisma.visit.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        consumerId: true,
        storeId: true,
        merchantId: true,
        source: true,
        status: true,
        posVisitId: true,
        createdAt: true,
      },
    });

    return visits;
  }

  /**
   * Return a single visit by PerkValet visit ID.
   */
  async getVisitById(visitId) {
    return prisma.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true,
        consumerId: true,
        storeId: true,
        merchantId: true,
        source: true,
        status: true,
        posVisitId: true,
        createdAt: true,
      },
    });
  }

  /**
   * Validate whether a promotion can be applied to a visit.
   * Checks: visit is identified, promotion is live, consumer has progress.
   */
  async validatePromotion(visit, promotion) {
    if (!visit.consumerId) {
      return { valid: false, reason: "visit_not_identified" };
    }
    if (promotion.status !== "live") {
      return { valid: false, reason: "promotion_not_live" };
    }

    const progress = await prisma.consumerPromoProgress.findFirst({
      where: {
        consumerId: visit.consumerId,
        promotionId: promotion.id,
        milestonesAvailable: { gt: 0 },
      },
    });

    if (!progress) {
      return { valid: false, reason: "no_reward_available" };
    }

    return { valid: true };
  }

  /**
   * Record a promotion redemption against a visit.
   * Delegates to processRewardGrant (same path as QR/POS flows).
   */
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
      source: "square_webhook",
      outcome: "success",
      payloadJson: { redemptionId: result.redemptionId, discountAmount, metadata },
    });

    return { success: true, redemptionId: result.redemptionId };
  }

  // ─────────────────────────────────────────────────────────────
  // Square-specific helpers (used by OAuth + webhook routes)
  // ─────────────────────────────────────────────────────────────

  /**
   * List Square locations for the connected merchant.
   * Used during onboarding to let the merchant map locations → PV stores.
   */
  async listLocations() {
    const data = await this._squareFetch("/locations");
    return data.locations || [];
  }

  /**
   * Fetch a Square Customer by customer_id.
   * Returns null if not found rather than throwing.
   */
  async getSquareCustomer(customerId) {
    try {
      const data = await this._squareFetch(`/customers/${customerId}`);
      return data.customer || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a PerkValet Consumer from a Square payment object.
   * Strategy: customer_id → fetch customer → phone → match Consumer.phoneE164
   *           fallback: buyer_email_address → match Consumer via User.email
   * Returns null if no match.
   */
  async resolveConsumer(payment) {
    // Try phone via Square customer record
    if (payment.customer_id) {
      const customer = await this.getSquareCustomer(payment.customer_id);
      if (customer?.phone_number) {
        const phone = normalizePhone(customer.phone_number);
        if (phone) {
          const consumer = await prisma.consumer.findUnique({
            where: { phoneE164: phone },
            select: { id: true },
          });
          if (consumer) return consumer.id;
        }
      }
      // Try email from Square customer
      if (customer?.email_address) {
        const consumerId = await matchByEmail(customer.email_address);
        if (consumerId) return consumerId;
      }
    }

    // Fallback: buyer_email_address on the payment
    if (payment.buyer_email_address) {
      const consumerId = await matchByEmail(payment.buyer_email_address);
      if (consumerId) return consumerId;
    }

    return null;
  }

  /**
   * List all catalog items and categories from Square, normalized to PV format.
   * Handles pagination via cursor. Fetches ITEM and CATEGORY types.
   */
  async listCatalog() {
    const categories = [];
    const items = [];

    // Fetch all catalog objects (paginated)
    let cursor = null;
    do {
      const params = new URLSearchParams({ types: "ITEM,CATEGORY" });
      if (cursor) params.set("cursor", cursor);

      const data = await this._squareFetch(`/catalog/list?${params}`);
      const objects = data.objects || [];

      for (const obj of objects) {
        if (obj.type === "CATEGORY") {
          categories.push({
            externalId: obj.id,
            name: obj.category_data?.name || "Unnamed Category",
          });
        } else if (obj.type === "ITEM") {
          const item = obj.item_data || {};
          const variations = (item.variations || []).map((v) => {
            const vd = v.item_variation_data || {};
            return {
              externalId: v.id,
              name: vd.name || null,
              sku: vd.sku || null,
              upc: vd.upc || null,
              priceCents: vd.price_money?.amount || null,
            };
          });

          // Use first variation for primary price/sku/upc if item-level not available
          const primaryVar = variations[0] || {};

          items.push({
            externalId: obj.id,
            name: item.name || "Unnamed Item",
            description: item.description || null,
            sku: primaryVar.sku || null,
            upc: primaryVar.upc || null,
            priceCents: primaryVar.priceCents || null,
            currency: primaryVar.priceCents != null
              ? (item.variations?.[0]?.item_variation_data?.price_money?.currency || "USD")
              : null,
            categoryExternalId: item.category_id || null,
            categoryName: null, // resolved after all categories are collected
            imageUrl: item.image_ids?.length
              ? `__image_pending:${item.image_ids[0]}` // resolved below
              : null,
            variations,
          });
        }
      }

      cursor = data.cursor || null;
    } while (cursor);

    // Resolve category names on items
    const catMap = Object.fromEntries(categories.map((c) => [c.externalId, c.name]));
    for (const item of items) {
      if (item.categoryExternalId) {
        item.categoryName = catMap[item.categoryExternalId] || null;
      }
    }

    // Resolve image URLs (batch — max 1 call per image, but typically few unique images)
    const imageIds = new Set();
    for (const item of items) {
      if (item.imageUrl?.startsWith("__image_pending:")) {
        imageIds.add(item.imageUrl.replace("__image_pending:", ""));
      }
    }
    const imageMap = {};
    for (const imgId of imageIds) {
      try {
        const imgData = await this._squareFetch(`/catalog/object/${imgId}`);
        imageMap[imgId] = imgData.object?.image_data?.url || null;
      } catch {
        imageMap[imgId] = null;
      }
    }
    for (const item of items) {
      if (item.imageUrl?.startsWith("__image_pending:")) {
        const imgId = item.imageUrl.replace("__image_pending:", "");
        item.imageUrl = imageMap[imgId] || null;
      }
    }

    return { categories, items };
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Normalize a phone number string to E.164 (+1XXXXXXXXXX for US). */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Match a consumer by email via the User record. */
async function matchByEmail(email) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true },
  });
  if (!user) return null;

  const consumer = await prisma.consumer.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
  return consumer?.id || null;
}

module.exports = { SquareAdapter };
