# PerkValet API Validation Report — Square & Clover

**In response to:** PerkValet API Validation Brief (April 15, 2026)
**Prepared by:** Claude Code
**Date:** April 16, 2026
**Status:** Research complete — No implementation code written

---

## Area 1: Consumer On-Premises Notification

### Business Requirement
When a consumer opens the PV mobile app and checks in at a merchant location, PV needs to notify the POS system that a specific consumer is on premises — before a transaction is opened.

### Finding: Square

**The capability does NOT exist.** Square has no check-in, presence, or pre-transaction customer notification API.

- No endpoint like `POST /v2/locations/{id}/checkins` or equivalent
- No mechanism to push a notification to the Square POS screen that a customer has arrived
- The customer is only associated with a transaction at payment time — either by the cashier manually looking them up, or by the buyer using a card on file

**Endpoint(s):** None applicable. `POST /v2/loyalty/accounts/search` can look up a loyalty account by phone, but this is a data query from PV's side — it does not notify the POS.

**Plan Tier:** N/A — capability does not exist on any tier.

**Limitations:** Square's POS model is transaction-initiated, not presence-initiated.

### Finding: Clover

**The capability does NOT exist via REST API.** Clover has no check-in or presence API.

- No endpoint like `POST /v3/merchants/{mId}/checkins`
- Clover does have a **Messaging/Intent system** for on-device Android apps (`CustomActivity`), but this requires a native Android APK installed on the Clover device — not accessible via REST API
- A cloud-only integration cannot push a notification to the POS screen

**Endpoint(s):** None via REST API. Android SDK `CustomActivity` is the only path.

**Plan Tier:** N/A via REST. Android SDK available on Register plan and above.

**Limitations:** On-device Android app required. Clover App Market approval process takes 4-8 weeks.

### Gap

**Both platforms: Full gap.** Neither Square nor Clover supports pre-transaction consumer presence notification via API.

### Recommended Approach

1. **QR-based check-in (already built):** Consumer scans a QR code at the store → PV backend records the check-in → PV pre-fetches the consumer's profile, pending rewards, and purchase history. This data is available instantly when the cashier asks for the phone number.

2. **Pre-fetch on consumer app open:** When the consumer opens the PV app near a known merchant location (geofence or manual store selection), PV pre-loads their reward status. The consumer can show this screen to the associate.

3. **Future: Clover on-device app** could listen for PV check-in events and display a notification on the register screen. This is a separate project.

**Net impact:** The POS itself won't know the customer is present, but PV can pre-stage the data so lookup is instant once the phone number is entered. The cashier adds 5 seconds to type a phone number — acceptable for v1.

---

## Area 2: Pre-Staged Reward Discount

### Business Requirement
When a consumer earns a reward milestone, PV stages a discount against that consumer's profile in the POS system. On their next visit, the discount is automatically surfaced and applied.

### Finding: Square

**No way to attach a pending discount to a customer profile that auto-applies at checkout.**

- **Catalog API** (`POST /v2/catalog/object` type `DISCOUNT`) creates global discount definitions — not customer-specific
- **Orders API** (`PUT /v2/orders/{id}` with `discounts` array) can attach discounts to a specific order — but requires programmatic order creation, not available on the POS screen automatically
- **Loyalty API** (`POST /v2/loyalty/rewards`) creates rewards tied to a loyalty account that can be redeemed — but requires the merchant to use Square Loyalty ($45/mo per location)
- **Gift Cards API** (`POST /v2/gift-cards`, `POST /v2/gift-cards/activities`) — this is the working approach: load funds onto a digital gift card, consumer presents it at next visit as a payment tender

**Endpoint(s):** `POST /v2/gift-cards`, `POST /v2/gift-cards/activities` (ACTIVATE, LOAD)

**Plan Tier:** Gift Cards must be enabled on the merchant's Square account (included in Plus/Premium, or paid add-on on lower tiers).

