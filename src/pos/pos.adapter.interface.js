/**
 * pos.adapter.interface.js — PVPosAdapter abstract interface
 *
 * All POS adapters (Square, Clover, Lightspeed, Toast …) must extend this
 * class and implement every method. Calling the base method throws, so a
 * missing implementation is caught at runtime during development/testing.
 *
 * Interface contract (per spec PerkValet POS Adapter Layer v1):
 *
 *   getStoreContext(storeId)         → { storeId, merchantId, name, posType, locationId }
 *   getRecentVisits(storeId, opts?)  → Visit[]
 *   getVisitById(visitId)            → Visit | null
 *   validatePromotion(visit, promo)  → { valid: bool, reason?: string }
 *   recordRedemption(payload)        → { success: bool, redemptionId }
 */

class PVPosAdapter {
  /**
   * Return PerkValet store context for the given pvStoreId.
   * @param {number} storeId — PerkValet store ID
   * @returns {Promise<{storeId, merchantId, name, posType, locationId}>}
   */
  async getStoreContext(storeId) {
    throw new Error(`${this.constructor.name} must implement getStoreContext()`);
  }

  /**
   * Return recent visits for a store (used for dashboard/polling).
   * @param {number} storeId
   * @param {{ limit?: number, since?: Date }} [opts]
   * @returns {Promise<object[]>}
   */
  async getRecentVisits(storeId, opts = {}) {
    throw new Error(`${this.constructor.name} must implement getRecentVisits()`);
  }

  /**
   * Return a single visit by PerkValet visit ID.
   * @param {number} visitId
   * @returns {Promise<object|null>}
   */
  async getVisitById(visitId) {
    throw new Error(`${this.constructor.name} must implement getVisitById()`);
  }

  /**
   * Validate whether a promotion can be applied to a visit.
   * @param {object} visit
   * @param {object} promotion
   * @returns {Promise<{ valid: boolean, reason?: string }>}
   */
  async validatePromotion(visit, promotion) {
    throw new Error(`${this.constructor.name} must implement validatePromotion()`);
  }

  /**
   * Record a promotion redemption.
   * @param {{ visitId: number, promotionId: number, discountAmount: number, metadata?: object }} payload
   * @returns {Promise<{ success: boolean, redemptionId: number }>}
   */
  async recordRedemption(payload) {
    throw new Error(`${this.constructor.name} must implement recordRedemption()`);
  }

  /**
   * List catalog items from the POS, normalized to PV common format.
   * @returns {Promise<{ categories: NormalizedCategory[], items: NormalizedItem[] }>}
   *
   * NormalizedCategory: { externalId, name }
   * NormalizedItem: { externalId, name, description, sku, upc, priceCents, currency,
   *                   categoryExternalId, categoryName, imageUrl, variations: NormalizedVariation[] }
   * NormalizedVariation: { externalId, name, sku, upc, priceCents }
   */
  async listCatalog() {
    throw new Error(`${this.constructor.name} must implement listCatalog()`);
  }
}

module.exports = { PVPosAdapter };
