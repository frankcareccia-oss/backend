// tests/visits.test.js — Visit recording and QR scanning

const request = require("supertest");
const { getApp, merchantToken, consumerToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser, createConsumer } = require("./helpers/seed");

let app;
let store;
let qrToken;
let merchAuth;
let consumerAuth;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const merchant = await createMerchant({ name: "Visit Test Shop" });
  const user = await createUser({ email: "visit-test@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: user.id, merchantId: merchant.id }));

  store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Visit Store", phoneRaw: "", phoneCountry: "US" },
  });

  const qr = await prisma.storeQr.create({
    data: { storeId: store.id, merchantId: merchant.id, token: "test-visit-qr-token", status: "active" },
  });
  qrToken = qr.token;

  const consumer = await createConsumer({ phoneE164: "+14085556666" });
  consumerAuth = authHeader(consumerToken({ consumerId: consumer.id, phone: consumer.phoneE164 }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Visits", () => {
  describe("POST /visits", () => {
    it("records a visit with valid QR token", async () => {
      const res = await request(app).post("/visits")
        .set(merchAuth)
        .send({ token: qrToken });
      expect([200, 201]).toContain(res.status);
    });

    it("rejects missing token", async () => {
      const res = await request(app).post("/visits")
        .set(merchAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects invalid token", async () => {
      const res = await request(app).post("/visits")
        .set(merchAuth)
        .send({ token: "nonexistent-qr-token" });
      expect([400, 404]).toContain(res.status);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).post("/visits")
        .send({ token: qrToken });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /scan", () => {
    it("records a scan with phone", async () => {
      const res = await request(app).post("/scan")
        .set(merchAuth)
        .send({ token: qrToken, phone: "+14085556666" });
      expect([200, 201]).toContain(res.status);
    });

    it("rejects missing token", async () => {
      const res = await request(app).post("/scan")
        .set(merchAuth)
        .send({ phone: "+14085551234" });
      expect(res.status).toBe(400);
    });

    it("rejects missing phone", async () => {
      const res = await request(app).post("/scan")
        .set(merchAuth)
        .send({ token: qrToken });
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).post("/scan")
        .send({ token: qrToken, phone: "+14085551234" });
      expect(res.status).toBe(401);
    });
  });
});

describe("Consumer Scan", () => {
  describe("POST /me/scan", () => {
    it("records a consumer scan", async () => {
      const res = await request(app)
        .post("/me/scan")
        .set(consumerAuth)
        .send({ token: qrToken });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty("ok", true);
    });

    it("rejects missing token", async () => {
      const res = await request(app)
        .post("/me/scan")
        .set(consumerAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects invalid token", async () => {
      const res = await request(app)
        .post("/me/scan")
        .set(consumerAuth)
        .send({ token: "fake-token" });
      expect([400, 404]).toContain(res.status);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).post("/me/scan")
        .send({ token: qrToken });
      expect(res.status).toBe(401);
    });
  });
});
