// backend/scripts/dev_seed.js
require("dotenv").config();

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { prisma } = require("../src/db/prisma");

async function main() {
  const email = process.env.DEV_ADMIN_EMAIL || "admin@perkvalet.local";
  const password = process.env.DEV_ADMIN_PASSWORD || "TempPass123!";
  const merchantName = process.env.DEV_DEMO_MERCHANT_NAME || "Demo Merchant";

  console.log("[dev-seed] Using:", { email, merchantName });

  // 1) Ensure admin user exists (idempotent by email)
  const passwordHash = await bcrypt.hash(password, 10);

  const adminUser = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {
      passwordHash,
      systemRole: "pv_admin",
      status: "active",
    },
    create: {
      email: email.toLowerCase(),
      passwordHash,
      systemRole: "pv_admin",
      status: "active",
    },
    select: { id: true, email: true, systemRole: true, status: true },
  });

  // 2) Ensure demo merchant exists (idempotent by name - best effort)
  let merchant = await prisma.merchant.findFirst({
    where: { name: merchantName },
  });

  if (!merchant) {
    merchant = await prisma.merchant.create({
      data: {
        name: merchantName,
        status: "active",
        statusReason: "Dev seed",
        statusUpdatedAt: new Date(),
      },
    });
    console.log("[dev-seed] created merchant:", merchant.name);
  } else if (merchant.status !== "active") {
    merchant = await prisma.merchant.update({
      where: { id: merchant.id },
      data: {
        status: "active",
        statusReason: "Dev seed (reactivate)",
        statusUpdatedAt: new Date(),
      },
    });
    console.log("[dev-seed] reactivated merchant:", merchant.name);
  } else {
    console.log("[dev-seed] merchant exists:", merchant.name);
  }

  // 3) Ensure BillingAccount exists for merchant (idempotent by merchantId)
  const acct = await prisma.billingAccount.findUnique({
    where: { merchantId: merchant.id },
    select: { id: true, merchantId: true },
  });

  let billingAccount = acct;
  if (!billingAccount) {
    billingAccount = await prisma.billingAccount.create({
      data: {
        merchantId: merchant.id,
        billingEmail: email.toLowerCase(), // required by schema
      },
      select: { id: true, merchantId: true },
    });
    console.log("[dev-seed] created billingAccount:", billingAccount.id);
  } else {
    console.log("[dev-seed] billingAccount exists:", billingAccount.id);
  }

  // 4) Seed demo stores (idempotent by merchantId + store name)
  const storesToSeed = [
    {
      name: "Demo Store – Downtown",
      address1: "123 Main St",
      city: "Danville",
      state: "CA",
      postal: "94526",
    },
    {
      name: "Demo Store – East Side",
      address1: "456 Oak Ave",
      city: "San Ramon",
      state: "CA",
      postal: "94583",
    },
  ];

  for (const s of storesToSeed) {
    const existing = await prisma.store.findFirst({
      where: { merchantId: merchant.id, name: s.name },
      select: { id: true, name: true, status: true },
    });

    let store = existing;

    if (!store) {
      store = await prisma.store.create({
        data: {
          merchantId: merchant.id,
          status: "active",
          ...s,
        },
        select: { id: true, name: true, status: true },
      });
      console.log("[dev-seed] created store:", store.name);
    } else if (store.status !== "active") {
      store = await prisma.store.update({
        where: { id: store.id },
        data: { status: "active" },
        select: { id: true, name: true, status: true },
      });
      console.log("[dev-seed] reactivated store:", store.name);
    } else {
      console.log("[dev-seed] store exists:", store.name);
    }

    // 5) Seed an active Store QR for each store (only if none exists)
    // NOTE: This assumes your StoreQr model has: storeId, merchantId, token, status, updatedAt
    // If your StoreQr schema differs, run once and Prisma will tell you missing fields; adjust accordingly.
    const existingQr = await prisma.storeQr.findFirst({
      where: { storeId: store.id, status: "active" },
      select: { id: true, token: true },
    });

    if (!existingQr) {
      const token = crypto.randomBytes(16).toString("hex");
      await prisma.storeQr.create({
        data: {
          storeId: store.id,
          merchantId: merchant.id,
          token,
          status: "active",
          updatedAt: new Date(),
        },
      });
      console.log("[dev-seed] created active store QR:", store.name);
    } else {
      console.log("[dev-seed] store QR exists:", store.name);
    }
  }

  console.log("[dev-seed] ✅ done");
  console.log("[dev-seed] adminUser:", adminUser);
  console.log("[dev-seed] merchant:", { id: merchant.id, name: merchant.name, status: merchant.status });
  console.log("[dev-seed] billingAccount:", billingAccount);

  console.log("\nLogin creds:");
  console.log("  email   :", email);
  console.log("  password:", password);
}

main()
  .catch((e) => {
    console.error("[dev-seed] ❌ failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
