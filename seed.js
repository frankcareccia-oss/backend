// seed.js — bootstrap pv_admin account
// Usage: node seed.js
// Safe to run multiple times — skips if pv_admin already exists.

require("dotenv").config({ override: true });

const { PrismaClient } = require("@prisma/client");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@perksvalet.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const ADMIN_NAME = "PerkValet Admin";

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

  if (existing) {
    console.log(`pv_admin already exists (id=${existing.id}, email=${existing.email}) — skipping.`);
    return;
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const user = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash,
      firstName: "PerkValet",
      lastName: "Admin",
      systemRole: "pv_admin",
    },
  });

  console.log(`✓ pv_admin created: id=${user.id}, email=${user.email}`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);
  console.log(`  Change this password immediately after first login.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect().finally(() => pool.end()));
