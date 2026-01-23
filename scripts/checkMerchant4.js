require("dotenv").config();
const { prisma } = require("../src/db/prisma");

async function run() {
  const m = await prisma.merchant.findUnique({ where: { id: 4 } });
  console.log(m);
  await prisma.$disconnect();
}
run().catch(console.error);
