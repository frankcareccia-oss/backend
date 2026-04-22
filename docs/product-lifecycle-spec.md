# PerkValet — Product & Promotion Lifecycle Spec
## Bidirectional POS Sync, State Machine, and Scheduling
*Issued: April 22, 2026*
*Covers: Product lifecycle, promotion lifecycle, POS sync architecture, scheduling cron*

---

## The Core Architectural Principle

**Clover and Square own the transaction. PerkValet owns the relationship.**

More specifically:

| System | Owns | Never touches |
|--------|------|--------------|
| Clover/Square | Product name, price, category, SKU, inventory, register button | PV enrichment fields, promotion config, consumer presentation |
| PerkValet | Consumer description, image, allergens, dietary flags, promotion mechanics, lifecycle state | POS product name, price, SKU — read only if POS-originated |

This is a **complementary overlay** — not a redefinition. PV dresses up what the POS already knows. The POS never knows about the dressing.

---

## The Three Product Origin Scenarios

### Scenario A — Existing POS product (most common)
Merchant already has products in Clover/Square.
PV reads them. PV enriches them. PV never writes back.

```
POS → PV (read)           PV enriches with description, image, allergens
PV → POS (never)          POS product stays exactly as the merchant configured it
```

**Identifier:** `posProductId IS NOT NULL` — POS created this, PV has no write permission.

### Scenario B — New product created in PV
Merchant creates a new product in PV — a bundle, a seasonal item, a new offering.
PV holds it in DRAFT until ready. When ACTIVE, PV pushes the POS-compatible subset to the POS.

```
PV creates full record    name + price + description + image + allergens + promotion config
PV → POS on activation    name + price + category + SKU only (POS-compatible subset)
POS returns posProductId  PV stores it, now tracks this product bidirectionally
```

**Identifier:** `posProductId IS NULL` until activation — PV created this, PV has write permission to POS.

### Scenario C — PV-created product modified in POS
Merchant edits the price directly in Clover after PV created it.
Nightly sync pulls the updated POS fields back into PV.
PV enrichment fields remain completely untouched.

```
POS price changes          Clover → PV nightly sync updates posPriceCents
PV enrichment unchanged    description, image, allergens stay exactly as PV set them
```

---

## The Write Permission Rule

```javascript
// The single rule that governs all POS write decisions
function canPVWriteToPOS(product) {
  // POS-originated products: PV never writes
  if (product.posProductId !== null && product.pvOrigin === false) {
    return false;
  }
  // PV-originated products: PV may write POS-compatible subset only
  return true;
}
```

**posProductId IS NULL** → PV created this → PV may push to POS
**posProductId IS NOT NULL + pvOrigin = false** → POS created this → PV reads only, never writes

---

## The POS-Compatible Payload Subset

When PV pushes a product to Clover or Square, it sends ONLY what the POS can accept.
Everything else stays in PV for consumer presentation.

```javascript
function buildPOSPayload(product, posType) {
  // Only these fields go to the POS — nothing else
  const basePayload = {
    name: product.pvDisplayName || product.posProductName,
    price: product.posPriceCents,
    category: product.posCategory,
    sku: product.posSku || generateSku(product)
  };

  if (posType === 'clover') {
    return {
      name: basePayload.name,
      price: basePayload.price,
      categories: [{ name: basePayload.category }],
      sku: basePayload.sku
      // Clover does not accept: description, image, allergens, dietary
    };
  }

  if (posType === 'square') {
    return {
      type: 'ITEM',
      item_data: {
        name: basePayload.name,
        variations: [{
          type: 'ITEM_VARIATION',
          item_variation_data: {
            name: 'Regular',
            price_money: {
              amount: basePayload.price,
              currency: 'USD'
            }
          }
        }],
        category_id: basePayload.category
        // Square does not accept: allergens, dietary, PV description
      }
    };
  }
}
```

**Fields that NEVER go to the POS:**
- `pvDescription` — consumer-facing copy
- `pvImageUrl` — consumer-facing image
- `pvAllergens` — consumer-facing allergen flags
- `pvDietaryClaims` — consumer-facing dietary claims
- `pvAvailableToday` — PV operational flag
- Any promotion or bundle configuration

