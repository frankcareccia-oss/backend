# PerkValet — Advanced Promotion Engine Spec (Item 20)

**Date:** April 19, 2026
**Status:** Draft — for review before implementation
**Prerequisite:** Current stamp-based promotions working end-to-end

---

## Overview

The current promotion engine supports one mechanic: **stamp/visit-based** — visit N times, get a reward. This spec defines four additional promotion types that expand PV's value proposition to merchants.

Each type has a distinct earning model, distinct reward triggers, and distinct UI in the consumer app. The underlying infrastructure (PosRewardDiscount, Entitlement, webhook pipeline) is reused — only the accumulation and trigger logic changes.

---

## Current State

**What exists today:**
- `Promotion.mechanic = "stamps"` — one stamp per visit, threshold triggers reward
- `ConsumerPromoProgress.stampCount` — tracks progress
- `accumulateStamps()` in pos.stamps.js — increment on payment webhook
- `Promotion.promotionType = "stamp"` — field exists, defaults to "stamp"

**What needs to change:**
- New accumulation functions per type (not just stamp++)
- New progress tracking fields or models
- New trigger conditions
- Consumer app UI for each type's progress display
- Growth Studio goal cards already map to types — need backend support

---

## Type 1: Bundle Promotion

### Business Use Case
"Buy a coffee + pastry combo for $8 (saves $2.50)" — merchant packages items together at a discount price. Consumer buys the bundle upfront or over time.

### Earning Model
- **Fixed bundle:** Consumer purchases a specific set of items in one transaction → gets bundle price
- **Accumulating bundle:** Consumer purchases items across visits → bundle completes when all items purchased

### Schema Additions
```prisma
model BundleDefinition {
  id            Int    @id @default(autoincrement())
  promotionId   Int    @unique
  promotion     Promotion @relation(...)
  items         Json   // [{ productId, sku, name, quantity }]
  bundlePriceCents Int // what the consumer pays for the bundle
  savingsCents  Int    // how much they save vs individual prices
  validityDays  Int    @default(30) // days to complete the bundle
}
```

### Trigger
- **Fixed:** All items in one order → apply bundle price at checkout
- **Accumulating:** Track which items have been purchased → when all items hit, grant reward

### Consumer App Display
- Checklist instead of stamp dots — each item shows ✓ or ○
- "2 of 4 items collected — Coffee ✓, Muffin ✓, Sandwich ○, Smoothie ○"
- Progress bar shows percentage of items collected

### POS Integration
- **Clover:** Apply bundle discount to order when triggered
- **Square:** Gift card credit for the savings amount

---

## Type 2: Tiered Reward Promotion

### Business Use Case
"Bronze at 5 visits ($2 off), Silver at 15 visits ($5 off), Gold at 30 visits ($10 off + free item)" — escalating rewards that increase customer lifetime value.

### Earning Model
- Same as stamps — one stamp per visit
- Multiple thresholds with escalating rewards
- Consumer sees their current tier and progress to next

### Schema Additions
```prisma
model PromotionTier {
  id            Int    @id @default(autoincrement())
  promotionId   Int
  promotion     Promotion @relation(...)
  tierName      String // "Bronze", "Silver", "Gold"
  tierLevel     Int    // 1, 2, 3
  threshold     Int    // visits to reach this tier
  rewardType    String // discount_fixed, discount_pct, free_item, custom
  rewardValue   Int?
  rewardNote    String?
  
  @@unique([promotionId, tierLevel])
  @@index([promotionId])
}
```

### Trigger
- When stampCount crosses a tier threshold → grant that tier's reward
- Progress tracks toward the NEXT tier, not just the current one
- Once highest tier reached, consumer stays at that tier (or resets if repeatable)

### Consumer App Display
- Tier badges: Bronze → Silver → Gold with visual progression
- Current tier highlighted
- "You're Silver (15 visits) — 15 more visits to Gold!"
- Earned rewards listed per tier

### Growth Studio Mapping
- Goal: "Reward my best customers" → tiered promotion

---

## Type 3: Conditional Promotion

### Business Use Case
"Haven't visited in 30 days? Your next visit earns double stamps" or "Visit on Tuesday before 10am and earn a bonus stamp" — time/behavior-based triggers that drive specific behavior.

### Sub-types

**A. Lapse-based (win-back):**
- Consumer hasn't visited in N days → next visit earns bonus stamps or instant reward
- Merchant sets: lapse trigger (days), bonus multiplier (2x, 3x), expiry

**B. Time-based:**
- Purchases during specific hours/days earn bonus stamps
- Merchant sets: days of week, time window, bonus multiplier
- Example: "Tuesdays 2-5pm earn double stamps"

**C. Spend-based:**
- Spend over $X in one transaction → earn bonus stamps or immediate discount
- Merchant sets: minimum spend, reward

### Schema Additions
```prisma
model PromotionCondition {
  id              Int    @id @default(autoincrement())
  promotionId     Int
  promotion       Promotion @relation(...)
  conditionType   String // "lapse", "time", "spend"
  
  // Lapse
  lapseDays       Int?   // days of inactivity to trigger
  
  // Time
  activeDays      Json?  // ["mon","tue","wed"] or null for all days
  activeStartHour Int?   // 14 (2pm)
  activeEndHour   Int?   // 17 (5pm)
  
  // Spend
  minimumSpendCents Int? // minimum order value
  
  // Reward
  bonusMultiplier Float  @default(2.0) // 2x, 3x stamps
  bonusRewardType String? // or an instant reward instead of bonus stamps
  bonusRewardValue Int?
  
  @@index([promotionId])
}
```

