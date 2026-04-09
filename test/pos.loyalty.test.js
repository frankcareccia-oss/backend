// tests/pos.loyalty.test.js — POS loyalty redemption flow

const request = require("supertest");
const { getApp } = require("./helpers/setup");

let app;
beforeAll(() => { app = getApp(); });

describe("POS Loyalty — /pos/loyalty", () => {
  describe("POST /pos/loyalty/grant-by-token", () => {
    it("rejects missing token", async () => {
      const res = await request(app)
        .post("/pos/loyalty/grant-by-token")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid/expired token", async () => {
      const res = await request(app)
        .post("/pos/loyalty/grant-by-token")
        .send({ token: "ZZZZZ0" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("rejects non-string token", async () => {
      const res = await request(app)
        .post("/pos/loyalty/grant-by-token")
        .send({ token: 12345 });
      expect(res.status).toBe(400);
    });
  });
});
