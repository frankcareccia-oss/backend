// tests/admin.catalog.test.js — Admin product + category CRUD, store products

const request = require("supertest");
const { getApp, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant } = require("./helpers/seed");

let app;
let auth;
let merchant;
let productId;
let categoryId;
let storeId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const admin = await prisma.user.create({
    data: { email: "catalog-admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  auth = authHeader(adminToken({ userId: admin.id }));

  merchant = await createMerchant({ name: "Catalog Test Shop" });

  // Create a store for store product tests
  const store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Catalog Test Store", phoneRaw: "", phoneCountry: "US" },
  });
  storeId = store.id;
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Admin Categories", () => {
  describe("POST /admin/merchants/:merchantId/categories", () => {
    it("creates a category", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchant.id}/categories`)
        .set(auth)
        .send({ name: "Hot Drinks" });
      expect(res.status).toBe(201);
      expect(res.body.category.name).toBe("Hot Drinks");
      categoryId = res.body.category.id;
    });

    it("rejects duplicate name", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchant.id}/categories`)
        .set(auth)
        .send({ name: "Hot Drinks" });
      expect(res.status).toBe(409);
    });

    it("rejects missing name", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchant.id}/categories`)
        .set(auth)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("GET /admin/merchants/:merchantId/categories", () => {
    it("lists categories", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${merchant.id}/categories`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("categories");
      expect(res.body.categories.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PATCH /admin/merchants/:merchantId/categories/:categoryId", () => {
    it("updates category name", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/categories/${categoryId}`)
        .set(auth)
        .send({ name: "Cold Drinks" });
      expect(res.status).toBe(200);
      expect(res.body.category.name).toBe("Cold Drinks");
    });
  });
});

describe("Admin Products", () => {
  describe("POST /admin/merchants/:merchantId/products", () => {
    it("creates a product", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchant.id}/products`)
        .set(auth)
        .send({ name: "Admin Espresso", description: "Strong", categoryId });
      expect(res.status).toBe(201);
      expect(res.body.product.name).toBe("Admin Espresso");
      expect(res.body.product.status).toBe("draft");
      expect(res.body.product.sku).toBeTruthy();
      productId = res.body.product.id;
    });

    it("rejects missing name", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchant.id}/products`)
        .set(auth)
        .send({ description: "no name" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid categoryId", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchant.id}/products`)
        .set(auth)
        .send({ name: "Bad Cat", categoryId: 99999 });
      expect(res.status).toBe(422);
    });
  });

  describe("GET /admin/merchants/:merchantId/products", () => {
    it("lists products", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${merchant.id}/products`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PATCH /admin/merchants/:merchantId/products/:productId", () => {
    it("updates product name", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/products/${productId}`)
        .set(auth)
        .send({ name: "Admin Latte" });
      expect(res.status).toBe(200);
      expect(res.body.product.name).toBe("Admin Latte");
    });
  });

  describe("Product lifecycle", () => {
    it("activates a draft product", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchant.id}/products/${productId}/activate`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("active");
    });

    it("deactivates an active product", async () => {
      const res = await request(app)
        .delete(`/admin/merchants/${merchant.id}/products/${productId}`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("inactive");
    });

    it("reactivates an inactive product", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchant.id}/products/${productId}/reactivate`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("active");
    });

    it("rejects non-existent product", async () => {
      const res = await request(app)
        .delete(`/admin/merchants/${merchant.id}/products/99999`)
        .set(auth);
      expect(res.status).toBe(404);
    });
  });
});

describe("Admin Store Products", () => {
  describe("GET /admin/merchants/:merchantId/stores/:storeId/products", () => {
    it("lists store products", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${merchant.id}/stores/${storeId}/products`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("products");
    });
  });

  describe("PATCH store product enabled", () => {
    it("disables product at store", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/stores/${storeId}/products/${productId}`)
        .set(auth)
        .send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.storeProduct.enabled).toBe(false);
    });

    it("re-enables product at store", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/stores/${storeId}/products/${productId}`)
        .set(auth)
        .send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.storeProduct.enabled).toBe(true);
    });

    it("rejects non-boolean enabled", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/stores/${storeId}/products/${productId}`)
        .set(auth)
        .send({ enabled: "yes" });
      expect(res.status).toBe(400);
    });
  });
});
