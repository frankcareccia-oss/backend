# Thread D2 — Billing Domain MVP DONE (Tactical Plan)
Goal: Billing/payments are real end-to-end and payer-only is enforced.

## Definition of DONE
- Billing policy persistence is real (per rollout rule; no destructive changes).
- Invoice lifecycle works: **generate → issue → list/detail → public pay → payment recorded/status updated**.
- Role boundaries enforced:
  - **PAYER can only pay**
  - **Admin/Support cannot pay**
- Stripe: PaymentIntent creation + webhook confirmation (or explicitly document a stub and label as “MVP DONE (no Stripe)”).
- QA: repeatable runbook + quickrun scripts + hooks; tag created and pushed.

## Work breakdown (deliverable-first)
### D2.1 Contracts and endpoints (backend)
- Ensure canonical endpoints exist for:
  - Admin invoice list/detail
  - Generate invoice
  - Issue invoice
  - Public pay (tokenized guest pay)
  - Payment status query
- Enforce immutable invoices once issued; void is explicit action with audit log.

### D2.2 Stripe integration (backend)
- Create PaymentIntent for payable invoices.
- Webhook handler updates Payment record + invoice status.
- Idempotency on webhook processing.
- Store providerChargeId (PaymentIntent id) and timestamps.

### D2.3 Role gates / invariants
- Admin never pays invoices.
- Support never pays invoices (support is read-only assist).
- Payer only sees/pay actions; no admin routes.

### D2.4 QA + hooks
- QA runbook with 5–8 test cases:
  - generate → issue → pay success
  - pay wrong amount (reject)
  - pay already paid (idempotent)
  - payer tries admin endpoint (403)
  - webhook replay (idempotent)
- Hooks: QA + Support correlation keys; stable event names.

## Outputs to commit (backend repo)
- docs/tracking/PerkValet_Backend_MasterPlan_Tracker.docx (updated)
- docs/threads/Thread-D2-Billing-MVP.md (this file, updated with actual endpoints/notes)
- qa workspace scripts/runbook location pointer (do not commit workspace binaries)

## Tag
- billing-d2-mvp-locked
