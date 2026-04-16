# PerkValet — Consumer Reward Flow Development Plan

**Date:** April 16, 2026
**Status:** Draft — For review before implementation
**Scope:** Backend + Consumer App + Merchant Portal
**Prerequisite:** API Validation Report (Areas 1-6) reviewed

---

## Overview

This plan modifies the existing PV platform to support the complete real-life consumer reward experience across Square and Clover merchants with physical POS hardware.

**The consumer journey:**
1. Consumer visits a store, pays at the POS register → stamps accumulate → milestone reached → reward earned
2. Consumer opens PV app (at store or later) → sees earned reward → activates it when ready
3. On next visit: consumer opens PV app near the store → sees "You have a $3.00 reward" → tells associate
4. At the counter: associate enters phone number → applies the reward → consumer pays the discounted amount
5. PV detects the redemption via webhook → marks reward redeemed → cleans up

**What exists today vs what needs to change:**

| Component | Current State | What Changes |
|-----------|--------------|-------------|
| Stamp pipeline (pos.stamps.js) | Working — shared Square/Clover | Minor: stop creating Clover discount templates at milestone time |
| Square gift card rewards | Working — auto-creates on milestone | No change — gift card flow stays as-is |
| Clover discount delivery | Creates discount template at milestone time | **Major refactor**: create template only when consumer activates in app |
| Consumer app wallet | Shows earned rewards, gift cards | **Add**: Activate button, check-in, reward status, pending reward display |
| Consumer check-in | QR scan only (ScanPage.jsx) | **Add**: Geolocation check-in, manual check-in button |
| Store model | Address only, no coordinates | **Add**: latitude, longitude, geofenceRadiusMeters |
| Merchant portal store settings | Address, phone, contact | **Add**: Coordinates display, geofence radius control |
| ConsumerCheckin model | Does not exist | **New**: Analytics table for check-in tracking |
| Consumer /me/summary | Returns stamp counts + hasAccountIssue | **Modify**: Include pending reward info |

---

## Architecture: How Square and Clover Differ

The consumer experience is identical. The backend reward delivery mechanism differs by POS:

| Step | Square | Clover |
|------|--------|--------|
| Milestone earned | Gift card created + loaded with reward value | PosRewardDiscount created with status "earned" |
| Consumer activates | Gift card already exists — activation shows the barcode | PV creates discount template on Clover register via API |
| At the counter | Consumer shows barcode → associate scans as payment tender | Consumer gives name/phone → associate taps discount button on register |
| PV detects redemption | Payment webhook → gift card tender detected | Payment webhook → PV-branded discount found on order |
| Cleanup | Gift card stays (reusable for future rewards) | Discount template deleted from Clover register |

**The consumer app does NOT need to know which POS the merchant uses.** The `/me/wallet` and check-in endpoints return a unified response. The app shows the appropriate UI based on a `rewardDeliveryType` field ("giftcard" or "discount_template").

---

## Phase 1: Schema Changes

**Priority:** Must be done first — other phases depend on these models.

### 1a. Add coordinates to Store model

```
Store {
  ...existing fields...
  latitude            Float?
  longitude           Float?
  geofenceRadiusMeters Int    @default(150)   // 50-500, merchant-configurable
}
```

### 1b. Add ConsumerCheckin model

```
ConsumerCheckin {
  id              Int       @id @default(autoincrement())
  consumerId      Int
  storeId         Int
  merchantId      Int
  triggeredBy     String    // "geofence" | "manual" | "qr"
  hadPendingReward Boolean  @default(false)
  createdAt       DateTime  @default(now())

  consumer  Consumer @relation(...)
  store     Store    @relation(...)
  merchant  Merchant @relation(...)

  @@index([consumerId, storeId, createdAt])
  @@index([storeId, createdAt])
}
```

### 1c. Add rewardDeliveryType to PosRewardDiscount

Currently the model tracks Clover discounts. Add a field to distinguish delivery mechanisms:

```
PosRewardDiscount {
  ...existing fields...
  deliveryType    String    // "discount_template" | "giftcard"
}
```