---

## Product Lifecycle State Machine

```
DRAFT → STAGED → ACTIVE → SUSPENDED → ARCHIVED
              ↗ (activate now)  ↘ (reactivate) ↗
```

### State Definitions

**DRAFT**
- Product exists in PV only
- NOT sent to POS
- Merchant is still configuring description, image, allergens
- Consumer cannot see it
- No go-live date set yet
- Default state on creation

**STAGED**
- Product is complete and approved in PV
- NOT sent to POS yet
- Go-live date/time is set
- PV scheduling cron watches for it
- Consumer cannot see it
- Associate cannot tap it
- Equivalent to a movie with a release date — complete, just not released

**ACTIVE**
- PV has pushed product to POS (if PV-originated)
- OR: POS product is enriched and available (if POS-originated)
- Associate can tap it at the register
- Consumer can see it in the app with full PV enrichment
- Promotion mechanics are live
- This is the only state where full bidirectional sync matters

**SUSPENDED**
- PV signals POS to hide/deactivate the item
- Associate cannot tap it at register
- Consumer sees "temporarily unavailable" — never "suspended"
- All PV enrichment and promotion config preserved
- Can be reactivated at any time → returns to ACTIVE
- Use case: seasonal item, out of stock, temporary removal

**ARCHIVED**
- PV removes or permanently deactivates in POS
- Associate cannot tap it
- Consumer cannot see it
- All data preserved in PV for audit and history
- Cannot be reactivated — must duplicate to create new version
- Use case: discontinued product, replaced by new version

---

## POS Actions Per State Transition

| Transition | POS Action | Clover API | Square API |
|-----------|-----------|------------|------------|
| DRAFT → STAGED | None | — | — |
| STAGED → ACTIVE | Create item in POS | `POST /v3/merchants/{mId}/items` | `POST /v2/catalog/object` |
| ACTIVE → SUSPENDED | Hide/deactivate item | Update item `available = false` | Update visibility `PRIVATE` |
| SUSPENDED → ACTIVE | Show/reactivate item | Update item `available = true` | Update visibility `PUBLIC` |
| ACTIVE → ARCHIVED | Delete/archive item | `DELETE /v3/merchants/{mId}/items/{itemId}` | Archive catalog object |
| ARCHIVED → anything | Not allowed | — | — |

**⚠️ API Validation Required:**
Does Clover support toggling item visibility via API without deleting it?
If not, PV workaround: track suspension in PV only, don't show in consumer app,
leave Clover item as-is. Validate before building SUSPENDED transition handler.

---

## Scheduling Cron

**File:** `src/cron/product.lifecycle.cron.js`
**Schedule:** Every 15 minutes (same cadence as platform health monitor)
**Scope:** Only `isSeedMerchant = false` merchants

```javascript
async function runProductLifecycleCron() {
  const now = new Date();

  // STAGED → ACTIVE: go-live time has arrived
  const readyToActivate = await prisma.product.findMany({
    where: {
      pvStatus: 'staged',
      pvGoLiveAt: { lte: now },
      merchant: { isSeedMerchant: false }
    },
    include: { merchant: { include: { posConnection: true } } }
  });

  for (const product of readyToActivate) {
    try {
      // Push to POS if PV-originated
      if (!product.posProductId) {
        const posId = await pushProductToPOS(product);
        await prisma.product.update({
          where: { id: product.id },
          data: {
            pvStatus: 'active',
            pvActivatedAt: now,
            posProductId: posId,
            posPushedAt: now
          }
        });
      } else {
        // POS-originated: just activate in PV
        await prisma.product.update({
          where: { id: product.id },
          data: { pvStatus: 'active', pvActivatedAt: now }
        });
      }

      await pvHook('product.activated', {
        productId: product.id,
        merchantId: product.merchantId,
        scheduledFor: product.pvGoLiveAt,
        activatedAt: now,
        pvOriginated: !product.posProductId
      });

    } catch (err) {
      await pvHook('product.activation.failed', {
        productId: product.id,
        merchantId: product.merchantId,
        error: err.message
      });
    }
  }

  // ACTIVE → SUSPENDED: scheduled suspension time arrived
  const readyToSuspend = await prisma.product.findMany({
    where: {
      pvStatus: 'active',
      pvSuspendAt: { lte: now },
      merchant: { isSeedMerchant: false }
    },
    include: { merchant: { include: { posConnection: true } } }
  });

  for (const product of readyToSuspend) {
    try {
      await suspendProductInPOS(product);
      await prisma.product.update({
        where: { id: product.id },
        data: { pvStatus: 'suspended', pvSuspendedAt: now }
      });
      await pvHook('product.suspended', {
        productId: product.id,
        merchantId: product.merchantId,
        scheduledSuspension: true
      });
    } catch (err) {
      await pvHook('product.suspension.failed', {
        productId: product.id,
        merchantId: product.merchantId,
        error: err.message
      });
    }
  }
}
```

