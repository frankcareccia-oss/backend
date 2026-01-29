# PerkValet Backend Master Plan — Master Map (v2.08 canonical, v2.05 checklist lens)
Last updated: 2026-01-29 06:16

This file is the **master** “where we are / where we need to go” map. It tracks only **big rocks** (major epics), not cleanup.

## Status legend
- **DONE**: End-to-end implemented + role gates enforced + repeatable QA/runbook + tag created.
- **PARTIAL**: Some parts implemented, but not end-to-end or not fully enforced/verified.
- **NOT DONE**: Not implemented.
- **BLOCKED**: Explicitly deferred by plan or dependent on another epic.

---

## A) Big-rock map (spec-driven)

| Area | Spec ref | Status | Owner thread(s) | Evidence / notes | Next action (big rock) |
|---|---|---:|---|---|---|
| POS Integration (Initial Release) | v2.08 §13 | **DONE** | POS-8 (DONE) | POS-8 endpoints validated end-to-end (provisioning, shift-code login, POS JWT, replay/idempotency, stats/activity). | None (only enhancements later). |
| Roles & boundaries (normative) | v2.08 §15–17 / v2.05 Roles+Invariants | **PARTIAL** | D2 + E | Patterns exist (admin gate, POS-only), but platform-wide enforcement across billing/payments/support/config not proven complete. | Finish enforcement in D2 + E; verify via QA. |
| Public pay constraints (payer-only) | v2.08 §15–17 / v2.05 PAYER | **PARTIAL** | D2 | UI intent exists; backend billing/payments enforcement required to claim DONE. | Implement billing/payments + payer-only enforcement. |
| Mandatory hooks (QA/Support/Docs/Chatbot) | v2.08 §15–17 / v2.05 Hooks | **PARTIAL** | D2 + E + R | POS flows instrumented; platform-wide coverage not verified. | Add/verify hooks in D2 + E + R surfaces. |
| Merchant onboarding / setup | v2.08 §5 | **PARTIAL** | E (primary) | Admin-gated merchant/store capabilities exist; “full onboarding workflow” not verified. | Define and complete onboarding flow end-to-end. |
| Merchant Admin config (users/products/rewards) | v2.08 §6–8 / v2.05 MERCHANT_ADMIN | **NOT DONE / UNKNOWN** | E | POS can issue rewards; merchant-admin config surfaces not confirmed. | Build merchant-admin configuration domain. |
| Reward lifecycle model (states/rules) | v2.08 §7 | **PARTIAL** | E | Issuance at POS exists; full lifecycle rules not proven end-to-end. | Implement lifecycle + constraints + auditability. |
| Analytics & reporting (beyond POS) | v2.08 §12 | **PARTIAL** | R | POS today stats + recent activity exist; broader reporting not confirmed. | Implement merchant/store reporting rollups. |
| Offline & resilience (beyond POS replay) | v2.08 §11 | **PARTIAL** | Later / TBD | POS replay/idempotency exists; offline queue/sync is broader. | Decide offline model and implement reconciliation rules. |
| Consumer app requirements | v2.08 §9 | **NOT DONE** | Later / TBD | Not in validated scope. | Implement only if MVP scope includes consumer app. |
| Group model (phased, MVP reporting) | v2.08 §10 | **NOT DONE** | Later / TBD | Not implemented. | Implement group participation + reporting-only settlement + visibility constraints. |

---

## B) v2.05 checklist lens (roles / hooks / invariants)

| Checklist item | Status | Owner thread(s) | Notes |
|---|---:|---|---|
| PLATFORM_ADMIN: onboard_merchant | PARTIAL | E | Confirm/complete full onboarding workflow. |
| PLATFORM_ADMIN: grant_support_access | NOT DONE / UNKNOWN | R | Define support access model (read-only surfaces). |
| SUPPORT: billing_help | BLOCKED | D2 | Unblocked when billing/payments surfaces exist. |
| SUPPORT: payment_issue_resolution | BLOCKED | D2 | Depends on Stripe/webhooks + payment status. |
| MERCHANT_ADMIN: manage_users | PARTIAL | E | Complete endpoints/flows. |
| MERCHANT_ADMIN: products | NOT DONE / UNKNOWN | E | Implement product catalog/config. |
| MERCHANT_ADMIN: rewards (configuration) | PARTIAL | E | Implement reward definitions/rules. |
| MERCHANT_AP: receive_invoice | BLOCKED | D2 | Needs billing + email delivery. |
| MERCHANT_AP: pay_invoice | PARTIAL | D2 | Needs payer-only backend enforcement. |
| PAYER: pay_invoice_only | PARTIAL | D2 | Enforce on pay endpoints + public UI. |
| HOOKS: QA | PARTIAL | D2 + E + R | Expand beyond POS. |
| HOOKS: Support | PARTIAL | D2 + R | Ensure correlation + stable event keys. |
| HOOKS: Docs | NOT DONE / UNKNOWN | D2 + E + R | Define docs hook outputs (API refs/runbooks). |
| HOOKS: Chatbot | NOT DONE / UNKNOWN | D2 + E + R | Define chatbot context surfaces. |
| INVARIANT: Admin never pays invoices | PARTIAL | D2 | Enforce in billing/payments endpoints. |
| INVARIANT: Support assists but does not pay | PARTIAL | D2 | Enforce in billing/payments endpoints. |
| INVARIANT: Payer only pays | PARTIAL | D2 | Enforce payer-only contract. |

---

## C) Thread lineup (one major feature per thread)
1. **Thread D2 — Billing Domain MVP DONE**
2. **Thread E — Merchant Admin Configuration DONE**
3. **Thread R — Reporting & Audit Surfaces DONE**

Each thread has its own tactical file under `docs/threads/` and must end with:
- QA/runbook updated
- Tracker updated
- Tag created and pushed
