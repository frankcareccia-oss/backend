# Thread R — Reporting & Audit Surfaces DONE (Tactical Plan)
Goal: Answer “what happened?” and “how are stores performing?” without DB digging.

## Definition of DONE
- Reporting endpoints exist for store + merchant rollups:
  - visits, rewards issued, rewards redeemed (basic time windows)
- Read-only audit visibility for support/admin (no mutation).
- Hooks + stable event keys support QA/support correlation.
- QA: one merchant with 2 stores validated; tag created and pushed.

## Work breakdown (deliverable-first)
### R.1 Reporting endpoints
- Store rollup: today/7d/30d counts for visits, rewards issued, rewards redeemed.
- Merchant rollup: aggregate across stores.
- Filter options: storeId, date range (MVP only).

### R.2 Audit surfaces
- Read-only event timeline (visits/rewards/redemptions/payments when D2 done).
- Correlation IDs in responses for support.

### R.3 QA + hooks
- QA runbook with known dataset seeding approach (or safe dev fixtures).
- Hooks: Support and QA events for report queries + failures.

## Outputs to commit (backend repo)
- docs/tracking/PerkValet_Backend_MasterPlan_Tracker.docx (updated)
- docs/threads/Thread-R-Reporting-Audit.md (this file, updated)

## Tag
- reporting-r-locked
