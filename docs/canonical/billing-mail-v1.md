\# PerkValet Billing \& Mail Canonical Spec (v1)



STATUS: ACTIVE / NORMATIVE  

SCOPE: Billing invoices, guest pay, mail delivery, dunning, permissions  

APPLIES TO: Backend, Admin UI, Cron, Support, Chatbot



---



\## 1. Billing Lifecycle (Authoritative)



Invoice states:



\- draft

\- issued

\- past\_due

\- paid

\- void

\- paused (merchant-level, not invoice-level)



Rules:

\- Draft invoices are NOT payable and NOT emailable

\- Issued invoices are payable but not automatically mailed until a mail run occurs

\- Paid invoices are immutable

\- Void invoices are terminal

\- Past\_due invoices are issued invoices whose due date has elapsed

\- Merchant pause is allowed ONLY after dunning exhaustion



---



\## 2. Guest Pay Token Flow (External Merchant Flow)



Merchant-facing flow ONLY:



1\. Invoice email received

2\. Merchant clicks “Pay Invoice”

3\. Guest Pay page loads

4\. Merchant pays invoice

5\. Confirmation shown



Merchant CANNOT:

\- Generate tokens

\- Regenerate tokens

\- Resend emails

\- Modify invoices



Guest Pay Token lifecycle:



\- Minted (exactly once per active invoice)

\- Emailed via invoice mail

\- Used OR expired

\- Revoked automatically on successful payment



Idempotency:

\- Only ONE active token per invoice

\- Token mint endpoint is idempotent

\- Payment intent creation is idempotent per invoice + amount



---



\## 3. Automated Billing Cycle (Primary Flow)



This is the PRIMARY billing mechanism.



\### 3.1 Invoice Creation

\- Invoices may be created:

&nbsp; - Continuously during the month, OR

&nbsp; - In batch at cycle close

\- Creation does NOT trigger email



\### 3.2 Invoice Issuance

\- Invoices are marked `issued`

\- Issuance does NOT trigger email



\### 3.3 Invoice Mail Run (Cron / Scheduler)

\- Scheduled job executes at configured cadence

\- Finds all:

&nbsp; - issued

&nbsp; - unpaid

&nbsp; - not yet mailed

\- For each invoice:

&nbsp; - Mint guest pay token (idempotent)

&nbsp; - Send invoice email

&nbsp; - Record mail-sent audit marker



Mail is NEVER sent inline with invoice creation.



---



\## 4. Dunning \& Late Notices (Automated First)



\### 4.1 Default Dunning Schedule

\- T+X days: Reminder #1

\- T+Y days: Reminder #2

\- T+Z days: Final Notice



These are:

\- Automatic

\- Legally vetted templates

\- Non-editable by operators



\### 4.2 Manual Notices (After Exhaustion)

\- Allowed ONLY after automated dunning completes

\- Manually scheduled

\- Explicit operator action required

\- Fully audited



---



\## 5. Manual Exception Flow (Secondary / Augmenting)



Used ONLY for:

\- Bounced emails

\- Lost email

\- Merchant request

\- Invoice adjustment



Actions:

\- Resend invoice email (same token)

\- Regenerate token (revokes prior)

\- Adjust invoice (creates audit record)



Manual actions NEVER auto-trigger dunning reset unless explicitly stated.



---



\## 6. Merchant Visibility



Merchant can:

\- View current invoice

\- View invoice history

\- Pay invoices



Merchant cannot:

\- Modify invoices

\- Trigger emails

\- Pause account



---



\## 7. Roles \& Permissions (Authoritative)



\### PerkValet Admin (Superuser)

\- All actions

\- Pause merchant

\- Override dunning

\- Modify invoices

\- Regenerate tokens



\### AP Clerk

\- View all invoices

\- Send / resend invoice emails

\- Regenerate guest pay tokens

\- Schedule manual notices

\- Cannot pause merchant without Admin approval



\### Support Tech

\- Read-only invoice access

\- Read-only payment status

\- No mutation rights



\### Chatbot

\- Read-only invoice + payment status

\- No PII beyond invoice metadata



---



\## 8. Merchant Pause Rules (Strict)



Merchant may be paused ONLY when:

\- Invoice is past\_due

\- Automated dunning exhausted

\- Manual notices exhausted

\- Explicit human decision recorded



Pause effects:

\- Disable service access

\- Billing remains accessible

\- Payment still allowed



---



\## 9. Audit \& Compliance (Mandatory)



All actions must emit:

\- Actor

\- Role

\- Invoice ID

\- Timestamp

\- Reason (if manual)



No silent state changes allowed.



---



\## 10. Change Control



This document is canonical.



Changes require:

\- Version bump (v2, v3…)

\- Explicit approval

\- Backward compatibility review



