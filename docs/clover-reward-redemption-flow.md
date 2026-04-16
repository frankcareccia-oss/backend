# Clover Reward Redemption Flow

**Document version:** 1.0
**Date:** 2026-04-15
**Status:** Draft — For review before implementation

---

## Overview

When a PerkValet consumer earns a loyalty reward at a Clover merchant, the reward must be delivered as a discount on a future purchase. This document describes the complete interaction between all actors and systems from the moment a reward is earned through its redemption at the register.

---

## Actors

| Actor | Description | Interface |
|-------|-------------|-----------|
| **Consumer** | End customer enrolled in a loyalty program | PV Mobile App (phone) |
| **Associate** | Store employee operating the register | Clover POS Register (physical device) |
| **PV Backend** | PerkValet cloud server | REST API, webhook receiver |
| **Clover Cloud** | Clover's cloud platform | REST API v3, webhook sender |
| **Clover Register** | Physical POS device at the store | Touchscreen register app |
| **PV Mobile App** | Consumer-facing mobile wallet | React web app on phone |

---

## Preconditions

- Merchant has an active Clover POS connection in PerkValet
- Merchant has at least one active promotion (e.g., "Buy 10, get $3 off")
- Consumer has a PV account linked by phone number
- Consumer's phone number matches a Clover customer record at the merchant

---

## Flow A: Consumer Earns a Reward

This happens automatically when the consumer makes qualifying purchases.

| # | Who | Where | Does What |
|---|-----|-------|-----------|
| A1 | Associate | Clover Register | Rings up items, attaches customer (by phone or name lookup), processes payment |
| A2 | Clover Register | Clover Cloud | Payment completes; Clover sends payment webhook to PV Backend |
| A3 | PV Backend | PV Backend | Receives webhook; fetches payment and order details from Clover API |
| A4 | PV Backend | PV Backend | Resolves consumer: fetches customer from order, looks up phone, matches to PV Consumer record |
| A5 | PV Backend | PV Backend | Creates Visit record; records PaymentEvent in audit ledger |
| A6 | PV Backend | PV Backend | Accumulates stamps: increments ConsumerPromoProgress for each active promotion |
| A7 | PV Backend | PV Backend | **Milestone check:** if stampCount reaches threshold (e.g., 10/10): |
| | | | - Resets stamp count to 0 |
| | | | - Creates PromoRedemption (status: granted) |
| | | | - Creates Entitlement (type: reward, status: active) |
| | | | - Creates PosRewardDiscount (status: earned) |
| | | | - Fires event: `reward_granted` |
| A8 | PV Backend | PV Mobile App | Consumer's wallet auto-refreshes (background poll or push notification) |
| A9 | Consumer | PV Mobile App | Opens wallet; sees new reward: **"$3.00 off at Brewed Awakening — Activate when ready"** |

**State after Flow A:**
- Entitlement: `active`
- PosRewardDiscount: `earned` (no Clover discount template exists yet)
- Clover Register: no change (no discount button visible)
- Consumer wallet: reward visible, not yet activated

---

## Flow B: Consumer Activates the Reward

This is an intentional action by the consumer, done when they are ready to use the reward (typically before or during their next visit).

| # | Who | Where | Does What |
|---|-----|-------|-----------|
| B1 | Consumer | PV Mobile App | Views earned reward in wallet |
| B2 | Consumer | PV Mobile App | Taps **"Activate"** button |
| B3 | PV Mobile App | PV Backend | Sends request: `POST /me/wallet/{entitlementId}/activate` |
| B4 | PV Backend | PV Backend | Validates: entitlement exists, status is active, PosRewardDiscount status is earned |
| B5 | PV Backend | Clover Cloud | Creates discount template: `POST /v3/merchants/{mId}/discounts` with body: `{ "name": "PerkValet — Jane D. $3.00 off", "amount": -300 }` |
| B6 | Clover Cloud | Clover Register | Discount template syncs to the register's discount list |
| B7 | PV Backend | PV Backend | Updates PosRewardDiscount: status `earned` → `activated`, stores Clover discount template ID |
| B8 | PV Backend | PV Mobile App | Returns success response |
| B9 | Consumer | PV Mobile App | Sees updated reward status: **"Active! Show this to the associate or give them your phone number"** |

**State after Flow B:**
- Entitlement: `active`
- PosRewardDiscount: `activated` (cloverDiscountTemplateId stored)
- Clover Register: **"PerkValet — Jane D. $3.00 off"** visible in discount list
- Consumer wallet: reward shows as activated with instructions

---

## Flow C: Redemption at the Register