**Limitations:**
- Discount is delivered as a gift card balance, not as a named order discount
- Consumer must present the gift card (barcode in PV app) at checkout — cashier scans it
- Split tender is handled automatically by Square POS (part gift card, part credit card)
- The cashier does NOT need to do math — the POS handles it

**Gap:** No auto-apply. The consumer must present the gift card. The cashier scans it as a payment method.

### Finding: Clover

**No way to auto-apply a discount based on customer identity.** But a workable alternative exists.

- **Discount Templates** (`POST /v3/merchants/{mId}/discounts`) create named discounts that appear as tappable buttons on the Clover Register
- Discounts are **not** customer-specific — they appear for all cashiers on all orders
- There is **no mechanism** to tie a discount to a customer record for auto-application
- The cashier must manually tap the discount button during the order

**Endpoint(s):** `POST /v3/merchants/{mId}/discounts` (create template), `DELETE /v3/merchants/{mId}/discounts/{id}` (cleanup after use)

**Plan Tier:** Register plan and above ($49.95/mo+). Essentials may have limited discount support.

**Limitations:**
- Cashier must manually select the discount — not automatic
- Discount template is visible to all cashiers (not filtered by customer)
- Must be cleaned up after redemption to avoid register clutter
- Dynamic naming is supported — PV sets the `name` field (e.g., "PerkValet — Jane D. $3.00 off")

**Validated on sandbox (April 15, 2026):**
- Created discount template via API → confirmed visible on Clover dashboard Discounts page
- Clover confirms: "These will show up when you hit the Discount button while editing a line item or at the bottom of your Register"
- Discount name appears on the receipt exactly as set by PV

**Gap:** Not automatic. Cashier must tap the discount. Consumer-specific naming mitigates wrong-customer risk.

### Recommended Approach

| Platform | Mechanism | Cashier Action | Consumer Action |
|----------|-----------|---------------|-----------------|
| **Square** | Gift card (digital) | Scans barcode from consumer's phone | Opens PV app, shows gift card barcode |
| **Clover** | Named discount template | Taps "PerkValet — Jane D. $3.00 off" button on register | Tells associate "I have a PerkValet reward" or gives phone # |

**Discount guard (both platforms):** PV must ensure the reward value does not exceed the order total. For Square, the gift card handles this naturally (partial tender). For Clover, the POS itself caps the discount at the order total.

**Discount name (Clover):** Fully dynamic. PV controls the `name` field. Can include consumer name, reward amount, promo name.

**Order-level vs line-item discounts (Clover):** Both work via API. Order-level is simpler for "$ off" rewards. Line-item is better for "free specific item" rewards. Both show on the receipt.

---

## Area 3: Phone Number Identity Consistency

### Business Requirement
PV uses phone number as the primary consumer identity key. Phone matching must work consistently.

### Finding: Square

- **Phone in webhook:** NOT directly included in `payment.completed` webhook payload. The webhook includes `customer_id` (if a customer was associated). You must call `GET /v2/customers/{customer_id}` to get the phone number. **This is an additional API call per webhook.**
- **customer_id presence:** Only present when the cashier associated a customer with the transaction, OR the buyer used a card on file / Square Loyalty. For anonymous card-present transactions, there may be **no customer_id at all.**
- **Phone format:** Square stores `phone_number` as a string. Not strictly E.164 — merchants can enter numbers in various formats. PV must normalize.
- **Cross-location consistency:** Customers are shared across all locations under one seller account. One `customer_id` = one person everywhere. **This is good.**
- **Manual vs screen entry:** Both result in the same customer record. No difference in webhook behavior.

**Endpoint(s):** `GET /v2/customers/{id}` for phone lookup after webhook.

**Plan Tier:** Free (Customers API available on all plans).

**Limitations:**
- Extra API call needed per webhook to get phone
- Phone not guaranteed on every transaction
- Format varies — normalization required

### Finding: Clover