---

## Schema

```prisma
model Product {
  id                  Int       @id @default(autoincrement())
  merchantId          Int

  // Origin tracking — the single most important field
  pvOrigin            Boolean   @default(false)
  // false = POS created this, PV reads only
  // true  = PV created this, PV may write to POS

  // POS-owned fields (read from POS, never modified by PV)
  // Only populated when pvOrigin = false (POS-originated)
  posProductId        String?   // Clover item ID or Square catalog object ID
  posProductName      String?   // Exactly as it appears in POS
  posPriceCents       Int?      // Authoritative price from POS
  posCategory         String?   // Category as defined in POS
  posSku              String?   // SKU/PLU from POS
  posLastSyncedAt     DateTime? // When PV last pulled from POS
  posPushedAt         DateTime? // When PV last pushed to POS (pvOrigin=true only)

  // PV-owned fields (created and managed by PV, never sent to POS)
  pvDisplayName       String?   // Consumer display name (overrides posProductName)
  pvDescription       String?   // AI-generated or merchant-written consumer copy
  pvImageUrl          String?   // Consumer-facing image
  pvAllergens         Json?     // { gluten: bool, dairy: bool, nuts: bool, ... }
  pvDietaryClaims     Json?     // { vegan: bool, vegetarian: bool, glutenFree: bool, ... }
  pvAvailableToday    Boolean   @default(true)  // Manual availability toggle

  // Lifecycle state machine
  pvStatus            String    @default("draft")
  // draft | staged | active | suspended | archived

  // Scheduling
  pvGoLiveAt          DateTime? // When to transition STAGED → ACTIVE
  pvSuspendAt         DateTime? // When to auto-transition ACTIVE → SUSPENDED

  // Lifecycle timestamps
  pvActivatedAt       DateTime?
  pvSuspendedAt       DateTime?
  pvArchivedAt        DateTime?
  pvDuplicatedFromId  Int?      // If created by duplicating an archived product

  // Pricing (PV sets this for pvOrigin=true products)
  pvPriceCents        Int?      // PV-set price, sent to POS on activation

  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  merchant            Merchant  @relation(fields: [merchantId], references: [id])
  promotionItems      PromotionItem[]
  bundleItems         BundleItem[]

  @@index([merchantId, pvStatus])
  @@index([pvStatus, pvGoLiveAt])  // for scheduling cron
  @@index([pvStatus, pvSuspendAt]) // for suspension cron
}
```

---

## Promotion Lifecycle (Same Pattern)

The exact same state machine applies to promotions.
A promotion in STAGED has legal terms accepted, budget set, consumer description written.
It does not go live until `pvGoLiveAt` arrives.

```
DRAFT → STAGED → ACTIVE → SUSPENDED → ARCHIVED
```

| State | Consumer sees | Associate sees | Stamps accumulate |
|-------|--------------|----------------|-------------------|
| DRAFT | Nothing | Nothing | No |
| STAGED | Nothing | Nothing | No |
| ACTIVE | Full promotion card | Promotion active | Yes |
| SUSPENDED | "Temporarily paused" | Promotion paused | No |
| ARCHIVED | Nothing | Nothing | No |

**The same scheduling cron handles both** — add promotion transitions
alongside product transitions in `product.lifecycle.cron.js`.

---

## Consumer App Presentation Logic

