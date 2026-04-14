// test/toast.test.js — Toast integration: connection, adapter, webhook, catalog sync, location mapping

const request = require("supertest");
const { getApp, merchantToken, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");
const { captureStdout } = require("./helpers/captureStdout");
const { encrypt } = require("../src/utils/encrypt");

let app;
let merchAuth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Toast Test Café" });
  const owner = await createUser({ email: "toast-owner@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── Connection Management ───────────────────────────────────────────────────

describe("Toast Connection", () => {
  describe("POST /pos/connect/toast", () => {
    it("rejects missing credentials", async () => {
      const res = await request(app)
        .post("/pos/connect/toast")
        .set(merchAuth)
        .send({ clientId: "test" }); // missing clientSecret and restaurantGuid
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/pos/connect/toast")
        .send({ clientId: "x", clientSecret: "y", restaurantGuid: "z" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /pos/connect/toast/status", () => {
    it("returns not connected initially", async () => {
      const res = await request(app)
        .get("/pos/connect/toast/status")
        .set(merchAuth);
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/pos/connect/toast/status");
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /pos/connect/toast", () => {
    it("succeeds even with no connection (idempotent)", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app)
          .delete("/pos/connect/toast")
          .set(merchAuth);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const joined = output.join("\n");
        expect(joined).toContain("toast.disconnected");
        expect(joined).toContain("TC-TST-04");
      } finally {
        restore();
      }
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).delete("/pos/connect/toast");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /pos/connect/toast/sync-catalog", () => {
    it("rejects when no Toast connection", async () => {
      const res = await request(app)
        .post("/pos/connect/toast/sync-catalog")
        .set(merchAuth);
      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).post("/pos/connect/toast/sync-catalog");
      expect(res.status).toBe(401);
    });
  });
});

// ─── Webhook ─────────────────────────────────────────────────────────────────

describe("Toast Webhook", () => {
  afterEach(async () => {
    await prisma.posLocationMap.deleteMany({
      where: { posConnection: { posType: "toast", merchantId: merchant.id } },
    });
    await prisma.posConnection.deleteMany({
      where: { posType: "toast", merchantId: merchant.id },
    });
  });

  describe("POST /webhooks/toast", () => {
    it("accepts and returns 200", async () => {
      const res = await request(app)
        .post("/webhooks/toast")
        .set("Content-Type", "application/json")
        .send({ eventType: "ORDER_PAID", restaurantGuid: "none" });
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it("handles verification ping", async () => {
      const res = await request(app)
        .post("/webhooks/toast")
        .set("Content-Type", "application/json")
        .send("");
      expect(res.status).toBe(200);
    });

    it("ignores non-payment events", async () => {
      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "toast",
          externalMerchantId: "TST_IGNORE_001",
          accessTokenEnc: encrypt("test-token"),
          status: "active",
        },
      });

      const res = await request(app)
        .post("/webhooks/toast")
        .set("Content-Type", "application/json")
        .send({ eventType: "MENU_UPDATED", restaurantGuid: "TST_IGNORE_001" });

      expect(res.status).toBe(200);
      await new Promise(r => setTimeout(r, 500));

      // No visit should be created
      const visits = await prisma.visit.findMany({
        where: { merchantId: merchant.id, source: "toast_webhook" },
      });
      expect(visits.length).toBe(0);
    });

    it("creates visit and records PaymentEvent when location is mapped", async () => {
      const store = await prisma.store.create({
        data: { name: "Toast Test Store", merchantId: merchant.id, phoneRaw: "555-0600" },
      });

      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "toast",
          externalMerchantId: "TST_MAPPED_001",
          accessTokenEnc: encrypt("test-token"),
          status: "active",
        },
      });

      await prisma.posLocationMap.create({
        data: {
          posConnectionId: conn.id,
          externalLocationId: "TST_MAPPED_001",
          externalLocationName: "Toast Test",
          pvStoreId: store.id,
          active: true,
        },
      });

      const orderGuid = "tst_order_" + Date.now();
      const res = await request(app)
        .post("/webhooks/toast")
        .set("Content-Type", "application/json")
        .send({
          eventType: "ORDER_PAID",
          restaurantGuid: "TST_MAPPED_001",
          orderGuid,
        });

      expect(res.status).toBe(200);
      await new Promise(r => setTimeout(r, 1500));

      // Verify visit
      const visit = await prisma.visit.findFirst({
        where: { posVisitId: "toast:" + orderGuid },
      });
      expect(visit).not.toBeNull();
      expect(visit.storeId).toBe(store.id);
      expect(visit.merchantId).toBe(merchant.id);
      expect(visit.source).toBe("toast_webhook");
      expect(visit.status).toBe("pending_identity");

      // Verify PaymentEvent
      const pe = await prisma.paymentEvent.findFirst({
        where: { providerEventId: "toast:" + orderGuid },
      });
      expect(pe).not.toBeNull();
      expect(pe.source).toBe("toast");
      expect(pe.eventType).toBe("payment_completed");

      // Clean up
      await prisma.visit.deleteMany({ where: { posVisitId: "toast:" + orderGuid } });
      await prisma.paymentEvent.deleteMany({ where: { providerEventId: "toast:" + orderGuid } });
      await prisma.store.delete({ where: { id: store.id } });
    });

    it("is idempotent — duplicate order creates only one visit", async () => {
      const store = await prisma.store.create({
        data: { name: "Toast Idem Store", merchantId: merchant.id, phoneRaw: "555-0601" },
      });

      const conn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "toast",
          externalMerchantId: "TST_IDEM_001",
          accessTokenEnc: encrypt("test-token"),
          status: "active",
        },
      });

      await prisma.posLocationMap.create({
        data: {
          posConnectionId: conn.id,
          externalLocationId: "TST_IDEM_001",
          externalLocationName: "Idem Test",
          pvStoreId: store.id,
          active: true,
        },
      });

      const orderGuid = "tst_idem_" + Date.now();
      const payload = {
        eventType: "ORDER_PAID",
        restaurantGuid: "TST_IDEM_001",
        orderGuid,
      };

      await request(app).post("/webhooks/toast").set("Content-Type", "application/json").send(payload);
      await new Promise(r => setTimeout(r, 1500));
      await request(app).post("/webhooks/toast").set("Content-Type", "application/json").send(payload);
      await new Promise(r => setTimeout(r, 1000));

      const visits = await prisma.visit.findMany({
        where: { posVisitId: "toast:" + orderGuid },
      });
      expect(visits.length).toBe(1);

      // Clean up
      await prisma.visit.deleteMany({ where: { posVisitId: "toast:" + orderGuid } });
      await prisma.paymentEvent.deleteMany({ where: { providerEventId: "toast:" + orderGuid } });
      await prisma.store.delete({ where: { id: store.id } });
    });

    it("accumulates stamps when consumer is identified", async () => {
      const store = await prisma.store.create({
        data: { name: "Toast Stamp Store", merchantId: merchant.id, phoneRaw: "555-0602" },
      });

      const consumer = await prisma.consumer.create({
        data: { phoneE164: "+15550007777", email: "toast-stamps@test.com", firstName: "Toast", lastName: "Tester", status: "active" },
      });

      const promo = await prisma.promotion.create({
        data: {
          merchantId: merchant.id,
          name: "Toast Stamp Card",
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
          posType: "toast",
          externalMerchantId: "TST_STAMP_001",
          accessTokenEnc: encrypt("test-token"),
          status: "active",
        },
      });

      await prisma.posLocationMap.create({
        data: {
          posConnectionId: conn.id,
          externalLocationId: "TST_STAMP_001",
          externalLocationName: "Stamp Test",
          pvStoreId: store.id,
          active: true,
        },
      });

      const { accumulateStamps } = require("../src/pos/pos.stamps");
      const visit = await prisma.visit.create({
        data: {
          storeId: store.id,
          merchantId: merchant.id,
          consumerId: consumer.id,
          source: "toast_webhook",
          status: "identified",
          posVisitId: "toast:stamp_test_" + Date.now(),
        },
      });

      await accumulateStamps(prisma, {
        consumerId: consumer.id,
        merchantId: merchant.id,
        storeId: store.id,
        visitId: visit.id,
      });

      const progress = await prisma.consumerPromoProgress.findFirst({
        where: { consumerId: consumer.id, promotionId: promo.id },
      });
      expect(progress).not.toBeNull();
      expect(progress.stampCount).toBe(1);
      expect(progress.lifetimeEarned).toBe(1);

      // Clean up
      await prisma.consumerPromoProgress.deleteMany({ where: { consumerId: consumer.id } });
      await prisma.promoRedemption.deleteMany({ where: { promotionId: promo.id } });
      await prisma.promotionEvent.deleteMany({ where: { promotionId: promo.id } });
      await prisma.visit.delete({ where: { id: visit.id } });
      await prisma.promotion.delete({ where: { id: promo.id } });
      await prisma.consumer.delete({ where: { id: consumer.id } });
      await prisma.store.delete({ where: { id: store.id } });
    });
  });
});