This happens during the consumer's visit, involving both the consumer and the associate.

| # | Who | Where | Does What |
|---|-----|-------|-----------|
| C1 | Consumer | In person | Approaches register; tells associate: "I have a PerkValet reward" |
| C2 | Consumer | In person | Either shows the PV app screen to the associate OR gives their phone number |
| C3 | Associate | Clover Register | Rings up the consumer's items for the current order |
| C4 | Associate | Clover Register | Taps **"Discount"** button on the register screen |
| C5 | Associate | Clover Register | Sees **"PerkValet — Jane D. $3.00 off"** in the discount list |
| C6 | Associate | Clover Register | Taps the discount to apply it to the order |
| C7 | Clover Register | Clover Register | Recalculates order total: e.g., $8.00 → $5.00 |
| C8 | Associate | Clover Register | Confirms the discounted total with the consumer |
| C9 | Associate | Clover Register | Processes payment at the reduced amount ($5.00) |
| C10 | Consumer | In person | Pays $5.00 (not $8.00) |

**State after Flow C:**
- Clover order: has line items + "PerkValet — Jane D. $3.00 off" discount applied
- Payment: completed at discounted total
- Consumer: paid the correct, reduced amount

---

## Flow D: PV Detects Redemption and Cleans Up

This happens automatically after payment, triggered by the payment webhook.

| # | Who | Where | Does What |
|---|-----|-------|-----------|
| D1 | Clover Register | Clover Cloud | Payment completes; Clover sends payment webhook to PV Backend |
| D2 | PV Backend | Clover Cloud | Fetches order details with discounts expanded |
| D3 | PV Backend | PV Backend | Scans order discounts for PerkValet-branded entries (pattern match on name or template ID lookup) |
| D4 | PV Backend | PV Backend | Match found: links the order discount to the PosRewardDiscount record |
| D5 | PV Backend | PV Backend | Updates PosRewardDiscount: status `activated` → `redeemed`, stores cloverOrderId, appliedAt timestamp |
| D6 | PV Backend | PV Backend | Updates Entitlement: status `active` → `redeemed` |
| D7 | PV Backend | Clover Cloud | Deletes the discount template: `DELETE /v3/merchants/{mId}/discounts/{templateId}` |
| D8 | PV Backend | PV Backend | Fires event: `clover.discount.redeemed` |
| D9 | PV Backend | PV Backend | Also processes this visit normally: creates Visit, accumulates stamps (may trigger next milestone) |
| D10 | Consumer | PV Mobile App | Wallet auto-refreshes; reward now shows: **"Redeemed at Brewed Awakening on Apr 16, 2026"** |

**State after Flow D:**
- Entitlement: `redeemed`
- PosRewardDiscount: `redeemed` (full audit trail: earned → activated → redeemed)
- Clover Register: discount template removed (clean register, no clutter)
- Consumer wallet: reward moved to "Redeemed" history

---

## Exception Flows

### E1: Consumer Hasn't Activated Before Arriving at Register

| # | Who | Where | Does What |
|---|-----|-------|-----------|
| E1.1 | Consumer | In person | "I have a PerkValet reward" |
| E1.2 | Associate | Clover Register | Taps Discount — does NOT see a PerkValet discount (no template exists) |
| E1.3 | Associate | In person | "I don't see it — can you activate it in your app?" |
| E1.4 | Consumer | PV Mobile App | Opens wallet, taps Activate (Flow B runs: B1-B9) |
| E1.5 | Associate | Clover Register | Waits a few seconds for sync; taps Discount again |
| E1.6 | Associate | Clover Register | **"PerkValet — Jane D. $3.00 off"** now appears → taps it |
| E1.7 | | | Continues with Flow C from step C7 |

### E2: Activated Template Expires (TTL)

Consumer activates but doesn't visit within the TTL window (e.g., 24 hours).

| # | Who | Where | Does What |
|---|-----|-------|-----------|
| E2.1 | PV Backend | PV Backend (cron) | Scans for PosRewardDiscount records with status `activated` older than TTL |
| E2.2 | PV Backend | Clover Cloud | Deletes the expired discount template from Clover |
| E2.3 | PV Backend | PV Backend | Updates PosRewardDiscount: status `activated` → `earned` (back to earned) |
| E2.4 | Consumer | PV Mobile App | Wallet shows reward as "Ready to activate" again |
| E2.5 | Consumer | PV Mobile App | Can re-activate when ready (Flow B runs again) |

### E3: Associate Applies Discount to Wrong Customer's Order