```javascript
function renderProductForConsumer(product) {
  // Never show draft, staged, or archived products
  if (['draft', 'staged', 'archived'].includes(product.pvStatus)) {
    return null;
  }

  // Suspended: show card but mark unavailable
  const isAvailable = product.pvStatus === 'active'
    && product.pvAvailableToday;

  return {
    // Name: PV override if set, otherwise POS name
    name: product.pvDisplayName || product.posProductName,

    // Price: always authoritative — POS price if POS-originated,
    //        PV price if PV-originated
    price: product.pvOrigin
      ? product.pvPriceCents
      : product.posPriceCents,

    // PV-only enrichment
    description: product.pvDescription,
    image: product.pvImageUrl,
    allergens: product.pvAllergens,
    dietary: product.pvDietaryClaims,

    // Availability
    available: isAvailable,
    unavailableMessage: !isAvailable
      ? 'Temporarily unavailable'
      : null,

    // Promotion participation
    promotions: isAvailable
      ? product.promotionItems
      : []
  };
}
```

---

## Merchant Web App — Product Card UI States

Each product card shows current state as a colored badge with available actions:

| State | Badge color | Badge text | Available actions |
|-------|------------|------------|-------------------|
| DRAFT | Gray | Draft | Edit, Schedule, Activate now, Delete |
| STAGED | Amber | Goes live [date] | Edit, Change date, Activate now, Revert to draft |
| ACTIVE | Teal | Live at register | Edit enrichment, Suspend, Archive |
| SUSPENDED | Red | Suspended | Reactivate, Archive |
| ARCHIVED | Gray | Archived | Duplicate only |

**Two-section layout for each product card:**

```
┌─────────────────────────────────────────────────────┐
│  [TEAL: Live at register]                           │
│                                                     │
│  Latte                                    $5.50     │
│  FROM YOUR CLOVER ACCOUNT · synced 2h ago           │
│  Category: Coffee · SKU: PRD-0003                   │
│                              [View in Clover →]     │
├─────────────────────────────────────────────────────┤
│  PERKVALET — CONSUMER PRESENTATION                  │
│                                                     │
│  Description    [+ Write with AI]                   │
│  A smooth, velvety espresso...                      │
│                                                     │
│  Image          [Change]                            │
│  [thumbnail]                                        │
│                                                     │
│  Allergens   ■ dairy  □ gluten  □ nuts              │
│  Dietary     □ vegan  ■ vegetarian                  │
│                                                     │
│  Available today  [toggle ON]                       │
│                                                     │
│  [Suspend]  [Archive]                               │
└─────────────────────────────────────────────────────┘
```

Top section: read-only if POS-originated. "View in Clover" link for price/name changes.
Bottom section: always editable by merchant. PV's enrichment layer.

---

## Nightly Product Sync

Existing `team.sync.cron.js` pattern — add product sync:

**File:** `src/cron/product.sync.cron.js`
**Schedule:** 3:00 AM daily

```javascript
async function runProductSync(merchantId) {
  const posProducts = await fetchProductsFromPOS(merchantId);

  for (const posProduct of posProducts) {
    const existing = await prisma.product.findFirst({
      where: { merchantId, posProductId: posProduct.id }
    });

    if (!existing) {
      // New product appeared in POS — create PV record
      await prisma.product.create({
        data: {
          merchantId,
          pvOrigin: false,
          posProductId: posProduct.id,
          posProductName: posProduct.name,
          posPriceCents: posProduct.price,
          posCategory: posProduct.category,
          posSku: posProduct.sku,
          posLastSyncedAt: new Date(),
          pvStatus: 'active', // POS products are already live
        }
      });
      await pvHook('product.sync.new', { merchantId, posProductId: posProduct.id });

    } else if (existing.pvOrigin === false) {
      // Existing POS-originated product — update POS fields only
      // NEVER touch pv* fields during sync
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          posProductName: posProduct.name,
          posPriceCents: posProduct.price,
          posCategory: posProduct.category,
          posSku: posProduct.sku,
          posLastSyncedAt: new Date()
        }
      });
    }
    // pvOrigin = true products: skip — PV owns these, don't overwrite
  }

  // Products in PV but no longer in POS → suspend in PV
  const pvProducts = await prisma.product.findMany({
    where: { merchantId, pvOrigin: false, pvStatus: 'active' }
  });

  for (const pvProduct of pvProducts) {
    const stillInPOS = posProducts.find(p => p.id === pvProduct.posProductId);
    if (!stillInPOS) {
      await prisma.product.update({
        where: { id: pvProduct.id },
        data: { pvStatus: 'suspended', pvSuspendedAt: new Date() }
      });
      await pvHook('product.sync.removed_from_pos', {
        merchantId, productId: pvProduct.id
      });
    }
  }
}
```

