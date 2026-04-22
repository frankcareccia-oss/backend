// test/product.lifecycle.test.js — Product lifecycle state machine tests
//
// Tests: transitions, gates, edit restrictions per state

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app, auth, merchantId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const merchant = await createMerchant({ name: "Lifecycle Test Coffee" });
  merchantId = merchant.id;
  const user = await createUser({ email: "lifecycle-test@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "owner" });

  const token = merchantToken({ userId: user.id, merchantId: merchant.id });
  auth = authHeader(token);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ── Helper: create a product in draft ──
async function createDraftProduct(name = "Test Product") {
  const res = await request(app)
    .post("/merchant/products")
    .set(auth)
    .send({ name, description: "A test product" });
  expect(res.status).toBe(201);
  return res.body.product;
}

describe("Product Lifecycle State Machine", () => {

  // ── TRANSITION TESTS ──

  describe("draft → staged", () => {
    it("requires startAt to stage", async () => {
      const product = await createDraftProduct("Stage Gate Test");
      const res = await request(app)
        .post(`/merchant/products/${product.id}/stage`)
        .set(auth)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("stages with a startAt date", async () => {
      const product = await createDraftProduct("Stage Success Test");
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const res = await request(app)
        .post(`/merchant/products/${product.id}/stage`)
        .set(auth)
        .send({ startAt: futureDate });
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("staged");
    });
  });

  describe("staged → draft (revert)", () => {
    it("reverts staged product to draft", async () => {
      const product = await createDraftProduct("Revert Test");
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      await request(app).post(`/merchant/products/${product.id}/stage`).set(auth).send({ startAt: futureDate });

      const res = await request(app)
        .post(`/merchant/products/${product.id}/revert-to-draft`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("draft");
    });
  });

  describe("staged → active", () => {
    it("activates a staged product", async () => {
      const product = await createDraftProduct("Activate Staged Test");
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      await request(app).post(`/merchant/products/${product.id}/stage`).set(auth).send({ startAt: futureDate });

      const res = await request(app)
        .post(`/merchant/products/${product.id}/activate`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("active");
    });
  });

  describe("draft → active (activate now)", () => {
    it("activates a draft product directly", async () => {
      const product = await createDraftProduct("Activate Now Test");
      const res = await request(app)
        .post(`/merchant/products/${product.id}/activate`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("active");
    });
  });

  describe("active → suspended", () => {
    it("suspends an active product", async () => {
      const product = await createDraftProduct("Suspend Test");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);

      const res = await request(app)
        .delete(`/merchant/products/${product.id}`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("suspended");
    });
  });

  describe("suspended → active (reactivate)", () => {
    it("reactivates a suspended product", async () => {
      const product = await createDraftProduct("Reactivate Test");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);
      await request(app).delete(`/merchant/products/${product.id}`).set(auth);

      const res = await request(app)
        .post(`/merchant/products/${product.id}/reactivate`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("active");
    });
  });

  describe("active → archived", () => {
    it("archives an active product", async () => {
      const product = await createDraftProduct("Archive Test");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);

      const res = await request(app)
        .post(`/merchant/products/${product.id}/archive`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("archived");
    });
  });

  describe("suspended → archived", () => {
    it("archives a suspended product", async () => {
      const product = await createDraftProduct("Suspend Then Archive");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);
      await request(app).delete(`/merchant/products/${product.id}`).set(auth);

      const res = await request(app)
        .post(`/merchant/products/${product.id}/archive`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("archived");
    });
  });

  // ── BLOCKED TRANSITIONS ──

  describe("blocked transitions", () => {
    it("cannot stage an active product", async () => {
      const product = await createDraftProduct("Block Stage Active");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);

      const res = await request(app)
        .post(`/merchant/products/${product.id}/stage`)
        .set(auth)
        .send({ startAt: new Date().toISOString() });
      expect(res.status).toBe(409);
    });

    it("cannot revert active to draft", async () => {
      const product = await createDraftProduct("Block Active Draft");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);

      const res = await request(app)
        .post(`/merchant/products/${product.id}/revert-to-draft`)
        .set(auth);
      expect(res.status).toBe(409);
    });

    it("cannot activate an archived product", async () => {
      const product = await createDraftProduct("Block Archived Activate");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);
      await request(app).post(`/merchant/products/${product.id}/archive`).set(auth);

      const res = await request(app)
        .post(`/merchant/products/${product.id}/activate`)
        .set(auth);
      expect(res.status).toBe(409);
    });
  });

  // ── EDIT RESTRICTION TESTS ──

  describe("edit restrictions by state", () => {
    it("allows full edit in draft state", async () => {
      const product = await createDraftProduct("Edit Draft Test");
      const res = await request(app)
        .patch(`/merchant/products/${product.id}`)
        .set(auth)
        .send({ name: "Updated Name", description: "Updated desc" });
      expect(res.status).toBe(200);
      expect(res.body.product.name).toBe("Updated Name");
    });

    it("allows only startAt/endAt edit in staged state", async () => {
      const product = await createDraftProduct("Edit Staged Test");
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      await request(app).post(`/merchant/products/${product.id}/stage`).set(auth).send({ startAt: futureDate });

      // Should allow date change
      const newDate = new Date(Date.now() + 172800000).toISOString();
      const res1 = await request(app)
        .patch(`/merchant/products/${product.id}`)
        .set(auth)
        .send({ startAt: newDate });
      expect(res1.status).toBe(200);

      // Should block name change
      const res2 = await request(app)
        .patch(`/merchant/products/${product.id}`)
        .set(auth)
        .send({ name: "Should Not Work" });
      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe("STATE_LOCKED");
    });

    it("blocks all edits in active state", async () => {
      const product = await createDraftProduct("Edit Active Test");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);

      const res = await request(app)
        .patch(`/merchant/products/${product.id}`)
        .set(auth)
        .send({ name: "Should Not Work" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("STATE_LOCKED");
    });

    it("blocks all edits in suspended state", async () => {
      const product = await createDraftProduct("Edit Suspended Test");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);
      await request(app).delete(`/merchant/products/${product.id}`).set(auth);

      const res = await request(app)
        .patch(`/merchant/products/${product.id}`)
        .set(auth)
        .send({ name: "Should Not Work" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("STATE_LOCKED");
    });

    it("blocks all edits in archived state", async () => {
      const product = await createDraftProduct("Edit Archived Test");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);
      await request(app).post(`/merchant/products/${product.id}/archive`).set(auth);

      const res = await request(app)
        .patch(`/merchant/products/${product.id}`)
        .set(auth)
        .send({ name: "Should Not Work" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("STATE_LOCKED");
    });
  });

  // ── DUPLICATE TESTS ──

  describe("duplicate archived product", () => {
    it("duplicates an archived product as new draft", async () => {
      const product = await createDraftProduct("Original Product");
      await request(app).post(`/merchant/products/${product.id}/activate`).set(auth);
      await request(app).post(`/merchant/products/${product.id}/archive`).set(auth);

      const res = await request(app)
        .post(`/merchant/products/${product.id}/duplicate`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.product.status).toBe("draft");
      expect(res.body.product.name).toBe("Original Product (copy)");
      expect(res.body.product.pvDuplicatedFromId).toBe(product.id);
      expect(res.body.product.id).not.toBe(product.id);
    });

    it("cannot duplicate a non-archived product", async () => {
      const product = await createDraftProduct("Not Archived");
      const res = await request(app)
        .post(`/merchant/products/${product.id}/duplicate`)
        .set(auth);
      expect(res.status).toBe(409);
    });
  });

  // ── pvOrigin TESTS ──

  describe("pvOrigin field", () => {
    it("new products have pvOrigin=true by default", async () => {
      const product = await createDraftProduct("PV Origin Test");
      const dbProduct = await prisma.product.findUnique({ where: { id: product.id } });
      expect(dbProduct.pvOrigin).toBe(true);
    });
  });
});
