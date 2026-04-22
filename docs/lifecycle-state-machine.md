# Product & Promotion Lifecycle State Machine
*Applies to: Products and Promotions (identical rules)*

## States

| State | Consumer sees | POS register | Editable fields |
|-------|-------------|-------------|-----------------|
| **draft** | Nothing | Not in POS | Everything |
| **staged** | Nothing | Not in POS | startAt, endAt only |
| **active** | Full card/promotion | Visible on register | Nothing |
| **suspended** | "Temporarily unavailable" | Hidden on register | Nothing |
| **archived** | Nothing | Hidden on register | Nothing (duplicate only) |

## Allowed Transitions

```
draft → staged       (requires startAt go-live date)
draft → active       (activate now — startAt defaults to now)
staged → draft       (revert to edit)
staged → active      (go live now or scheduling cron fires)
active → suspended   (temporarily hide)
active → archived    (permanently end)
suspended → active   (reactivate)
suspended → archived (permanently end)
archived → (none)    (terminal — duplicate to create new draft)
```

## Transition Gates

| Transition | Gate condition |
|-----------|---------------|
| draft → staged | `startAt` must be set (go-live date required) |
| draft → active | `startAt` set to now if not provided |
| staged → active | Always allowed |
| active → draft | **BLOCKED** — consumers may have the old version in their wallets |

## Edit Restrictions

| State | What can be changed | What's locked |
|-------|-------------------|---------------|
| **draft** | Everything — name, description, dates, config, items | Nothing locked |
| **staged** | Only `startAt` and `endAt` (scheduling) | All other fields — revert to draft to edit |
| **active** | Nothing | All fields — archive and duplicate to change |
| **suspended** | Nothing | All fields — frozen |
| **archived** | Nothing | Terminal state — duplicate only |

## Why active cannot go back to draft

Once a product or promotion has been active:
- Consumers may have stamps, progress, or rewards tied to it
- Transaction history references the original configuration
- Changing it retroactively would create data inconsistencies

To make changes: **archive → duplicate → edit draft → stage → activate**

## POS Actions Per Transition

| Transition | Clover | Square |
|-----------|--------|--------|
| staged → active (PV-originated) | POST /v3/merchants/{mId}/items | UpsertCatalogObject |
| active → suspended | hidden: true | is_archived: true |
| suspended → active | hidden: false | is_archived: false |
| active → archived | hidden: true (NEVER DELETE) | is_archived: true (NEVER DELETE) |

## API Endpoints

### Products
- `POST /merchant/products/:id/stage` — draft → staged (requires startAt)
- `POST /merchant/products/:id/activate` — draft/staged → active
- `POST /merchant/products/:id/revert-to-draft` — staged → draft
- `POST /merchant/products/:id/archive` — active/suspended → archived
- `POST /merchant/products/:id/reactivate` — suspended → active
- `DELETE /merchant/products/:id` — active → suspended

### Promotions
- Status transitions via `PATCH /merchant/promotions/:id` with `{ status: "staged" }` etc.
- Same gates apply: staged requires startAt, active blocks all edits

## Badge Colors (UI)

| State | Color | Badge text |
|-------|-------|-----------|
| draft | Purple/gray | Draft |
| staged | Amber | Goes live [date] |
| active | Teal/green | Live at register |
| suspended | Red | Suspended |
| archived | Gray | Archived |
