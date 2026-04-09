// tests/pos.auth.test.js — POS auth login validation

const request = require("supertest");
const { getApp } = require("./helpers/setup");

let app;
beforeAll(() => { app = getApp(); });

describe("POS Auth", () => {
  describe("POST /pos/auth/login", () => {
    it("rejects missing code", async () => {
      const res = await request(app).post("/pos/auth/login").send({});
      expect(res.status).toBe(400);
    });

    it("rejects empty code", async () => {
      const res = await request(app).post("/pos/auth/login").send({ code: "" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid code format (no store#pin)", async () => {
      const res = await request(app).post("/pos/auth/login").send({ code: "invalid" });
      expect(res.status).toBe(401);
    });

    it("rejects code with non-numeric PIN", async () => {
      const res = await request(app).post("/pos/auth/login").send({ code: "1#abcd" });
      expect(res.status).toBe(401);
    });

    it("rejects code for non-existent store", async () => {
      const res = await request(app).post("/pos/auth/login").send({ code: "99999#1234" });
      expect([401, 404]).toContain(res.status);
    });

    it("does not leak error details", async () => {
      const res = await request(app).post("/pos/auth/login").send({ code: "1#0000" });
      // Should not expose stack traces or internal details
      expect(res.body).not.toHaveProperty("stack");
      expect(JSON.stringify(res.body)).not.toContain("prisma");
    });
  });
});
