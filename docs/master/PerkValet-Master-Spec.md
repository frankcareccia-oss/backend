# PerkValet Unified Master Specification (Embedded)

**Status:** Canonical
**Versioning Model:** Embedded (section-level versioning with change logs)

This document is the single source of truth for PerkValet. It embeds prior specifications and introduces new normative sections without invalidating earlier versions.

---

## Change Log

### v2.03.1 (Embedded)
- Recorded implementation status for POS-9 and POS-10
- Clarified POS timestamp/idempotency requirements for POS write endpoints
- No breaking changes to v2.03.0 content

### v2.03.0 (Embedded)
- Embedded **Loyalty & Promotions Contract v1** as a new Normative section
- No breaking changes to v2.02.1 behavior

---

## Embedded Sources

- **Master Spec v2.02.1** (embedded verbatim; unchanged)
- **Backend Engineering Notes** (embedded by domain section)
- **POS Specification** (embedded by domain section)
- **Loyalty Flow + Hook Contract v1** (new; Normative)

---

## 1. Overview & Goals
*(From Master Spec v2.02.1 — unchanged)*

---

## 2. Core Domain Model
*(From Master Spec v2.02.1 — unchanged)*

---

## 3. Identity & Roles
*(From Master Spec v2.02.1 — unchanged)*

---

## 4. Merchant & Store Model
*(From Master Spec v2.02.1 — unchanged)*

---

## 5. POS Architecture (Embedded)

### 5.1 POS Auth & Provisioning
*(From POS Spec — unchanged)*

### 5.2 POS Identity and Consumer Linkage

#### 5.2.1 POS-9 — Customer Preview + Create (Locked)
- Backend endpoints:
  - `POST /pos/customer/preview` (phone identityValue)
  - `POST /pos/customer/create` (phone identityValue + **firstName required**, lastName optional)
- Canonical identity output: `consumerId`
- Git tag: `pos-9-locked`

#### 5.2.2 POS-10 — Persist consumerId on Visit/Reward (Locked)
- Backend behavior:
  - `POST /pos/visit` accepts optional `consumerId`
  - `POST /pos/reward` accepts optional `consumerId`
  - When `consumerId` provided, backend validates:
    - Consumer exists and is active
    - Consumer is associated to the Store (`StoreConsumer` active)
  - Persistence:
    - Visits: NDJSON event + Prisma `Visit.consumerId`
    - Rewards: NDJSON event + `PosReward.payloadJson.consumerId`
- Git tag: `pos-10-locked`

#### 5.2.3 POS Write Middleware Requirements (Normative)
POS write endpoints that use replay/idempotency middleware MUST include:
- `X-POS-Idempotency-Key` header
- `X-POS-Timestamp` header (ISO timestamp)

---

### 5.3 POS Idempotency & Replay
*(From Backend Engineering Notes — unchanged)*

---

## 6. Loyalty & Promotions (Normative)

> **This section is Normative.** Backend, POS, and future Mobile implementations **MUST** conform.

### 6.1 Conceptual Model
- Items → Promotions → Offer Sets
- Consumer participation is explicit and event-driven

### 6.2 QR Payload Contract (Normative)
- QR payloads MUST carry stable tokens only
- QR payloads MUST be versioned

**Conceptual payload:**
`pv:store:<storeToken>:offers:<offerSetToken>:v1:<sig>`

### 6.3 Loyalty Flow (Normative)
1. Merchant configures Items and Promotions
2. Backend publishes Offer Set token
3. Consumer scans QR and fetches offers
4. Consumer announces presence (optional, future)
5. POS records progress events
6. POS grants rewards when eligible

### 6.4 Hook / Event Contract (Normative)

All hooks emit structured JSON lines with:
`pvHook`, `ts`, `tc`, `sev`, `stable`

**PII policy (normative):**
- Hooks MUST NOT emit raw phone/email.
- Use masked values or ids only (`consumerId`, `identifierMasked`).

#### 6.4.1 Mobile scan + offer retrieval (future)
- `loyalty.qr.scanned`
- `loyalty.offers.presented`

#### 6.4.2 Consumer presence (future)
- `loyalty.consumer.present`
- `loyalty.consumer.present.rejected`

#### 6.4.3 POS Customer Identity (POS-9)
- `pos.customer.preview.*`
- `pos.customer.create.*`

#### 6.4.4 POS Promotion Progress
- `pos.promo.progress.requested`
- `pos.promo.progress.applied`
- `pos.promo.progress.denied`

#### 6.4.5 POS Reward Grant
- `pos.reward.grant.requested`
- `pos.reward.grant.succeeded`
- `pos.reward.grant.denied`

#### 6.4.6 Mobile sync (future)
- `loyalty.consumer.progress.updated`
- `loyalty.consumer.reward.granted`

### 6.5 Persistence Rules (Normative)
- Events MUST be written to NDJSON
- Visits MAY also be written to Prisma Visit table
- No Reward table is required in v1

### 6.6 POS-10 Alignment
- POS write endpoints MAY accept `consumerId`
- Store-scoped validation is REQUIRED

---

## 7. Billing (Embedded)
*(From Master Spec v2.02.1 — unchanged)*

---

## 8. Security & Auth
*(From Master Spec v2.02.1 — unchanged)*

---

## 9. QA, Hooks, Observability
- Hooks are first-class artifacts
- Test cases reference hook names and `tc` IDs

---

## 10. Appendices
- POS-9: Customer Identity
- POS-10: Consumer Linkage (implemented)

---

## Notes for Embed Completion

This embedded master file is the **canonical wrapper**. To complete the embed, paste the full text of:
- Master Spec v2.02.1
- Backend Engineering Notes
- POS Specification

…into the marked sections above (or link to them in Appendix if you prefer).

Once pasted, increment the Change Log with the embed completion entry (e.g., v2.03.2).
