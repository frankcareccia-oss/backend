// tests/square.integration.test.js — Square OAuth and connection management

const request = require("supertest");
const { getApp, merchantToken, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let auth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Square Test Shop" });
  const user = await createUser({ email: "square-test@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "owner" });

  auth = authHeader(merchantToken({ userId: user.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Square Connection", () => {
  describe("GET /pos/connect/square/status", () => {
    it("returns not connected when no connection exists", async () => {
      const res = await request(app)
        .get("/pos/connect/square/status")
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/pos/connect/square/status");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /pos/connect/square/locations", () => {
    it("rejects when no Square connection", async () => {
      const res = await request(app)
        .get("/pos/connect/square/locations")
        .set(auth);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /pos/connect/square/sync-catalog", () => {
    it("rejects when no Square connection", async () => {
      const res = await request(app)
        .post("/pos/connect/square/sync-catalog")
        .set(auth);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /pos/connect/square/map-location", () => {
    it("rejects when no Square connection", async () => {
      const res = await request(app)
        .post("/pos/connect/square/map-location")
        .set(auth)
        .send({ externalLocationId: "LOC123", pvStoreId: 1 });
      expect(res.status).toBe(404);
    });

    it("rejects missing fields", async () => {
      const res = await request(app)
        .post("/pos/connect/square/map-location")
        .set(auth)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("GET /pos/connect/square/sync-log", () => {
    it("returns empty logs when no syncs", async () => {
      const res = await request(app)
        .get("/pos/connect/square/sync-log")
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("logs");
      expect(Array.isArray(res.body.logs)).toBe(true);
    });
  });

  describe("DELETE /pos/connect/square", () => {
    it("succeeds even with no connection (idempotent)", async () => {
      const res = await request(app)
        .delete("/pos/connect/square")
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).delete("/pos/connect/square");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /pos/connect/square (OAuth redirect)", () => {
    it("redirects to Square OAuth", async () => {
      const res = await request(app)
        .get("/pos/connect/square")
        .set(auth)
        .redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/squareup.*\.com\/oauth2\/authorize/);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/pos/connect/square").redirects(0);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /pos/connect/square/callback", () => {
    it("rejects missing code/state", async () => {
      const res = await request(app).get("/pos/connect/square/callback");
      expect([400, 302]).toContain(res.status);
    });

    it("rejects invalid state parameter", async () => {
      const res = await request(app)
        .get("/pos/connect/square/callback?code=test&state=badstate");
      expect([400, 302, 500]).toContain(res.status);
    });
  });
});
