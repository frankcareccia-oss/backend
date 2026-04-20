// test/ai-validation.test.js — AI Validation (Item 21)

"use strict";

// Mock Anthropic for AI insight tests
const mockCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});
process.env.ANTHROPIC_API_KEY = "test-key";

const {
  draftValidationInsight,
  generateDeterministicInsight,
} = require("../src/utils/aiDraft");

const { checkDivergence } = require("../src/merchant/simulator.projections");

// ── Deterministic insight generation ────────────────────────

describe("generateDeterministicInsight", () => {
  test("generates underperformance insight", () => {
    const insight = generateDeterministicInsight({
      promotionName: "Coffee Stamps",
      divergencePct: -25,
      direction: "under",
      attributionRate: 0.45,
      durationDays: 21,
    });

    expect(insight).toContain("Coffee Stamps");
    expect(insight).toContain("25%");
    expect(insight).toContain("below");
    expect(insight).toContain("phone number"); // low attribution advice
  });

  test("generates overperformance insight", () => {
    const insight = generateDeterministicInsight({
      promotionName: "Happy Hour",
      divergencePct: 35,
      direction: "over",
      attributionRate: 0.72,
      durationDays: 30,
    });

    expect(insight).toContain("Great news");
    expect(insight).toContain("35%");
    expect(insight).toContain("ahead");
    expect(insight).toContain("budget");
  });

  test("suggests signage for normal attribution + underperformance", () => {
    const insight = generateDeterministicInsight({
      promotionName: "Loyalty",
      divergencePct: -30,
      direction: "under",
      attributionRate: 0.70, // attribution is fine
      durationDays: 14,
    });

    expect(insight).toContain("signage");
  });
});

// ── AI insight generation (mocked) ──────────────────────────

describe("draftValidationInsight", () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({
      content: [{ text: "Your afternoon program is off to a solid start. Consider adding a small counter sign to remind customers about the bonus stamps during their 2-5pm visits." }],
    });
  });

  test("generates AI insight for underperformance", async () => {
    const insight = await draftValidationInsight({
      merchantName: "BLVD Coffee",
      promotionName: "Afternoon Double",
      objective: "fill-slow",
      projectedValue: "58% lift",
      actualValue: "31% lift",
      divergencePct: -27,
      attributionRate: 0.61,
      durationDays: 21,
      direction: "under",
    });

    expect(insight).toBeDefined();
    expect(insight.length).toBeGreaterThan(20);
  });

  test("prompt includes merchant name and actual numbers", async () => {
    await draftValidationInsight({
      merchantName: "BLVD Coffee",
      promotionName: "Afternoon Double",
      objective: "fill-slow",
      projectedValue: "58%",
      actualValue: "31%",
      divergencePct: -27,
      durationDays: 21,
      direction: "under",
    });

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("BLVD Coffee");
    expect(prompt).toContain("Afternoon Double");
    expect(prompt).toContain("21 days");
    expect(prompt).toContain("-27%");
  });

  test("prompt includes encouragement rules", async () => {
    await draftValidationInsight({
      merchantName: "Test",
      promotionName: "Test",
      divergencePct: -30,
      durationDays: 14,
      direction: "under",
    });

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("never blame");
    expect(prompt).toContain("encouraging");
  });
});

// ── Divergence detection integration ─────────────────────────

describe("Divergence + insight integration", () => {
  test("divergence triggers insight generation", () => {
    const divergence = checkDivergence(1000, 700); // 30% under
    expect(divergence).not.toBeNull();
    expect(divergence.direction).toBe("under");

    const insight = generateDeterministicInsight({
      promotionName: "Test Promo",
      divergencePct: divergence.divergencePct,
      direction: divergence.direction,
      attributionRate: 0.55,
      durationDays: 21,
    });

    expect(insight).toContain("Test Promo");
    expect(insight).toContain("below");
  });

  test("no divergence = no insight needed", () => {
    const divergence = checkDivergence(1000, 950); // 5% under — within threshold
    expect(divergence).toBeNull();
  });

  test("overperformance triggers positive insight", () => {
    const divergence = checkDivergence(1000, 1400); // 40% over
    expect(divergence.direction).toBe("over");

    const insight = generateDeterministicInsight({
      promotionName: "VIP Program",
      divergencePct: divergence.divergencePct,
      direction: divergence.direction,
      attributionRate: 0.80,
      durationDays: 30,
    });

    expect(insight).toContain("Great news");
    expect(insight).toContain("budget");
  });
});
