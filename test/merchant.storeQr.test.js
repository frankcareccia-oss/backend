// tests/merchant.storeQr.test.js — Merchant store QR generation

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let auth;
let merchant;
let storeId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "QR Test Shop" });
  const owner = await createUser({ email: "qr-owner@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });

  const store = await prisma.store.create({
    data: {
      merchantId: merchant.id,
      name: "QR Test Location",
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

describe("Merchant Store QR", () => {
  describe("POST /merchant/stores/:storeId/qr/generate", () => {
    it("generates a QR code", async () => {
      const res = await request(app)
        .post(`/merchant/stores/${storeId}/qr/generate`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.storeId).toBe(storeId);
      expect(res.body.merchantId).toBe(merchant.id);
      expect(res.body).toHaveProperty("qrToken");
      expect(res.body).toHaveProperty("qrUrl");
      expect(res.body).toHaveProperty("qrImageDataUrl");
      expect(res.body.qrToken).toMatch(/^pv_/);
      expect(res.body.qrImageDataUrl).toMatch(/^data:image\/png/);
      expect(res.body.status).toBe("active");
    });

    it("replaces previous QR on re-generate", async () => {
      const res1 = await request(app)
        .post(`/merchant/stores/${storeId}/qr/generate`)
        .set(auth);
      const firstToken = res1.body.qrToken;

      const res2 = await request(app)
        .post(`/merchant/stores/${storeId}/qr/generate`)
        .set(auth);
      expect(res2.status).toBe(200);
      expect(res2.body.qrToken).not.toBe(firstToken);

      // Old QR should be archived
      const oldQr = await prisma.storeQr.findFirst({
        where: { storeId, token: firstToken },
      });
      expect(oldQr.status).toBe("archived");
    });

    it("rejects non-existent store", async () => {
      const res = await request(app)
        .post("/merchant/stores/99999/qr/generate")
        .set(auth);
      expect(res.status).toBe(404);
    });

    it("rejects invalid storeId", async () => {
      const res = await request(app)
        .post("/merchant/stores/abc/qr/generate")
        .set(auth);
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post(`/merchant/stores/${storeId}/qr/generate`);
      expect(res.status).toBe(401);
    });
  });
});