---

## API Validation Results ✅

*Validated: April 22, 2026 — all green lights*

| Question | Clover | Square |
|----------|--------|--------|
| Toggle visibility without deleting? | YES — `hidden: true/false` | YES — `is_archived: true/false` |
| Fields accepted on create? | name, price, sku, categories, hidden, available | name, description, variations (price), categories, image_ids, is_archived |
| New item appears on register immediately? | YES | YES |
| Deleted items recoverable? | NO — permanent | NO — but archived items ARE recoverable |

### State transition implementation — confirmed

| Transition | Clover | Square |
|-----------|--------|--------|
| STAGED → ACTIVE | `POST /items` (shows immediately) | `UpsertCatalogObject` (shows immediately) |
| ACTIVE → SUSPENDED | `hidden: true` | `is_archived: true` |
| SUSPENDED → ACTIVE | `hidden: false` | `is_archived: false` |
| ACTIVE → ARCHIVED | `hidden: true` (never DELETE) | `is_archived: true` (never DELETE) |

### Key decisions confirmed

**Never use DELETE on either POS.**
Clover deletes are permanent and irreversible.
Square deletes cascade and kill all item variations.
Always use the hide/archive flag instead.
SUSPENDED and ARCHIVED both set the same POS flag.
The distinction between temporary and permanent lives in PV's `pvStatus` field only.

**New items appear immediately — no merchant manual step.**
This is the big one. The merchant experience story is fully intact.
PV schedules a product, the cron fires at go-live time,
the item appears on the register. Zero manual intervention required.

**Square bonus — push `pvDescription` on create.**
Square's catalog API accepts `description` and `description_html` fields.
PV should push `pvDescription` to Square when creating items.
An associate looking up an item in Square will see PerkValet's
AI-generated description — value-add at no extra cost.
Clover does NOT support this — description stays PV-only for Clover merchants.

### Cautions

**Clover `hidden` flag — intermittent reliability.**
Community reports of the hidden flag occasionally not working as expected.
Run sandbox tests for ACTIVE → SUSPENDED and SUSPENDED → ACTIVE transitions
before shipping. Add to pre-launch checklist.

**Never use DELETE — add to Claude Code's never-break rules:**
```javascript
// NEVER call DELETE on POS items — use hide/archive instead
// Clover: DELETE is permanent, no recovery
// Square: DELETE cascades to all variations
// Always: set hidden/is_archived = true
```

---

## pvHooks

| Event | Trigger | Fields |
|-------|---------|--------|
| `product.activated` | STAGED → ACTIVE | productId, merchantId, scheduledFor, activatedAt, pvOriginated |
| `product.activation.failed` | POS push fails | productId, merchantId, error |
| `product.suspended` | ACTIVE → SUSPENDED | productId, merchantId, scheduledSuspension |
| `product.suspension.failed` | POS suspend fails | productId, merchantId, error |
| `product.archived` | → ARCHIVED | productId, merchantId |
| `product.sync.new` | New POS product found | merchantId, posProductId |
| `product.sync.removed_from_pos` | POS product disappeared | merchantId, productId |
| `product.pushed_to_pos` | PV pushes to POS | productId, merchantId, posType, posProductId |

---

## What This Does NOT Include

- Inventory level tracking (POS-managed, not PV's responsibility)
- Price overrides for enrolled consumers (future — tiered pricing)
- Product recommendations based on purchase history (Phase 4)
- Bulk product import from CSV (future — POS sync handles this)
- Product variants (size, milk type) — single product model for v1