| # | Who | Where | Does What |
|---|-----|-------|-----------|
| E3.1 | Associate | Clover Register | Accidentally applies "PerkValet — Jane D." discount to a different customer's order |
| E3.2 | Clover Register | Clover Cloud | Payment webhook fires |
| E3.3 | PV Backend | PV Backend | Detects PerkValet discount on the order, but order's customer phone doesn't match Jane D. |
| E3.4 | PV Backend | PV Backend | Logs warning: "Discount used on mismatched customer" |
| E3.5 | PV Backend | PV Backend | Still marks reward as redeemed (discount was consumed on Clover side) |
| E3.6 | PV Backend | Clover Cloud | Deletes the template (cleanup) |

### E4: Consumer Has Multiple Pending Rewards

| # | Who | Where | Does What |
|---|-----|-------|-----------|
| E4.1 | Consumer | PV Mobile App | Has 2 earned rewards ($3.00 off each) |
| E4.2 | Consumer | PV Mobile App | Can activate one or both |
| E4.3 | PV Backend | Clover Cloud | Creates separate templates: "PerkValet — Jane D. $3.00 off (1)" and "PerkValet — Jane D. $3.00 off (2)" |
| E4.4 | Associate | Clover Register | Sees both in discount list — can apply one or both to the order |

### E5: Reward Expires (Promotion Expiry)

| # | Who | Where | Does What |
|---|-----|-------|-----------|
| E5.1 | PV Backend | PV Backend (cron) | Promotion end date passed; scans unredeemed entitlements |
| E5.2 | PV Backend | PV Backend | Updates Entitlement: status `active` → `expired` |
| E5.3 | PV Backend | Clover Cloud | If template was activated: deletes it from Clover |
| E5.4 | PV Backend | PV Backend | Updates PosRewardDiscount: status → `expired` |
| E5.5 | Consumer | PV Mobile App | Reward shows as "Expired" in wallet history |

---

## State Diagram: PosRewardDiscount Lifecycle

```
                    ┌─────────┐
  Milestone hit ──> │  earned  │
                    └────┬────┘
                         │
           Consumer taps "Activate"
           PV creates Clover template
                         │
                    ┌────▼─────┐
                    │ activated │──── TTL expires ──── back to "earned"
                    └────┬─────┘
                         │
           Associate taps discount on register
           Payment webhook confirms usage
                         │
                    ┌────▼─────┐
                    │ redeemed  │
                    └──────────┘

  Other terminal states:
    expired  ── promotion end date passed
    skipped  ── discount guard rejected (order too small)
```

---

## Key Design Decisions

1. **Consumer-initiated activation** — The discount template is NOT created at milestone time. It's created when the consumer explicitly activates. This prevents cluttering the merchant's Clover register with discounts that may never be used.

2. **Consumer-specific naming** — Each discount template includes the consumer's name so the associate knows who it belongs to.

3. **Template cleanup** — Templates are deleted after redemption (or after TTL expiry) so the register stays clean.

4. **No math for the associate** — The associate taps a pre-built, named, correctly-valued discount button. No mental math, no manual entry, no errors.

5. **Discount guard** — Fixed-amount rewards are only created when the reward value is calculable. The Clover register itself prevents discounts from exceeding the order total.

6. **Webhook verification** — PV confirms the discount was actually used by checking the order discounts in the payment webhook. This closes the audit loop.

---

## Systems Affected

| System | Changes Needed |
|--------|---------------|
| PV Backend | New endpoint: `POST /me/wallet/{id}/activate`. Modify milestone handler to create PosRewardDiscount with status "earned" (not immediately create template). Add discount detection in payment webhook. Add template cleanup. |
| PV Mobile App (Consumer) | Add "Activate" button on earned rewards. Show activation status and instructions for associate. |
| Clover API | No changes — uses existing `POST/DELETE /v3/merchants/{mId}/discounts` endpoints |
| Clover Register | No changes — discount templates automatically appear when created via API |
| PV Admin Portal | Optional: show discount redemption history for merchant reporting |

---

## Open Questions

1. **TTL duration** — How long should an activated discount template stay on the register before auto-expiring? 24 hours? 48 hours? Configurable per merchant?

2. **Associate-initiated activation** — Should the associate be able to activate a reward on behalf of the consumer (e.g., consumer doesn't have their phone)? If so, we need a merchant-facing lookup endpoint.

3. **Notification** — Should PV send a push notification or SMS when a reward is earned? When it's about to expire?

4. **Multiple POS types** — If a merchant has both Square and Clover, the reward delivery mechanism differs. Should the Entitlement track which POS type to use, or should PV auto-detect based on the merchant's active connections?
