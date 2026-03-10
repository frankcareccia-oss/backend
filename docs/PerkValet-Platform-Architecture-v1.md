# PerkValet Platform Architecture Contract (V1)

Status: Locked V1 Contract

## Platform Architecture

PerkValet operates a three-layer architecture.

PerkValet Platform
    |
Merchant Organization
    |
Store Location

Each layer has independent role systems and permissions.

## Identity Model

All people are represented by one global identity record.

User table fields:

id
email
passwordHash
systemRole
firstName
lastName
phoneRaw
phoneCountry
phoneE164
status
tokenVersion
createdAt
updatedAt

Rule:
Email is the global identity key.

A user may belong to multiple merchants.

## System Roles

pv_admin
merchant
user

Routing example:

pv_admin ? /merchants
merchant ? /merchant
user ? /rewards

## PerkValet Platform Roles

pv_admin
pv_support
pv_ar_clerk
pv_qa

## pv_admin Capabilities

pv_admin can:

create merchants
edit merchants
suspend merchants
view merchant data
assign merchant_owner
recover merchant_owner
manage billing policy
manage PV staff
view logs
view diagnostics

pv_admin cannot manage merchant workforce roles.

Exception:
pv_admin may assign merchant_owner.

## Merchant Model

Merchant table:

id
legalName
displayName
status
createdAt
updatedAt

## Merchant Membership

MerchantUser table:

id
merchantId
userId
role
status
suspendedAt
archivedAt
statusReason
statusUpdatedAt
createdAt
updatedAt

Relationship:

User ? MerchantUser ? Merchant

## Merchant Roles

merchant_owner (UI label: Owner)
merchant_admin
ap_clerk
merchant_employee
store_admin
store_subadmin
pos_employee

## Merchant Hierarchy

pv_admin
  ?
merchant_owner
  ?
merchant_admin
  ?
store_admin
  ?
store_subadmin
  ?
pos_employee

## Billing Authority

Invoices may be paid by:

merchant_owner
merchant_admin
ap_clerk

## Role Cardinality Rules

Certain roles are singleton roles.

merchant_owner ? only one per merchant
ap_clerk ? only one per merchant

Example validation message:

This merchant already has an active Owner.

## Security Model

Authorization layers:

JWT authentication
role validation
device trust

Trusted device required for:

pv_admin
pv_support
pv_ar_clerk
merchant_owner
merchant_admin

## Event Hooks

merchant.created
merchant.user.created
merchant.user.updated
merchant.user.role_changed
store.user.assigned
store.user.removed
invoice.generated
invoice.paid
reward.processed

## Environment Model

development
qa
staging
production

Deployment pipeline:

dev ? qa ? staging ? production

## UI Surfaces

PerkValet UI consists of three surfaces:

PV Platform Surface
Merchant Surface
Public Surface

## UI Layout Standard

App.jsx
PageContainer
PageHeader
Card
Grid/Form/Table

Page widths:

form = 760
page = 1100
wide = 1400
full = 1760

## Identity Architecture

User
 |
 |-- PvTeamMember
 |
 |-- MerchantUser
 |      |
 |      |-- Merchant
 |              |
 |              |-- Store
 |                      |
 |                      |-- StoreUser
 |
 |-- ConsumerUser

## Guiding Principle

Identity is never duplicated.
Only memberships and roles change.
