// tests/consumer.auth.test.js — Consumer OTP login flow

const request = require("supertest");
const { getApp } = require("./helpers/setup");

let app;
beforeAll(() => { app = getApp(); });

describe("Consumer Auth — OTP Flow", () => {
  const phone = "4085559999";

  describe("POST /consumer/auth/otp/start", () => {
    it("sends OTP for valid phone", async () => {
      const res = await request(app)
        .post("/consumer/auth/otp/start")
        .send({ phone });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.hint).toBe("Code sent");
    });

    it("rejects missing phone", async () => {
      const res = await request(app)
        .post("/consumer/auth/otp/start")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid phone", async () => {
      const res = await request(app)
        .post("/consumer/auth/otp/start")
        .send({ phone: "123" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /consumer/auth/otp/verify", () => {
    it("rejects missing phone or code", async () => {
      const res = await request(app)
        .post("/consumer/auth/otp/verify")
        .send({ phone });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects wrong code", async () => {
      const res = await request(app)
        .post("/consumer/auth/otp/verify")
        .send({ phone, code: "999999" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CODE");
    });
  });
});
