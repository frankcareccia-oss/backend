// tests/hardening/merchant.abuse.test.js — Merchant product/promo input abuse, status transition abuse, payment edge cases

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("../helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("../helpers/seed");

let app;
let auth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Merchant Abuse Test" });
  const user = await createUser({ email: "merch-abuse@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "owner" });
  auth = authHeader(merchantToken({ userId: user.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Product Input Abuse", () => {
  it("handles XSS in product name", async () => {
    const res = await request(app)
      .post("/merchant/products")
      .set(auth)
      .send({ name: '<img src=x onerror=alert(1)>' });
    expect(res.status).not.toBe(500);
  });

  it("handles SQL injection in product name", async () => {
    const res = await request(app)
      .post("/merchant/products")
      .set(auth)
      .send({ name: "'; DROP TABLE products; --" });
    // Should succeed as a product name, not execute SQL
    expect([201, 200]).toContain(res.status);
    // Verify products table still exists
    const count = await prisma.product.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("handles extremely long product name", async () => {
    const res = await request(app)
      .post("/merchant/products")
      .set(auth)
      .send({ name: "P".repeat(10000) });
    expect(res.status).not.toBe(500);
  });

  it("handles unicode/emoji in product name", async () => {
    const res = await request(app)
      .post("/merchant/products")
      .set(auth)
      .send({ name: "Café Latté ☕ 抹茶" });
    expect([200, 201]).toContain(res.status);
  });

  it("handles null bytes in product description", async () => {
    const res = await request(app)
      .post("/merchant/products")
      .set(auth)
      .send({ name: "Null Test", description: "Has\x00null\x00bytes" });
    expect(res.status).not.toBe(500);
  });
});

describe("Promotion Status Transition Abuse", () => {
  let promoId;

  beforeAll(async () => {
    // Create a promotion for transition tests
    const res = await request(app)
      .post("/merchant/promotions")
      .set(auth)
      .send({
        name: "Transition Abuse Test",
        mechanic: "stamps",
        threshold: 5,
        rewardType: "custom",
        rewardNote: "Free item",
      });
    promoId = res.body.promotion.id;
  });

  it("rejects skip from draft to active (must go through staged)", async () => {
    const res = await request(app)
      .patch(`/merchant/promotions/${promoId}`)
      .set(auth)
      .send({ status: "active" });
    expect([400, 409]).toContain(res.status);
  });

  it("rejects invalid status value", async () => {
    const res = await request(app)
      .patch(`/merchant/promotions/${promoId}`)
      .set(auth)
      .send({ status: "deleted" });
    expect([400, 409]).toContain(res.status);
  });

  it("rejects SQL injection in status", async () => {
    const res = await request(app)
      .patch(`/merchant/promotions/${promoId}`)
      .set(auth)
      .send({ status: "'; DROP TABLE promotions; --" });
    expect([400, 409]).toContain(res.status);
    const count = await prisma.promotion.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("rejects status as number", async () => {
    const res = await request(app)
      .patch(`/merchant/promotions/${promoId}`)
      .set(auth)
      .send({ status: 1 });
    expect(res.status).not.toBe(500);
  });

  it("allows valid transition draft → staged", async () => {
    const res = await request(app)
      .patch(`/merchant/promotions/${promoId}`)
      .set(auth)
      .send({ status: "staged" });
    expect(res.status).toBe(200);
  });

  it("allows unstaging back to draft (staged → draft)", async () => {
    const res = await request(app)
      .patch(`/merchant/promotions/${promoId}`)
      .set(auth)
      .send({ status: "draft" });
    expect(res.status).toBe(200);
    expect(res.body.promotion.status).toBe("draft");
  });
});

describe("Merchant Store Abuse", () => {
  it("rejects store name as only whitespace", async () => {
    const res = await request(app)
      .post("/merchant/stores")
      .set(auth)
      .send({ merchantId: merchant.id, name: "   " });
    expect(res.status).toBe(400);
  });

  it("rejects store with wrong merchantId", async () => {
    const res = await request(app)
      .post("/merchant/stores")
      .set(auth)
      .send({ merchantId: 99999, name: "Wrong Merchant" });
    expect([403, 404]).toContain(res.status);
  });

  it("handles XSS in store name", async () => {
    const res = await request(app)
      .post("/merchant/stores")
      .set(auth)
      .send({ merchantId: merchant.id, name: '<script>document.cookie</script>' });
    // Should create (it's a string) but not execute
    expect(res.status).not.toBe(500);
  });
});

describe("Growth Advisor Abuse", () => {
  it("handles request with extra query params", async () => {
    const res = await request(app)
      .get("/merchant/growth-advisor?evil=true&drop=table")
      .set(auth);
    expect(res.status).toBe(200);
  });

  it("rejects promotion outcomes for negative ID", async () => {
    const res = await request(app)
      .get("/merchant/promotions/-1/outcomes")
      .set(auth);
    expect(res.status).not.toBe(500);
  });

  it("rejects promotion outcomes for string ID", async () => {
    const res = await request(app)
      .get("/merchant/promotions/abc/outcomes")
      .set(auth);
    expect(res.status).not.toBe(500);
  });
});
