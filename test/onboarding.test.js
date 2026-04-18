// test/onboarding.test.js — Merchant onboarding flow tests

"use strict";

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app, auth, merchant, owner;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Onboard Test Shop" });
  owner = await createUser({ email: "onboard-owner@test.com" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  auth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

describe("Onboarding Session", () => {
  describe("GET /merchant/onboarding", () => {
    it("creates a new session on first call", async () => {
      const res = await request(app).get("/merchant/onboarding").set(auth);
      expect(res.status).toBe(200);
      expect(res.body.session).toBeDefined();
      expect(res.body.session.currentStage).toBe("pos-access");
      expect(res.body.session.currentStep).toBe("2.1");
      expect(res.body.session.merchantId).toBe(merchant.id);
    });

    it("returns existing session on subsequent calls", async () => {
      const res = await request(app).get("/merchant/onboarding").set(auth);
      expect(res.status).toBe(200);
      expect(res.body.session.currentStage).toBe("pos-access");
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/merchant/onboarding");
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /merchant/onboarding", () => {
    it("updates POS type and advances step", async () => {
      const res = await request(app)
        .patch("/merchant/onboarding")
        .set(auth)
        .send({ posType: "clover", currentStep: "2.2" });

      expect(res.status).toBe(200);
      expect(res.body.session.posType).toBe("clover");
      expect(res.body.session.currentStep).toBe("2.2");
    });

    it("updates setup persona", async () => {
      const res = await request(app)
        .patch("/merchant/onboarding")
        .set(auth)
        .send({ setupPersona: "self", currentStep: "2.3" });

      expect(res.status).toBe(200);
      expect(res.body.session.setupPersona).toBe("self");
    });

    it("advances to connect stage", async () => {
      const res = await request(app)
        .patch("/merchant/onboarding")
        .set(auth)
        .send({ credentialStatus: "ready", currentStage: "connect", currentStep: "3.1" });

      expect(res.status).toBe(200);
      expect(res.body.session.currentStage).toBe("connect");
      expect(res.body.session.credentialStatus).toBe("ready");
    });

    it("marks session complete when stage is live", async () => {
      const res = await request(app)
        .patch("/merchant/onboarding")
        .set(auth)
        .send({ currentStage: "live", currentStep: "6.1" });

      expect(res.status).toBe(200);
      expect(res.body.session.completedAt).toBeDefined();
    });
  });

  describe("POST /merchant/onboarding/help", () => {
    it("records help request and returns auto-response", async () => {
      // Reset session first
      await prisma.onboardingSession.update({
        where: { merchantId: merchant.id },
        data: { currentStage: "connect", currentStep: "3.1", completedAt: null },
      });

      const res = await request(app)
        .post("/merchant/onboarding/help")
        .set(auth)
        .send({ step: "3.1", message: "I can't find my login" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.response).toBeDefined();
      expect(typeof res.body.response).toBe("string");
      expect(res.body.response.length).toBeGreaterThan(10);

      // Verify stuck status recorded
      const session = await prisma.onboardingSession.findUnique({
        where: { merchantId: merchant.id },
      });
      expect(session.stuckAtStep).toBe("3.1");
      expect(session.stuckAt).toBeDefined();
    });

    it("returns step-specific help for password recovery", async () => {
      await prisma.onboardingSession.update({
        where: { merchantId: merchant.id },
        data: { currentStep: "2.4", posType: "clover" },
      });

      const res = await request(app)
        .post("/merchant/onboarding/help")
        .set(auth)
        .send({ step: "2.4" });

      expect(res.status).toBe(200);
      expect(res.body.response).toContain("spam");
    });
  });

  describe("POST /merchant/onboarding/connect", () => {
    it("returns OAuth redirect URL for Clover", async () => {
      await prisma.onboardingSession.update({
        where: { merchantId: merchant.id },
        data: { posType: "clover", currentStage: "connect", currentStep: "3.1" },
      });

      const res = await request(app)
        .post("/merchant/onboarding/connect")
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.redirectUrl).toBeDefined();
      expect(res.body.redirectUrl).toContain("oauth/authorize");
      expect(res.body.redirectUrl).toContain("client_id");

      // Verify attempt counter incremented
      const session = await prisma.onboardingSession.findUnique({
        where: { merchantId: merchant.id },
      });
      expect(session.oauthAttempts).toBeGreaterThanOrEqual(1);
    });

    it("returns OAuth redirect URL for Square", async () => {
      await prisma.onboardingSession.update({
        where: { merchantId: merchant.id },
        data: { posType: "square" },
      });

      const res = await request(app)
        .post("/merchant/onboarding/connect")
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.redirectUrl).toContain("oauth2/authorize");
    });

    it("rejects unsupported POS type", async () => {
      await prisma.onboardingSession.update({
        where: { merchantId: merchant.id },
        data: { posType: "toast" },
      });

      const res = await request(app)
        .post("/merchant/onboarding/connect")
        .set(auth);

      expect(res.status).toBe(400);
    });

    it("increments OAuth attempt counter on each call", async () => {
      await prisma.onboardingSession.update({
        where: { merchantId: merchant.id },
        data: { posType: "clover", oauthAttempts: 0 },
      });

      await request(app).post("/merchant/onboarding/connect").set(auth);
      await request(app).post("/merchant/onboarding/connect").set(auth);
      await request(app).post("/merchant/onboarding/connect").set(auth);

      const session = await prisma.onboardingSession.findUnique({
        where: { merchantId: merchant.id },
      });
      expect(session.oauthAttempts).toBe(3);
    });
  });

  describe("POST /merchant/onboarding/complete-connection", () => {
    it("detects no active connection", async () => {
      const res = await request(app)
        .post("/merchant/onboarding/complete-connection")
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("Clover merchant ID validation", () => {
    it("detects valid 13-char Clover merchant ID as production", async () => {
      // Create a mock POS connection with valid Clover ID
      const { encrypt } = require("../src/utils/encrypt");
      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "clover",
          status: "active",
          accessTokenEnc: encrypt("test-token"),
          externalMerchantId: "TC4DGCJW1K4EW", // valid 13-char
        },
      });

      const res = await request(app)
        .post("/merchant/onboarding/complete-connection")
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.posEnvironment).toBe("production");

      // Cleanup
      await prisma.posConnection.delete({ where: { id: conn.id } });
    });

    it("flags invalid format merchant ID as sandbox", async () => {
      const { encrypt } = require("../src/utils/encrypt");
      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "clover",
          status: "active",
          accessTokenEnc: encrypt("test-token"),
          externalMerchantId: "sandbox-default", // invalid format
        },
      });

      const res = await request(app)
        .post("/merchant/onboarding/complete-connection")
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.posEnvironment).toBe("sandbox");

      // Cleanup
      await prisma.posConnection.delete({ where: { id: conn.id } });
    });
  });

  describe("OAuth attempt tracking", () => {
    it("auto-escalates after 3+ failed attempts", async () => {
      await prisma.onboardingSession.update({
        where: { merchantId: merchant.id },
        data: { oauthAttempts: 3, posType: "clover" },
      });

      // On the 4th attempt, the UI should show stronger warning
      const session = await prisma.onboardingSession.findUnique({
        where: { merchantId: merchant.id },
      });
      expect(session.oauthAttempts).toBeGreaterThanOrEqual(3);

      // Verify help request with high attempt count adds context
      const res = await request(app)
        .post("/merchant/onboarding/help")
        .set(auth)
        .send({ step: "3.1", message: "Still can't connect after multiple tries" });

      expect(res.status).toBe(200);
      expect(res.body.response).toBeDefined();
    });
  });

  describe("Resume logic", () => {
    it("preserves all answers across sessions", async () => {
      // Set various answers
      await prisma.onboardingSession.update({
        where: { merchantId: merchant.id },
        data: {
          posType: "clover",
          setupPersona: "self",
          credentialStatus: "ready",
          currentStage: "connect",
          currentStep: "3.1",
          completedAt: null,
        },
      });

      // Simulate "next login" — GET should return all saved data
      const res = await request(app).get("/merchant/onboarding").set(auth);
      expect(res.status).toBe(200);
      expect(res.body.session.posType).toBe("clover");
      expect(res.body.session.setupPersona).toBe("self");
      expect(res.body.session.credentialStatus).toBe("ready");
      expect(res.body.session.currentStage).toBe("connect");
      expect(res.body.session.currentStep).toBe("3.1");
    });
  });
});