// ─── Catalog Sync ────────────────────────────────────────────────────────────

describe("Toast Catalog Sync (e2e)", () => {
  let conn;
  let store;

  beforeAll(async () => {
    await prisma.posLocationMap.deleteMany({
      where: { posConnection: { posType: "toast", merchantId: merchant.id } },
    });
    await prisma.posConnection.deleteMany({
      where: { posType: "toast", merchantId: merchant.id },
    });

    conn = await prisma.posConnection.create({
      data: {
        merchantId: merchant.id,
        posType: "toast",
        externalMerchantId: "TST_CATALOG_001",
        accessTokenEnc: encrypt("test-token"),
        status: "active",
      },
    });

    store = await prisma.store.create({
      data: { name: "Toast Catalog Store", merchantId: merchant.id, phoneRaw: "555-0700" },
    });

    await prisma.posLocationMap.create({
      data: {
        posConnectionId: conn.id,
        externalLocationId: "TST_CATALOG_001",
        externalLocationName: "Catalog Test",
        pvStoreId: store.id,
        active: true,
      },
    });
  });

  afterAll(async () => {
    await prisma.catalogSyncLog.deleteMany({ where: { posConnectionId: conn.id } });
    await prisma.product.deleteMany({ where: { merchantId: merchant.id, catalogSource: "pos" } });
    await prisma.productCategory.deleteMany({ where: { merchantId: merchant.id, catalogSource: "pos" } });
    await prisma.posLocationMap.deleteMany({ where: { posConnectionId: conn.id } });
    await prisma.posConnection.delete({ where: { id: conn.id } });
    await prisma.store.delete({ where: { id: store.id } });
  });

  it("syncs menu items from Toast into PV tables", async () => {
    const { ToastAdapter } = require("../src/pos/adapters/toast.adapter");
    const { syncCatalogFromPos } = require("../src/pos/pos.catalog.sync");

    const adapter = new ToastAdapter(conn);

    // Mock Toast menu API response
    adapter._toastFetch = async (path) => {
      if (path.includes("/menus")) {
        return [{
          guid: "menu-001",
          name: "Main Menu",
          groups: [
            {
              guid: "TST_GRP_001",
              name: "Coffee",
              items: [
                { guid: "TST_ITEM_001", name: "Americano", description: "Bold espresso + water", price: 4.50 },
                { guid: "TST_ITEM_002", name: "Cappuccino", description: "Espresso + steamed milk", price: 5.50 },
              ],
            },
            {
              guid: "TST_GRP_002",
              name: "Food",
              items: [
                { guid: "TST_ITEM_003", name: "Avocado Toast", description: "Sourdough + avocado", price: 12.00 },
              ],
            },
          ],
        }];
      }
      return [];
    };

    const result = await syncCatalogFromPos(prisma, adapter, {
      merchantId: merchant.id,
      posConnectionId: conn.id,
      trigger: "manual",
    });

    expect(result.summary.categoriesCreated).toBe(2);
    expect(result.summary.productsCreated).toBe(3);

    // Verify categories
    const cats = await prisma.productCategory.findMany({
      where: { merchantId: merchant.id, catalogSource: "pos" },
      orderBy: { name: "asc" },
    });
    expect(cats.length).toBe(2);
    expect(cats[0].name).toBe("Coffee");
    expect(cats[1].name).toBe("Food");

    // Verify products
    const products = await prisma.product.findMany({
      where: { merchantId: merchant.id, catalogSource: "pos" },
      orderBy: { name: "asc" },
    });
    expect(products.length).toBe(3);
    expect(products[0].name).toBe("Americano");
    expect(products[0].priceCents).toBe(450);
    expect(products[1].name).toBe("Avocado Toast");
    expect(products[1].priceCents).toBe(1200);
    expect(products[2].name).toBe("Cappuccino");
    expect(products[2].priceCents).toBe(550);
  });

  it("updates existing products on re-sync", async () => {
    const { ToastAdapter } = require("../src/pos/adapters/toast.adapter");
    const { syncCatalogFromPos } = require("../src/pos/pos.catalog.sync");

    const adapter = new ToastAdapter(conn);

    adapter._toastFetch = async (path) => {
      if (path.includes("/menus")) {
        return [{
          guid: "menu-001",
          name: "Main Menu",
          groups: [
            {
              guid: "TST_GRP_001",
              name: "Coffee",
              items: [
                { guid: "TST_ITEM_001", name: "Americano", description: "Bold espresso + water", price: 5.00 }, // price changed
                { guid: "TST_ITEM_002", name: "Cappuccino", description: "Espresso + steamed milk", price: 5.50 },
                { guid: "TST_ITEM_004", name: "Flat White", description: "Smooth + velvety", price: 5.75 }, // new
              ],
            },
            {
              guid: "TST_GRP_002",
              name: "Food",
              items: [
                { guid: "TST_ITEM_003", name: "Avocado Toast", description: "Sourdough + avocado", price: 12.00 },
              ],
            },
          ],
        }];
      }
      return [];
    };

    const result = await syncCatalogFromPos(prisma, adapter, {
      merchantId: merchant.id,
      posConnectionId: conn.id,
      trigger: "manual",
    });

    expect(result.summary.productsCreated).toBe(1);
    expect(result.summary.productsUpdated).toBe(3);

    const americano = await prisma.product.findFirst({
      where: { merchantId: merchant.id, externalCatalogId: "TST_ITEM_001" },
    });
    expect(americano.priceCents).toBe(500);

    const allProducts = await prisma.product.findMany({
      where: { merchantId: merchant.id, catalogSource: "pos" },
    });
    expect(allProducts.length).toBe(4);
  });
});