Or alternatively, keep PosRewardDiscount for Clover only and rely on ConsumerGiftCard for Square. This is the current design — no change needed if we keep the two models separate.

### 1d. Modify PosRewardDiscount status values

Current: `pending`, `applied`, `failed`, `skipped`

Revised: `earned`, `activated`, `redeemed`, `expired`, `skipped`

- `earned` — milestone hit, reward recorded, no action taken on POS yet
- `activated` — consumer tapped Activate, Clover discount template created
- `redeemed` — associate applied the discount, detected in payment webhook
- `expired` — TTL or promotion expiry, template deleted from Clover
- `skipped` — discount guard rejected

---

## Phase 2: Store Coordinate Sync

### 2a. Square — Pull coordinates from Locations API

On merchant onboarding (after OAuth):
- Call `GET /v2/locations`
- For each location, store `coordinates.latitude` and `coordinates.longitude` on the PV Store record
- If coordinates are null (Square hasn't geocoded), geocode the address as fallback

On `location.updated` webhook:
- Re-sync coordinates for the affected location

**Files changed:** `src/pos/square.oauth.routes.js` (onboarding), `src/pos/square.webhook.routes.js` (location update handler)

### 2b. Clover — Geocode from address

On merchant onboarding (after OAuth):
- Read store address from `GET /v3/merchants/{mId}/address`
- Call Google Maps Geocoding API with the address
- Store resulting lat/lng on the PV Store record

On store address change (admin portal):
- Re-geocode

**New dependency:** Google Maps Geocoding API key (env var `GOOGLE_MAPS_API_KEY`)

**Files changed:** `src/pos/clover.oauth.routes.js` (onboarding), new utility `src/utils/geocode.js`

### 2c. Merchant portal — Store settings UI

- Display store coordinates (read-only for Square, editable override for Clover)
- Geofence radius slider: 50-500 meters, default 150
- "Test Check-in" button — simulates a check-in for QA

**Files changed:** `admin/src/pages/MerchantStoreEdit.jsx`

---

## Phase 3: Consumer Check-in Endpoint

### 3a. Backend: POST /consumer/checkin

**New file:** `src/consumer/consumer.checkin.routes.js`

```
POST /consumer/checkin
  Auth: requireConsumerJwt
  Body: { storeId, triggeredBy: "geofence" | "manual" | "qr" }

  1. Validate store exists and consumer has active promotions there
  2. Deduplicate: skip if consumer checked in at same store within 2 hours
  3. Fetch consumer's current state:
     - Stamp count + milestone progress (ConsumerPromoProgress)
     - Pending rewards:
       - Square: ConsumerGiftCard with balance > 0
       - Clover: PosRewardDiscount with status "earned" or "activated"
  4. Create ConsumerCheckin record
  5. Fire pvHook: consumer.checkin
  6. Return unified response:
     {
       storeName, merchantName,
       programs: [{ name, stampCount, threshold, stampsToNext }],
       pendingRewards: [{ id, description, value, type, status, activatable }],
       checkinId
     }
```

**Key design:** The `pendingRewards` array is POS-agnostic. Each reward has:
- `type`: "giftcard" (Square) or "discount" (Clover)
- `status`: "earned" (can be activated) or "activated" (ready to use at counter)
- `activatable`: true if the consumer can tap Activate (Clover earned, or Square with no barcode shown yet)

### 3b. Backend: GET /consumer/stores/nearby

**New endpoint** — returns stores near the consumer's current location.

```
GET /consumer/stores/nearby?lat={lat}&lng={lng}&radiusMeters={radius}
  Auth: requireConsumerJwt

  1. Query stores with coordinates within radius (Haversine or bounding box)
  2. Filter to stores where consumer has active promotions
  3. Return: [{ storeId, storeName, merchantName, distance, hasActivePromo, hasPendingReward }]
```

This powers the consumer app's location-aware store list and geofence registration.

---

## Phase 4: Consumer Reward Activation

This is the critical change — decoupling reward creation from POS-side staging.

### 4a. Backend: POST /me/wallet/{entitlementId}/activate

**New endpoint** in `consumer.wallet.routes.js`

```
POST /me/wallet/{entitlementId}/activate
  Auth: requireConsumerJwt

  1. Validate entitlement: exists, belongs to consumer, status is "active", type is "reward"
  2. Determine POS type for this merchant:
     - Find PosConnection (square or clover)
  3. Branch by POS type:

     CLOVER:
       a. Find PosRewardDiscount with status "earned" linked to this entitlement
       b. Create discount template on Clover: POST /v3/merchants/{mId}/discounts
          { name: "PerkValet — {firstName} {lastInitial}. ${amount} off", amount: -{cents} }
       c. Update PosRewardDiscount: status "earned" → "activated", store templateId
       d. Return { activated: true, type: "discount", instructions: "Tell the associate to apply your PerkValet discount" }

     SQUARE:
       a. Gift card already exists from milestone (created by issueGiftCardReward)
       b. No POS-side action needed — the gift card is already loaded
       c. Update entitlement metadata to flag as "activated" (for UI display)
       d. Return { activated: true, type: "giftcard", instructions: "Show your gift card barcode to the cashier" }

  4. Fire pvHook: consumer.reward.activated
```

### 4b. Refactor pos.stamps.js milestone handler

**Current behavior:** On milestone, calls `issueGiftCardReward()` (Square) or `issueCloverDiscountReward()` (Clover, which creates a discount template immediately).

**New behavior:**
- **Square:** Still calls `issueGiftCardReward()` — gift card must exist before consumer can activate/present it. No change.
- **Clover:** Creates `PosRewardDiscount` with status `"earned"` only. Does NOT create the Clover discount template. Template is created later when consumer activates (Phase 4a).

**Files changed:** `src/pos/pos.stamps.js`, `src/pos/pos.clover.discount.js`

### 4c. Template TTL / Expiry

Background job (cron or lazy check):
- Find PosRewardDiscount with status "activated" and `updatedAt` older than TTL (default 24h, configurable)
- Delete the discount template from Clover: `DELETE /v3/merchants/{mId}/discounts/{templateId}`
- Reset status: "activated" → "earned"
- Consumer can re-activate when ready

**Files changed:** New cron job or add to existing daily job

---

## Phase 5: Redemption Detection in Payment Webhook

### 5a. Clover — Detect discount template usage

**In `clover.webhook.routes.js` payment handler:**

After visit creation and consumer resolution:
1. Fetch the order with discounts expanded
2. Scan order discounts for PV-branded names (match pattern "PerkValet —" or look up by stored template ID)
3. If found:
   - Match to PosRewardDiscount record
   - Update status: "activated" → "redeemed"
   - Update Entitlement: "active" → "redeemed"
   - Delete the discount template from Clover (cleanup)
   - Fire pvHook: `clover.discount.redeemed`

**Files changed:** `src/pos/clover.webhook.routes.js`

### 5b. Square — Gift card tender detection

**Already implemented.** The existing Square webhook handler detects gift card tenders and logs REDEEMED events. No changes needed.

**Verify:** When a gift card tender is detected, also update the Entitlement status to "redeemed" if it isn't already.

**Files changed:** `src/pos/square.webhook.routes.js` (minor — ensure entitlement status update)

---

## Phase 6: Consumer App Changes

### 6a. Geolocation check-in (foreground)

**On app open or tab focus:**
1. Request geolocation permission (`navigator.geolocation`)
2. Get current position
3. Call `GET /consumer/stores/nearby?lat=...&lng=...`
4. If consumer is within a store's geofence radius:
   - Auto-fire `POST /consumer/checkin` with `triggeredBy: "geofence"`
   - Show banner: "You're at {storeName}!" with reward status

**Files changed:** `consumer-app/src/App.jsx` or new `useGeolocation.js` hook

### 6b. Manual check-in button

**In Wallet.jsx or a new CheckIn component:**
- "Check In" button visible when the consumer has active promotions
- Tapping it calls `POST /consumer/checkin` with `triggeredBy: "manual"`
- Shows the same reward status response

**Files changed:** `consumer-app/src/pages/Wallet.jsx`, `consumer-app/src/api.js`

### 6c. Reward activation UI

**In the wallet reward card:**

Current: Reward card shows status and "Redeem at Store" button.

New states:

| Reward Status | What Consumer Sees | Action Available |
|--------------|-------------------|-----------------|
| **Earned** (Clover) | "Reward ready — $3.00 off" | **"Activate"** button |
| **Activated** (Clover) | "Active! Tell the associate to apply your PerkValet discount, or give them your phone number" | "Deactivate" option |
| **Earned** (Square) | "Reward ready — $3.00 credit on your gift card" | **"Show Barcode"** button |
| **Showing barcode** (Square) | Gift card barcode displayed for cashier to scan | Timer / auto-dismiss |
| **Redeemed** | "Redeemed at {store} on {date}" | None — history item |

**Files changed:** `consumer-app/src/pages/Wallet.jsx`, `consumer-app/src/api.js` (add `activateReward`, `checkin`, `getNearbyStores`)

### 6d. Check-in notification banner

**New component or modification to Wallet.jsx:**

When check-in returns pending rewards:
- Amber banner at top: "You're at Brewed Awakening! You have a $3.00 reward ready."
- Tap banner → scrolls to the reward card with Activate button highlighted

**Files changed:** `consumer-app/src/pages/Wallet.jsx`

---

## Phase 7: Merchant Portal Changes

### 7a. Store settings — Coordinates and geofence

**In MerchantStoreEdit.jsx:**
- Display latitude/longitude (read-only for Square, editable for Clover)
- Geofence radius slider: 50-500m, default 150m
- "Re-geocode" button for Clover (if address changed)
- "Test Check-in" button (simulates a consumer check-in for this store)

**Files changed:** `admin/src/pages/MerchantStoreEdit.jsx`

### 7b. Backend — Store update endpoint

Ensure `PATCH /merchants/me/stores/:id` accepts `latitude`, `longitude`, `geofenceRadiusMeters` fields.

**Files changed:** `src/merchant/merchant.routes.js` or `src/store/store.routes.js`

### 7c. Analytics — Check-in reporting

**New section in merchant dashboard or reports:**
- Check-ins per store per week (geofence vs manual breakdown)
- Check-in to transaction conversion rate
- Most active check-in times

**Data source:** `ConsumerCheckin` joined to `Visit` by consumerId + storeId + date

**Files changed:** New report endpoint + admin UI component

---

## Phase 8: Cleanup and Hardening

### 8a. Remove order UPDATE pre-payment handler

The `handleCloverOrderUpdate` function in `clover.webhook.routes.js` was built to inject discounts on order updates before payment. With the discount template approach, this is no longer needed. Remove it to avoid confusion.

**Files changed:** `src/pos/clover.webhook.routes.js`

### 8b. Clover webhook: remove direct order discount application from payment handler

The payment handler currently tries to apply pending discounts to the order. With discount templates, the associate applies the discount on the register. The payment handler only needs to DETECT that it was applied. Remove the `applyPendingCloverRewards` call from the payment flow.

**Files changed:** `src/pos/clover.webhook.routes.js`

### 8c. Rate limit handling

Add retry with exponential backoff for Clover API calls (we hit 429 during sandbox testing). Clover's production limit is 16 req/s per token.

**Files changed:** `src/pos/pos.clover.discount.js` (cloverRequest function)

### 8d. Template cleanup cron

Daily job to:
- Delete expired discount templates from Clover (TTL exceeded)
- Clean up orphaned PosRewardDiscount records
- Reconcile gift card balances (Square — already built)

**Files changed:** New or extend existing cron job

---

## Implementation Order

| Order | Phase | Dependency | Estimated Tests |
|-------|-------|-----------|----------------|
| 1 | Phase 1: Schema changes | None | 0 (migration only) |
| 2 | Phase 2: Store coordinate sync | Phase 1 | 4-5 |
| 3 | Phase 3: Check-in endpoint | Phase 1 | 6-8 |
| 4 | Phase 4: Reward activation | Phase 1, Phase 3 | 6-8 |
| 5 | Phase 5: Redemption detection | Phase 4 | 4-5 |
| 6 | Phase 6: Consumer app changes | Phase 3, Phase 4 | 3-4 (component tests) |
| 7 | Phase 7: Merchant portal | Phase 1, Phase 2 | 2-3 |
| 8 | Phase 8: Cleanup | Phase 4, Phase 5 | 2-3 |

**Estimated total: ~30-35 new tests**

---

## What Does NOT Change

| Component | Why No Change |
|-----------|--------------|
| pos.stamps.js (core stamp logic) | Stamp accumulation is transaction-driven, not check-in-driven |
| Square gift card creation on milestone | Gift card must exist before consumer can present it |
| Square webhook payment handler | Gift card tender detection already works |
| Consumer OTP auth flow | Phone-based identity unchanged |
| Merchant onboarding OAuth | OAuth flow unchanged (coordinate sync is a post-OAuth step) |
| QR scan visit flow | Existing QR check-in continues to work alongside geolocation |

---

## End-to-End Flow After Implementation

### Clover Merchant

```
Visit 1:  Consumer pays → webhook → stamps 1/2
Visit 2:  Consumer pays → webhook → stamps 2/2 → MILESTONE
          → Entitlement created (active)
          → PosRewardDiscount created (earned)
          → Consumer wallet: "You earned $3.00 off!"

Consumer opens app near store:
          → Geolocation detects proximity
          → POST /consumer/checkin
          → Banner: "You're at Brewed Awakening! You have a $3.00 reward"
          → Consumer taps "Activate"
          → POST /me/wallet/{id}/activate
          → PV creates discount template on Clover register
          → App shows: "Active! Tell the associate"

Visit 3:  Consumer tells associate "I have a PerkValet reward"
          → Associate taps Discount on register
          → Sees "PerkValet — Jane D. $3.00 off" → taps it
          → Order total reduced → consumer pays less
          → Payment webhook → PV detects PV-branded discount
          → PosRewardDiscount: redeemed
          → Entitlement: redeemed
          → Template deleted from Clover
```

### Square Merchant

```
Visit 1:  Consumer pays → webhook → stamps 1/2
Visit 2:  Consumer pays → webhook → stamps 2/2 → MILESTONE
          → Entitlement created (active)
          → Gift card created + loaded with $3.00
          → Consumer wallet: "You earned $3.00 credit!"

Consumer opens app near store:
          → Geolocation detects proximity
          → POST /consumer/checkin
          → Banner: "You're at Coffee Corner! You have a $3.00 credit"
          → Consumer taps "Show Barcode"
          → Gift card barcode displayed on phone screen

Visit 3:  Consumer shows barcode to cashier
          → Cashier scans as payment tender
          → $3.00 deducted from gift card, rest charged to credit card
          → Payment webhook → PV detects gift card tender
          → Entitlement: redeemed
          → Gift card balance updated
```

---

## Open Questions

1. **Geofence TTL** — How long should an activated Clover discount template stay on the register? Default 24h? Configurable per merchant?

2. **Multiple rewards** — If consumer has 2 pending rewards at the same merchant, do we create 2 separate discount templates on Clover? Or combine into one?

3. **Cross-store redemption** — Can a consumer earn stamps at Store A and redeem at Store B (same merchant)? Current pipeline supports this — confirm it should continue.

4. **Offline resilience** — What happens if the consumer activates a reward but the Clover API is down? Queue and retry? Show "activation pending" in the app?

5. **Square gift card minimum** — Square requires a minimum amount for gift card activation. Is $1.00 the minimum? Does this affect small rewards?

6. **Notification strategy** — Push notifications (Web Push API) vs in-app only for check-in alerts? Push requires separate permission flow.
