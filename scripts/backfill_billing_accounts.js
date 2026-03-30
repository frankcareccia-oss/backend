require("dotenv").config();
const { prisma } = require("../src/db/prisma");

async function main() {
  const merchants = await prisma.merchant.findMany({
    include: { billingAccount: true },
  });

  const missing = merchants.filter((m) => !m.billingAccount);
  console.log("Missing BillingAccounts:", missing.map((m) => `${m.id} ${m.name}`));

  if (missing.length === 0) {
    console.log("All merchants already have a BillingAccount.");
    return;
  }

  const created = await Promise.all(
    missing.map((m) =>
      prisma.billingAccount.create({
        data: {
          merchantId: m.id,
          billingEmail: `billing+merchant${m.id}@example.com`,
        },
      })
    )
  );

  console.log("Created:", created.length);
}

main().finally(() => prisma.$disconnect());