- **Phone in webhook:** NOT included. Clover webhooks only send `{objectId, type, ts}`. You need **3 API calls minimum**: fetch payment → fetch order (with customers expand) → fetch customer phone numbers.
- **Phone format:** Clover does NOT enforce any format. You may get `(555) 123-4567`, `5551234567`, `+15551234567`, etc. **Highly inconsistent.** PV must normalize aggressively.
- **Cross-location consistency:** **Customers are siloed per merchant ID (location).** A customer at Location A is a completely different record than the same person at Location B. No cross-location customer unification.
- **Manual vs screen entry:** Both create the same customer record format. No difference.
- **Phone availability:** Customer is only associated with an order if the cashier explicitly adds them. **Not guaranteed on any given transaction.**

**Endpoint(s):** `GET /v3/merchants/{mId}/orders/{oId}?expand=customers`, `GET /v3/merchants/{mId}/customers/{id}?expand=phoneNumbers`

**Plan Tier:** Essentials and above for customer features.

**Limitations:**
- 3 API calls per webhook to get phone (rate limit risk at 16 req/s)
- Phone not guaranteed
- Format wildly inconsistent
- Customers siloed per location — PV must unify

### Gap

**Both platforms:** Phone number is never guaranteed on a transaction. If the cashier doesn't associate a customer, PV cannot attribute the visit. This is the single biggest risk to the PV architecture.

### Recommended Approach

1. **PV is already the source of truth for consumer identity.** PV's `Consumer.phoneE164` is the canonical identifier. POS customer records are resolved by phone match, not the other way around.

2. **Normalize aggressively.** Strip all non-digits, apply country code rules. Already implemented in both adapters.

3. **Encourage customer association.** Merchant training: "Always ask for the phone number." This is the same friction every loyalty program has (Starbucks, etc.).

4. **Fallback: Card fingerprint matching (Square only).** Square provides a card fingerprint that persists across transactions. Could be used to auto-match repeat customers even without phone entry. Not yet implemented — future enhancement.

5. **Multi-location unification (Clover):** PV already handles this — `Consumer.phoneE164` is unique, and PV resolves Clover customer records to PV consumers by phone across all locations.

---

## Area 4: Multi-Location Webhook Architecture

### Finding: Square

**Single OAuth connection covers all locations. Each webhook includes location_id.**

- **OAuth:** One OAuth authorization per seller account covers all locations
- **Webhooks:** `POST /v2/webhooks/subscriptions` subscribes to events across ALL locations. Cannot filter to a subset.
- **location_id:** Present in the `payment` object within the webhook payload
- **Location enumeration:** `GET /v2/locations` returns all locations under the seller account — available for merchant onboarding UI

**Endpoint(s):** `POST /v2/webhooks/subscriptions`, `GET /v2/locations`

**Plan Tier:** Free for API/webhooks. Merchant needs Square Plus or higher to actually have multiple locations configured.

**Limitations:** Cannot subscribe to a subset of locations. Must filter in webhook handler. Minor concern.

**Rate limits:** No per-location rate limits. Limits are per-seller per-application. 1000+ txns/day across all locations is well within limits.

### Finding: Clover

**Each location requires its own OAuth authorization and webhook setup.**

- **OAuth:** Each Clover merchant ID (= location) goes through a separate OAuth flow and generates its own `access_token`
- **Webhooks:** Configured per-app in the developer dashboard (not per-merchant via API). One webhook URL receives events from ALL merchants who install the app. But each merchant's events are tagged with their merchant ID.
- **Location identification:** The merchant ID in the webhook identifies the location
- **Location enumeration:** When a multi-location chain installs the app, each location triggers a separate installation. No "list all locations for this chain" API.

**Endpoint(s):** OAuth per merchant ID. Webhook URL is per-app (developer dashboard).

**Plan Tier:** Any plan that supports third-party apps (Essentials+).

**Limitations:**
- N OAuth tokens for N locations (your `PosConnection` table handles this)
- No "enterprise" view of all locations under one merchant group
- Onboarding a 10-location chain = 10 separate OAuth flows
- Rate limits are per-token (16 req/s) — each location has its own quota

### Gap

**Clover:** Multi-location onboarding is manual and repetitive. No API to "install for all locations at once."

