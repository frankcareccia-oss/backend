// tests/consumer.wallet.test.js — Consumer wallet and promotions

const request = require("supertest");
const { getApp, consumerToken, authHeader } = require("./helpers/setup");

let app;
beforeAll(() => { app = getApp(); });

const auth = authHeader(consumerToken());

describe("Consumer Wallet", () => {
  describe("GET /me/summary", () => {
    it("returns summary counts", async () => {
      const res = await request(app).get("/me/summary").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("rewardsReady");
      expect(res.body).toHaveProperty("rewardsRedeemed");
      expect(res.body).toHaveProperty("programsJoined");
      expect(typeof res.body.rewardsReady).toBe("number");
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/me/summary");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /me/wallet", () => {
    it("returns wallet with active filter", async () => {
      const res = await request(app).get("/me/wallet?status=active").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("wallet");
      expect(Array.isArray(res.body.wallet)).toBe(true);
    });

    it("returns wallet with redeemed filter", async () => {
      const res = await request(app).get("/me/wallet?status=redeemed").set(auth);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.wallet)).toBe(true);
    });

    it("rejects invalid status filter", async () => {
      const res = await request(app).get("/me/wallet?status=bogus").set(auth);
      expect(res.status).toBe(400);
    });
  });
});

describe("Consumer Promotions", () => {
  describe("GET /me/promotions", () => {
    it("returns available promotions", async () => {
      const res = await request(app).get("/me/promotions").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("promotions");
      expect(Array.isArray(res.body.promotions)).toBe(true);
    });
  });

  describe("POST /me/promotions/:id/join", () => {
    it("rejects joining non-existent promotion", async () => {
      const res = await request(app).post("/me/promotions/99999/join").set(auth);
      expect([404, 422]).toContain(res.status);
    });
  });

  describe("POST /me/wallet/:id/redeem-request", () => {
    it("rejects non-existent entitlement", async () => {
      const res = await request(app).post("/me/wallet/99999/redeem-request").set(auth);
      expect(res.status).toBe(404);
    });
  });
});
