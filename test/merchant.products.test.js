// tests/merchant.products.test.js — Merchant product & category CRUD

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let auth;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const merchant = await createMerchant({ name: "Test Coffee Shop" });
  const user = await createUser({ email: "products-test@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "merchant_admin" });

  const token = merchantToken({ userId: user.id, merchantId: merchant.id });
  auth = authHeader(token);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Merchant Products", () => {
  let productId;

  describe("POST /merchant/products", () => {
    it("creates a product", async () => {
      const res = await request(app)
        .post("/merchant/products")
        .set(auth)
        .send({ name: "Test Americano", description: "Bold and smooth" });
      expect(res.status).toBe(201);
      expect(res.body.product).toHaveProperty("id");
      expect(res.body.product.name).toBe("Test Americano");
      expect(res.body.product.sku).toBeTruthy();
      productId = res.body.product.id;
    });

    it("rejects missing name", async () => {
      const res = await request(app)
        .post("/merchant/products")
        .set(auth)
        .send({ description: "no name" });
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/merchant/products")
        .send({ name: "Nope" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /merchant/products", () => {
    it("lists products", async () => {
      const res = await request(app).get("/merchant/products").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(Array.isArray(res.body.items)).toBe(true);
    });
  });

  describe("PATCH /merchant/products/:productId", () => {
    it("updates product name", async () => {
      const res = await request(app)
        .patch(`/merchant/products/${productId}`)
        .set(auth)
        .send({ name: "Test Americano Updated" });
      expect(res.status).toBe(200);
      expect(res.body.product.name).toBe("Test Americano Updated");
    });

    it("rejects empty name", async () => {
      const res = await request(app)
        .patch(`/merchant/products/${productId}`)
        .set(auth)
        .send({ name: "" });
      expect(res.status).toBe(400);
    });
  });
});

describe("Merchant Categories", () => {
  let categoryId;

  describe("POST /merchant/categories", () => {
    it("creates a category", async () => {
      const res = await request(app)
        .post("/merchant/categories")
        .set(auth)
        .send({ name: "Test Hot Drinks" });
      expect(res.status).toBe(201);
      expect(res.body.category.name).toBe("Test Hot Drinks");
      categoryId = res.body.category.id;
    });

    it("rejects duplicate name", async () => {
      const res = await request(app)
        .post("/merchant/categories")
        .set(auth)
        .send({ name: "Test Hot Drinks" });
      expect(res.status).toBe(409);
    });
  });

  describe("PATCH /merchant/categories/:categoryId", () => {
    it("updates category name", async () => {
      const res = await request(app)
        .patch(`/merchant/categories/${categoryId}`)
        .set(auth)
        .send({ name: "Test Hot Beverages" });
      expect(res.status).toBe(200);
      expect(res.body.category.name).toBe("Test Hot Beverages");
    });
  });
});