### Recommended Approach

1. **Square:** Already well-suited. Single OAuth + location_id filtering. Already implemented.

2. **Clover:** Accept the per-location OAuth model. Streamline onboarding:
   - After first location connects, prompt merchant to connect additional locations
   - Each triggers its own OAuth flow but PV pre-fills the merchant context
   - Store all `PosConnection` records under one PV `Merchant` — already implemented

3. **Webhook routing:** Both platforms' webhooks include location identifiers. PV's `PosLocationMap` table handles the routing. Already implemented.

---

## Area 5: Plan Tier Summary

### Square Plan Requirements

| PV Capability | Square Endpoint | Minimum Plan | Notes |
|--------------|----------------|-------------|-------|
| Customer lookup | `/v2/customers/*` | **Free** | Available on all plans |
| Webhook subscriptions | `/v2/webhooks/subscriptions` | **Free** | Available on all plans |
| Catalog sync | `/v2/catalog/*` | **Free** | Available on all plans |
| Payment processing | `/v2/payments/*` | **Free** | Available on all plans |
| Orders API | `/v2/orders/*` | **Free** | Available on all plans |
| Gift card rewards | `/v2/gift-cards/*` | **Plus or add-on** | Must be enabled; not on bare Free plan |
| Multi-location | Inherent in API | **Plus** | Merchant needs Plus to manage multiple locations |
| Square Loyalty (native) | `/v2/loyalty/*` | **Loyalty add-on (~$45/mo/location)** | NOT needed — PV builds its own loyalty |

**Minimum for PV:** Merchant on **Square Free** for core functionality. **Square Plus or Gift Card add-on** for gift card reward delivery.

### Clover Plan Requirements

| PV Capability | Clover Endpoint | Minimum Plan | Notes |
|--------------|----------------|-------------|-------|
| Customer lookup | `/v3/merchants/{mId}/customers` | **Essentials ($14.95/mo)** | Starter is insufficient |
| Payment webhooks | Webhook subscription (developer dashboard) | **Essentials** | All payment-processing plans |
| Discount templates | `/v3/merchants/{mId}/discounts` | **Register ($49.95/mo)** | Essentials may have limited discount support |
| Order details + line items | `/v3/merchants/{mId}/orders` | **Essentials** | |
| Catalog sync | `/v3/merchants/{mId}/items` | **Essentials** | |
| Customer-facing display | Android SDK `CustomActivity` | **Register + compatible hardware** | Requires Clover Station Duo or Mini |
| On-device loyalty app | Android SDK | **Register** | Requires app market approval (4-8 weeks) |

**"Customer Engagement Plus" ($99/mo):** Does NOT unlock additional API capabilities for third-party developers. It adds Clover-native marketing features (emails, feedback, reputation). **Not relevant to PV.**

**Minimum for PV:** Merchant on **Clover Register ($49.95/mo)** for discount template functionality. **Essentials** works for stamp accrual only (no discount delivery).

### Capabilities NOT Available via API on Any Plan

| Capability | Square | Clover |
|-----------|--------|--------|
| Pre-transaction customer check-in | Not available | Not available (REST). Android SDK only. |
| Auto-apply discount per customer at checkout | Not available | Not available (REST). Android SDK only. |
| Virtual gift card creation | **Available** | **NOT available** — physical card stock only |
| Push notification to POS screen | Not available | Not available (REST). Android SDK only. |

---

## Rate Limit Summary

| Platform | Limit | Scope | Impact |
|----------|-------|-------|--------|
| **Square** | ~20-30 req/s | Per-seller, per-application | Comfortable for 1000+ txns/day |
| **Clover** | 16 req/s | Per-token (per-location) | Tight when 3+ calls needed per webhook. Cache customer data. |
| **Clover sandbox** | More aggressive than production | Per-token | Expect 429 errors during testing — production will be better |

---

## Summary: Gaps and Recommended Approaches

