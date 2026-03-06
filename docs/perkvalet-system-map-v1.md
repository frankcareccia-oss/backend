# PerkValet System Map
Status: Locked (V1 Architecture)

Related Document:
perkvalet-role-model-v1.md

------------------------------------------------------------
1. Platform Structure
------------------------------------------------------------

PerkValet consists of three operational domains:

PV Platform
Merchant Organization
Store Operations

These domains remain separate to maintain security boundaries
and operational clarity.

------------------------------------------------------------
2. PV Platform (Admin Surface)

Purpose:
Operate the PerkValet platform.

UI Surface

/admin

Capabilities

• manage PV staff
• manage merchants
• billing operations
• system diagnostics

Roles

pv_admin
pv_support
pv_qa
pv_ar_clerk
pv_dev (optional)

------------------------------------------------------------
3. Merchant Organization

Purpose:
Manage merchant employees and permissions.

UI Surface

/merchant/users

Responsibilities

• create employee
• edit employee
• disable employee
• assign merchant role

Merchant Roles

owner
merchant_admin
merchant_ap_clerk
store_admin
pos_employee

------------------------------------------------------------
4. Store Operations

Purpose:
Manage staffing at physical locations.

UI Surface

/merchant/stores/:storeId

Capabilities

• assign employees to store
• remove employees
• set primary contact
• clear primary contact

Canonical Field

Store.primaryContactStoreUserId

------------------------------------------------------------
5. Merchant Onboarding Flow

PV Admin Workflow

Create Merchant
?
Create Store
?
Create Merchant Admin
?
Send activation email

------------------------------------------------------------
6. Email Infrastructure

System Emails

• device verification
• merchant invitation
• employee invitation
• password reset
• invoice notice
• payment confirmation

------------------------------------------------------------
7. POS Integration Architecture

Target POS (V1)

Square

Architecture

POS Webhook
?
PV Queue
?
Transaction Processor
?
Reward Engine

Fallback

Polling for transactions

------------------------------------------------------------
8. Reward Engine

Processing Flow

Transaction Received
?
Identify Consumer
?
Check Promotion Eligibility
?
Validate Purchase
?
Update Reward Progress
?
Issue Reward

------------------------------------------------------------
9. Consumer Identity

V1 Consumer Identifier

Phone Number

Flow

POS asks phone
?
PV lookup
?
create consumer if new
?
attach transaction

------------------------------------------------------------
10. Promotion System

Merchant Capabilities

• create promotion
• edit promotion
• activate promotion
• disable promotion

Promotion Fields

• reward type
• spend threshold
• item validation
• expiration
• funding source

------------------------------------------------------------
11. Reporting

Merchant Reports

• promotion usage
• reward redemption
• transaction counts

PV Reports

• merchant activity
• reward liability
• system usage

------------------------------------------------------------
12. Billing

Billing Flow

Usage captured
?
Invoice generated
?
Merchant notified
?
Stripe payment
?
Invoice closed

------------------------------------------------------------
13. Support Diagnostics

Support Panel

SupportInfo.jsx

Information available

• user id
• merchant id
• store id
• device id
• API activity

------------------------------------------------------------
14. Deployment Environments

DEV
QA
STAGING
PRODUCTION

Each environment maintains separate

• database
• Stripe keys
• email routing
• POS keys

------------------------------------------------------------
15. Out of Scope for V1

Consumer mobile app
AI chatbot
advanced analytics
multi-POS integrations
consumer wallet
automated marketing

------------------------------------------------------------
