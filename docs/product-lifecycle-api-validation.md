# POS API Validation — Product Lifecycle State Transitions
*Researched: April 22, 2026*
*Context: PerkValet Product & Promotion Lifecycle Spec*

---

## Summary

All state transitions in the product lifecycle spec are natively supported by both Clover and Square APIs. No workarounds needed.

**Critical rule: NEVER use DELETE on either POS. Always use hide/archive flags.**

---

## Clover REST API v3

### Item Visibility Toggle
- **Field:** `hidden` (boolean, defaults to `false`)
- `hidden: false` → item shows on Register app
- `hidden: true` → item hidden from Register app
- Also has `available` boolean (separate from `hidden`) for stock availability
- **Caution:** Community reports of `hidden` flag occasionally not working. Test in sandbox.

### POST /v3/merchants/{mId}/items — Accepted Fields
| Field | Type | Required |
|-------|------|----------|
| `name` | string | YES |
| `price` | int64 (cents) | YES |
| `sku` | string | No |
| `hidden` | boolean | No (default: false) |
| `available` | boolean | No (default: true) |
| `categories` | array of {id} | No |
| `priceType` | string | No (FIXED, VARIABLE, PER_UNIT) |
| `code` | string | No |
| `alternateName` | string | No |
| `cost` | integer | No |
| `stockCount` | integer | No |
| `colorCode` | string | No |
| `taxRates` | array | No |
| `modifierGroups` | array | No |

**NOT accepted:** description, image, allergens, dietary claims (these are PV-only enrichment)

### Immediate Register Appearance
YES — new items appear on Clover Register immediately. No merchant action needed.

### Delete Behavior
PERMANENT. No undelete. Deleted items gone from inventory, may remain as orphaned references in historical orders.

**Rule: Always use `hidden: true` instead of DELETE.**

---

## Square API v2

### Item Visibility Toggle — Two Mechanisms

**1. Archive (preferred for SUSPENDED/ARCHIVED):**
- `is_archived: true` → hidden from POS and Dashboard search
- `is_archived: false` → restored, fully recoverable
- All CRUD operations remain valid on archived items
- Order and inventory references preserved

**2. Location scoping (for multi-location control):**
- `present_at_all_locations: true/false`
- `present_at_location_ids: [...]` — include only specific locations
- `absent_at_location_ids: [...]` — exclude specific locations

### UpsertCatalogObject — Accepted Fields
```json
{
  "object": {
    "type": "ITEM",
    "present_at_all_locations": true,
    "item_data": {
      "name": "Coffee",
      "description": "Plain text",
      "description_html": "<p>HTML</p>",
      "abbreviation": "CO",
      "is_archived": false,
      "variations": [{
        "type": "ITEM_VARIATION",
        "item_variation_data": {
          "name": "Regular",
          "pricing_type": "FIXED_PRICING",
          "price_money": { "amount": 400, "currency": "USD" }
        }
      }],
      "categories": [{ "id": "EXISTING_CAT_ID" }],
      "image_ids": ["EXISTING_IMG_ID"],
      "tax_ids": ["EXISTING_TAX_ID"]
    }
  }
}
```

**Inline creation rules:**
- At least one variation REQUIRED for transactions
- Categories, taxes, images must be existing IDs (not created inline)
- Images require separate `POST /v2/catalog/images` (multipart, max 15MB)
- Temporary IDs use `#` prefix, replaced with permanent IDs in response

**Bonus:** Square accepts `description` and `description_html` — PV could push pvDescription to Square (not to Clover)

### Immediate Register Appearance
YES — items appear in Square POS app and Dashboard immediately.

### Delete Behavior
PERMANENT and CASCADING — deleting an item deletes all its variations.
Archived items ARE fully recoverable via `is_archived: false`.

**Rule: Always use `is_archived: true` instead of DELETE.**

---

## POS Action Mapping for State Transitions

| PV Transition | Clover Action | Square Action |
|--------------|---------------|---------------|
| STAGED → ACTIVE (PV-originated) | `POST /v3/merchants/{mId}/items` | `POST /v2/catalog/object` (UpsertCatalogObject) |
| ACTIVE → SUSPENDED | Update: `hidden: true` | Update: `is_archived: true` |
| SUSPENDED → ACTIVE | Update: `hidden: false` | Update: `is_archived: false` |
| ACTIVE → ARCHIVED | Update: `hidden: true` (never delete) | Update: `is_archived: true` (never delete) |

---

## Sources

### Clover
- [Manage items and item groups](https://docs.clover.com/dev/docs/managing-items-item-groups)
- [Create an inventory item](https://docs.clover.com/dev/reference/inventorycreateitem)
- [Update an inventory item](https://docs.clover.com/dev/reference/inventoryupdateitem)
- [Inventory FAQs](https://docs.clover.com/dev/docs/inventory-faqs)

### Square
- [CatalogObject Reference](https://developer.squareup.com/reference/square/objects/CatalogObject)
- [CatalogItem Reference](https://developer.squareup.com/reference/square/objects/CatalogItem)
- [Archive Catalog Items](https://developer.squareup.com/docs/catalog-api/archive-catalog-items)
- [UpsertCatalogObject](https://developer.squareup.com/reference/square/catalog-api/upsert-catalog-object)