| # | Requirement | Square | Clover | Impact |
|---|-----------|--------|--------|--------|
| 1 | Consumer check-in / presence | **Gap** — no API | **Gap** — no REST API (Android SDK only) | Medium — QR check-in workaround exists |
| 2 | Pre-staged auto-apply discount | **Gap** — no auto-apply; gift card is the workaround | **Gap** — no auto-apply; discount template is the workaround | High — core reward UX depends on this |
| 3 | Phone in webhook | **Partial** — requires extra API call; not always present | **Partial** — requires 3 API calls; not always present; format inconsistent | High — attribution breaks without phone |
| 4 | Multi-location webhooks | **Full support** — single OAuth, location_id in events | **Partial** — per-location OAuth, but webhook URL is global | Medium — manageable with onboarding flow |
| 5 | Plan tier requirements | **Free** for core; **Plus/add-on** for gift cards | **Register ($49.95)** for discounts; Essentials for stamps only | Low — reasonable merchant cost |

### Critical Path Items

1. **Phone number availability is the #1 risk.** Both platforms only include customer data when the cashier explicitly associates the customer. Merchant training is essential. No technical workaround exists.

2. **Reward delivery is platform-specific.** Square uses gift cards (consumer presents barcode). Clover uses discount templates (cashier taps button). Neither auto-applies. Both require one human action at checkout.

3. **Clover on-device app is the long-term play.** For auto-apply discounts, customer-facing display, and check-in notification, a Clover Android app is the only path. This is a separate project phase.

4. **Geofencing is PV-owned** (see Area 6 below). Neither POS platform provides proximity detection. PV builds this in the consumer mobile app using native platform APIs. This is POS-agnostic — works identically across Square, Clover, Toast, or any future POS.

---

## Area 6: Geolocation & Proximity

### Business Requirement
PV needs to detect when a consumer is physically near a merchant's store and pre-stage the checkout experience — surfacing pending rewards, stamp progress, and store context before the consumer reaches the counter.

### Finding: Square

**No geofencing, proximity, or beacon API exists.** Square provides store coordinates only.

| Capability | Status | Details |
|-----------|--------|---------|
| Store coordinates (lat/lng) | **Available** | `GET /v2/locations` returns `coordinates.latitude` and `coordinates.longitude` when Square has geocoded the address. Not all locations will have it populated. |
| Geofencing API | **Not available** | No endpoint for defining geofences or receiving entry/exit events |
| Proximity / beacon API | **Not available** | No BLE beacon, no NFC for customer ID |
| Customer-facing display customization | **Not available** | Not programmable via API |
| Location update webhook | **Available** | `location.updated` webhook fires when store details change — can trigger coordinate re-sync |

**Endpoint(s):** `GET /v2/locations` (includes `coordinates` object), `GET /v2/locations/{id}`

**Plan Tier:** Free — Locations API available on all plans.

### Finding: Clover

**No geofencing, proximity, or beacon API exists.** Clover provides street address only — no coordinates.

| Capability | Status | Details |
|-----------|--------|---------|
| Store coordinates (lat/lng) | **Not available** | `GET /v3/merchants/{mId}/address` returns street address only — no lat/lng fields. Must geocode externally. |
| Geofencing API | **Not available** | No REST API for geofences |
| Proximity / beacon API | **Not available** | No BLE hardware in Clover devices. NFC locked to payment processing. |
| Customer-facing display | **Android SDK only** | On-device app can render custom UI on customer-facing screen (Station Duo, Mini). Not via REST. |
| On-device GPS | **Limited** | Clover runs Android; `LocationManager` accessible but devices lack GPS chip. Wi-Fi/IP-based only — poor accuracy for geofencing. |

**Endpoint(s):** `GET /v3/merchants/{mId}` (address block), `GET /v3/merchants/{mId}/address`

**Plan Tier:** Free for address data. Android SDK requires Register plan + compatible hardware.

### Gap

**Both platforms: Full gap.** Neither Square nor Clover provides geofencing, proximity detection, or pre-transaction notification capabilities. Store coordinates are available from Square but must be geocoded for Clover.

### Recommended Approach: PV-Owned Geofencing

