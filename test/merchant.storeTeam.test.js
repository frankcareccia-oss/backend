// tests/merchant.storeTeam.test.js — Merchant store team management

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let auth;
let merchant;
let storeId;
let employeeMuId; // merchantUser ID for the employee
let storeUserId;  // assigned storeUser ID

beforeAll(async () => {
  app = getApp();
  await resetDb();

  // Create merchant with owner + employee
  merchant = await createMerchant({ name: "Team Test Shop" });

  const owner = await createUser({ email: "team-owner@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });

  const employee = await createUser({ email: "team-employee@perkvalet.org" });
  const empMu = await addMerchantUser({ merchantId: merchant.id, userId: employee.id, role: "merchant_employee" });
  employeeMuId = empMu.id;

  // Create a store
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.id,
      name: "Team Test Location",
      phoneRaw: "",
      phoneCountry: "US",
    },
  });
  storeId = store.id;

  const token = merchantToken({ userId: owner.id, merchantId: merchant.id });
  auth = authHeader(token);
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Merchant Store Team", () => {
  describe("GET /merchant/stores/:storeId/team", () => {
    it("returns team with employees list", async () => {
      const res = await request(app)
        .get(`/merchant/stores/${storeId}/team`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("storeId", storeId);
      expect(res.body).toHaveProperty("merchantId", merchant.id);
      expect(Array.isArray(res.body.employees)).toBe(true);
      expect(res.body.employees.length).toBeGreaterThanOrEqual(2); // owner + employee
    });

    it("rejects non-existent store", async () => {
      const res = await request(app)
        .get("/merchant/stores/99999/team")
        .set(auth);
      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .get(`/merchant/stores/${storeId}/team`);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /merchant/stores/:storeId/team/assign", () => {
    it("assigns employee to store", async () => {
      const res = await request(app)
        .post(`/merchant/stores/${storeId}/team/assign`)
        .set(auth)
        .send({
          merchantUserId: employeeMuId,
          permissionLevel: "pos_access",
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.storeUser).toHaveProperty("id");
      expect(res.body.storeUser.permissionLevel).toBe("pos_access");
      storeUserId = res.body.storeUser.id;
    });

    it("updates permission on re-assign", async () => {
      const res = await request(app)
        .post(`/merchant/stores/${storeId}/team/assign`)
        .set(auth)
        .send({
          merchantUserId: employeeMuId,
          permissionLevel: "store_admin",
        });
      expect(res.status).toBe(200);
      expect(res.body.storeUser.permissionLevel).toBe("store_admin");
    });

    it("rejects invalid permissionLevel", async () => {
      const res = await request(app)
        .post(`/merchant/stores/${storeId}/team/assign`)
        .set(auth)
        .send({
          merchantUserId: employeeMuId,
          permissionLevel: "superuser",
        });
      expect(res.status).toBe(400);
    });

    it("rejects missing merchantUserId", async () => {
      const res = await request(app)
        .post(`/merchant/stores/${storeId}/team/assign`)
        .set(auth)
        .send({ permissionLevel: "pos_access" });
      expect(res.status).toBe(400);
    });

    it("rejects non-existent employee", async () => {
      const res = await request(app)
        .post(`/merchant/stores/${storeId}/team/assign`)
        .set(auth)
        .send({
          merchantUserId: 99999,
          permissionLevel: "pos_access",
        });
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /merchant/stores/:storeId/team/primary-contact", () => {
    it("sets primary contact", async () => {
      const res = await request(app)
        .patch(`/merchant/stores/${storeId}/team/primary-contact`)
        .set(auth)
        .send({ primaryContactStoreUserId: storeUserId });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.primaryContactStoreUserId).toBe(storeUserId);
    });

    it("clears primary contact", async () => {
      const res = await request(app)
        .patch(`/merchant/stores/${storeId}/team/primary-contact`)
        .set(auth)
        .send({ primaryContactStoreUserId: null });
      expect(res.status).toBe(200);
      expect(res.body.primaryContactStoreUserId).toBeNull();
    });

    it("rejects invalid storeUserId", async () => {
      const res = await request(app)
        .patch(`/merchant/stores/${storeId}/team/primary-contact`)
        .set(auth)
        .send({ primaryContactStoreUserId: 99999 });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /merchant/stores/team/:storeUserId", () => {
    it("removes team member", async () => {
      const res = await request(app)
        .delete(`/merchant/stores/team/${storeUserId}`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.storeUserId).toBe(storeUserId);
    });

    it("rejects non-existent storeUser", async () => {
      const res = await request(app)
        .delete("/merchant/stores/team/99999")
        .set(auth);
      expect(res.status).toBe(404);
    });
  });
});
