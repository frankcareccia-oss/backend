// tests/consumers.test.js — Consumer lookup and create (merchant/admin facing)

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser, createConsumer } = require("./helpers/seed");

let app;
let auth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Consumer Lookup Test" });
  const user = await createUser({ email: "lookup-test@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "owner" });
  auth = authHeader(merchantToken({ userId: user.id, merchantId: merchant.id }));

  // Seed a consumer to look up
  await createConsumer({ phoneE164: "+14085551111", email: "existing@test.com", firstName: "Existing" });
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Consumer Lookup", () => {
  describe("POST /consumers/lookup", () => {
    it("finds existing consumer by phone", async () => {
      const res = await request(app)
        .post("/consumers/lookup")
        .set(auth)
        .send({ phone: "+14085551111" });
      expect(res.status).toBe(200);
      expect(res.body.found).toBe(true);
      expect(res.body.consumer).toHaveProperty("id");
    });

    it("handles unknown phone", async () => {
      const res = await request(app)
        .post("/consumers/lookup")
        .set(auth)
        .send({ phone: "+19995550000" });
      // May return 200 with found:false or 400 — must not 500
      expect([200, 400]).toContain(res.status);
      if (res.status === 200) expect(res.body.found).toBe(false);
    });

    it("rejects missing phone", async () => {
      const res = await request(app)
        .post("/consumers/lookup")
        .set(auth)
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/consumers/lookup")
        .send({ phone: "+14085551111" });
      expect(res.status).toBe(401);
    });
  });
});

describe("Consumer Create", () => {
  describe("POST /consumers", () => {
    it("creates a new consumer", async () => {
      const res = await request(app)
        .post("/consumers")
        .set(auth)
        .send({
          phone: "+14085552222",
          firstName: "New",
          merchantId: merchant.id,
        });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty("consumer");
    });

    it("returns existing consumer for same phone (idempotent)", async () => {
      const res = await request(app)
        .post("/consumers")
        .set(auth)
        .send({
          phone: "+14085551111",
          firstName: "Existing",
          merchantId: merchant.id,
        });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty("consumer");
    });

    it("rejects missing phone", async () => {
      const res = await request(app)
        .post("/consumers")
        .set(auth)
        .send({ firstName: "NoPhone", merchantId: merchant.id });
      expect(res.status).toBe(400);
    });

    it("rejects missing firstName", async () => {
      const res = await request(app)
        .post("/consumers")
        .set(auth)
        .send({ phone: "+14085553333", merchantId: merchant.id });
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/consumers")
        .send({ phone: "+14085554444", firstName: "Anon", merchantId: merchant.id });
      expect(res.status).toBe(401);
    });
  });
});
