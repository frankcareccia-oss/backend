require("dotenv").config();

const { prisma } = require("../src/db/prisma");

async function run() {
  const acct = await prisma.billingAccount.findUnique({
    where: { merchantId: 4 }
  });
  console.log(acct);
  await prisma.$disconnect();
}

run().catch(console.error);
