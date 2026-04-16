# Clover Discount Reward Integration — Dev Plan

**Agreed:** 2026-04-15
**Status:** In Progress (Phase 1 complete)

## Context

- Stamp accumulation pipeline is already shared between Square and Clover (`pos.stamps.js`)
- Milestone detection + Entitlement creation already works for Clover
- Gap: Square issues gift cards on milestone; Clover needs to apply discounts directly to orders via API
- **Proven on sandbox 2026-04-15**: both order-level and line-item discounts work, show on receipt with dynamic names
- Sandbox merchant: Brewed Awakening (JB0AQ7GDQCWA1), token may need refresh via developer portal

## Critical Business Rule: Discount Guard

- **Fixed discount**: order total must be >= reward amount. If order is $3 and reward is $5, SKIP — don't issue the discount. Log: `"[PV] Reward skipped: order total ($3.00) < reward value ($5.00) — reward stays pending"`
- **Free item**: match by SKU on order. Apply 100% discount on that line item only (always exact match, no overshoot)
- **Percentage discount**: always safe — can't exceed order total
- **Consumer must NEVER get money back from a reward**

## Phase 1: Core Discount Delivery Function ✅

- [x] 1a. Create `src/pos/pos.clover.discount.js` — `applyCloverDiscount({ posConnection, orderId, name, amount, percentage })`
  - Calls POST /v3/merchants/{mId}/orders/{orderId}/discounts
  - Implements discount guard (check order total >= reward for fixed discounts)
  - pvHook: clover.discount.applied (TC-CLO-DISC-01)
  - Tests: success, auth failure, invalid order, discount guard rejection
- [x] 1b. Create PosRewardDiscount model + migration
  - Fields: consumerId, merchantId, posConnectionId, entitlementId, cloverOrderId, cloverDiscountId, discountName, amountCents, percentage, rewardType, status (pending/applied/failed/skipped), skippedReason, appliedAt
- [x] 1c. Modify pos.stamps.js milestone handler — branch on POS type:
  - Square → issueGiftCardReward() (existing)
  - Clover → issueCloverDiscountReward() (new)
  - Tests for branching logic

## Phase 2: Instant Reward Flow

- [ ] 2a. issueCloverDiscountReward() for "instant" timing:
  - Has orderId from payment webhook context
  - Check discount guard (order total >= reward)
  - If passes: apply discount, build dynamic name from promo data
  - If fails: skip, log warning, leave reward pending
  - Record in PosRewardDiscount
  - pvHook: clover.reward.instant (TC-CLO-DISC-02)
  - Tests: instant applied, guard rejection logged, dynamic name on receipt
- [ ] 2b. Handle overpayment edge case — document behavior clearly

## Phase 3: Next-Visit Reward Flow

- [ ] 3a. issueCloverDiscountReward() for "next visit" timing:
  - Create PosRewardDiscount with status "pending"
  - Entitlement stays "active" in consumer wallet
  - pvHook: clover.reward.pending (TC-CLO-DISC-03)
- [ ] 3b. Modify clover.webhook.routes.js payment handler:
  - After consumer resolution, check for pending rewards
  - Query PosRewardDiscount where consumerId + merchantId + status = "pending"
  - Check discount guard against current order total
  - If passes: apply discount, update status to "applied"
  - If fails: leave pending, log skip reason
  - pvHook: clover.reward.applied_next_visit (TC-CLO-DISC-04)
  - Tests: pending detected, discount applied, guard rejection, status transitions

## Phase 4: Order Enrichment

- [ ] 4a. In handleCloverPayment(), fetch + store line items in PosOrder/PosOrderItem
  - Fire-and-forget, never block pipeline
  - pvHook: clover.order.enriched (TC-CLO-ORD-01)
  - Tests: items stored, names/prices match
- [ ] 4b. For free_item rewards: match rewardSku against PosOrderItem to build discount name
  - e.g., "PerkValet Reward — Free Large Latte ($5.00)"

## Phase 5: Duplicate Customer Detection

- [ ] 5a. Port Square duplicate detection to Clover webhook
  - Search Clover customers by phone on payment
  - Create DuplicateCustomerAlert if 2+ customers same phone
  - pvHook: clover.customer.duplicate (TC-CLO-CUST-01)
  - Tests: duplicate detected, alert created, no alert when unique

## Phase 6: Webhook Hardening

- [ ] 6a. In-memory dedup cache (5-min TTL, same as Square)
- [ ] 6b. Handle catalog events (I/IC types) → trigger catalog sync
- [ ] 6c. Handle customer events (C type) → duplicate detection
- [ ] 6d. Tests for each

## Phase 7: App Permissions & Deployment

- [ ] 7a. Document prod Clover app permissions (Orders R/W required)
- [ ] 7b. Update seed scripts for Brewed Awakening local testing
- [ ] 7c. Deployment checklist

## Estimated Test Coverage

- Phase 1: 16 tests ✅
- Phase 2: 3-4 tests (instant flow)
- Phase 3: 4-5 tests (next-visit flow) — partially done in Phase 1 tests
- Phase 4: 2-3 tests (order enrichment)
- Phase 5: 3-4 tests (duplicate detection)
- Phase 6: 3-4 tests (hardening)
- **Total: ~30-35 tests**

## Dependencies

- Prisma migration for PosRewardDiscount model ✅
- Clover sandbox token (Brewed Awakening: JB0AQ7GDQCWA1)
- Promo timing field on Promotion model (future — not blocking, default to "next visit" for now)

## Key Architectural Differences from Square

| Aspect | Square | Clover |
|--------|--------|--------|
| Reward mechanism | Gift card (load funds) | Discount on order |
| Timing | Forced "next visit" | Supports "instant" + "next visit" |
| Receipt visibility | Gift card tender line | Named discount line (PerkValet branded) |
| API complexity | Create + activate + load + link customer | Single POST to /orders/{id}/discounts |
| Discount guard | N/A (gift card always works) | Required (order total >= reward) |
| Reconciliation | EOD balance check vs Square | Not needed (discount is atomic) |

## Sandbox Test Results (2026-04-15)

- Created order P4KFF8DM4C96G on "Brewed Awakening" (merchant JB0AQ7GDQCWA1)
- Applied order-level discount "PerkValet Reward - Free Coffee" (-$5.00) — shows on receipt
- Applied line-item discount "PerkValet 50% Off" (50%) — shows on receipt as -$1.75
- Both discount names visible on receipt and in dashboard order details
- Discount names are **fully dynamic** — PV sets the `name` field, Clover passes it through to receipt
