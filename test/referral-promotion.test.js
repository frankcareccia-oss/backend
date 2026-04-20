// test/referral-promotion.test.js — Referral promotion type

"use strict";

const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");
const {
  generateReferralCode,
  getOrCreateReferralCode,
  applyReferralCode,
  checkReferralReward,
} = require("../src/promo/promo.referral");

let merchant, promo, referrer, referee;

beforeAll(async () => {

  merchant = await createMerchant({ name: "Ref Test Coffee" });
  const cat = await prisma.productCategory.create({ data: { merchantId: merchant.id, name: "Coffee" } });

  promo = await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "Refer a Friend", mechanic: "stamps",
      threshold: 1, repeatable: true, rewardType: "discount_fixed",
      rewardValue: 300, status: "active", promotionType: "referral",
      categoryId: cat.id,
    },
  });

  referrer = await prisma.consumer.create({
    data: { phoneE164: "+14085551111", firstName: "Jane", lastName: "Referrer" },
  });
  referee = await prisma.consumer.create({
    data: { phoneE164: "+14085552222", firstName: "Bob", lastName: "Referee" },
  });
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

// ── Code generation ─────────────────────────────────────────

describe("generateReferralCode", () => {
  test("generates code in FIRST-MERCH-XXXX format", () => {
    const code = generateReferralCode("Jane Smith", "BLVD Coffee");
    expect(code).toMatch(/^JANE-BLVD-[A-F0-9]{4}$/);
  });

  test("handles missing names", () => {
    const code = generateReferralCode(null, null);
    expect(code).toMatch(/^FRIEND-PV-[A-F0-9]{4}$/);
  });

  test("truncates long names", () => {
    const code = generateReferralCode("Alexander", "Boulevard Coffee Co");
    expect(code.split("-")[0].length).toBeLessThanOrEqual(6);
    expect(code.split("-")[1].length).toBeLessThanOrEqual(4);
  });
});

// ── getOrCreateReferralCode ─────────────────────────────────

describe("getOrCreateReferralCode", () => {
  test("creates code on first call", async () => {
    const result = await getOrCreateReferralCode(referrer.id, promo.id);
    expect(result.code).toBeDefined();
    expect(result.consumerId).toBe(referrer.id);
    expect(result.promotionId).toBe(promo.id);
  });

  test("returns same code on subsequent calls", async () => {
    const first = await getOrCreateReferralCode(referrer.id, promo.id);
    const second = await getOrCreateReferralCode(referrer.id, promo.id);
    expect(first.code).toBe(second.code);
  });
});

// ── applyReferralCode ───────────────────────────────────────

describe("applyReferralCode", () => {
  let referralCode;

  beforeAll(async () => {
    referralCode = await getOrCreateReferralCode(referrer.id, promo.id);
  });

  test("succeeds for valid code + different consumer", async () => {
    const result = await applyReferralCode(referee.id, referralCode.code);
    expect(result.success).toBe(true);
    expect(result.referralRedemption).toBeDefined();
    expect(result.referralRedemption.referrerId).toBe(referrer.id);
    expect(result.referralRedemption.refereeId).toBe(referee.id);
  });

  test("rejects self-referral (same consumerId)", async () => {
    const result = await applyReferralCode(referrer.id, referralCode.code);
    expect(result.success).toBe(false);
    expect(result.error).toBe("SELF_REFERRAL");
  });

  test("rejects duplicate referral (same referee)", async () => {
    const result = await applyReferralCode(referee.id, referralCode.code);
    expect(result.success).toBe(false);
    expect(result.error).toBe("ALREADY_REFERRED");
  });

  test("rejects invalid code", async () => {
    const result = await applyReferralCode(referee.id, "FAKE-CODE-0000");
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_CODE");
  });

  test("increments usedCount", async () => {
    const updated = await prisma.referralCode.findUnique({ where: { code: referralCode.code } });
    expect(updated.usedCount).toBe(1);
  });

  test("rejects when max uses reached", async () => {
    // Set maxUses to current count
    await prisma.referralCode.update({
      where: { code: referralCode.code },
      data: { maxUses: 1 },
    });

    const newConsumer = await prisma.consumer.create({
      data: { phoneE164: "+14085553333", firstName: "New" },
    });
    const result = await applyReferralCode(newConsumer.id, referralCode.code);
    expect(result.success).toBe(false);
    expect(result.error).toBe("CODE_EXHAUSTED");

    // Reset
    await prisma.referralCode.update({
      where: { code: referralCode.code },
      data: { maxUses: 10 },
    });
  });
});

// ── checkReferralReward ─────────────────────────────────────

describe("checkReferralReward", () => {
  test("grants rewards to both referrer and referee on first purchase", async () => {
    const rewards = await checkReferralReward(referee.id, merchant.id);

    expect(rewards.length).toBe(1);
    expect(rewards[0].referrerId).toBe(referrer.id);
    expect(rewards[0].refereeId).toBe(referee.id);

    // Verify entitlements created for both
    const referrerEntitlements = await prisma.entitlement.findMany({
      where: { consumerId: referrer.id, merchantId: merchant.id, type: "reward" },
    });
    const refereeEntitlements = await prisma.entitlement.findMany({
      where: { consumerId: referee.id, merchantId: merchant.id, type: "reward" },
    });

    expect(referrerEntitlements.length).toBeGreaterThanOrEqual(1);
    expect(refereeEntitlements.length).toBeGreaterThanOrEqual(1);

    // Check metadata
    const referrerReward = referrerEntitlements.find(e => e.metadataJson?.referralType === "referrer");
    const refereeReward = refereeEntitlements.find(e => e.metadataJson?.referralType === "referee");
    expect(referrerReward).toBeDefined();
    expect(refereeReward).toBeDefined();
    expect(referrerReward.metadataJson.displayLabel).toContain("Referral reward");
    expect(refereeReward.metadataJson.displayLabel).toContain("Welcome reward");
  });

  test("does not grant again on subsequent purchases", async () => {
    const rewards = await checkReferralReward(referee.id, merchant.id);
    expect(rewards.length).toBe(0); // already triggered
  });
});

// ── Inactive promo ──────────────────────────────────────────

describe("Inactive referral promo", () => {
  test("rejects referral code when promo is not active", async () => {
    const inactivePromo = await prisma.promotion.create({
      data: {
        merchantId: merchant.id, name: "Old Referral", mechanic: "stamps",
        threshold: 1, repeatable: true, rewardType: "discount_fixed",
        rewardValue: 200, status: "draft", promotionType: "referral",
      },
    });
    const consumer3 = await prisma.consumer.create({
      data: { phoneE164: "+14085554444", firstName: "Draft" },
    });
    const code = await getOrCreateReferralCode(consumer3.id, inactivePromo.id);
    const consumer4 = await prisma.consumer.create({
      data: { phoneE164: "+14085555555", firstName: "New" },
    });
    const result = await applyReferralCode(consumer4.id, code.code);
    expect(result.success).toBe(false);
    expect(result.error).toBe("PROMO_INACTIVE");
  });
});
