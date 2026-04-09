// tests/merchant.users.test.js — Merchant user management (list, add, update)

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let auth;
let merchant;
let ownerUserId;
let addedUserId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "User Mgmt Test Shop" });
  const owner = await createUser({ email: "owner-test@perkvalet.org" });
  ownerUserId = owner.id;
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });

  const token = merchantToken({ userId: owner.id, merchantId: merchant.id });
  auth = authHeader(token);
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Merchant Users", () => {
  describe("GET /merchant/users", () => {
    it("lists users for merchant", async () => {
      const res = await request(app)
        .get(`/merchant/users?merchantId=${merchant.id}`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      // Owner should be in the list
      const owner = res.body.items.find(u => u.userId === ownerUserId);
      expect(owner).toBeTruthy();
      expect(owner.role).toBe("owner");
    });

    it("rejects missing merchantId", async () => {
      const res = await request(app)
        .get("/merchant/users")
        .set(auth);
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .get(`/merchant/users?merchantId=${merchant.id}`);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /merchant/users", () => {
    it("creates a new merchant user", async () => {
      const res = await request(app)
        .post("/merchant/users")
        .set(auth)
        .send({
          merchantId: merchant.id,
          email: "newemployee@perkvalet.org",
          role: "merchant_employee",
          firstName: "Jane",
          lastName: "Doe",
        });
      expect([200, 201]).toContain(res.status);
      expect(res.body.ok).toBe(true);
      expect(res.body).toHaveProperty("userId");
      expect(res.body).toHaveProperty("membership");
      expect(res.body.membership.role).toBe("merchant_employee");
      addedUserId = res.body.userId;
    });

    it("rejects missing email", async () => {
      const res = await request(app)
        .post("/merchant/users")
        .set(auth)
        .send({
          merchantId: merchant.id,
          role: "merchant_employee",
        });
      expect(res.status).toBe(400);
    });

    it("rejects missing role", async () => {
      const res = await request(app)
        .post("/merchant/users")
        .set(auth)
        .send({
          merchantId: merchant.id,
          email: "norole@perkvalet.org",
        });
      expect(res.status).toBe(400);
    });

    it("rejects invalid role", async () => {
      const res = await request(app)
        .post("/merchant/users")
        .set(auth)
        .send({
          merchantId: merchant.id,
          email: "badrole@perkvalet.org",
          role: "superadmin",
        });
      expect(res.status).toBe(400);
    });

    it("handles duplicate email (upsert)", async () => {
      const res = await request(app)
        .post("/merchant/users")
        .set(auth)
        .send({
          merchantId: merchant.id,
          email: "newemployee@perkvalet.org",
          role: "merchant_admin",
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Role should be updated
      expect(res.body.membership.role).toBe("merchant_admin");
    });
  });

  describe("PATCH /merchant/users/:userId", () => {
    it("updates user role", async () => {
      const res = await request(app)
        .patch(`/merchant/users/${addedUserId}`)
        .set(auth)
        .send({
          merchantId: merchant.id,
          role: "ap_clerk",
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.membership.role).toBe("ap_clerk");
    });

    it("updates user name", async () => {
      const res = await request(app)
        .patch(`/merchant/users/${addedUserId}`)
        .set(auth)
        .send({
          merchantId: merchant.id,
          firstName: "Janet",
          lastName: "Smith",
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.user.firstName).toBe("Janet");
      expect(res.body.user.lastName).toBe("Smith");
    });

    it("suspends a user", async () => {
      const res = await request(app)
        .patch(`/merchant/users/${addedUserId}`)
        .set(auth)
        .send({
          merchantId: merchant.id,
          status: "suspended",
        });
      expect(res.status).toBe(200);
      expect(res.body.membership.status).toBe("suspended");
    });

    it("reactivates a user", async () => {
      const res = await request(app)
        .patch(`/merchant/users/${addedUserId}`)
        .set(auth)
        .send({
          merchantId: merchant.id,
          status: "active",
        });
      expect(res.status).toBe(200);
      expect(res.body.membership.status).toBe("active");
    });

    it("rejects missing merchantId", async () => {
      const res = await request(app)
        .patch(`/merchant/users/${addedUserId}`)
        .set(auth)
        .send({ role: "merchant_employee" });
      expect(res.status).toBe(400);
    });

    it("rejects non-existent user", async () => {
      const res = await request(app)
        .patch("/merchant/users/99999")
        .set(auth)
        .send({ merchantId: merchant.id, role: "merchant_employee" });
      expect([404, 400]).toContain(res.status);
    });
  });
});