Geofencing is built entirely in the **PV consumer mobile app** using native platform APIs. This is 100% POS-agnostic — it works identically regardless of which POS the merchant uses.

#### Architecture

```
Consumer's Phone (PV App)          PV Backend              POS (Square/Clover)
        │                              │                         │
  GPS detects store                    │                         │
  geofence entry                       │                         │
        │                              │                         │
        ├── POST /consumer/checkin ──> │                         │
        │   { storeId, triggeredBy:    │                         │
        │     "geofence" }             │                         │
        │                              │                         │
        │ <── { storeName,             │                         │
        │      stampCount: 8/10,       │                         │
        │      pendingReward:          │                         │
        │        "$3.00 off" }         │                         │
        │                              │                         │
  Show notification:                   │                         │
  "You're at Brewed Awakening!         │                         │
   You have a $3.00 reward"            │                         │
        │                              │                         │
        │         ... consumer walks to counter ...              │
        │                              │                         │
        │                              │    Associate rings up   │
        │                              │    items, asks for      │
        │                              │    phone number         │
        │                              │         │               │
        │                              │ <── payment webhook ────┤
        │                              │    (normal stamp/reward  │
        │                              │     pipeline runs)       │
```

#### Part 1: Store Coordinates

| Source | Method | Endpoint |
|--------|--------|----------|
| **Square** | Pull from API | `GET /v2/locations` → `coordinates.latitude`, `coordinates.longitude` |
| **Clover** | Geocode address externally | `GET /v3/merchants/{mId}/address` → street address → Google Maps Geocoding API → lat/lng |

**Schema addition to Store model:**
- `latitude` (Float, nullable)
- `longitude` (Float, nullable)
- `geofenceRadiusMeters` (Int, default 150, range 50-500)

**Sync triggers:**
- On merchant onboarding (OAuth complete → pull/geocode coordinates)
- On location update webhook (Square: `location.updated`)
- On store address change in PV admin

#### Part 2: Consumer Mobile App Geofencing

**Native platform APIs — no third-party service required for v1:**

| Platform | API | Notes |
|----------|-----|-------|
| iOS | `CLLocationManager` with `CLCircularRegion` | Works in background. Requires "Always" or "When In Use" location permission. |
| Android | `GeofencingClient` from Google Play Services | Works in background. Requires `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION`. |

**Geofence registration:**
- On app launch and on store list update, register geofences for all stores where the consumer has active promotions
- Each region: center = store lat/lng, radius = store's `geofenceRadiusMeters`

**On geofence entry:**
1. Fire check-in to PV backend: `POST /consumer/checkin`
2. Show local notification with reward status
3. Badge the PV app

**Edge cases:**
- No active promotions at this store → silent, no notification
- Already checked in within 2 hours at same store → suppress duplicate
- Location permissions denied → fall back to manual check-in button in app
- App backgrounded → geofence events must work in background (both platforms support this)

**Manual check-in fallback:**
- Always-visible "Check In" button in the PV app
- Consumer taps when at a store → same backend flow as geofence trigger
- Covers: location permissions denied, poor GPS signal indoors, consumer preference

#### Part 3: Backend Check-in Endpoint

**`POST /consumer/checkin`**

| Field | Type | Description |
|-------|------|-------------|
| storeId | Int | Required — which store the consumer is at |
| consumerId | Int | From JWT — authenticated consumer |
| triggeredBy | String | "geofence", "manual", or "qr" |
| timestamp | DateTime | When the check-in occurred |

**Response:**
```json
{
  "storeName": "Brewed Awakening",
  "stampCount": 8,
  "stampsToNextReward": 2,
  "pendingReward": {
    "description": "PerkValet Reward — $3.00 off",
    "value": 300,
    "activatedInPos": true
  }
}
```

**Behavior:**
- Validates consumer is enrolled in at least one active promotion at this store's merchant
- Pre-fetches: stamp count, milestone progress, pending rewards (from PosRewardDiscount or ConsumerGiftCard)
- Returns unified response regardless of POS type
- Fires `pvHook: consumer.checkin` with `triggeredBy` field for analytics
- Does **NOT** create a visit or stamp — check-in is presence detection only

