require("dotenv").config();
const { prisma } = require("../src/db/prisma");

(async () => {
  const merchantId = Number(process.env.MID || 0);
  if (!merchantId) throw new Error("Set MID env var (merchant id)");

  const m = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!m) throw new Error("Merchant not found: " + merchantId);

  const existing = await prisma.billingAccount.findUnique({ where: { merchantId } });
  if (existing) {
    console.log("BillingAccount exists:", { id: existing.id, merchantId });
    return;
  }

  const email = "billing+merchant" + merchantId + "@example.com";
  const acct = await prisma.billingAccount.create({
    data: {
      merchantId,
      provider: "stripe",
      billingEmail: email,
      status: "active",
    },
  });

  console.log("Created BillingAccount:", { id: acct.id, merchantId: acct.merchantId, billingEmail: acct.billingEmail });
})().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
