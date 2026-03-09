
# PerkValet RBAC — Billing Admin Surface

Status: Canonical authorization reference for the PerkValet billing admin UI.

Scope:
This document defines role permissions for the following admin pages:

/admin/billing-policy
/admin/invoices
/admin/invoices/:invoiceId

These pages belong to the **PerkValet internal administration surface** and are **not accessible to merchant roles**.

---

# Roles

## Internal PerkValet Roles

pv_admin  
ar_clerk  
support  
qa  

## Merchant / Store Roles (Excluded)

merchant_admin  
store_admin  
store_subadmin  
pos_employee  

Rule:

Merchant/store roles **must never have access** to `/admin/*` billing surfaces.

---

# Page Access Matrix

| Role | Billing Policy | Invoice List | Invoice Detail |
|-----|-----|-----|-----|
pv_admin | View + Edit | View | Full |
ar_clerk | View | View | Operational |
support | View | View | View |
qa | View | View | View |
merchant roles | ✖ | ✖ | ✖ |

---

# Billing Policy

Route:

/admin/billing-policy

Purpose:

Platform‑level billing configuration including:

- invoice terms
- late fee configuration
- guest payment settings

Permissions:

| Action | pv_admin | ar_clerk | support | qa |
|------|------|------|------|------|
View policy | ✔ | ✔ | ✔ | ✔ |
Edit fields | ✔ | ✖ | ✖ | ✖ |
Save policy | ✔ | ✖ | ✖ | ✖ |

UI rule:

The **Save Policy** button must be visible only to `pv_admin`.

All other roles see a read‑only page.

---

# Invoice List

Route:

/admin/invoices

Purpose:

Administrative view of all merchant invoices.

Permissions:

| Action | pv_admin | ar_clerk | support | qa |
|------|------|------|------|------|
View invoices | ✔ | ✔ | ✔ | ✔ |
Filter invoices | ✔ | ✔ | ✔ | ✔ |
Open invoice detail | ✔ | ✔ | ✔ | ✔ |

Developer tools panel visibility:

| Role | Visible |
|------|------|
pv_admin | ✔ |
qa | ✔ |
ar_clerk | ✖ |
support | ✖ |

---

# Invoice Detail

Route:

/admin/invoices/:invoiceId

Purpose:

Detailed management of an individual invoice.

Sections:

Actions  
Pay Link  
Amount Due  
Summary  

Permissions:

| Action | pv_admin | ar_clerk | support | qa |
|------|------|------|------|------|
View invoice | ✔ | ✔ | ✔ | ✔ |
Issue invoice | ✔ | ✔ | ✖ | ✖ |
Generate pay link | ✔ | ✔ | ✖ | ✖ |
Preview late fee | ✔ | ✔ | ✖ | ✖ |
Void invoice | ✔ | ✖ | ✖ | ✖ |

Rationale:

Voiding invoices alters accounting records and is restricted to `pv_admin`.

---

# UI Behavior Rules

Unauthorized actions must be **hidden**, not disabled.

Example:

- Void Invoice button visible only to `pv_admin`
- Save Policy button visible only to `pv_admin`

The server remains the **authoritative enforcement layer**.

---

# QA Test Guidance

QA should validate:

1. Role visibility rules
2. Correct hiding of unauthorized actions
3. Navigation between invoice list and detail
4. Invoice state transitions (issued, paid, void)
5. Pay link generation workflow
6. Billing policy read‑only behavior for non‑admins

Example test:

Login as `ar_clerk`

Open:

/admin/invoices/:invoiceId

Verify:

Issue invoice visible  
Generate Pay Link visible  
Preview late fee visible  
Void invoice NOT visible

---

# Environment Policy

Permissions are identical across:

development  
qa  
staging  
production  

No role escalation based on environment.

---

# Ownership

This document is the canonical reference for billing admin RBAC.

Location:

backend/docs/security/PerkValet-RBAC-Billing-Admin-Surface.md