**Schema: ConsumerCheckin**
- `consumerId` (Int)
- `storeId` (Int)
- `triggeredBy` (String: "geofence" | "manual" | "qr")
- `timestamp` (DateTime)
- `hadPendingReward` (Boolean)
- Used for analytics only — not part of the transaction pipeline

#### Part 4: Integration with Existing Reward Flow

**No changes to the core pipeline.** Geofencing is a consumer notification layer only.

| Component | Changed? | Notes |
|-----------|----------|-------|
| pos.stamps.js | No | Stamp accumulation unchanged |
| Transaction webhooks | No | Payment webhook handling unchanged |
| Reward staging | No | Gift card (Square) and discount template (Clover) flows unchanged |
| Associate flow at counter | No | Phone number, existing reward application unchanged |

**What changes:** Consumer awareness. The check-in endpoint reads existing pending reward data:
- **Square:** Queries `ConsumerGiftCard` for active gift cards with balance
- **Clover:** Queries `PosRewardDiscount` with status "earned" or "activated"
- Returns a **unified** `pendingReward` response — consumer app doesn't need to know the POS type

#### Part 5: Merchant Web App Controls

Add to store settings:
- **Store coordinates** — read-only for Square (synced from API), editable for Clover (from geocoding, allow manual correction)
- **Geofence radius slider** — 50 to 500 meters, default 150m
- **"Test geofence"** button — triggers a simulated check-in for the logged-in merchant user for QA

#### Part 6: Analytics

| Metric | Source | Query |
|--------|--------|-------|
| Check-ins per store per week | `ConsumerCheckin` | Group by storeId, week |
| Geofence vs manual ratio | `ConsumerCheckin.triggeredBy` | Count by type |
| Check-in to transaction conversion | `ConsumerCheckin` joined to `Visit` by consumerId + storeId + date | Match check-ins to same-day transactions |

#### Test Coverage Required

| Test | Type |
|------|------|
| Geofence entry triggers check-in event (mocked location) | Unit |
| Duplicate check-in suppressed within 2-hour window | Unit |
| Consumer with no active promotions — silent | Unit |
| Manual check-in produces identical response to geofence | Integration |
| Check-in returns correct pending reward for Square consumer | Integration |
| Check-in returns correct pending reward for Clover consumer | Integration |
| Check-in returns null pending reward when none exists | Integration |
| Store coordinate sync from Square locations endpoint | Integration |
| Google Maps geocoding for Clover store address | Integration |
| Background geofence event fires correctly (iOS and Android) | Device/E2E |

---

## Revised Summary: Gaps and Recommended Approaches

| # | Requirement | Square | Clover | Impact | Approach |
|---|-----------|--------|--------|--------|----------|
| 1 | Consumer check-in / presence | **Gap** — no API | **Gap** — no REST API | Medium | **PV-owned geofencing in consumer app (Area 6)** |
| 2 | Pre-staged auto-apply discount | **Gap** — no auto-apply | **Gap** — no auto-apply | High | Square: gift card. Clover: discount template. |
| 3 | Phone in webhook | **Partial** — extra API call | **Partial** — 3 API calls; inconsistent format | High | Normalize aggressively; merchant training |
| 4 | Multi-location webhooks | **Full support** | **Partial** — per-location OAuth | Medium | Automate onboarding flow |
| 5 | Plan tier requirements | Free + gift card add-on | Register ($49.95) for discounts | Low | Document in merchant onboarding |
| 6 | Geolocation & proximity | **Partial** — coordinates available | **Gap** — must geocode | Low | PV-owned; POS-agnostic |

---

*This report validates API capabilities only. No implementation code was written. Gaps identified above should be reviewed and resolved before proceeding to the coding phase.*

*Geofencing Build Brief incorporated as Area 6 per specification. Implementation is POS-agnostic and does not require POS API changes.*
