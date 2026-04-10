// tests/merchant.bundles.test.js — Merchant + Admin bundle CRUD

const request = require("supertest");
const { getApp, merchantToken, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let merchAuth;
let adminAuth;
let merchant;
let bundleId;
let productId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Bundle Test Shop" });

  // Merchant owner
  const owner = await createUser({ email: "bundle-owner@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));

  // Admin
  const admin = await prisma.user.create({
    data: { email: "bundle-admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  adminAuth = authHeader(adminToken({ userId: admin.id }));

  // Seed a product for the ruleTree
  const product = await prisma.product.create({
    data: { merchantId: merchant.id, name: "Bundle Coffee", sku: "BDL-001", status: "active" },
  });
  productId = product.id;
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

function validRuleTree() {
  return {
    type: "PRODUCT",
    productId,
    productName: "Bundle Coffee",
    quantity: 3,
  };
}

describe("Merchant Bundles", () => {
  describe("POST /merchant/bundles", () => {
    it("creates a bundle", async () => {
      const res = await request(app)
        .post("/merchant/bundles")
        .set(merchAuth)
        .send({ name: "Coffee 3-Pack", price: 12.99, ruleTree: validRuleTree() });
      expect(res.status).toBe(201);
      expect(res.body.bundle).toHaveProperty("id");
      expect(res.body.bundle.name).toBe("Coffee 3-Pack");
      expect(res.body.bundle.status).toBe("wip");
      bundleId = res.body.bundle.id;
    });

    it("rejects missing name", async () => {
      const res = await request(app)
        .post("/merchant/bundles")
        .set(merchAuth)
        .send({ price: 10, ruleTree: validRuleTree() });
      expect(res.status).toBe(400);
    });

    it("rejects missing price", async () => {
      const res = await request(app)
        .post("/merchant/bundles")
        .set(merchAuth)
        .send({ name: "No Price", ruleTree: validRuleTree() });
      expect(res.status).toBe(400);
    });

    it("rejects negative price", async () => {
      const res = await request(app)
        .post("/merchant/bundles")
        .set(merchAuth)
        .send({ name: "Bad Price", price: -5, ruleTree: validRuleTree() });
      expect(res.status).toBe(400);
    });

    it("rejects missing ruleTree", async () => {
      const res = await request(app)
        .post("/merchant/bundles")
        .set(merchAuth)
        .send({ name: "No Rules", price: 10 });
      expect(res.status).toBe(400);
    });

    it("rejects invalid ruleTree type", async () => {
      const res = await request(app)
        .post("/merchant/bundles")
        .set(merchAuth)
        .send({ name: "Bad Tree", price: 10, ruleTree: { type: "INVALID" } });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /merchant/bundles", () => {
    it("lists bundles", async () => {
      const res = await request(app).get("/merchant/bundles").set(merchAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("bundles");
      expect(res.body.bundles.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by status", async () => {
      const res = await request(app).get("/merchant/bundles?status=wip").set(merchAuth);
      expect(res.status).toBe(200);
      res.body.bundles.forEach(b => expect(b.status).toBe("wip"));
    });
  });

  describe("PATCH /merchant/bundles/:bundleId", () => {
    it("updates bundle name", async () => {
      const res = await request(app)
        .patch(`/merchant/bundles/${bundleId}`)
        .set(merchAuth)
        .send({ name: "Coffee 5-Pack" });
      expect(res.status).toBe(200);
      expect(res.body.bundle.name).toBe("Coffee 5-Pack");
    });
  });

  describe("DELETE /merchant/bundles/:bundleId", () => {
    it("deletes a wip bundle", async () => {
      const res = await request(app)
        .delete(`/merchant/bundles/${bundleId}`)
        .set(merchAuth);
      expect(res.status).toBe(200);
    });

    it("rejects non-existent bundle", async () => {
      const res = await request(app)
        .delete("/merchant/bundles/99999")
        .set(merchAuth);
      expect([404, 400]).toContain(res.status);
    });
  });
});

describe("Admin Bundles", () => {
  let adminBundleId;

  describe("POST /admin/merchants/:merchantId/bundles", () => {
    it("creates a bundle via admin", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchant.id}/bundles`)
        .set(adminAuth)
        .send({ name: "Admin Bundle", price: 25, ruleTree: validRuleTree() });
      expect(res.status).toBe(201);
      expect(res.body.bundle.name).toBe("Admin Bundle");
      adminBundleId = res.body.bundle.id;
    });
  });

  describe("GET /admin/merchants/:merchantId/bundles", () => {
    it("lists merchant bundles", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${merchant.id}/bundles`)
        .set(adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("bundles");
    });
  });

  describe("PATCH /admin/merchants/:merchantId/bundles/:bundleId", () => {
    it("updates bundle via admin", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/bundles/${adminBundleId}`)
        .set(adminAuth)
        .send({ name: "Admin Bundle Updated" });
      expect(res.status).toBe(200);
      expect(res.body.bundle.name).toBe("Admin Bundle Updated");
    });
  });

  describe("DELETE /admin/merchants/:merchantId/bundles/:bundleId", () => {
    it("deletes bundle via admin", async () => {
      const res = await request(app)
        .delete(`/admin/merchants/${merchant.id}/bundles/${adminBundleId}`)
        .set(adminAuth);
      expect(res.status).toBe(200);
    });
  });
});
