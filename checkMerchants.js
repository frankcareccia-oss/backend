const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function run() {
  const rows = await prisma.merchant.findMany({
    select: { id: true, name: true, status: true },
    orderBy: { id: "asc" }
  });

  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
}

run();