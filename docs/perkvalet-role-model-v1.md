
# PerkValet Role & Contact Model
Status: Locked (v1.0)

Purpose:
Define the separation of platform roles, merchant roles, and store contact ownership.

Scope:
Merchant UI, PV Admin UI, backend contracts, and future development threads.

------------------------------------------------------------

1. Core Principle

PerkValet separates platform authority from merchant authority.

Two independent role domains exist:

Platform Roles → Internal PerkValet staff permissions  
Merchant Roles → Merchant organization permissions

These must never be blended.

This separation protects:
- audit logs
- permissions clarity
- support traceability
- security boundaries

------------------------------------------------------------

2. Platform Roles (PV)

Platform roles are used only in the PV Admin surface.

Canonical Roles

pv_admin      → PV Admin
pv_support    → PV Support
pv_qa         → PV QA
pv_ar_clerk   → PV AR Clerk
pv_dev        → PV Developer (optional)

Platform Role Rules

• Visible only in PV Admin UI
• Not visible in merchant UI
• Not stored as merchant memberships
• Not used for merchant authorization

------------------------------------------------------------

3. Merchant Roles

Merchant roles represent permissions inside a merchant organization.

Canonical Merchant Roles

owner               → Merchant Owner
merchant_admin      → Merchant Admin
merchant_ap_clerk   → Merchant AP Clerk
store_admin         → Store Admin
pos_employee        → POS Employee

Merchant Role Rules

• Visible only in merchant context
• Assigned through merchant membership
• Can vary by merchant organization

------------------------------------------------------------

4. No Dual‑Role Shortcut

PV staff must not be given merchant roles simply to access merchant UI.

Incorrect pattern:

pv_support + merchant_admin

Correct pattern:

• Use a separate merchant test account
• Or create a temporary merchant membership for testing

Reason:
• avoids permission ambiguity
• preserves clean audit logs
• prevents support/security confusion

------------------------------------------------------------

5. Store Contact Ownership

Store contact is a store-level property.

Canonical Model

Store
  └── primaryContactStoreUserId

NOT

MerchantUser
  └── primaryStoreContact

------------------------------------------------------------

6. Merchant Users Page Scope

This page manages identity and merchant membership.

Editable fields:
• email
• first name
• last name
• phone
• merchant role
• membership status

Visible summary fields:
• store assignment count
• store contact summary

Example:

Primary contact for 2 stores
Not a primary contact

Not editable from this page:
• store assignments
• primary contact designation
• store‑specific permissions

Those belong to Store → Team & Access.

------------------------------------------------------------

7. Store Page Responsibilities

Store-level pages manage staffing.

Store Team & Access must allow:

• assign employees to store
• select primary contact
• remove primary contact

------------------------------------------------------------

8. Merchant UI Requirements

Merchant User Editor fields:

• email
• role dropdown
• status dropdown
• phone
• name

Role Dropdown Options

Merchant Owner
Merchant Admin
Merchant AP Clerk
Store Admin
POS Employee

Store Contact Display

Replace dropdown with read‑only badge:

Primary contact for 1 store
Primary contact for 2 stores
Not a primary contact

------------------------------------------------------------

9. PV Admin UI Requirements

PV Admin interface manages platform roles only.

PV Org / Team Page roles:

PV Admin
PV Support
PV QA
PV AR Clerk
PV Developer

Merchant management screens may view merchant memberships
but must never merge role lists.

------------------------------------------------------------

10. UI Separation Model

PV Admin Surface
Manages:
• PV staff
• platform roles
• platform operations

Merchant Surface
Manages:
• merchant employees
• merchant roles
• store staffing

------------------------------------------------------------

11. Locked Policy Decisions

• platform roles and merchant roles remain separate
• store primary contact is store-owned
• merchant employee page manages identity + merchant membership only
• store pages manage store staffing
• role dropdowns use human labels
• POS role name is pos_employee

------------------------------------------------------------

12. Implementation Scope (Next Thread)

Merchant UI
• remove incorrect store contact dropdown
• add store contact summary badge
• add missing roles (POS, AP Clerk)

PV UI
• add platform role editor
• keep PV roles separate from merchant roles

Optional backend cleanup
• centralize role enum definitions
• confirm legacy store_subadmin handling

------------------------------------------------------------

Thread Bootstrap Template

Thread: Merchant/PV Role Separation Implementation
Contract: PV Admin UI Contract v1.0
Architecture: Model B
Row Pattern: Pattern B
Scope: Merchant role UI + PV role UI separation
Policy: Platform roles separate from merchant roles
Store Contact Ownership: Store-level only

------------------------------------------------------------
