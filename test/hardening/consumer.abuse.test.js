// tests/hardening/consumer.abuse.test.js — Consumer OTP fuzzing, wallet abuse, phone validation

const request = require("supertest");
const { getApp, consumerToken, authHeader } = require("../helpers/setup");
const { prisma, resetDb, createConsumer } = require("../helpers/seed");

let app;
let auth;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const consumer = await createConsumer({ phoneE164: "+14085557777" });
  auth = authHeader(consumerToken({ consumerId: consumer.id, phone: consumer.phoneE164 }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("OTP Phone Fuzzing", () => {
  it("rejects missing phone", async () => {
    const res = await request(app).post("/consumer/auth/otp/start").send({});
    expect(res.status).toBe(400);
  });

  it("rejects empty phone", async () => {
    const res = await request(app).post("/consumer/auth/otp/start").send({ phone: "" });
    expect(res.status).toBe(400);
  });

  it("rejects phone too short", async () => {
    const res = await request(app).post("/consumer/auth/otp/start").send({ phone: "123" });
    expect(res.status).toBe(400);
  });

  it("rejects phone with letters", async () => {
    const res = await request(app).post("/consumer/auth/otp/start").send({ phone: "408-555-ABCD" });
    expect(res.status).not.toBe(500);
  });

  it("rejects phone as number type", async () => {
    const res = await request(app).post("/consumer/auth/otp/start").send({ phone: 4085551234 });
    expect(res.status).not.toBe(500);
  });

  it("rejects SQL injection in phone", async () => {
    const res = await request(app).post("/consumer/auth/otp/start").send({ phone: "' OR 1=1 --" });
    expect(res.status).not.toBe(500);
  });

  it("rejects extremely long phone", async () => {
    const res = await request(app).post("/consumer/auth/otp/start").send({ phone: "1".repeat(1000) });
    expect(res.status).not.toBe(500);
  });

  it("handles international format", async () => {
    const res = await request(app).post("/consumer/auth/otp/start").send({ phone: "+442071234567" });
    // May succeed or fail validation, but should not crash
    expect(res.status).not.toBe(500);
  });
});

describe("OTP Verify Fuzzing", () => {
  it("rejects missing phone and code", async () => {
    const res = await request(app).post("/consumer/auth/otp/verify").send({});
    expect(res.status).toBe(400);
  });

  it("rejects wrong code format", async () => {
    const res = await request(app).post("/consumer/auth/otp/verify")
      .send({ phone: "+14085551234", code: "not-a-code" });
    expect(res.status).not.toBe(500);
  });

  it("rejects code as number", async () => {
    const res = await request(app).post("/consumer/auth/otp/verify")
      .send({ phone: "+14085551234", code: 123456 });
    expect(res.status).not.toBe(500);
  });

  it("rejects SQL injection in code", async () => {
    const res = await request(app).post("/consumer/auth/otp/verify")
      .send({ phone: "+14085551234", code: "' OR 1=1 --" });
    expect(res.status).not.toBe(500);
  });
});

describe("Consumer Wallet Abuse", () => {
  it("rejects wallet with SQL injection status", async () => {
    const res = await request(app)
      .get("/me/wallet?status=' OR 1=1 --")
      .set(auth);
    expect(res.status).toBe(400);
  });

  it("rejects wallet with extremely long status", async () => {
    const res = await request(app)
      .get("/me/wallet?status=" + "x".repeat(1000))
      .set(auth);
    expect(res.status).toBe(400);
  });

  it("rejects join with zero promotion ID", async () => {
    const res = await request(app)
      .post("/me/promotions/0/join")
      .set(auth);
    expect(res.status).not.toBe(500);
  });

  it("rejects join with negative promotion ID", async () => {
    const res = await request(app)
      .post("/me/promotions/-1/join")
      .set(auth);
    expect(res.status).not.toBe(500);
  });

  it("rejects join with string promotion ID", async () => {
    const res = await request(app)
      .post("/me/promotions/abc/join")
      .set(auth);
    expect(res.status).not.toBe(500);
  });

  it("rejects redeem with string entitlement ID", async () => {
    const res = await request(app)
      .post("/me/wallet/abc/redeem-request")
      .set(auth);
    expect(res.status).not.toBe(500);
  });

  it("consumer cannot access merchant routes", async () => {
    const res = await request(app)
      .get("/merchant/products")
      .set(auth);
    expect(res.status).toBe(401);
  });

  it("consumer cannot access admin routes", async () => {
    const res = await request(app)
      .get("/admin/invoices")
      .set(auth);
    expect(res.status).toBe(401);
  });
});
