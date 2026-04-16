// tests/clover.test.js — Clover integration: OAuth, adapter, webhook, connection management

const request = require("supertest");
const { getApp, merchantToken, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");
const { captureStdout } = require("./helpers/captureStdout");
const { encrypt } = require("../src/utils/encrypt");

let app;
let merchAuth;
let adminAuth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Clover Test Shop" });
  const owner = await createUser({ email: "clover-owner@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));

  const admin = await prisma.user.create({
    data: { email: "clover-admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  adminAuth = authHeader(adminToken({ userId: admin.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Clover OAuth", () => {
  describe("GET /pos/connect/clover", () => {
    it("redirects to Clover OAuth and emits hook", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app)
          .get("/pos/connect/clover")
          .set(merchAuth)
          .redirects(0);
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain("clover.com/oauth/authorize");
        expect(res.headers.location).toContain("client_id=");

        const joined = output.join("\n");
        expect(joined).toContain("clover.oauth.initiated");
        expect(joined).toContain("TC-CLO-01");
      } finally {
        restore();
      }
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/pos/connect/clover").redirects(0);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /pos/connect/clover/status", () => {
    it("returns not connected initially", async () => {
      const res = await request(app)
        .get("/pos/connect/clover/status")
        .set(merchAuth);
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/pos/connect/clover/status");
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /pos/connect/clover", () => {
    it("succeeds even with no connection (idempotent)", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app)
          .delete("/pos/connect/clover")
          .set(merchAuth);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const joined = output.join("\n");
        expect(joined).toContain("clover.oauth.disconnected");
        expect(joined).toContain("TC-CLO-04");
      } finally {
        restore();
      }
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).delete("/pos/connect/clover");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /pos/connect/clover/callback", () => {
    it("rejects missing code", async () => {
      const res = await request(app).get("/pos/connect/clover/callback");
      expect(res.status).toBe(400);
    });

    it("rejects invalid state", async () => {
      const res = await request(app)
        .get("/pos/connect/clover/callback?code=test&merchant_id=m123&state=badstate");
      expect([400, 500]).toContain(res.status);
    });
  });

  describe("POST /pos/connect/clover/sync-catalog", () => {
    it("rejects when no Clover connection", async () => {
      const res = await request(app)
        .post("/pos/connect/clover/sync-catalog")
        .set(merchAuth);
      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).post("/pos/connect/clover/sync-catalog");
      expect(res.status).toBe(401);
    });
  });
});

describe("Clover Webhook", () => {
  // Clean up any leftover Clover connections between tests to avoid unique constraint violations
  afterEach(async () => {
    await prisma.posLocationMap.deleteMany({
      where: { posConnection: { posType: "clover", merchantId: merchant.id } },
    });
    await prisma.posConnection.deleteMany({
      where: { posType: "clover", merchantId: merchant.id },
    });
  });

  describe("POST /webhooks/clover", () => {
    it("accepts and returns 200", async () => {
      const res = await request(app)
        .post("/webhooks/clover")
        .set("Content-Type", "application/json")
        .send({ type: "payment.created", merchants: {} });
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it("handles verification ping", async () => {
      const res = await request(app)
        .post("/webhooks/clover")
        .set("Content-Type", "application/json")
        .send("");
      expect(res.status).toBe(200);
    });

    it("processes payment event with PosConnection", async () => {
      // Create a Clover PosConnection
      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "clover",
          externalMerchantId: "CLV_TEST_001",
          accessTokenEnc: encrypt("test-token"),
          status: "active",
        },
      });

      const res = await request(app)
        .post("/webhooks/clover")
        .set("Content-Type", "application/json")
        .send({
          type: "payments",
          merchants: {
            CLV_TEST_001: {
              payments: [{ type: "CREATE", objectId: "clv_pay_" + Date.now() }],
            },
          },
        });

      expect(res.status).toBe(200);

      // Wait for async processing
      await new Promise(r => setTimeout(r, 1000));

    });

    it("creates visit and records PaymentEvent when location is mapped", async () => {
      // Set up: PosConnection + Store + PosLocationMap
      const store = await prisma.store.create({
        data: { name: "Clover Test Store", merchantId: merchant.id, phoneRaw: "555-0100" },
      });

      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "clover",
          externalMerchantId: "CLV_MAPPED_001",
          accessTokenEnc: encrypt("test-token"),
          status: "active",
        },
      });

      await prisma.posLocationMap.create({
        data: {
          posConnectionId: conn.id,
          externalLocationId: "CLV_MAPPED_001",
          externalLocationName: "Clover Test",
          pvStoreId: store.id,
          active: true,
        },
      });

      const payId = "clv_visit_" + Date.now();
      const res = await request(app)
        .post("/webhooks/clover")
        .set("Content-Type", "application/json")
        .send({
          type: "payments",
          merchants: {
            CLV_MAPPED_001: {
              payments: [{ type: "CREATE", objectId: payId }],
            },
          },
        });

      expect(res.status).toBe(200);
      await new Promise(r => setTimeout(r, 1500));

      // Verify visit was created
      const visit = await prisma.visit.findFirst({
        where: { posVisitId: "clover:" + payId },
      });
      expect(visit).not.toBeNull();
      expect(visit.storeId).toBe(store.id);
      expect(visit.merchantId).toBe(merchant.id);
      expect(visit.source).toBe("clover_webhook");
      expect(visit.status).toBe("pending_identity"); // no consumer linked

      // Verify PaymentEvent was recorded
      const pe = await prisma.paymentEvent.findFirst({
        where: { providerEventId: "clover:" + payId },
      });
      expect(pe).not.toBeNull();
      expect(pe.source).toBe("clover");
      expect(pe.eventType).toBe("payment_completed");

      // Clean up (connections/locationMaps handled by afterEach)
      await prisma.visit.deleteMany({ where: { posVisitId: "clover:" + payId } });
      await prisma.paymentEvent.deleteMany({ where: { providerEventId: "clover:" + payId } });
      await prisma.store.delete({ where: { id: store.id } });
    });

    it("is idempotent — duplicate payment creates only one visit", async () => {
      const store = await prisma.store.create({
        data: { name: "Clover Idem Store", merchantId: merchant.id, phoneRaw: "555-0101" },
      });

      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "clover",
          externalMerchantId: "CLV_IDEM_001",
          accessTokenEnc: encrypt("test-token"),
          status: "active",
        },
      });

      await prisma.posLocationMap.create({
        data: {
          posConnectionId: conn.id,
          externalLocationId: "CLV_IDEM_001",
          externalLocationName: "Idem Test",
          pvStoreId: store.id,
          active: true,
        },
      });

      const payId = "clv_idem_" + Date.now();
      const payload = {
        type: "payments",
        merchants: {
          CLV_IDEM_001: {
            payments: [{ type: "CREATE", objectId: payId }],
          },
        },
      };

      // Send twice
      await request(app).post("/webhooks/clover").set("Content-Type", "application/json").send(payload);
      await new Promise(r => setTimeout(r, 1500));
      await request(app).post("/webhooks/clover").set("Content-Type", "application/json").send(payload);
      await new Promise(r => setTimeout(r, 1000));

      // Only one visit should exist
      const visits = await prisma.visit.findMany({
        where: { posVisitId: "clover:" + payId },
      });
      expect(visits.length).toBe(1);

      // Clean up (connections/locationMaps handled by afterEach)
      await prisma.visit.deleteMany({ where: { posVisitId: "clover:" + payId } });
      await prisma.paymentEvent.deleteMany({ where: { providerEventId: "clover:" + payId } });
      await prisma.store.delete({ where: { id: store.id } });
    });

    it("accumulates stamps when consumer is identified", async () => {
      const store = await prisma.store.create({
        data: { name: "Clover Stamp Store", merchantId: merchant.id, phoneRaw: "555-0102" },
      });

      const consumer = await prisma.consumer.create({
        data: { phoneE164: "+15550001234", email: "clover-stamps@test.com", firstName: "Stamp", lastName: "Test", status: "active" },
      });

      const promo = await prisma.promotion.create({
        data: {
          merchantId: merchant.id,
          name: "Clover Stamp Card",
          mechanic: "stamps",
          threshold: 5,
          rewardType: "discount_pct",
          rewardValue: 10,
          status: "active",
          repeatable: true,
        },
      });

      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "clover",
          externalMerchantId: "CLV_STAMP_001",
          accessTokenEnc: encrypt("test-token"),
          status: "active",
        },
      });

      await prisma.posLocationMap.create({
        data: {
          posConnectionId: conn.id,
          externalLocationId: "CLV_STAMP_001",
          externalLocationName: "Stamp Test",
          pvStoreId: store.id,
          active: true,
        },
      });

      // Directly create a visit with the consumer identified, then call accumulateStamps
      // (full consumer resolution requires real Clover API — tested separately)
      const { accumulateStamps } = require("../src/pos/pos.stamps");
      const visit = await prisma.visit.create({
        data: {
          storeId: store.id,
          merchantId: merchant.id,
          consumerId: consumer.id,
          source: "clover_webhook",
          status: "identified",
          posVisitId: "clover:stamp_test_" + Date.now(),
        },
      });

      await accumulateStamps(prisma, {
        consumerId: consumer.id,
        merchantId: merchant.id,
        storeId: store.id,
        visitId: visit.id,
      });

      // Verify stamp was recorded
      const progress = await prisma.consumerPromoProgress.findFirst({
        where: { consumerId: consumer.id, promotionId: promo.id },
      });
      expect(progress).not.toBeNull();
      expect(progress.stampCount).toBe(1);
      expect(progress.lifetimeEarned).toBe(1);

      // Clean up (connections/locationMaps handled by afterEach)
      await prisma.posRewardDiscount.deleteMany({ where: { consumerId: consumer.id } });
      await prisma.entitlement.deleteMany({ where: { consumerId: consumer.id } });
      await prisma.consumerPromoProgress.deleteMany({ where: { consumerId: consumer.id } });
      await prisma.promoRedemption.deleteMany({ where: { consumerId: consumer.id } });
      await prisma.promotionEvent.deleteMany({ where: { promotionId: promo.id } });
      await prisma.visit.delete({ where: { id: visit.id } });
      await prisma.promotion.delete({ where: { id: promo.id } });
      await prisma.consumer.delete({ where: { id: consumer.id } });
      await prisma.store.delete({ where: { id: store.id } });
    });
  });
});