// ─── Location Mapping ────────────────────────────────────────────────────────

describe("Toast Location Mapping", () => {
  let conn;
  let store;

  beforeAll(async () => {
    await prisma.posLocationMap.deleteMany({
      where: { posConnection: { posType: "toast", merchantId: merchant.id } },
    });
    await prisma.posConnection.deleteMany({
      where: { posType: "toast", merchantId: merchant.id },
    });

    conn = await prisma.posConnection.create({
      data: {
        merchantId: merchant.id,
        posType: "toast",
        externalMerchantId: "TST_LOC_001",
        accessTokenEnc: encrypt("test-token"),
        status: "active",
      },
    });

    store = await prisma.store.create({
      data: { name: "Toast Location Store", merchantId: merchant.id, phoneRaw: "555-0800" },
    });
  });

  afterAll(async () => {
    await prisma.posLocationMap.deleteMany({ where: { posConnectionId: conn.id } });
    await prisma.posConnection.delete({ where: { id: conn.id } });
    await prisma.store.delete({ where: { id: store.id } });
  });

  describe("GET /pos/connect/toast/locations", () => {
    it("returns locations and existing maps", async () => {
      const res = await request(app)
        .get("/pos/connect/toast/locations")
        .set(merchAuth);
      expect(res.status).toBe(200);
      expect(res.body.locations).toBeDefined();
      expect(res.body.existingMaps).toBeDefined();
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/pos/connect/toast/locations");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /pos/connect/toast/map-location", () => {
    it("maps a Toast location to a PV store", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app)
          .post("/pos/connect/toast/map-location")
          .set(merchAuth)
          .send({
            externalLocationId: "TST_LOC_001",
            externalLocationName: "Test Toast Location",
            pvStoreId: store.id,
          });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.map.pvStoreId).toBe(store.id);

        const joined = output.join("\n");
        expect(joined).toContain("toast.location.mapped");
        expect(joined).toContain("TC-TST-05");
      } finally {
        restore();
      }

      const map = await prisma.posLocationMap.findFirst({
        where: { posConnectionId: conn.id, externalLocationId: "TST_LOC_001" },
      });
      expect(map).not.toBeNull();
      expect(map.pvStoreId).toBe(store.id);
      expect(map.pvStoreName).toBe("Toast Location Store");
    });

    it("rejects missing fields", async () => {
      const res = await request(app)
        .post("/pos/connect/toast/map-location")
        .set(merchAuth)
        .send({ externalLocationId: "TST_LOC_001" });
      expect(res.status).toBe(400);
    });

    it("rejects store not owned by merchant", async () => {
      const res = await request(app)
        .post("/pos/connect/toast/map-location")
        .set(merchAuth)
        .send({ externalLocationId: "TST_LOC_001", pvStoreId: 999999 });
      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/pos/connect/toast/map-location")
        .send({ externalLocationId: "TST_LOC_001", pvStoreId: 1 });
      expect(res.status).toBe(401);
    });
  });
});

// ─── Adapter Resolver ────────────────────────────────────────────────────────

describe("Toast Adapter Resolver", () => {
  it("resolves ToastAdapter for toast posType", async () => {
    await prisma.posLocationMap.deleteMany({
      where: { posConnection: { posType: "toast", merchantId: merchant.id } },
    });
    await prisma.posConnection.deleteMany({
      where: { posType: "toast", merchantId: merchant.id },
    });

    const conn = await prisma.posConnection.create({
      data: {
        merchantId: merchant.id,
        posType: "toast",
        externalMerchantId: "TST_RESOLVE_001",
        accessTokenEnc: encrypt("test-token"),
        status: "active",
      },
    });

    const { getPosAdapter } = require("../src/pos/pos.adapter.resolver");
    const adapter = await getPosAdapter({ id: merchant.id }, "toast");
    expect(adapter.constructor.name).toBe("ToastAdapter");

    await prisma.posConnection.delete({ where: { id: conn.id } });
  });
});
