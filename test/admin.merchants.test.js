// tests/admin.merchants.test.js — Admin merchant CRUD + config + users

const request = require("supertest");
const { getApp, adminToken, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");
const { captureStdout } = require("./helpers/captureStdout");

let app;
let auth;       // admin auth
let merchAuth;  // merchant auth (for escalation tests)
let adminUser;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  // Create admin user (pv_admin)
  adminUser = await prisma.user.create({
    data: { email: "admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  const token = adminToken({ userId: adminUser.id });
  auth = authHeader(token);

  // Create a merchant user for escalation tests
  const merchant = await createMerchant({ name: "Existing Shop" });
  const merchUser = await createUser({ email: "merch-user@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: merchUser.id, role: "merchant_admin" });
  merchAuth = authHeader(merchantToken({ userId: merchUser.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Admin Merchants", () => {
  let createdMerchantId;

  describe("GET /merchants", () => {
    it("lists merchants", async () => {
      const res = await request(app).get("/merchants").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by status", async () => {
      const res = await request(app).get("/merchants?status=active").set(auth);
      expect(res.status).toBe(200);
      res.body.items.forEach(m => expect(m.status).toBe("active"));
    });

    it("rejects non-admin", async () => {
      const res = await request(app).get("/merchants").set(merchAuth);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /merchants", () => {
    it("creates a merchant and emits hook", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app)
          .post("/merchants")
          .set(auth)
          .send({ name: "New Test Merchant", merchantType: "coffee_shop" });
        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty("id");
        expect(res.body.name).toBe("New Test Merchant");
        expect(res.body.merchantType).toBe("coffee_shop");
        createdMerchantId = res.body.id;

        const joined = output.join("\n");
        expect(joined).toContain("admin.merchant.created");
      } finally {
        restore();
      }
    });

    it("rejects missing name", async () => {
      const res = await request(app)
        .post("/merchants")
        .set(auth)
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects invalid merchantType", async () => {
      const res = await request(app)
        .post("/merchants")
        .set(auth)
        .send({ name: "Bad Type", merchantType: "spaceship" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /merchants/:merchantId", () => {
    it("returns merchant detail", async () => {
      const res = await request(app)
        .get(`/merchants/${createdMerchantId}`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("New Test Merchant");
      expect(res.body).toHaveProperty("stores");
    });

    it("rejects non-existent merchant", async () => {
      const res = await request(app).get("/merchants/99999").set(auth);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /merchants/:merchantId", () => {
    it("updates merchant status", async () => {
      const res = await request(app)
        .patch(`/merchants/${createdMerchantId}`)
        .set(auth)
        .send({ status: "suspended" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("suspended");
    });

    it("updates merchant type", async () => {
      const res = await request(app)
        .patch(`/merchants/${createdMerchantId}`)
        .set(auth)
        .send({ merchantType: "restaurant", status: "active" });
      expect(res.status).toBe(200);
      expect(res.body.merchantType).toBe("restaurant");
    });

    it("rejects invalid status", async () => {
      const res = await request(app)
        .patch(`/merchants/${createdMerchantId}`)
        .set(auth)
        .send({ status: "deleted" });
      expect(res.status).toBe(400);
    });

    it("rejects empty body", async () => {
      const res = await request(app)
        .patch(`/merchants/${createdMerchantId}`)
        .set(auth)
        .send({});
      expect(res.status).toBe(400);
    });
  });
});

describe("Admin Platform Config", () => {
  describe("GET /admin/platform/config", () => {
    it("returns platform config", async () => {
      const res = await request(app).get("/admin/platform/config").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("config");
    });
  });

  describe("PUT /admin/platform/config", () => {
    it("updates config values", async () => {
      const res = await request(app)
        .put("/admin/platform/config")
        .set(auth)
        .send({ consumer_jwt_ttl_days: 30 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("rejects invalid config value", async () => {
      const res = await request(app)
        .put("/admin/platform/config")
        .set(auth)
        .send({ consumer_jwt_ttl_days: 999 });
      expect(res.status).toBe(400);
    });
  });
});

describe("Admin Merchant Users", () => {
  let testMerchantId;

  beforeAll(async () => {
    // Use the first merchant we find
    const merchants = await prisma.merchant.findMany({ take: 1 });
    testMerchantId = merchants[0].id;
  });

  describe("GET /admin/merchants/:merchantId/users", () => {
    it("lists merchant users", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${testMerchantId}/users`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.users)).toBe(true);
    });
  });

  describe("POST /admin/merchants/:merchantId/users", () => {
    it("creates a user for merchant", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${testMerchantId}/users`)
        .set(auth)
        .send({ email: "admin-created@perkvalet.org", firstName: "Admin", lastName: "Created" });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body).toHaveProperty("userId");
      expect(res.body).toHaveProperty("membership");
    });

    it("rejects missing email", async () => {
      const res = await request(app)
        .post(`/admin/merchants/${testMerchantId}/users`)
        .set(auth)
        .send({ firstName: "No Email" });
      expect(res.status).toBe(400);
    });
  });
});
