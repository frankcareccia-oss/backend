// tests/growth.advisor.test.js — Growth Advisor API + Promotion Outcomes

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");

let app;
beforeAll(() => { app = getApp(); });

const auth = authHeader(merchantToken());

describe("Growth Advisor", () => {
  describe("GET /merchant/growth-advisor", () => {
    it("returns summary, metrics, insights, recommendations", async () => {
      const res = await request(app).get("/merchant/growth-advisor").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("summary");
      expect(res.body).toHaveProperty("metrics");
      expect(res.body).toHaveProperty("insights");
      expect(res.body).toHaveProperty("recommendations");
      expect(typeof res.body.summary).toBe("string");
      expect(res.body.metrics).toHaveProperty("aov");
      expect(res.body.metrics).toHaveProperty("totalOrders");
      expect(res.body.metrics).toHaveProperty("repeatRate");
      expect(Array.isArray(res.body.insights)).toBe(true);
      expect(Array.isArray(res.body.recommendations)).toBe(true);
    });

    it("recommendations have playbook structure", async () => {
      const res = await request(app).get("/merchant/growth-advisor").set(auth);
      if (res.body.recommendations.length > 0) {
        const rec = res.body.recommendations[0];
        expect(rec).toHaveProperty("playbookId");
        expect(rec).toHaveProperty("headline");
        expect(rec).toHaveProperty("recommendation");
        expect(rec).toHaveProperty("reason");
        expect(rec).toHaveProperty("confidence");
        expect(rec).toHaveProperty("cta");
        expect(rec.cta).toHaveProperty("label");
        expect(rec.cta).toHaveProperty("route");
      }
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/merchant/growth-advisor");
      expect(res.status).toBe(401);
    });
  });
});

describe("Promotion Outcomes", () => {
  describe("GET /merchant/promotion-outcomes", () => {
    it("returns outcomes list", async () => {
      const res = await request(app).get("/merchant/promotion-outcomes").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(Array.isArray(res.body.items)).toBe(true);
    });
  });

  describe("GET /merchant/promotions/:id/outcomes", () => {
    it("rejects non-existent promotion", async () => {
      const res = await request(app).get("/merchant/promotions/99999/outcomes").set(auth);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /merchant/promotion-outcomes/recompute", () => {
    it("triggers recompute", async () => {
      const res = await request(app)
        .post("/merchant/promotion-outcomes/recompute")
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
