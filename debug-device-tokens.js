require("dotenv").config();

const { PrismaClient } = require("@prisma/client");

// Your Prisma build wants at least an options object
const prisma = new PrismaClient({});

(async () => {
  try {
    const rows = await prisma.deviceVerifyToken.findMany({
      orderBy: { id: "desc" },
      take: 10,
    });

    console.log("NOW:", new Date().toISOString());
    console.log("COUNT:", rows.length);

    for (const r of rows) {
      console.log({
        id: r.id,
        userId: r.userId,
        expiresAt: r.expiresAt,
        usedAt: r.usedAt,
        deviceIdHash: r.deviceIdHash,
        tokenHashPreview: String(r.tokenHash || "").slice(0, 16),
        expired: r.expiresAt ? r.expiresAt <= new Date() : null,
      });
    }
  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await prisma.$disconnect();
  }
})();
