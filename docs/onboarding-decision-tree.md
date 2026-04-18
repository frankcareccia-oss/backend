# PerkValet — Merchant Onboarding Decision Tree
**Date:** April 17, 2026
**Status:** Enriched draft — ready for implementation
**Original:** Claude Code draft
**Enriched with:** Real-world Clover OAuth failure research + UX recommendations

---

## What Claude Code Got Right

The TurboTax model is correct. The resume logic is solid. The schema is clean. The help escalation via Claude API is smart. The overall structure — Account → POS Access → Connect → Map Stores → First Promo → Live — is the right sequence.

This document keeps everything Claude Code designed and adds:
1. Real-world Clover OAuth failure modes discovered in research
2. Specific error messages that must be handled
3. The "already logged into Clover" problem and how to handle it
4. Sources Claude Code can reference for Clover-specific edge cases

---

## Progress Bar Stages

```
Account → POS Access → Connect → Map Stores → First Promo → Live ✓
```

Each stage can have multiple sub-steps. The merchant sees the major stages. Sub-steps appear in the content area for the current stage.

---

## Stage 1: Account

Already done at this point. The merchant has a PV account (they logged into the portal). This stage shows as completed.

Sub-steps (already completed):
- 1.1 Created PV account (email + password)
- 1.2 Logged into merchant portal

---

## Stage 2: POS Access

**Goal:** Determine which POS they use, whether they have admin access, and get them ready to connect.

### Step 2.1 — Which POS?

**Screen:** Three logo cards side by side

> "Which point-of-sale system do you use at your register?"

| Option | Next Step |
|--------|-----------|
| Clover (logo) | → 2.2 |
| Square (logo) | → 2.2 |
| Toast (logo) | → 2.2 (Toast: show "coming soon" — not yet supported) |
| "I don't use a POS / cash only" | → 2.8 (manual path) |
| "I'm not sure" | → 2.7 (help identify) |

**Save:** `posType` on OnboardingSession

---

### Step 2.2 — Who set it up?

> "Did you set up your [Clover/Square] system yourself, or did someone else handle it?"

| Option | Next Step |
|--------|-----------|
| "I set it up myself" | → 2.3 |
| "Someone else set it up (tech person, POS rep, etc.)" | → 2.5 |
| "I'm not sure / it was a while ago" | → 2.5 |

**Save:** `setupPersona`

---

### Step 2.3 — Do you have credentials?

> "Great! Do you have your [Clover/Square] login email and password handy?"

| Option | Next Step |
|--------|-----------|
| "Yes, I have them ready" | → Stage 3 (Connect) |
| "I know my email but forgot my password" | → 2.4 (password recovery) |
| "I don't remember my login at all" | → 2.6 (find credentials) |

---

### Step 2.4 — Password Recovery Guide

> "No problem! Here's how to reset your password:"

