require("dotenv").config();
const { prisma } = require("../src/db/prisma");

async function run() {
  const acct = await prisma.billingAccount.upsert({
    where: { merchantId: 2 },
    update: {},
    create: {
      merchantId: 2,
      provider: "stripe",
      billingEmail: "billing+merchant2@test.com",
      status: "active",
    },
  });

  console.log("BillingAccount OK:", acct);
  await prisma.$disconnect();
}

run().catch(console.error);
