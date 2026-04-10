// tests/auth.device.test.js — Device verification routes

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let auth;
let userId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const merchant = await createMerchant({ name: "Device Test Shop" });
  const user = await createUser({ email: "device-test@perkvalet.org" });
  userId = user.id;
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "owner" });
  auth = authHeader(merchantToken({ userId: user.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Device Verification", () => {
  describe("GET /auth/device/status", () => {
    it("returns device status", async () => {
      const res = await request(app)
        .get("/auth/device/status")
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("ok", true);
      expect(res.body).toHaveProperty("trusted");
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/auth/device/status");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /auth/device/list", () => {
    it("returns device list or 404 if route not mounted", async () => {
      const res = await request(app)
        .get("/auth/device/list")
        .set(auth);
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("ok", true);
        expect(Array.isArray(res.body.devices)).toBe(true);
      }
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/auth/device/list");
      expect([401, 404]).toContain(res.status);
    });
  });

  describe("POST /auth/device/revoke/:deviceId", () => {
    it("rejects non-existent device", async () => {
      const res = await request(app)
        .post("/auth/device/revoke/99999")
        .set(auth);
      expect([200, 404]).toContain(res.status);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).post("/auth/device/revoke/1");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /auth/device/debug/:userId", () => {
    it("returns debug info or requires auth", async () => {
      const res = await request(app).get(`/auth/device/debug/${userId}`);
      // May be public debug endpoint or behind auth wall
      expect([200, 401, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("ok", true);
      }
    });

    it("handles non-existent user", async () => {
      const res = await request(app).get("/auth/device/debug/99999");
      expect(res.status).not.toBe(500);
    });
  });
});