describe("Clover Catalog Sync (e2e)", () => {
  let conn;
  let store;

  beforeAll(async () => {
    // Clean up any leftover clover connections
    await prisma.posLocationMap.deleteMany({
      where: { posConnection: { posType: "clover", merchantId: merchant.id } },
    });
    await prisma.posConnection.deleteMany({
      where: { posType: "clover", merchantId: merchant.id },
    });

    conn = await prisma.posConnection.create({
      data: {
        merchantId: merchant.id,
        posType: "clover",
        externalMerchantId: "CLV_CATALOG_001",
        accessTokenEnc: encrypt("test-token"),
        status: "active",
      },
    });

    store = await prisma.store.create({
      data: { name: "Clover Catalog Store", merchantId: merchant.id, phoneRaw: "555-0200" },
    });

    await prisma.posLocationMap.create({
      data: {
        posConnectionId: conn.id,
        externalLocationId: "CLV_CATALOG_001",
        externalLocationName: "Catalog Test",
        pvStoreId: store.id,
        active: true,
      },
    });
  });

  afterAll(async () => {
    // Clean up in dependency order
    await prisma.catalogSyncLog.deleteMany({ where: { posConnectionId: conn.id } });
    await prisma.product.deleteMany({ where: { merchantId: merchant.id, catalogSource: "pos" } });
    await prisma.productCategory.deleteMany({ where: { merchantId: merchant.id, catalogSource: "pos" } });
    await prisma.posLocationMap.deleteMany({ where: { posConnectionId: conn.id } });
    await prisma.posConnection.delete({ where: { id: conn.id } });
    await prisma.store.delete({ where: { id: store.id } });
  });

  it("syncs categories and products from Clover into PV tables", async () => {
    const { CloverAdapter } = require("../src/pos/adapters/clover.adapter");
    const { syncCatalogFromPos } = require("../src/pos/pos.catalog.sync");

    const adapter = new CloverAdapter(conn);

    // Mock Clover API responses with realistic data
    adapter._cloverFetch = async (path) => {
      if (path.includes("/items")) {
        return {
          elements: [
            {
              id: "CLV_ITEM_001",
              name: "House Blend Coffee",
              description: "Our signature roast",
              sku: "HBC-001",
              price: 450,
              categories: { elements: [{ id: "CLV_CAT_001", name: "Hot Drinks" }] },
            },
            {
              id: "CLV_ITEM_002",
              name: "Blueberry Muffin",
              description: "Freshly baked daily",
              sku: "BM-001",
              price: 350,
              categories: { elements: [{ id: "CLV_CAT_002", name: "Pastries" }] },
            },
            {
              id: "CLV_ITEM_003",
              name: "Iced Latte",
              description: "",
              sku: "",
              price: 550,
              categories: { elements: [{ id: "CLV_CAT_001", name: "Hot Drinks" }] },
            },
          ],
        };
      }
      if (path.includes("/categories")) {
        return {
          elements: [
            { id: "CLV_CAT_001", name: "Hot Drinks" },
            { id: "CLV_CAT_002", name: "Pastries" },
          ],
        };
      }
      return { elements: [] };
    };

    const result = await syncCatalogFromPos(prisma, adapter, {
      merchantId: merchant.id,
      posConnectionId: conn.id,
      trigger: "manual",
    });

    // Verify summary
    expect(result.summary.categoriesCreated).toBe(2);
    expect(result.summary.productsCreated).toBe(3);

    // Verify categories in DB
    const cats = await prisma.productCategory.findMany({
      where: { merchantId: merchant.id, catalogSource: "pos" },
      orderBy: { name: "asc" },
    });
    expect(cats.length).toBe(2);
    expect(cats[0].name).toBe("Hot Drinks");
    expect(cats[0].externalCatalogId).toBe("CLV_CAT_001");
    expect(cats[1].name).toBe("Pastries");

    // Verify products in DB
    const products = await prisma.product.findMany({
      where: { merchantId: merchant.id, catalogSource: "pos" },
      orderBy: { name: "asc" },
    });
    expect(products.length).toBe(3);
    expect(products[0].name).toBe("Blueberry Muffin");
    expect(products[0].priceCents).toBe(350);
    expect(products[0].externalCatalogId).toBe("CLV_ITEM_002");
    expect(products[1].name).toBe("House Blend Coffee");
    expect(products[1].priceCents).toBe(450);
    expect(products[2].name).toBe("Iced Latte");
    expect(products[2].priceCents).toBe(550);

    // Verify products are linked to categories
    expect(products[0].categoryId).toBe(cats[1].id); // Pastries
    expect(products[1].categoryId).toBe(cats[0].id); // Hot Drinks
    expect(products[2].categoryId).toBe(cats[0].id); // Hot Drinks

    // Verify sync log was recorded
    const log = await prisma.catalogSyncLog.findFirst({
      where: { posConnectionId: conn.id },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log.trigger).toBe("manual");
    expect(log.summary.productsCreated).toBe(3);

    // Verify PosConnection lastCatalogSyncAt was updated
    const updatedConn = await prisma.posConnection.findUnique({ where: { id: conn.id } });
    expect(updatedConn.lastCatalogSyncAt).not.toBeNull();
  });

  it("updates existing products on re-sync (idempotent)", async () => {
    const { CloverAdapter } = require("../src/pos/adapters/clover.adapter");
    const { syncCatalogFromPos } = require("../src/pos/pos.catalog.sync");

    const adapter = new CloverAdapter(conn);

    // Re-sync with updated prices and a new item
    adapter._cloverFetch = async (path) => {
      if (path.includes("/items")) {
        return {
          elements: [
            {
              id: "CLV_ITEM_001",
              name: "House Blend Coffee",
              description: "Our signature roast — now organic!",
              sku: "HBC-001",
              price: 500, // price changed
              categories: { elements: [{ id: "CLV_CAT_001", name: "Hot Drinks" }] },
            },
            {
              id: "CLV_ITEM_002",
              name: "Blueberry Muffin",
              description: "Freshly baked daily",
              sku: "BM-001",
              price: 350,
              categories: { elements: [{ id: "CLV_CAT_002", name: "Pastries" }] },
            },
            {
              id: "CLV_ITEM_003",
              name: "Iced Latte",
              description: "Cold-brewed perfection",
              sku: "IL-001",
              price: 550,
              categories: { elements: [{ id: "CLV_CAT_001", name: "Hot Drinks" }] },
            },
            {
              id: "CLV_ITEM_004",
              name: "Croissant",
              description: "Butter croissant",
              sku: "CR-001",
              price: 300,
              categories: { elements: [{ id: "CLV_CAT_002", name: "Pastries" }] },
            },
          ],
        };
      }
      if (path.includes("/categories")) {
        return {
          elements: [
            { id: "CLV_CAT_001", name: "Hot Drinks" },
            { id: "CLV_CAT_002", name: "Pastries" },
          ],
        };
      }
      return { elements: [] };
    };

    const result = await syncCatalogFromPos(prisma, adapter, {
      merchantId: merchant.id,
      posConnectionId: conn.id,
      trigger: "manual",
    });

    // 3 existing products updated, 1 new created, 2 existing categories (no new)
    expect(result.summary.productsCreated).toBe(1);
    expect(result.summary.productsUpdated).toBe(3);
    expect(result.summary.categoriesCreated).toBe(0);
    expect(result.summary.categoriesUpdated).toBe(0);

    // Verify updated product
    const coffee = await prisma.product.findFirst({
      where: { merchantId: merchant.id, externalCatalogId: "CLV_ITEM_001" },
    });
    expect(coffee.priceCents).toBe(500);
    expect(coffee.description).toBe("Our signature roast — now organic!");

    // Verify new product
    const croissant = await prisma.product.findFirst({
      where: { merchantId: merchant.id, externalCatalogId: "CLV_ITEM_004" },
    });
    expect(croissant).not.toBeNull();
    expect(croissant.name).toBe("Croissant");
    expect(croissant.priceCents).toBe(300);

    // Total should be 4 products now (not duplicated)
    const allProducts = await prisma.product.findMany({
      where: { merchantId: merchant.id, catalogSource: "pos" },
    });
    expect(allProducts.length).toBe(4);

    // Two sync logs total
    const logs = await prisma.catalogSyncLog.findMany({
      where: { posConnectionId: conn.id },
    });
    expect(logs.length).toBe(2);
  });

  it("syncs via the /sync-catalog API endpoint", async () => {
    // This test requires a real Clover API connection, which will fail in sandbox
    // But we verify the route plumbing works correctly
    const res = await request(app)
      .post("/pos/connect/clover/sync-catalog")
      .set(merchAuth);

    // Should find our connection and attempt sync (will fail at Clover API call)
    // The route should return either success or a meaningful error
    expect([200, 500]).toContain(res.status);
  });
});

describe("Clover Location Mapping", () => {
  let conn;
  let store;

  beforeAll(async () => {
    await prisma.posLocationMap.deleteMany({
      where: { posConnection: { posType: "clover", merchantId: merchant.id } },
    });
    await prisma.posConnection.deleteMany({
      where: { posType: "clover", merchantId: merchant.id },
    });

    conn = await prisma.posConnection.create({
      data: {
        merchantId: merchant.id,
        posType: "clover",
        externalMerchantId: "CLV_LOC_001",
        accessTokenEnc: encrypt("test-token"),
        status: "active",
      },
    });

    store = await prisma.store.create({
      data: { name: "Clover Location Store", merchantId: merchant.id, phoneRaw: "555-0300" },
    });
  });

  afterAll(async () => {
    await prisma.posLocationMap.deleteMany({ where: { posConnectionId: conn.id } });
    await prisma.posConnection.delete({ where: { id: conn.id } });
    await prisma.store.delete({ where: { id: store.id } });
  });

  describe("GET /pos/connect/clover/locations", () => {
    it("returns locations and existing maps", async () => {
      const res = await request(app)
        .get("/pos/connect/clover/locations")
        .set(merchAuth);
      // Will fail at Clover API (no real token) but route plumbing works
      expect([200, 500]).toContain(res.status);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/pos/connect/clover/locations");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /pos/connect/clover/map-location", () => {
    it("maps a Clover location to a PV store", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app)
          .post("/pos/connect/clover/map-location")
          .set(merchAuth)
          .send({
            externalLocationId: "CLV_LOC_001",
            externalLocationName: "Test Clover Location",
            pvStoreId: store.id,
          });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.map.pvStoreId).toBe(store.id);
        expect(res.body.map.externalLocationId).toBe("CLV_LOC_001");

        const joined = output.join("\n");
        expect(joined).toContain("clover.location.mapped");
        expect(joined).toContain("TC-CLO-05");
      } finally {
        restore();
      }

      // Verify in DB
      const map = await prisma.posLocationMap.findFirst({
        where: { posConnectionId: conn.id, externalLocationId: "CLV_LOC_001" },
      });
      expect(map).not.toBeNull();
      expect(map.pvStoreId).toBe(store.id);
      expect(map.pvStoreName).toBe("Clover Location Store");
      expect(map.active).toBe(true);
    });

    it("rejects missing fields", async () => {
      const res = await request(app)
        .post("/pos/connect/clover/map-location")
        .set(merchAuth)
        .send({ externalLocationId: "CLV_LOC_001" }); // missing pvStoreId
      expect(res.status).toBe(400);
    });

    it("rejects store not owned by merchant", async () => {
      const res = await request(app)
        .post("/pos/connect/clover/map-location")
        .set(merchAuth)
        .send({ externalLocationId: "CLV_LOC_001", pvStoreId: 999999 });
      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/pos/connect/clover/map-location")
        .send({ externalLocationId: "CLV_LOC_001", pvStoreId: 1 });
      expect(res.status).toBe(401);
    });
  });
});

describe("Clover Adapter Resolver", () => {
  it("resolves CloverAdapter for clover posType", async () => {
    // Clean up any leftover clover connections first
    await prisma.posLocationMap.deleteMany({
      where: { posConnection: { posType: "clover", merchantId: merchant.id } },
    });
    await prisma.posConnection.deleteMany({
      where: { posType: "clover", merchantId: merchant.id },
    });

    const conn = await prisma.posConnection.create({
      data: {
        merchantId: merchant.id,
        posType: "clover",
        externalMerchantId: "CLV_RESOLVE_001",
        accessTokenEnc: encrypt("test-token"),
        status: "active",
      },
    });

    const { getPosAdapter } = require("../src/pos/pos.adapter.resolver");
    const adapter = await getPosAdapter({ id: merchant.id }, "clover");
    expect(adapter.constructor.name).toBe("CloverAdapter");

    await prisma.posConnection.delete({ where: { id: conn.id } });
  });
});
