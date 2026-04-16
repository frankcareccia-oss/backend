# PerkValet — Toast POS API Validation Report (Phase 10)

**Date:** April 16, 2026
**Status:** Research complete — No implementation code
**Prerequisite:** Waves 1 (Clover) and 2 (Square) complete

---

## Summary

Toast's API architecture is fundamentally different from Square and Clover. Key differences: partner-gated access (not merchant plan-based), pre-configured discounts only (no dynamic names), weak customer identity for in-store orders, and a restricted gift card API. PV can integrate with Toast for stamp accrual, but reward delivery requires a different approach.

---

## Area-by-Area Findings

### 1. Discounts

**Can apply discounts to orders, but only pre-configured ones.**

- **Endpoint:** `PATCH /orders/{orderGuid}` — add `appliedDiscounts` to a check
- **Constraint:** Discounts must reference a `discountGuid` from the restaurant's config (`GET /config/v2/discounts`)
- **Dynamic names:** NOT supported. Cannot create "PerkValet — Jane D. $3.00 off" on the fly like Clover
- **Before payment:** Yes — can apply while order is open
- **Gap:** Must pre-create a generic "PerkValet Reward" discount in each Toast restaurant's config during onboarding

**Recommended approach:** During merchant onboarding, create a "PerkValet Reward" discount in the Toast restaurant config. When consumer activates, PV applies that discount to the current order. Less personalized than Clover (no consumer name in discount label), but functional.

### 2. Gift Cards

**API exists but is partner-restricted.**

- **Endpoints:** `POST /giftCards/activate`, `POST /giftCards/addValue`, `GET /giftCards/{cardNumber}`
- **Access:** Requires Toast's explicit approval + gift card partnership agreement
- **Gap:** NOT available to standard API consumers. Significant blocker.

**Recommended approach:** Do not use Toast gift cards for v1. Use the discount approach instead.

### 3. Customer Identity

**Weak for in-store transactions.**

- Customer data (`firstName`, `lastName`, `email`, `phone`) is on the order's `check.customer` object
- For dine-in POS orders, customer data is **often absent** — primarily populated for online/delivery orders
- No `POST /customers` creation endpoint
- No customer search API

**Gap:** This is the biggest risk. If the server doesn't enter a customer on the order, PV cannot attribute the visit to a consumer. Same fundamental problem as Square/Clover but worse — Toast has no customer management tools.

**Recommended approach:** PV's QR check-in or phone entry at the table becomes critical for Toast merchants. Cannot rely on POS-side customer association.

### 4. Webhooks

**Order-based only.**

- Primary event: order created/updated/paid
- Payload: full order object with checks, payments, selections, customer (if present)
- No dedicated payment or customer webhooks
- Webhook URL configured during partner onboarding, not via API
- Webhook includes `restaurantGuid` for location routing

**Adequate for stamp accrual.** PV receives order/payment data and can extract customer info when present.

### 5. Multi-Location

**Supported via `restaurantGuid`.**

- Each API call requires `Toast-Restaurant-External-ID` header
- Webhooks include restaurant GUID
- Partner credentials work across all restaurants that install the app
- Similar to Clover's per-merchant model but with a single auth token

### 6. Store Coordinates

**Available.**

- **Endpoint:** `GET /restaurants/{restaurantGuid}` returns `location.latitude` and `location.longitude`
- Direct pull like Square — no geocoding needed

### 7. Plan Tiers

**Not merchant plan-based — partner-gated.**

- API access is granted to **partners**, not merchants
- PV must apply to Toast Developer Portal and get approved
- Some APIs (gift cards, labor) require additional partnership agreements
- Merchants install PV from Toast Marketplace — no per-merchant OAuth

### 8. Rate Limits

- **100 requests per second per restaurant** — generous
- 429 on exceed with retry guidance
- Well above what PV needs

### 9. Pre-staged Rewards

**Not available.** No mechanism to attach discount to customer profile. Discounts are order-level only.

### 10. Authentication

**Client-credentials OAuth** — different from Square/Clover's per-merchant OAuth.

- `POST /authentication/v1/authentication/login` with `clientId` + `clientSecret`
- One credential set per partner app
- Target specific restaurant via `Toast-Restaurant-External-ID` header
- Merchants install from Marketplace — PV doesn't need per-merchant OAuth flows

---

## Comparison Table

| Capability | Square | Clover | Toast |
|-----------|--------|--------|-------|
| Dynamic discount names | No (gift card) | Yes (templates) | **No** (pre-configured only) |
| Gift card API | Full | No virtual cards | **Partner-restricted** |
| Customer in webhook | If associated | If associated | **Often absent in-store** |
| Pre-staged rewards | No | No | No |
| Multi-location | Single OAuth | Per-location OAuth | **Single partner auth** |
| Store coordinates | Yes | No (geocode) | **Yes** |
| Rate limit | ~20-30/s | 16/s | **100/s** |
| Access model | Open API | Open API | **Partner approval** |
| Discount before payment | No (gift card) | Yes (template) | **Yes** (if pre-configured) |

---

## Recommended Toast Reward Delivery Approach

### Option A: Pre-configured Discount (Recommended for v1)

1. **Onboarding:** Create a "PerkValet Reward" discount in Toast restaurant config (manual step during merchant setup, or via config API if available)
2. **Milestone:** PV records reward earned (same as Clover)
3. **Activation:** Consumer activates in PV app → PV notes it's ready
4. **At register:** Server applies "PerkValet Reward" discount to the check → Toast API `PATCH /orders/{orderGuid}` with the discount GUID
5. **Detection:** Order webhook shows the discount was applied → PV marks redeemed

**Pros:** Works within Toast API constraints. Discount applied before payment.
**Cons:** Generic name ("PerkValet Reward" not "PerkValet — Jane D. $3.00 off"). Requires the server to know to apply it. May need PV-side integration with Toast POS UI (Flex SDK) for a smoother UX.

### Option B: Future — Toast Flex UI SDK

Toast offers a **Flex UI SDK** for embedding custom UI in the POS. This could show a "PerkValet Rewards" panel on the server's screen with customer-specific rewards. More investment but much better UX.

---

## Phase 11 Scope (When Ready to Build)

| Task | Effort |
|------|--------|
| Pull store coordinates from Toast Restaurant API | Low |
| Adapt webhook handler for Toast order format (already partially built) | Low |
| Create "PerkValet Reward" discount in Toast config during onboarding | Medium (may need manual step) |
| Apply discount via PATCH /orders/{orderGuid} on activation | Medium |
| Detect discount in order webhook → mark redeemed | Low |
| Consumer app: no changes (POS-agnostic) | None |
| Tests | ~6-8 |

**Estimated Phase 11 effort:** ~60% of Clover's Phase 4-5 work. The infrastructure is all built.

---

## Open Questions for Toast

1. **Partner approval timeline** — How long does Toast take to approve a developer partner? This blocks everything.
2. **Config API write access** — Can PV create the "PerkValet Reward" discount via API during onboarding, or must it be done manually in Toast's restaurant admin?
3. **Customer data improvement** — Can Toast's Marketplace listing encourage servers to enter customer phone? Or does PV need to handle identity entirely through QR check-in?
4. **Flex UI SDK** — Is this available to all partners or a separate tier? Timeline to integrate?
