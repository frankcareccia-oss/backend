// tests/auth.test.js — Auth routes (login, me, password)

const request = require("supertest");
const bcrypt = require("bcryptjs");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, addMerchantUser } = require("./helpers/seed");

let app;
let seededUser;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  // Seed a merchant + user for auth tests
  const merchant = await createMerchant({ name: "Central Perk" });
  const passwordHash = await bcrypt.hash("CentralPerk2026!", 12);
  seededUser = await prisma.user.create({
    data: {
      email: "central-perk-owner@perkvalet.org",
      passwordHash,
      systemRole: "user",
    },
  });
  await addMerchantUser({ merchantId: merchant.id, userId: seededUser.id });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Auth Routes", () => {
  describe("POST /auth/login", () => {
    it("rejects missing credentials", async () => {
      const res = await request(app).post("/auth/login").send({});
      expect(res.status).toBe(400);
    });

    it("rejects wrong password", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "central-perk-owner@perkvalet.org", password: "wrongpassword" });
      expect(res.status).toBe(401);
    });

    it("succeeds with valid credentials", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "central-perk-owner@perkvalet.org", password: "CentralPerk2026!" });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("accessToken");
      expect(res.body).toHaveProperty("systemRole");
    });
  });

  describe("GET /me", () => {
    it("returns user profile with valid JWT", async () => {
      const token = merchantToken({ userId: seededUser.id, merchantId: 1 });
      const res = await request(app).get("/me").set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("user");
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/me");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /auth/change-password", () => {
    it("rejects without auth", async () => {
      const res = await request(app)
        .post("/auth/change-password")
        .send({ currentPassword: "x", newPassword: "y" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET / (health check)", () => {
    it("returns 200", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
    });
  });
});
