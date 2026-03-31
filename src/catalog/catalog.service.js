// src/catalog/catalog.service.js
const { prisma } = require("../db/prisma");

// Generate next sequential SKU for a merchant: PRD-0001, PRD-0002, ...
async function generateSku(merchantId) {
  const last = await prisma.product.findFirst({
    where: {
      merchantId,
      sku: { startsWith: "PRD-" },
    },
    orderBy: { id: "desc" },
    select: { sku: true },
  });

  let next = 1;
  if (last?.sku) {
    const num = parseInt(last.sku.replace("PRD-", ""), 10);
    if (!isNaN(num)) next = num + 1;
  }

  return `PRD-${String(next).padStart(4, "0")}`;
}

module.exports = { generateSku };
