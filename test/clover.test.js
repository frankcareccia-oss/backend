// tests/clover.test.js — Clover integration: OAuth, adapter, webhook, connection management

const request = require("supertest");
const { getApp, merchantToken, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");
const { captureStdout } = require("./helpers/captureStdout");

let app;
let merchAuth;
let adminAuth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Clover Test Shop" });
  const owner = await createUser({ email: "clover-owner@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));

  const admin = await prisma.user.create({
    data: { email: "clover-admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  adminAuth = authHeader(adminToken({ userId: admin.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Clover OAuth", () => {
  describe("GET /pos/connect/clover", () => {
    it("redirects to Clover OAuth and emits hook", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app)
          .get("/pos/connect/clover")
          .set(merchAuth)
          .redirects(0);
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain("clover.com/oauth/authorize");
        expect(res.headers.location).toContain("client_id=");

        const joined = output.join("\n");
        expect(joined).toContain("clover.oauth.initiated");
        expect(joined).toContain("TC-CLO-01");
      } finally {
        restore();
      }
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/pos/connect/clover").redirects(0);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /pos/connect/clover/status", () => {
    it("returns not connected initially", async () => {
      const res = await request(app)
        .get("/pos/connect/clover/status")
        .set(merchAuth);
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/pos/connect/clover/status");
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /pos/connect/clover", () => {
    it("succeeds even with no connection (idempotent)", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app)
          .delete("/pos/connect/clover")
          .set(merchAuth);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const joined = output.join("\n");
        expect(joined).toContain("clover.oauth.disconnected");
        expect(joined).toContain("TC-CLO-04");
      } finally {
        restore();
      }
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).delete("/pos/connect/clover");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /pos/connect/clover/callback", () => {
    it("rejects missing code", async () => {
      const res = await request(app).get("/pos/connect/clover/callback");
      expect(res.status).toBe(400);
    });

    it("rejects invalid state", async () => {
      const res = await request(app)
        .get("/pos/connect/clover/callback?code=test&merchant_id=m123&state=badstate");
      expect([400, 500]).toContain(res.status);
    });
  });

  describe("POST /pos/connect/clover/sync-catalog", () => {
    it("rejects when no Clover connection", async () => {
      const res = await request(app)
        .post("/pos/connect/clover/sync-catalog")
        .set(merchAuth);
      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).post("/pos/connect/clover/sync-catalog");
      expect(res.status).toBe(401);
    });
  });
});

describe("Clover Webhook", () => {
  describe("POST /webhooks/clover", () => {
    it("accepts and returns 200", async () => {
      const res = await request(app)
        .post("/webhooks/clover")
        .set("Content-Type", "application/json")
        .send({ type: "payment.created", merchants: {} });
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it("handles verification ping", async () => {
      const res = await request(app)
        .post("/webhooks/clover")
        .set("Content-Type", "application/json")
        .send("");
      expect(res.status).toBe(200);
    });

    it("processes payment event with PosConnection", async () => {
      // Create a Clover PosConnection
      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "clover",
          externalMerchantId: "CLV_TEST_001",
          accessTokenEnc: "test-token",
          status: "active",
        },
      });

      const res = await request(app)
        .post("/webhooks/clover")
        .set("Content-Type", "application/json")
        .send({
          type: "payments",
          merchants: {
            CLV_TEST_001: {
              payments: [{ type: "CREATE", objectId: "clv_pay_" + Date.now() }],
            },
          },
        });

      expect(res.status).toBe(200);

      // Wait for async processing
      await new Promise(r => setTimeout(r, 1000));

      // Clean up
      await prisma.posConnection.delete({ where: { id: conn.id } });
    });
  });
});

describe("Clover Adapter Resolver", () => {
  it("resolves CloverAdapter for clover posType", async () => {
    const conn = await prisma.posConnection.create({
      data: {
        merchantId: merchant.id,
        posType: "clover",
        externalMerchantId: "CLV_RESOLVE_001",
        accessTokenEnc: "test-token",
        status: "active",
      },
    });

    const { getPosAdapter } = require("../src/pos/pos.adapter.resolver");
    const adapter = await getPosAdapter({ id: merchant.id }, "clover");
    expect(adapter.constructor.name).toBe("CloverAdapter");

    await prisma.posConnection.delete({ where: { id: conn.id } });
  });
});
