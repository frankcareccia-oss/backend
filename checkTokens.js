require("dotenv").config();
const { prisma } = require("./src/db/prisma");

async function run() {
  const rows = await prisma.guestPayToken.findMany({
    where: { invoiceId: 6 },
    orderBy: { createdAt: "desc" },
  });

  console.log(rows);
  await prisma.$disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
