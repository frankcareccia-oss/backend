// tests/merchant.stores.test.js — Merchant store CRUD + profile

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let auth;
let merchant;
let storeId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Store Test Shop" });
  const user = await createUser({ email: "store-test@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "owner" });

  const token = merchantToken({ userId: user.id, merchantId: merchant.id });
  auth = authHeader(token);
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Merchant Stores", () => {
  describe("POST /merchant/stores", () => {
    it("creates a store", async () => {
      const res = await request(app)
        .post("/merchant/stores")
        .set(auth)
        .send({
          merchantId: merchant.id,
          name: "Downtown Location",
          address1: "123 Main St",
          city: "San Jose",
          state: "CA",
          postal: "95112",
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe("Downtown Location");
      expect(res.body.merchantId).toBe(merchant.id);
      expect(res.body.status).toBe("active");
      storeId = res.body.id;
    });

    it("rejects missing name", async () => {
      const res = await request(app)
        .post("/merchant/stores")
        .set(auth)
        .send({ merchantId: merchant.id });
      expect(res.status).toBe(400);
    });

    it("rejects missing merchantId", async () => {
      const res = await request(app)
        .post("/merchant/stores")
        .set(auth)
        .send({ name: "No Merchant" });
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/merchant/stores")
        .send({ merchantId: merchant.id, name: "Nope" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /merchant/stores", () => {
    it("lists stores for merchant", async () => {
      const res = await request(app).get("/merchant/stores").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      expect(res.body.items[0]).toHaveProperty("name");
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/merchant/stores");
      expect(res.status).toBe(401);
    });
  });
});

describe("Merchant Store Profile", () => {
  describe("GET /merchant/stores/:storeId", () => {
    it("returns store profile", async () => {
      const res = await request(app)
        .get(`/merchant/stores/${storeId}`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Downtown Location");
      expect(res.body.merchantId).toBe(merchant.id);
    });

    it("rejects non-existent store", async () => {
      const res = await request(app)
        .get("/merchant/stores/99999")
        .set(auth);
      expect([403, 404]).toContain(res.status);
    });
  });

  describe("PATCH /merchant/stores/:storeId/profile", () => {
    it("updates store name and address", async () => {
      const res = await request(app)
        .patch(`/merchant/stores/${storeId}/profile`)
        .set(auth)
        .send({
          name: "Uptown Location",
          address1: "456 Elm St",
          city: "San Francisco",
          state: "CA",
          postal: "94102",
        });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Uptown Location");
      expect(res.body.address1).toBe("456 Elm St");
      expect(res.body.city).toBe("San Francisco");
    });

    it("updates store phone", async () => {
      const res = await request(app)
        .patch(`/merchant/stores/${storeId}/profile`)
        .set(auth)
        .send({
          phoneRaw: "4085551234",
          phoneCountry: "US",
        });
      expect(res.status).toBe(200);
      expect(res.body.phoneRaw).toBe("4085551234");
    });

    it("allows setting empty name", async () => {
      const res = await request(app)
        .patch(`/merchant/stores/${storeId}/profile`)
        .set(auth)
        .send({ name: "" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("");
      // Restore the name for subsequent tests
      await request(app)
        .patch(`/merchant/stores/${storeId}/profile`)
        .set(auth)
        .send({ name: "Uptown Location" });
    });

    it("accepts empty body as no-op", async () => {
      const res = await request(app)
        .patch(`/merchant/stores/${storeId}/profile`)
        .set(auth)
        .send({});
      expect(res.status).toBe(200);
    });
  });
});
