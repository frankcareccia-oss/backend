// test/ai-draft.test.js — AI draft utility edge cases
//
// Tests the JSON parsing, code fence stripping, and fallback behavior
// without making actual API calls (mocks the Anthropic client).

"use strict";

// Mock the Anthropic SDK before requiring the module
const mockCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

// Set the API key so requireKey() doesn't throw
process.env.ANTHROPIC_API_KEY = "test-key-for-unit-tests";

const {
  draftPromoDescription,
  draftProductDescription,
  draftBundleDescription,
} = require("../src/utils/aiDraft");

beforeEach(() => {
  mockCreate.mockReset();
});

// ── JSON parsing edge cases ─────────────────────────────────

describe("draftPromoDescription — JSON parsing", () => {
  const baseArgs = {
    merchantName: "BLVD Coffee",
    promoName: "Coffee Stamps",
    categoryName: "Coffee",
    merchantType: "coffee_shop",
    rewardType: "discount_fixed",
    rewardValue: 500,
    threshold: 8,
    promotionType: "stamp",
  };

  test("parses clean JSON response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: '{"versionA": "Earn $5 off after 8 visits.", "versionB": "Eight mornings and your ninth is on us."}' }],
    });

    const result = await draftPromoDescription(baseArgs);
    expect(result.versionA).toBe("Earn $5 off after 8 visits.");
    expect(result.versionB).toBe("Eight mornings and your ninth is on us.");
  });

  test("strips markdown code fences (```json ... ```)", async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: '```json\n{"versionA": "Version A text.", "versionB": "Version B text."}\n```' }],
    });

    const result = await draftPromoDescription(baseArgs);
    expect(result.versionA).toBe("Version A text.");
    expect(result.versionB).toBe("Version B text.");
  });

  test("strips code fences without json label (``` ... ```)", async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: '```\n{"versionA": "A here.", "versionB": "B here."}\n```' }],
    });

    const result = await draftPromoDescription(baseArgs);
    expect(result.versionA).toBe("A here.");
    expect(result.versionB).toBe("B here.");
  });

  test("falls back to raw text as versionA when JSON is completely broken", async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: "Here are two versions of the description..." }],
    });

    const result = await draftPromoDescription(baseArgs);
    expect(result.versionA).toContain("Here are two versions");
    expect(result.versionB).toBe("");
  });

  test("handles empty AI response", async () => {
    mockCreate.mockResolvedValue({ content: [{ text: "" }] });

    const result = await draftPromoDescription(baseArgs);
    expect(result.versionA).toBe("");
    expect(result.versionB).toBe("");
  });

  test("handles null content", async () => {
    mockCreate.mockResolvedValue({ content: [] });

    const result = await draftPromoDescription(baseArgs);
    expect(result.versionA).toBe("");
  });
});

// ── Prompt content verification ─────────────────────────────

describe("draftPromoDescription — prompt content", () => {
  const baseArgs = {
    merchantName: "BLVD Coffee",
    promoName: "Coffee Stamps",
    categoryName: "Coffee",
    merchantType: "coffee_shop",
    rewardType: "discount_fixed",
    rewardValue: 500,
    threshold: 8,
    promotionType: "stamp",
  };

  beforeEach(() => {
    mockCreate.mockResolvedValue({
      content: [{ text: '{"versionA": "A", "versionB": "B"}' }],
    });
  });

  test("includes merchant name in prompt", async () => {
    await draftPromoDescription(baseArgs);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("BLVD Coffee");
  });

  test("includes reward description for discount_fixed", async () => {
    await draftPromoDescription(baseArgs);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("$5.00 off");
  });

  test("includes reward description for discount_pct", async () => {
    await draftPromoDescription({ ...baseArgs, rewardType: "discount_pct", rewardValue: 15 });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("15% off");
  });

  test("includes reward description for free_item", async () => {
    await draftPromoDescription({ ...baseArgs, rewardType: "free_item", rewardSku: "LATTE" });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("free LATTE");
  });

  test("includes coffee sensory guidance for coffee_shop", async () => {
    await draftPromoDescription(baseArgs);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("sensory");
    expect(prompt).toContain("warmth");
  });

  test("does NOT include coffee sensory guidance for gym", async () => {
    await draftPromoDescription({ ...baseArgs, merchantType: "fitness" });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain("warmth");
    expect(prompt).toContain("progress");
  });

  test("includes time condition when provided", async () => {
    await draftPromoDescription({ ...baseArgs, timeCondition: "Tuesdays 7-10am" });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("Tuesdays 7-10am");
  });

  test("includes stamp expiry when timeframeDays set", async () => {
    await draftPromoDescription({ ...baseArgs, timeframeDays: 30 });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("30 days");
  });

  test("uses stamp tone for stamp promotions", async () => {
    await draftPromoDescription(baseArgs);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("habit-affirming");
  });

  test("uses bundle tone for bundle promotions", async () => {
    await draftPromoDescription({ ...baseArgs, promotionType: "bundle" });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("convenience");
  });

  test("requests two versions", async () => {
    await draftPromoDescription(baseArgs);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("Version A");
    expect(prompt).toContain("Version B");
    expect(prompt).toContain("reward");
    expect(prompt).toContain("experience");
  });

  test("instructs to never use 'loyalty'", async () => {
    await draftPromoDescription(baseArgs);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Never use the word "loyalty"');
  });
});

// ── Product description ─────────────────────────────────────

describe("draftProductDescription", () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({
      content: [{ text: "Smooth espresso meets velvety steamed milk. A café classic that warms you from the first sip." }],
    });
  });

  test("returns description string", async () => {
    const result = await draftProductDescription({
      merchantName: "BLVD Coffee",
      productName: "Latte",
      categoryName: "Coffee",
    });
    expect(result).toContain("espresso");
    expect(typeof result).toBe("string");
  });

  test("includes product name in prompt", async () => {
    await draftProductDescription({ merchantName: "BLVD", productName: "Matcha Latte", categoryName: "Tea" });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("Matcha Latte");
  });

  test("includes merchant name in prompt", async () => {
    await draftProductDescription({ merchantName: "BLVD Coffee", productName: "Latte" });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("BLVD Coffee");
  });
});

// ── Bundle description ──────────────────────────────────────

describe("draftBundleDescription", () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({
      content: [{ text: "Your morning essentials in one easy grab. Bold coffee and a warm croissant, together the way mornings should be." }],
    });
  });

  test("returns description string", async () => {
    const result = await draftBundleDescription({
      merchantName: "BLVD Coffee",
      bundleName: "Morning Combo",
      componentsDesc: "1x Drip Coffee + 1x Croissant",
      price: 8.50,
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(20);
  });

  test("includes price in prompt", async () => {
    await draftBundleDescription({ merchantName: "BLVD", bundleName: "Combo", price: 12.00 });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("$12.00");
  });

  test("includes components in prompt", async () => {
    await draftBundleDescription({
      merchantName: "BLVD", bundleName: "Combo",
      componentsDesc: "2x Espresso + 1x Muffin",
    });
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("2x Espresso + 1x Muffin");
  });
});