### Trigger
- **Lapse:** Check consumer's last visit date at stamp time → if > lapseDays, apply multiplier
- **Time:** Check transaction timestamp → if within active window, apply multiplier
- **Spend:** Check order total → if >= minimum, apply multiplier or instant reward

### Consumer App Display
- **Lapse:** "Welcome back! You earned 2x stamps on this visit"
- **Time:** "Happy Hour bonus: 2x stamps today between 2-5pm"
- **Spend:** "Spend $15+ today and earn a bonus stamp"

### Growth Studio Mapping
- Goal: "Fill slow periods" → time-based conditional
- Goal: "Bring customers back" → lapse-based conditional

---

## Type 4: Referral Promotion

### Business Use Case
"Refer a friend — you both get $3 off" — existing customer refers new customer, both get rewarded. Network growth driver.

### Earning Model
- Existing consumer gets a unique referral code/link
- New consumer signs up using that code
- When new consumer makes first purchase → both get reward

### Schema Additions
```prisma
model ReferralCode {
  id            Int      @id @default(autoincrement())
  promotionId   Int
  promotion     Promotion @relation(...)
  consumerId    Int      // the referrer
  consumer      Consumer @relation(...)
  code          String   @unique @db.VarChar(20) // "JANE-BLVD-X7K2"
  usedCount     Int      @default(0)
  maxUses       Int      @default(10) // cap per referrer
  createdAt     DateTime @default(now())
  
  @@index([consumerId])
  @@index([promotionId])
}

model ReferralRedemption {
  id              Int      @id @default(autoincrement())
  referralCodeId  Int
  referralCode    ReferralCode @relation(...)
  referrerId      Int      // who referred
  refereeId       Int      // who was referred
  referrerRewardId Int?    // entitlement for referrer
  refereeRewardId  Int?    // entitlement for referee
  firstPurchaseAt DateTime? // when referee made first purchase
  createdAt       DateTime @default(now())
  
  @@index([referralCodeId])
}
```

### Trigger
1. Referrer shares code → referee signs up with code
2. Referee makes first purchase → system creates rewards for both
3. Referrer reward: added to wallet (discount or gift card)
4. Referee reward: applied to first purchase or added to wallet

### Consumer App Display
- "Share PerkValet" card in wallet with unique referral link/code
- "You've referred 3 friends — earned $9 in rewards"
- Referee sees: "Welcome! Your friend earned you $3 off your first visit"

### Growth Studio Mapping
- Could be a standalone goal: "Grow through word of mouth"

---

## Implementation Priority

| Type | Value to Merchants | Build Effort | Priority |
|------|-------------------|--------------|----------|
| Tiered | High — increases LTV | Medium | **1st** |
| Conditional (time) | High — fills slow periods | Medium | **2nd** |
| Referral | High — growth driver | Medium | **3rd** |
| Conditional (lapse) | Medium — win-back | Low (builds on conditional) | **4th** |
| Bundle | Medium — upsell | High (order-level logic) | **5th** |
| Conditional (spend) | Medium — AOV | Low (builds on conditional) | **6th** |

### Recommended Build Order
1. **Tiered** — most requested by merchants, builds on existing stamp infrastructure
2. **Conditional (time + lapse)** — highest impact for coffee shops (happy hour, win-back)
3. **Referral** — network growth, unique to PV vs POS-native loyalty
4. **Bundle** — last because it requires order-level item matching

---

## Shared Infrastructure Changes

### Promotion Model Updates
```prisma
model Promotion {
  ...existing fields...
  promotionType   String  @default("stamp") // stamp, bundle, tiered, conditional, referral
  
  // Relations for advanced types
  tiers           PromotionTier[]
  conditions      PromotionCondition[]
  bundleDefinition BundleDefinition?
  referralCodes   ReferralCode[]
}
```

### accumulateStamps() Refactor
Rename to `accumulateProgress()`. Branch on `promotionType`:
- `stamp` → existing logic (increment stampCount)
- `tiered` → same as stamp but check multiple thresholds
- `conditional` → check conditions before applying stamp/bonus
- `referral` → separate flow (not visit-triggered)
- `bundle` → check order items against bundle definition

### Consumer App
- `Wallet.jsx` and `Discover.jsx` need type-specific card rendering
- Stamp dots → checklist (bundle), tier badges (tiered), referral share card
- Progress display adapts per type

### Growth Studio
- Already has goal cards that map to types
- Just needs to set `promotionType` when creating the promo
- Simulator projection math needs type-specific formulas

---

## What This Does NOT Include

- AI-generated promotion recommendations (Phase 4, Item 22)
- Legal validation beyond current flag engine (Phase 4, Item 21)
- Automated A/B testing between promotion types
- Cross-merchant promotion bundles

---

## Open Questions

1. **Tiered reset:** When a consumer reaches Gold tier, do they stay forever or reset after a period?
2. **Conditional stacking:** Can a consumer earn both a regular stamp AND a time-based bonus in one visit?
3. **Referral fraud:** How do we prevent self-referral (same person, different phone)?
4. **Bundle inventory:** Does the bundle need to check if the merchant still sells all the items?
5. **Cross-store tiering:** Can stamps from Store A count toward tiers at Store B? (Currently yes for stamp-based — should tiered work the same?)
