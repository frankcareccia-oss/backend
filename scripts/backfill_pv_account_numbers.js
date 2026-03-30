require("dotenv").config();
const { prisma } = require("../src/db/prisma");

function generatePvAccountNumber(merchantId) {
  const year = new Date().getFullYear();
  const padded = String(merchantId).padStart(5, "0");
  return `PV-${year}-${padded}`;
}

async function main() {
  const accounts = await prisma.billingAccount.findMany({
    where: { pvAccountNumber: null },
    select: { id: true, merchantId: true },
  });

  console.log("Accounts missing pvAccountNumber:", accounts.length);

  if (accounts.length === 0) {
    console.log("All billing accounts already have a PV account number.");
    return;
  }

  const results = await Promise.all(
    accounts.map((a) =>
      prisma.billingAccount.update({
        where: { id: a.id },
        data: { pvAccountNumber: generatePvAccountNumber(a.merchantId) },
      })
    )
  );

  console.log("Updated:", results.map((r) => `${r.merchantId} → ${r.pvAccountNumber}`));
}

main().finally(() => prisma.$disconnect());
