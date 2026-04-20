// test/support-ai.test.js — AI Support Pipeline

"use strict";

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app, auth, merchant;

beforeAll(async () => {
  app = getApp();
  merchant = await createMerchant({ name: `Support Test ${Date.now()}` });
  const owner = await createUser({ email: `support-owner-${Date.now()}@test.com` });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  auth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

// ── Diagnosis endpoint ──────────────────────────────────────

describe("POST /api/support/diagnose", () => {
  it("returns diagnosis for 401 error context", async () => {
    const res = await request(app)
      .post("/api/support/diagnose")
      .set(auth)
      .send({
        session: { pathname: "/merchant/dashboard" },
        apiEvents: [
          { direction: "in", ts: new Date().toISOString(), status: 401 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.diagnosis).toBeDefined();
    expect(res.body.diagnosis).toContain("session");
    expect(res.body.confidence).toBe("high");
    expect(res.body.resolution_steps).toBeDefined();
    expect(res.body.resolution_steps.length).toBeGreaterThan(0);
  });

  it("returns diagnosis for 500 error context", async () => {
    const res = await request(app)
      .post("/api/support/diagnose")
      .set(auth)
      .send({
        session: { pathname: "/merchant/promotions" },
        apiEvents: [
          { direction: "in", ts: new Date().toISOString(), status: 500 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.diagnosis).toBeDefined();
    expect(res.body.requires_pv_support).toBe(true);
  });

  it("returns page-specific diagnosis for onboarding page", async () => {
    const res = await request(app)
      .post("/api/support/diagnose")
      .set(auth)
      .send({
        session: { pathname: "/merchant/onboarding" },
        apiEvents: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.diagnosis).toBeDefined();
  });

  it("requires auth", async () => {
    const res = await request(app)
      .post("/api/support/diagnose")
      .send({});

    expect(res.status).toBe(401);
  });
});

// ── Ticket creation ─────────────────────────────────────────

describe("POST /api/support/ticket", () => {
  it("creates pre-populated ticket", async () => {
    const res = await request(app)
      .post("/api/support/ticket")
      .set(auth)
      .send({
        context: {
          session: { pathname: "/merchant/promotions", route: "/merchant/promotions" },
          apiEvents: [{ direction: "in", ts: new Date().toISOString(), status: 500 }],
          api: { lastError: "Server error", lastRequest: "GET /merchant/promotions → HTTP 500" },
        },
        diagnosis: {
          diagnosis: "Something went wrong on our end.",
          confidence: "medium",
          resolution_steps: ["Refresh the page"],
          requires_pv_support: true,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ticketId).toBeDefined();
    expect(res.body.priority).toBeDefined();
    expect(res.body.message).toContain("follow up");

    // Verify in DB
    const ticket = await prisma.supportTicket.findUnique({ where: { id: res.body.ticketId } });
    expect(ticket).toBeDefined();
    expect(ticket.merchantId).toBe(merchant.id);
    expect(ticket.page).toBe("/merchant/promotions");
    expect(ticket.aiDiagnosis).toContain("wrong on our end");
    expect(ticket.status).toBe("open");
  });

  it("sets high priority for 500 errors", async () => {
    const res = await request(app)
      .post("/api/support/ticket")
      .set(auth)
      .send({
        context: {
          session: { pathname: "/merchant/products" },
          apiEvents: [{ direction: "in", ts: new Date().toISOString(), status: 500 }],
        },
        diagnosis: { diagnosis: "Server error" },
      });

    expect(res.body.priority).toBe("high");
  });

  it("sets critical priority for billing pages", async () => {
    const res = await request(app)
      .post("/api/support/ticket")
      .set(auth)
      .send({
        context: {
          session: { pathname: "/merchant/billing/payment" },
          apiEvents: [],
        },
        diagnosis: { diagnosis: "Payment issue" },
      });

    expect(res.body.priority).toBe("critical");
  });
});

// ── Knowledge graph ─────────────────────────────────────────

describe("Knowledge graph", () => {
  it("loads and contains expected structure", () => {
    const fs = require("fs");
    const path = require("path");
    const kgPath = path.join(__dirname, "../src/agents/output/knowledge-graph.json");
    const kg = JSON.parse(fs.readFileSync(kgPath, "utf8"));

    expect(kg.pages).toBeDefined();
    expect(kg.pages.length).toBeGreaterThan(0);
    expect(kg.flows).toBeDefined();
    expect(kg.error_codes).toBeDefined();
    expect(kg.pos_connection_states).toBeDefined();
    expect(kg.promotion_types).toBeDefined();
    expect(kg.precedence_engine).toBeDefined();
  });

  it("has resolution steps for common errors", () => {
    const fs = require("fs");
    const path = require("path");
    const kgPath = path.join(__dirname, "../src/agents/output/knowledge-graph.json");
    const kg = JSON.parse(fs.readFileSync(kgPath, "utf8"));

    const posPage = kg.pages.find(p => p.id === "pos_connection");
    expect(posPage).toBeDefined();
    expect(posPage.common_issues.length).toBeGreaterThan(0);

    const oauthIssue = posPage.common_issues.find(i => i.id === "clover_session_conflict");
    expect(oauthIssue).toBeDefined();
    expect(oauthIssue.resolution.length).toBeGreaterThan(0);
    expect(oauthIssue.merchant_fixable).toBe(true);
  });

  it("has all 5 promotion types documented", () => {
    const fs = require("fs");
    const path = require("path");
    const kgPath = path.join(__dirname, "../src/agents/output/knowledge-graph.json");
    const kg = JSON.parse(fs.readFileSync(kgPath, "utf8"));

    const types = kg.promotion_types.map(t => t.type);
    expect(types).toContain("stamp");
    expect(types).toContain("tiered");
    expect(types).toContain("conditional");
    expect(types).toContain("referral");
    expect(types).toContain("bundle");
  });
});
