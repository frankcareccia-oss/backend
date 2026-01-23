require("dotenv/config");

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is missing. Ensure backend/.env contains DATABASE_URL="postgresql://...".'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // DEV ONLY passwords
  const adminPass = await bcrypt.hash("Admin123!", 10);
  const merchantPass = await bcrypt.hash("Merchant123!", 10);

  // 1) Create Merchant + Store
  const merchant = await prisma.merchant.create({
    data: {
      name: "Acme Markets",
      stores: {
        create: {
          name: "Acme - Danville",
          address1: "123 Main St",
          city: "Danville",
          state: "CA",
          postal: "94526",
        },
      },
    },
    include: { stores: true },
  });

  const store = merchant.stores[0];

  // 2) Create PerkValet Admin user
  await prisma.user.create({
    data: {
      email: "admin@perkvalet.local",
      passwordHash: adminPass,
      systemRole: "pv_admin",
      status: "active",
    },
  });

  // 3) Create Merchant user + membership + store permission
  const merchantUser = await prisma.user.create({
    data: {
      email: "merchant@perkvalet.local",
      passwordHash: merchantPass,
      systemRole: "user",
      status: "active",
      merchantUsers: {
        create: {
          merchantId: merchant.id,
          role: "merchant_admin",
          storeUsers: {
            create: {
              storeId: store.id,
              permissionLevel: "admin",
            },
          },
        },
      },
    },
  });

  console.log("Seed complete:");
  console.log("Merchant:", merchant.id, merchant.name);
  console.log("Store:", store.id, store.name);
  console.log("PV Admin:", "admin@perkvalet.local");
  console.log("Merchant User:", merchantUser.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
