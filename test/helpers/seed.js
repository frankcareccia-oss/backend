"use strict";

const { prisma } = require("../../src/db/prisma");

/**
 * Reset DB for tests (Postgres)
 * Truncate everything in public schema (except migrations).
 */
async function resetDb() {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public';"
  );

  const tables = rows
    .map((r) => r.tablename)
    .filter((t) => t !== "_prisma_migrations");

  if (tables.length === 0) return;

  const quoted = tables.map((t) => `"${String(t).replace(/"/g, '""')}"`);
  const sql = `TRUNCATE TABLE ${quoted.join(", ")} RESTART IDENTITY CASCADE;`;
  await prisma.$executeRawUnsafe(sql);
}

/**
 * Create merchant + billing account in TWO steps (most reliable across mappings/constraints).
 */
async function createMerchantWithBillingAccount({
  name = "Test Merchant",
  billingEmail = "billing@example.com",
} = {}) {
  const merchant = await prisma.merchant.create({ data: { name } });

  const billingAccount = await prisma.billingAccount.create({
    data: {
      merchantId: merchant.id,
      billingEmail,
      provider: "stripe",
    },
  });

  return { ...merchant, billingAccount };
}

async function createMerchant({ name = "Test Merchant" } = {}) {
  return prisma.merchant.create({ data: { name } });
}

async function createBillingAccount({ merchantId, billingEmail = "billing@example.com" } = {}) {
  return prisma.billingAccount.create({
    data: { merchantId, billingEmail, provider: "stripe" },
  });
}

async function createUser({
  email = "user@example.com",
  passwordHash = "$2a$10$testtesttesttesttesttesttesttesttesttesttesttesttesttest",
} = {}) {
  return prisma.user.create({
    data: { email, passwordHash, systemRole: "user" },
  });
}

async function addMerchantUser({ merchantId, userId, role = "merchant_admin" } = {}) {
  return prisma.merchantUser.create({
    data: { merchantId, userId, role, status: "active" },
  });
}

async function createIssuedInvoice({
  merchantId,
  billingAccountId,
  totalCents = 5000,
  status = "issued",
} = {}) {
  return prisma.invoice.create({
    data: {
      merchantId,
      billingAccountId,
      status,
      totalCents,
      subtotalCents: totalCents,
      taxCents: 0,
      amountPaidCents: 0,
      issuedAt: new Date(),
    },
  });
}

async function createInvoice(args = {}) {
  return createIssuedInvoice(args);
}

async function createGuestPayToken({ invoiceId, tokenHash = "test_token_hash", expiresAt } = {}) {
  return prisma.guestPayToken.create({
    data: {
      invoiceId,
      tokenHash,
      expiresAt: expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
}

async function createConsumer({
  phoneE164 = "+14085551212",
  email = "consumer@example.com",
  firstName = "Test",
  lastName = "Consumer",
} = {}) {
  return prisma.consumer.create({
    data: { phoneE164, email, firstName, lastName, status: "active" },
  });
}

module.exports = {
  prisma,
  resetDb,
  createMerchantWithBillingAccount,
  createMerchant,
  createBillingAccount,
  createUser,
  addMerchantUser,
  createIssuedInvoice,
  createInvoice,
  createGuestPayToken,
  createConsumer,
};
