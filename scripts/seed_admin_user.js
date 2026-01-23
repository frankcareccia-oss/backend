require("dotenv").config();

const { prisma } = require("../src/db/prisma");
const bcrypt = require("bcryptjs");

(async () => {
  const email = "admin@example.com";
  const pw = "ChangeMe123!";
  const hash = await bcrypt.hash(pw, 12);

  const u = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, systemRole: "pv_admin", status: "active" },
    create: { email, passwordHash: hash, systemRole: "pv_admin", status: "active" },
  });

  console.log("OK user:", { email: u.email, systemRole: u.systemRole });
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
