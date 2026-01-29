# Thread E — Merchant Admin Configuration DONE (Tactical Plan)
Goal: Merchant Admin can configure users/products/rewards without manual DB edits.

## Definition of DONE
- Merchant Admin can:
  - manage users (create/invite, assign roles, activate/suspend)
  - manage products/services (MVP catalog)
  - configure rewards + earn rules (definitions + constraints)
- Reward lifecycle rules enforced server-side (not just POS issuance).
- Role boundaries enforced for config endpoints (POS cannot modify config).
- QA: happy path + key negatives; tag created and pushed.

## Work breakdown (deliverable-first)
### E.1 Users + roles + membership model
- Endpoints to create/update merchant users.
- Enforce role matrix (owner/merchant_admin/store_admin/store_subadmin).
- Status lifecycle (active/suspended).

### E.2 Products/services
- Minimal product entity (name, sku/label, status).
- CRUD gated to merchant_admin/store_admin as required.

### E.3 Rewards definitions + earn rules
- Define reward templates (type/value/expiry/non-stackable).
- Define earn rules (visits/purchases thresholds) and linking to rewards.
- Enforce: no invalid configs; safe defaults.

### E.4 Reward lifecycle enforcement
- When reward is issued, ensure lifecycle state transitions are valid.
- Redemption path validates eligibility + store scope.

### E.5 QA + hooks
- QA: create merchant admin → add store users → add products → add reward rules → validate POS issuance respects rules.
- Hooks: QA + Docs hooks for config changes; stable event keys.

## Outputs to commit (backend repo)
- docs/tracking/PerkValet_Backend_MasterPlan_Tracker.docx (updated)
- docs/threads/Thread-E-Merchant-Admin-Config.md (this file, updated)
- Any API docs/runbooks relevant to config endpoints

## Tag
- merchant-config-e-locked