**For Clover:**
1. Go to **www.clover.com** (not the developer site — that's different)
2. Click "Forgot password?"
3. Enter the email address used when setting up Clover
4. Check your email for the reset link
5. Set a new password, then come back here

**For Square:**
1. Go to **squareup.com/login**
2. Click "Forgot password?"
3. Enter your email
4. Check your email for the reset link

> "Were you able to reset your password?"

| Option | Next Step |
|--------|-----------|
| "Yes, I'm ready to continue" | → Stage 3 (Connect) |
| "I didn't receive the email" | → Show: "Check your spam folder. If still nothing, the account may use a different email address — try other emails you use for business." → 2.6 |
| "I need help" | → Escalate with context: "Merchant stuck at password recovery for [POS type]" |

**⚠️ Implementation note:** Never link to `sandbox.dev.clover.com` for merchants. That is the developer sandbox environment. Merchants use `www.clover.com`. Sending a real merchant to the sandbox URL is a common source of confusion — their credentials won't work there and they'll think the system is broken.

---

### Step 2.5 — Someone Else Set It Up

> "No problem — that's very common! To connect PerkValet, we'll need admin access to your [Clover/Square] account. Here are your options:"

**Option A: "I can get the login from my tech person"**
> "Perfect. Here's exactly what to ask them:"
>
> *"Hi — I'm setting up a loyalty program for the store using PerkValet. I need the admin login email and password for our [Clover/Square] account. Can you send those to me?"*
>
> [Copy to clipboard button] [Email this to my tech person button]

> "Come back when you have the credentials. We'll save your progress — you won't have to start over."

**⚠️ Research finding:** A common real-world scenario is the merchant's tech person having a developer account that is separate from the merchant's own account. If the tech person sends credentials to their developer account instead of the live merchant account, the OAuth connection will fail or connect to the wrong account. Add this note:

> "Important: Make sure they send you the login for the **business account** (the one used at the register), not a separate developer or test account."

| Option | Next Step |
|--------|-----------|
| "I have the credentials now" | → Stage 3 |
| "Save and come back later" | → Save session, show "Resume" on next login |
| "I can't reach my tech person" | → Option B |

**Option B: "I don't know who set it up"**
> "Here are a few ways to find out:"
>
> 1. **Check your email** — search for emails from "Clover" or "Square" from when the system was first set up
> 2. **Check the POS device** — go to Settings on your Clover/Square device, look for Account or Owner information
> 3. **Call support directly:**
>    - Clover: **(855) 853-8340** — tell them you're the business owner and need admin access
>    - Square: **(855) 700-6000**
> 4. **Check with your bank or payment processor** — they may have your account details on file

| Option | Next Step |
|--------|-----------|
| "I found my login" | → Stage 3 |
| "Save and come back later" | → Save session |
| "I need help" | → Escalate |

---

### Step 2.6 — Find Your Credentials

> "Let's figure out which email your [Clover/Square] account uses:"
>
> 1. **Check your email inbox** — search for messages from "Clover" or "Square". The email they sent to is likely your login email.
> 2. **Think about which email you use for business** — many merchants use their business email, not personal.
> 3. **Check the POS device** — look in Settings → Account on your register.

> "Did you find it?"

| Option | Next Step |
|--------|-----------|
| "Yes" | → 2.4 (password recovery) or Stage 3 if they have the password |
| "No" | → 2.5 Option B (call support) |

---

### Step 2.7 — Help Identify POS

> "No worries! Let's figure it out. What does the device at your register look like?"

Show images of:
- Clover Station / Mini / Flex (with labels)
- Square Terminal / Stand / Register (with labels)
- Toast terminal (with label)
- iPad with generic POS app
- Traditional cash register

| Selection | Next Step |
|-----------|-----------|
| Clover device identified | → Set posType = "clover", go to 2.2 |
| Square device identified | → Set posType = "square", go to 2.2 |
| Toast device identified | → Set posType = "toast", go to 2.2 |
| "None of these / just a cash register" | → 2.8 |
| "I'm still not sure" | → Show: "Take a photo of your register and we'll help identify it" → Escalate |

---

### Step 2.8 — No POS / Cash Only

> "PerkValet works best with a connected POS system, but you can still get started manually. Your staff will enter customer visits by phone number at the register."

> "Would you like to:"

| Option | Next Step |
|--------|-----------|
| "Continue with manual setup" | → Skip to Stage 4 (Map Stores — manual entry) |
| "I'm getting a POS soon — save for later" | → Save session |
| "Actually, I think I do have a POS" | → Back to 2.7 |

---

## Stage 3: Connect

**Goal:** OAuth authorization. The merchant signs into their POS and authorizes PerkValet.

**⚠️ CRITICAL — Read before building this stage.**

Research into the Clover Developer Community forum reveals that OAuth is the single most common failure point for third-party Clover integrations. The happy path is simple but the failure modes are numerous and poorly documented. Every error case below is sourced from real developer reports.

**Reference:** Clover Developer Community OAuth threads: https://community.clover.com/topics/OAuth.html
**Reference:** Clover REST API error codes: https://medium.com/clover-platform-blog/troubleshooting-common-clover-rest-api-error-codes-9aaa8885373
**Reference:** Clover OAuth documentation: https://docs.clover.com/dev/docs/using-oauth-20

---

### Step 3.1 — Ready to Connect

> "Great! Now we'll connect your [Clover/Square] account to PerkValet. Here's what will happen:"
>
> 1. You'll be redirected to [Clover/Square]'s sign-in page — **use your [POS] login, not your PerkValet login**
> 2. [Clover/Square] will ask you to allow PerkValet to connect — click "Allow"
> 3. You'll be brought back here automatically — this takes about 30 seconds
>
> **We never see your [POS] password.** This is the same secure process used by thousands of business apps.

> [Connect My Clover Account] ← big green button

**⚠️ Implementation note — "Already logged in" problem:**
Research shows that if the merchant is already signed into their Clover account in the same browser session, the OAuth flow can fail with a 500 internal server error or redirect to the wrong account. This is a known Clover bug documented in community forums.

**Mitigation:**
- Before showing the Connect button, add this note in small text: *"Tip: For the smoothest connection, open this in a fresh browser tab or clear any Clover sessions first."*
- Alternatively: add a "Open in new tab" option for the OAuth redirect so the merchant's existing Clover session doesn't interfere
- Log the `already_logged_in` state if detectable and handle gracefully

**⚠️ Implementation note — Sandbox vs Production:**
Clover has a completely separate sandbox environment (`sandbox.dev.clover.com`) and production environment (`www.clover.com`). Merchants use production. Developers use sandbox. Using sandbox credentials in production throws a 401 Unauthorized error that looks like a bug to the merchant.

**Mitigation:**
- The PV OAuth redirect must ALWAYS point to the production Clover OAuth URL: `https://www.clover.com/oauth/authorize`
- Never use `https://sandbox.dev.clover.com/oauth/authorize` in the merchant-facing wizard
- If a connection attempt fails with 401, check whether the returned `merchantId` looks like a sandbox ID (they have different formatting) and surface a specific message: "It looks like you may have connected a test account. Please make sure you're signing in with your real Clover business login."

**Save:** session state = "connecting"

---

### Step 3.2 — OAuth Redirect

User is redirected to Clover/Square OAuth page. PV backend handles the callback.

**On success:**
- Backend receives authorization code
- Exchange code for OAuth token (POST to Clover token endpoint)
- Store token securely — never log or expose it
- Creates/updates PosConnection record
- Redirects back to onboarding with `?step=3.3&result=success`
- **Save:** posConnectionId, externalMerchantId

**⚠️ Implementation note — Merchant ID format:**
From Clover's documentation: the Clover Merchant ID is a 13-character alphanumeric ID (e.g., `TC4DGCJW1K4EW`). It is NOT the First Data Merchant ID. If the wrong ID is stored, all subsequent API calls will fail. Validate that the merchantId returned from OAuth is 13 characters and alphanumeric before storing it.

**⚠️ Implementation note — Permission scope:**
Apps are only granted the permissions requested at the time of installation. If PV ever needs additional Clover permissions in the future, the merchant will need to disconnect and reconnect. Design the reconnect flow (in Settings) now, even if it's simple, so this isn't a painful retrofit later.

---

**On failure/cancel — handle each case separately, never show a generic error:**

**Case A — User clicked Cancel:**
> "It looks like you cancelled the connection. That's okay — you can try again whenever you're ready."
> [Try Again] [Save and come back later]

**Case B — Invalid credentials / wrong account:**
> "The connection didn't go through. This sometimes happens if you signed in with a different email than your main Clover business account. Double-check that you used your owner/admin email."
> [Try Again] [Help me find the right login]

**Case C — No admin permissions:**
> "It looks like the account you used doesn't have owner-level access to this Clover account. PerkValet needs the main owner login to connect."
> [I don't have admin access] [Try a different account]
→ "I don't have admin access" → Back to 2.5

**Case D — Sandbox account detected (merchantId format mismatch):**
> "It looks like you may have signed in with a Clover test account instead of your real business account. Make sure you're using the same login you use at the register every day."
> [Try Again with my real account]

**Case E — Clover server error (500, timeout):**
> "Clover's system had a brief hiccup — this happens occasionally and is not a problem with your account. Wait 30 seconds and try again."
> [Try Again] [Check Clover's system status] ← links to https://status.clover.com
> If second attempt also fails → escalate with full error context

**Case F — Already logged into Clover (session conflict):**
> "There was a connection issue — this sometimes happens when your browser already has a Clover session open. Try opening a fresh browser tab and signing in again."
> [Open in New Tab]

**For all failure cases — log internally:**
```javascript
// pvHook — never shown to merchant, used for support context
await pvHook('onboarding.oauth.failed', {
  merchantId,
  posType,
  errorCode,     // actual HTTP error code
  errorMessage,  // actual error message from POS
  stuckStep: '3.2',
  timestamp: new Date()
});
```

**General failure fallback (if error doesn't match A-F):**
> "Something went wrong with the connection. Our team has been notified."
> [Try Again] [I need help]
→ "I need help" → Escalate with full error context pre-filled

---

### Step 3.3 — Connection Successful

> "You're connected! ✓"
>
> Progress animation: "Finding your stores..."
>
> (Backend is calling the POS locations API and geocoding addresses in the background)

**⚠️ Implementation note:** Geocoding Clover store addresses via Google Maps API can take 1-3 seconds per store. For a merchant with 3 locations this may be 5-10 seconds. Show a progress indicator — not a spinner that could look frozen. Consider: "Finding Los Gatos... ✓  Finding Almaden... ✓  Finding Blossom Hill... ✓" as each geocode completes.

Auto-advance to Stage 4 when all locations are loaded.

**On geocoding failure for one or more stores:**
> "We connected your account but had trouble finding the address for [Store Name]. You can add it manually."
> Continue to Stage 4 — show that store with a "needs address" flag

---

## Stage 4: Map Stores

**Goal:** Match POS locations to PV stores. Show the merchant what we found and let them confirm.

### Step 4.1 — Stores Found

> "We found [N] locations on your [Clover/Square] account:"
>
> ✓ BLVD Coffee — Los Gatos
>   15525 Los Gatos Blvd, Los Gatos, CA 95032
>
> ✓ BLVD Coffee — Almaden
>   6055 Meridian Ave, San Jose, CA 95120
>
> ✓ BLVD Coffee — Blossom Hill
>   638 Blossom Hill Rd, San Jose, CA 95123
>
> "Do these look right?"

| Option | Next Step |
|--------|-----------|
| "Yes, these are correct" | → Create PV stores + location maps, geocode addresses → Stage 5 |
| "Some of these aren't mine / are closed" | → 4.2 (select which to include) |
| "I have more locations that aren't showing" | → 4.3 |
| "None of these are right" | → Escalate |

---

### Step 4.2 — Select Locations

> "Check the locations you want to include in PerkValet:"

Checkboxes next to each location. Uncheck closed or irrelevant ones.

> [Continue with selected locations]

---

### Step 4.3 — Missing Locations

> "Additional locations may be on a separate [POS] account. Each [POS] account needs its own connection."
>
> "Would you like to connect another [POS] account for the missing locations?"

| Option | Next Step |
|--------|-----------|
| "Yes, connect another account" | → Back to Stage 3 (second OAuth) |
| "No, continue with what we have" | → Stage 5 |

**⚠️ Research finding:** Multiple Clover locations under different accounts is a real scenario. Some merchants (especially those who expanded) have locations on separate Clover accounts because they were set up at different times or by different people. The second OAuth flow must store a separate PosConnection record and associate it with the same PV merchant — not create a duplicate merchant.

---

### Step 4.4 — Manual Store Entry (for cash-only merchants)

> "Tell us about your store locations:"
>
> Store name: [___________]
> Address: [___________]
> City: [___________] State: [__] ZIP: [_____]
> Phone: [___________]
>
> [+ Add another location]
> [Continue]

---

## Stage 5: First Promotion

**Goal:** Get the merchant to create or activate their first loyalty program. Make it feel exciting, not administrative.

### Step 5.1 — Welcome to Loyalty

> "Your stores are connected! Now let's set up your first loyalty program."
>
> "What kind of reward would you like to offer your customers?"

Cards (visual, tappable):
- ☕ **Free item** — "Buy X, get one free" (most popular for cafés)
- 💲 **Dollar amount off** — "Earn $5 off after X visits"
- 📦 **Percentage off** — "Get 15% off after X visits"
- ✨ **Something custom** — "I have a specific reward in mind"

| Selection | Next Step |
|-----------|-----------|
| Free item | → 5.2 with rewardType="free_item" |
| Dollar off | → 5.2 with rewardType="discount_fixed" |
| Percentage off | → 5.2 with rewardType="discount_pct" |
| Custom | → 5.2 with rewardType="custom" |

---

### Step 5.2 — Configure the Basics

> "Almost there! Just a few details:"

**For "Free item":**
- "What item will they get free?" [dropdown of products from POS catalog, or free text if catalog unavailable]
- "How many visits to earn it?" [slider: 3-20, default 8]

**For "Dollar off":**
- "How much off?" [$__.__] (default $5.00)
- "How many visits to earn it?" [slider: 3-20, default 8]

**⚠️ Business rule:** Square gift cards have a minimum load value of $1.00. Reject any dollar-off reward value below $1.00 with: "The minimum reward value is $1.00."

**For "Percentage off":**
- "What percentage?" [slider: 5-50%, default 15%]
- "How many visits to earn it?" [slider: 3-20, default 10]

**For "Custom":**
- "Describe the reward:" [text field]
- "How many visits to earn it?" [slider: 3-20, default 8]

**Expiry (all types):**
> "How long should earned rewards last before they expire?"
> [slider: 30-365 days, default 90]
> "We recommend 90 days — long enough to be fair, short enough to keep customers coming back."

**⚠️ Business rule:** Minimum 30 days. Reject values below 30 with: "We require a minimum of 30 days so customers have a fair chance to use their reward."

**Budget (shown after reward configured):**
> "Set a monthly budget for this program (optional but recommended):"
> [$_____/month] or [No limit — I'll monitor manually]
> "We'll alert you when you're at 50%, 75%, and 90% of your budget."

---

### Step 5.3 — Legal flag check (runs silently before preview)

Before showing the preview, run the promotion through the flag-and-warn engine:

**Flag: No budget cap**
> "You haven't set a budget cap. Without one, this program could cost more than expected if it gets popular. Want to add a monthly limit?"
> [Set a budget] [Continue without a budget — I'll monitor manually]

**Flag: Very high visit threshold (>15)**
> "Requiring [X] visits for a reward is a long journey for customers. Many merchants find 8-10 visits gets the best balance of engagement and cost. Want to adjust?"
> [Adjust] [Keep my setting]

**Flag: Very low visit threshold (<4)**
> "Requiring only [X] visits means customers earn rewards quickly. This could be generous — make sure your budget reflects that."
> [Adjust] [That's intentional]

All flag acknowledgments logged in audit trail. Never block — merchant drives.

---

### Step 5.4 — Preview

> "Here's what your customers will see:"

[Show a mockup of the program card as it would appear in the consumer app — stamp dots, reward badge, merchant name, progress bar]

> "Program name:" [auto-generated, editable — e.g., "BLVD Coffee Loyalty — Buy 8 Get $5 Off"]

> **Important:** Once customers join this program, the reward value and visit requirement are locked — they're a commitment to your customers. You can pause new sign-ups anytime, but existing participants keep their original terms.

> [Launch This Program] ← big green button
> [Save as Draft — I'll launch later]

| Option | Next Step |
|--------|-----------|
| Launch | → Create promotion (status: active) → Stage 6 |
| Save as draft | → Create promotion (status: draft) → Stage 6 |

---

## Stage 6: Live

**Goal:** Confirmation, celebration, and next steps.

### Step 6.1 — You're Live!

> 🎉 "Congratulations! PerkValet is live at your store."
>
> "Here's what happens next:"
>
> 1. **Customers pay** — when they pay at the register, ask for their phone number. That's how PerkValet connects the visit to the customer.
> 2. **Stamps accumulate** — each visit earns a stamp toward their reward automatically
> 3. **Rewards appear** — when they hit [X] visits, the reward shows up in their PerkValet app
> 4. **You see results** — check your Reports dashboard anytime to see how it's working
>
> **One important thing for your team:**
> The loyalty program only works when your staff asks every customer for their phone number at checkout. This takes about 3 seconds and makes all the difference.
>
> Quick links:
> - [View my Reports dashboard]
> - [Share PerkValet with my customers] (QR code / link to consumer app)
> - [Create another promotion]
> - [Go to Dashboard]

---

## Help Escalation at Any Step

Every screen has a "I need help" link at the bottom. When clicked:

**1. System captures automatically:**
- Current step (e.g., "Stage 3, Step 3.2 — OAuth failed, Case E")
- All prior answers (POS type, setup persona, credentials status)
- POS connection status and any error codes returned
- Merchant name and ID
- Browser and OS (for debugging connection issues)
- Timestamp

**2. First: Claude API response**
- Send context to Claude API with the exact stuck point
- Claude generates a targeted, plain-language response
- Shown to merchant as a chat message in the guide
- Estimated 80% of issues resolved here

**3. If still stuck: "Talk to a person"**
- Creates a support ticket in admin portal (/admin/support)
- Admin sees full context — no "please describe your issue"
- Admin responds via the same chat interface
- Merchant gets a notification when response is ready

---

## Resume Logic

On every screen:
- All answers saved to OnboardingSession on every click
- On merchant's next login, check for incomplete OnboardingSession
- If found: show "Welcome back! Let's pick up where you left off" with progress bar
- One click to resume at the exact step

If merchant completed onboarding: don't show it again. Show dashboard instead.

If merchant wants to reconnect POS (e.g., switch accounts or add permissions): Settings → "Reconnect POS" starts a new session from Stage 3, keeping everything else.

**⚠️ Important:** When the merchant reconnects, invalidate the old OAuth token and request a fresh one. Cached tokens from previous sessions can cause "Unauthorized" errors that look like bugs.

---

## Schema: OnboardingSession

```prisma
model OnboardingSession {
  id              Int       @id @default(autoincrement())
  merchantId      Int       @unique
  merchantUserId  Int

  // Progress
  currentStage    String    @default("pos-access")
  currentStep     String    @default("2.1")
  completedSteps  Json      @default("[]")

  // Answers
  posType         String?   // clover, square, toast, manual
  setupPersona    String?   // self, someone-else, unsure
  credentialStatus String?  // ready, recovering, unknown

  // Connection
  posConnectionId Int?
  externalMerchantId String? // Clover 13-char alphanumeric ID — validate format
  posEnvironment  String?   // "production" | "sandbox" — detect and flag sandbox
  storesFound     Int?
  storesMapped    Int?

  // OAuth error tracking (internal — never shown to merchant)
  lastOAuthError  String?   // raw error code from POS
  oauthAttempts   Int       @default(0)

  // First promo
  firstPromoId    Int?
  firstPromoStatus String?  // active, draft

  // Stuck/help
  stuckAtStep     String?
  stuckReason     String?
  stuckAt         DateTime?
  helpMessages    Json      @default("[]")

  // Timestamps
  startedAt       DateTime  @default(now())
  completedAt     DateTime?
  lastActivityAt  DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  merchant    Merchant     @relation(fields: [merchantId], references: [id])
}
```

**New fields added vs original:**
- `externalMerchantId` — store the Clover merchant ID with format validation
- `posEnvironment` — detect if merchant accidentally connected sandbox
- `lastOAuthError` — log raw error code for support debugging
- `oauthAttempts` — track retry count, escalate after 3 failed attempts automatically

---

## Analytics: Onboarding Funnel

Track automatically from OnboardingSession data:

| Metric | How |
|--------|-----|
| Completion rate | completedAt not null / total sessions |
| Drop-off step | currentStep where lastActivityAt > 7 days ago |
| Average time to complete | completedAt - startedAt |
| Time per stage | timestamps per step |
| Help escalation rate | stuckAtStep not null / total sessions |
| Most common stuck point | group by stuckAtStep |
| Resume rate | sessions with multiple days of activity |
| OAuth failure rate | oauthAttempts > 1 / total sessions reaching Stage 3 |
| OAuth failure by case | group by lastOAuthError |
| Sandbox detection rate | posEnvironment = "sandbox" / total OAuth attempts |

**The OAuth failure rate and sandbox detection rate are new — they tell you exactly where the Clover integration is causing real-world pain.**

---

## Key Research Sources for Implementation

These are real-world resources Claude Code should read before implementing Stage 3:

| Source | What It Contains | URL |
|--------|-----------------|-----|
| Clover OAuth community thread | Real developer OAuth failures, workarounds for session conflicts, alternate launch path fixes | https://community.clover.com/topics/OAuth.html |
| Clover REST API error codes guide | Every common error code, what causes it, how to fix it. Essential for error message design | https://medium.com/clover-platform-blog/troubleshooting-common-clover-rest-api-error-codes-9aaa8885373 |
| Clover OAuth v2 documentation | Official flow documentation — reference for token exchange implementation | https://docs.clover.com/dev/docs/using-oauth-20 |
| Clover sandbox vs production guide | API token usage, difference between environments, how to test safely | https://docs.clover.com/dev/docs/using-api-tokens |
| Clover community — REST API auth issues | Real merchants/developers hitting the sandbox vs production confusion and the developer account vs merchant account confusion | https://community.clover.com/questions/20934/rest-api-authentication-issues.html |
| Clover system status page | Link this in the wizard for Case E (server errors) so merchants can check if Clover itself is down | https://status.clover.com |

---

## What This Does NOT Do

- Does not auto-configure the merchant's POS device
- Does not create a POS account for them
- Does not handle billing/payment setup (separate flow)
- Does not replace the Settings page — this is onboarding only, runs once
- Does not handle Square-specific failure modes in the same detail as Clover — Square OAuth research is a separate task before implementing the Square path in Stage 3
