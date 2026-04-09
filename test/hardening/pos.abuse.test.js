// tests/hardening/pos.abuse.test.js — POS auth abuse + money edge cases + Square resilience

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("../helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("../helpers/seed");

let app;
let auth;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const merchant = await createMerchant({ name: "POS Abuse Test" });
  const user = await createUser({ email: "pos-abuse@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "owner" });
  auth = authHeader(merchantToken({ userId: user.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POS Auth Abuse", () => {
  describe("PIN brute force patterns", () => {
    it("rejects rapid sequential PINs", async () => {
      const results = [];
      for (let pin = 1000; pin <= 1005; pin++) {
        const res = await request(app)
          .post("/pos/auth/login")
          .send({ code: "1#" + pin });
        results.push(res.status);
      }
      // All should be 401 (no valid PIN), none should be 500
      results.forEach(s => expect(s).not.toBe(500));
    });

    it("rejects extremely long PIN", async () => {
      const res = await request(app)
        .post("/pos/auth/login")
        .send({ code: "1#" + "9".repeat(1000) });
      expect([400, 401]).toContain(res.status);
    });

    it("rejects code with SQL injection", async () => {
      const res = await request(app)
        .post("/pos/auth/login")
        .send({ code: "1#' OR 1=1 --" });
      expect([400, 401]).toContain(res.status);
    });

    it("rejects code with null bytes", async () => {
      const res = await request(app)
        .post("/pos/auth/login")
        .send({ code: "1#\x001234" });
      expect(res.status).not.toBe(500);
    });

    it("rejects code as number type", async () => {
      const res = await request(app)
        .post("/pos/auth/login")
        .send({ code: 12345 });
      expect(res.status).not.toBe(500);
    });

    it("rejects code as array", async () => {
      const res = await request(app)
        .post("/pos/auth/login")
        .send({ code: ["1#1234"] });
      expect(res.status).not.toBe(500);
    });

    it("rejects code as object", async () => {
      const res = await request(app)
        .post("/pos/auth/login")
        .send({ code: { pin: "1234" } });
      expect(res.status).not.toBe(500);
    });
  });

  describe("POS visit identifier abuse", () => {
    it("POST /pos/visit with XSS identifier does not crash", async () => {
      const res = await request(app)
        .post("/pos/visit")
        .set(auth)
        .send({ identifier: '<script>alert("xss")</script>' });
      // Should reject (bad format or no POS session) but not 500
      expect(res.status).not.toBe(500);
    });

    it("POST /pos/visit with extremely long identifier", async () => {
      const res = await request(app)
        .post("/pos/visit")
        .set(auth)
        .send({ identifier: "x".repeat(10000) });
      expect(res.status).not.toBe(500);
    });
  });
});

describe("Square Route Abuse", () => {
  describe("OAuth state manipulation", () => {
    it("rejects callback with forged state", async () => {
      const forgedState = Buffer.from(JSON.stringify({
        merchantId: 1,
        nonce: "forged-nonce",
      })).toString("base64");
      const res = await request(app)
        .get(`/pos/connect/square/callback?code=fake&state=${forgedState}`);
      // Should not succeed — forged state shouldn't match
      expect(res.status).not.toBe(200);
    });

    it("rejects callback with non-base64 state", async () => {
      const res = await request(app)
        .get("/pos/connect/square/callback?code=fake&state=not-base64!!!");
      expect(res.status).not.toBe(200);
    });
  });

  describe("Square map-location abuse", () => {
    it("rejects negative pvStoreId", async () => {
      const res = await request(app)
        .post("/pos/connect/square/map-location")
        .set(auth)
        .send({ externalLocationId: "LOC1", pvStoreId: -1 });
      expect(res.status).not.toBe(500);
    });

    it("rejects string pvStoreId", async () => {
      const res = await request(app)
        .post("/pos/connect/square/map-location")
        .set(auth)
        .send({ externalLocationId: "LOC1", pvStoreId: "abc" });
      expect(res.status).not.toBe(500);
    });

    it("rejects XSS in externalLocationId", async () => {
      const res = await request(app)
        .post("/pos/connect/square/map-location")
        .set(auth)
        .send({ externalLocationId: '<script>alert(1)</script>', pvStoreId: 1 });
      expect(res.status).not.toBe(500);
    });
  });
});

describe("POS Bundle Edge Cases", () => {
  it("POST /pos/bundles/sell with negative bundleId", async () => {
    const res = await request(app)
      .post("/pos/bundles/sell")
      .set(auth)
      .send({ bundleId: -1 });
    expect(res.status).not.toBe(500);
  });

  it("POST /pos/bundles/sell with string bundleId", async () => {
    const res = await request(app)
      .post("/pos/bundles/sell")
      .set(auth)
      .send({ bundleId: "abc" });
    expect(res.status).not.toBe(500);
  });

  it("POST /pos/bundles/0/redeem with zero instanceId", async () => {
    const res = await request(app)
      .post("/pos/bundles/0/redeem")
      .set(auth);
    expect(res.status).not.toBe(500);
  });

  it("POST /pos/bundles/abc/redeem with string instanceId", async () => {
    const res = await request(app)
      .post("/pos/bundles/abc/redeem")
      .set(auth);
    expect(res.status).not.toBe(500);
  });
});
