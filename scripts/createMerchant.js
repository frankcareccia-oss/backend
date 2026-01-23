require("dotenv").config();
const { prisma } = require("../src/db/prisma");

async function run() {
  const m = await prisma.merchant.create({
    data: { name: "Thread J Test Merchant" },
  });
  console.log("Created merchant:", m);
  await prisma.$disconnect();
}

run().catch(console.error);
