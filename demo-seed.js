/**
 * demo-seed.js
 *
 * Populates the PerkValet database with demo data per DEMO_SETUP_CHECKLIST.md.
 * Run with:
 *   DATABASE_URL="..." node demo-seed.js
 *
 * Safe to re-run: uses upsert/findOrCreate patterns.
 * Prints a credentials table on completion.
 */

"use strict";

// Load .env only as fallback — shell DATABASE_URL takes precedence
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function hashPw(pw) {
  return bcrypt.hash(pw, 12);
}

async function upsertUser({ email, password, firstName, lastName, systemRole = "user" }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const updated = await prisma.user.update({
      where: { email },
      data: {
        firstName,
        lastName,
        passwordHash: await hashPw(password),
        systemRole,
        status: "active",
      },
    });
    return { user: updated, created: false };
  }
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPw(password),
      firstName,
      lastName,
      systemRole,
      status: "active",
      tokenVersion: 0,
    },
  });
  return { user, created: true };
}

async function upsertMerchant(name) {
  const existing = await prisma.merchant.findFirst({ where: { name } });
  if (existing) return { merchant: existing, created: false };
  const merchant = await prisma.merchant.create({
    data: { name, status: "active" },
  });
  return { merchant, created: true };
}

async function upsertMerchantUser(merchantId, userId, role) {
  return prisma.merchantUser.upsert({
    where: { merchantId_userId: { merchantId, userId } },
    update: { role, status: "active" },
    create: { merchantId, userId, role, status: "active" },
  });
}

async function upsertStore(merchantId, { name, address1, city, state, postal, phone }) {
  const existing = await prisma.store.findFirst({ where: { merchantId, name } });
  if (existing) return { store: existing, created: false };
  const store = await prisma.store.create({
    data: { merchantId, name, address1, city, state, postal, phoneRaw: phone, status: "active" },
  });
  return { store, created: true };
}

async function upsertStoreUser(storeId, merchantId, userId, permissionLevel) {
  const mu = await prisma.merchantUser.findFirst({ where: { merchantId, userId } });
  if (!mu) throw new Error(`MerchantUser not found for userId=${userId} merchantId=${merchantId}`);
  return prisma.storeUser.upsert({
    where: { storeId_merchantUserId: { storeId, merchantUserId: mu.id } },
    update: { permissionLevel, status: "active" },
    create: { storeId, merchantUserId: mu.id, permissionLevel, status: "active" },
  });
}

async function upsertProduct(merchantId, { sku, name, description }) {
  const existing = await prisma.product.findUnique({
    where: { merchantId_sku: { merchantId, sku } },
  });
  if (existing) return { product: existing, created: false };
  const product = await prisma.product.create({
    data: { merchantId, sku, name, description, status: "active", firstActivatedAt: new Date() },
  });
  return { product, created: true };
}

async function upsertPromotion(merchantId, {
  name, description, mechanic, earnPerUnit = 1, threshold,
  rewardType, rewardValue = null, rewardSku = null, rewardNote = null,
}) {
  const existing = await prisma.promotion.findFirst({ where: { merchantId, name } });
  if (existing) return { promo: existing, created: false };
  const promo = await prisma.promotion.create({
    data: {
      merchantId, name, description, mechanic, earnPerUnit, threshold,
      rewardType, rewardValue, rewardSku, rewardNote,
      status: "active",
      startAt: new Date("2026-04-01"),
      endAt: new Date("2027-04-01"),
      firstActivatedAt: new Date(),
    },
  });
  return { promo, created: true };
}

async function upsertBundle(merchantId, { name, price, ruleTreeJson }) {
  const existing = await prisma.bundle.findFirst({ where: { merchantId, name } });
  if (existing) return { bundle: existing, created: false };
  const bundle = await prisma.bundle.create({
    data: {
      merchantId, name, price, ruleTreeJson,
      status: "live",
      startAt: new Date("2026-04-01"),
    },
  });
  return { bundle, created: true };
}

// ─── Credential log ─────────────────────────────────────────────────────────

const creds = [];
function log(role, name, email, password, notes = "") {
  creds.push({ role, name, email, password, notes });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🌱  PerkValet demo seed starting...\n");

  // ── pv_admin ──────────────────────────────────────────────────────────────
  const adminPw = "PvAdmin@2026!";
  await upsertUser({
    email: "admin@perksvalet.com",
    password: adminPw,
    firstName: "PerkValet",
    lastName: "Admin",
    systemRole: "pv_admin",
  });
  log("pv_admin", "PerkValet Admin", "admin@perksvalet.com", adminPw);
  console.log("✓ pv_admin");

  // ══════════════════════════════════════════════════════════════════════════
  // MERCHANT 1 — Brewed Awakening Coffee Co.
  // ══════════════════════════════════════════════════════════════════════════
  const { merchant: brew } = await upsertMerchant("Brewed Awakening Coffee Co.");
  console.log(`✓ Merchant: ${brew.name} (ID ${brew.id})`);

  const brewUsers = [
    { email: "owner@brewedawakening.com",  password: "BrewOwner@2026!",  firstName: "Marco",  lastName: "Rossi",  role: "merchant_admin" },
    { email: "admin@brewedawakening.com",  password: "BrewAdmin@2026!",  firstName: "Sofia",  lastName: "Caruso", role: "merchant_admin" },
    { email: "ap@brewedawakening.com",     password: "BrewAP@2026!",     firstName: "Lena",   lastName: "Park",   role: "ap_clerk" },
    { email: "staff@brewedawakening.com",  password: "BrewStaff@2026!",  firstName: "Tom",    lastName: "Huang",  role: "merchant_employee" },
  ];

  for (const u of brewUsers) {
    const { user } = await upsertUser(u);
    await upsertMerchantUser(brew.id, user.id, u.role);
    log(`merchant:${u.role}`, `${u.firstName} ${u.lastName}`, u.email, u.password, "Brewed Awakening");
    console.log(`  ✓ ${u.firstName} ${u.lastName} (${u.role})`);
  }

  // Store 1 — Downtown Roastery
  const { store: downtown } = await upsertStore(brew.id, {
    name: "Downtown Roastery",
    address1: "101 Main St",
    city: "Chicago",
    state: "IL",
    postal: "60601",
    phone: "(312) 555-0101",
  });
  console.log(`  ✓ Store: ${downtown.name} (ID ${downtown.id})`);

  const downtownTeam = [
    { email: "dana@brewedawakening.com",  password: "BrewDana@2026!",  firstName: "Dana",  lastName: "Mills",  permissionLevel: "store_admin" },
    { email: "chris@brewedawakening.com", password: "BrewChris@2026!", firstName: "Chris", lastName: "Wade",   permissionLevel: "store_subadmin" },
    { email: "jamie@brewedawakening.com", password: "BrewJamie@2026!", firstName: "Jamie", lastName: "Lee",    permissionLevel: "pos_access" },
  ];

  for (const u of downtownTeam) {
    const { user } = await upsertUser(u);
    await upsertMerchantUser(brew.id, user.id, "merchant_employee");
    await upsertStoreUser(downtown.id, brew.id, user.id, u.permissionLevel);
    log(`store:${u.permissionLevel}`, `${u.firstName} ${u.lastName}`, u.email, u.password, "Downtown Roastery");
    console.log(`    ✓ ${u.firstName} ${u.lastName} (${u.permissionLevel})`);
  }

  // Store 2 — Westside Café
  const { store: westside } = await upsertStore(brew.id, {
    name: "Westside Café",
    address1: "450 West Ave",
    city: "Chicago",
    state: "IL",
    postal: "60607",
    phone: "(312) 555-0202",
  });
  console.log(`  ✓ Store: ${westside.name} (ID ${westside.id})`);

  const westsideTeam = [
    { email: "riley@brewedawakening.com", password: "BrewRiley@2026!", firstName: "Riley", lastName: "Chen", permissionLevel: "store_admin" },
    { email: "alex@brewedawakening.com",  password: "BrewAlex@2026!",  firstName: "Alex",  lastName: "Diaz", permissionLevel: "pos_access" },
  ];

  for (const u of westsideTeam) {
    const { user } = await upsertUser(u);
    await upsertMerchantUser(brew.id, user.id, "merchant_employee");
    await upsertStoreUser(westside.id, brew.id, user.id, u.permissionLevel);
    log(`store:${u.permissionLevel}`, `${u.firstName} ${u.lastName}`, u.email, u.password, "Westside Café");
    console.log(`    ✓ ${u.firstName} ${u.lastName} (${u.permissionLevel})`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MERCHANT 2 — FitZone Performance
  // ══════════════════════════════════════════════════════════════════════════
  const { merchant: fit } = await upsertMerchant("FitZone Performance");
  console.log(`✓ Merchant: ${fit.name} (ID ${fit.id})`);

  const fitUsers = [
    { email: "owner@fitzoneperf.com",  password: "FitOwner@2026!",  firstName: "Priya",   lastName: "Nair",   role: "merchant_admin" },
    { email: "admin@fitzoneperf.com",  password: "FitAdmin@2026!",  firstName: "Derek",   lastName: "Stone",  role: "merchant_admin" },
    { email: "ap@fitzoneperf.com",     password: "FitAP@2026!",     firstName: "Camille", lastName: "Roy",    role: "ap_clerk" },
    { email: "staff@fitzoneperf.com",  password: "FitStaff@2026!",  firstName: "Jonah",   lastName: "West",   role: "merchant_employee" },
  ];

  for (const u of fitUsers) {
    const { user } = await upsertUser(u);
    await upsertMerchantUser(fit.id, user.id, u.role);
    log(`merchant:${u.role}`, `${u.firstName} ${u.lastName}`, u.email, u.password, "FitZone Performance");
    console.log(`  ✓ ${u.firstName} ${u.lastName} (${u.role})`);
  }

  // Store 1 — FitZone North
  const { store: fitNorth } = await upsertStore(fit.id, {
    name: "FitZone North",
    address1: "800 Lincoln Ave",
    city: "Chicago",
    state: "IL",
    postal: "60614",
    phone: "(312) 555-0301",
  });
  console.log(`  ✓ Store: ${fitNorth.name} (ID ${fitNorth.id})`);

  const fitNorthTeam = [
    { email: "maya@fitzoneperf.com", password: "FitMaya@2026!", firstName: "Maya", lastName: "Torres", permissionLevel: "store_admin" },
    { email: "ben@fitzoneperf.com",  password: "FitBen@2026!",  firstName: "Ben",  lastName: "Okafor", permissionLevel: "store_subadmin" },
    { email: "zoe@fitzoneperf.com",  password: "FitZoe@2026!",  firstName: "Zoe",  lastName: "Grant",  permissionLevel: "pos_access" },
  ];

  for (const u of fitNorthTeam) {
    const { user } = await upsertUser(u);
    await upsertMerchantUser(fit.id, user.id, "merchant_employee");
    await upsertStoreUser(fitNorth.id, fit.id, user.id, u.permissionLevel);
    log(`store:${u.permissionLevel}`, `${u.firstName} ${u.lastName}`, u.email, u.password, "FitZone North");
    console.log(`    ✓ ${u.firstName} ${u.lastName} (${u.permissionLevel})`);
  }

  // Store 2 — FitZone South
  const { store: fitSouth } = await upsertStore(fit.id, {
    name: "FitZone South",
    address1: "200 South Blvd",
    city: "Chicago",
    state: "IL",
    postal: "60616",
    phone: "(312) 555-0302",
  });
  console.log(`  ✓ Store: ${fitSouth.name} (ID ${fitSouth.id})`);

  const fitSouthTeam = [
    { email: "nina@fitzoneperf.com",  password: "FitNina@2026!",  firstName: "Nina",  lastName: "Walsh",  permissionLevel: "store_admin" },
    { email: "carlo@fitzoneperf.com", password: "FitCarlo@2026!", firstName: "Carlo", lastName: "Reyes",  permissionLevel: "pos_access" },
  ];

  for (const u of fitSouthTeam) {
    const { user } = await upsertUser(u);
    await upsertMerchantUser(fit.id, user.id, "merchant_employee");
    await upsertStoreUser(fitSouth.id, fit.id, user.id, u.permissionLevel);
    log(`store:${u.permissionLevel}`, `${u.firstName} ${u.lastName}`, u.email, u.password, "FitZone South");
    console.log(`    ✓ ${u.firstName} ${u.lastName} (${u.permissionLevel})`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRODUCTS
  // ══════════════════════════════════════════════════════════════════════════

  // Brewed Awakening products
  const { product: brewDrip }   = await upsertProduct(brew.id, { sku: "BREW-001", name: "House Drip Coffee",  description: "Our signature house blend, brewed fresh daily." });
  const { product: brewLatte }  = await upsertProduct(brew.id, { sku: "BREW-002", name: "Seasonal Latte",     description: "Rotating seasonal latte crafted by our roasters." });
  const { product: brewBundle } = await upsertProduct(brew.id, { sku: "BREW-BUNDLE", name: "Coffee Loyalty Pack", description: "Prepaid loyalty pack — $25 value for $30 in store credit." });
  console.log(`✓ Brewed Awakening products: ${brewDrip.name}, ${brewLatte.name}, ${brewBundle.name}`);

  // FitZone products
  const { product: fitClass }  = await upsertProduct(fit.id, { sku: "FIT-001", name: "Single Group Class",       description: "Drop-in access to any group fitness class." });
  const { product: fitPT }     = await upsertProduct(fit.id, { sku: "FIT-002", name: "Personal Training Session", description: "One-on-one session with a certified FitZone trainer." });
  const { product: fitBundle } = await upsertProduct(fit.id, { sku: "FIT-BUNDLE", name: "10-Class Pack",         description: "Prepay for 10 classes at a discounted rate." });
  console.log(`✓ FitZone products: ${fitClass.name}, ${fitPT.name}, ${fitBundle.name}`);

  // ══════════════════════════════════════════════════════════════════════════
  // PROMOTIONS
  // ══════════════════════════════════════════════════════════════════════════

  // Brewed Awakening promotions
  await upsertPromotion(brew.id, {
    name: "The Classic Stamp Card",
    description: "Buy 10 coffees, get 1 free!",
    mechanic: "stamps", threshold: 10,
    rewardType: "free_item", rewardSku: brewDrip.sku,
  });
  await upsertPromotion(brew.id, {
    name: "Morning Points Multiplier",
    description: "Earn points every visit. Redeem for 15% off.",
    mechanic: "points", earnPerUnit: 10, threshold: 500,
    rewardType: "discount_pct", rewardValue: 15,
  });
  await upsertPromotion(brew.id, {
    name: "Happy Hour Stamp Saver",
    description: "Collect 5 happy hour stamps, get $2 off your next order.",
    mechanic: "stamps", threshold: 5,
    rewardType: "discount_fixed", rewardValue: 200,
  });
  await upsertPromotion(brew.id, {
    name: "Roaster's VIP Club",
    description: "Our most loyal regulars earn a bag of premium beans.",
    mechanic: "stamps", threshold: 20,
    rewardType: "custom", rewardNote: "Complimentary bag of single-origin beans — ask barista to redeem",
  });
  console.log("✓ Brewed Awakening promotions (4)");

  // FitZone promotions
  await upsertPromotion(fit.id, {
    name: "Class Stamp Card",
    description: "Attend 8 classes, earn your next one free!",
    mechanic: "stamps", threshold: 8,
    rewardType: "free_item", rewardSku: fitClass.sku,
  });
  await upsertPromotion(fit.id, {
    name: "Workout Points Rewards",
    description: "Earn points every workout. Redeem for a free PT session.",
    mechanic: "points", earnPerUnit: 20, threshold: 1000,
    rewardType: "free_item", rewardSku: fitPT.sku,
  });
  await upsertPromotion(fit.id, {
    name: "Member Discount Points",
    description: "Regular members earn points and unlock 10% off merchandise.",
    mechanic: "points", earnPerUnit: 5, threshold: 200,
    rewardType: "discount_pct", rewardValue: 10,
  });
  await upsertPromotion(fit.id, {
    name: "Challenge Finisher Reward",
    description: "Complete the 50-day challenge and earn exclusive FitZone swag.",
    mechanic: "points", earnPerUnit: 15, threshold: 750,
    rewardType: "custom", rewardNote: "FitZone branded gear bag — see front desk to redeem",
  });
  await upsertPromotion(fit.id, {
    name: "Drop-In Dollar Saver",
    description: "Drop in 6 times, get $5 off your next visit.",
    mechanic: "stamps", threshold: 6,
    rewardType: "discount_fixed", rewardValue: 500,
  });
  console.log("✓ FitZone promotions (5)");

  // ══════════════════════════════════════════════════════════════════════════
  // BUNDLES
  // ══════════════════════════════════════════════════════════════════════════

  await upsertBundle(brew.id, {
    name: "Coffee Loyalty Pack",
    price: 25.00,
    ruleTreeJson: { type: "PRODUCT", productId: brewBundle.id, productName: brewBundle.name, quantity: 1 },
  });
  console.log("✓ Brewed Awakening bundle: Coffee Loyalty Pack");

  await upsertBundle(fit.id, {
    name: "10-Class Pack",
    price: 150.00,
    ruleTreeJson: { type: "PRODUCT", productId: fitBundle.id, productName: fitBundle.name, quantity: 10 },
  });
  console.log("✓ FitZone bundle: 10-Class Pack");

  // ─── Credentials Table ───────────────────────────────────────────────────
  console.log("\n\n╔══════════════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                              PERKVALET DEMO CREDENTIALS                                        ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════════════╣");
  console.log(`║ ${"Role".padEnd(28)} ${"Name".padEnd(18)} ${"Email".padEnd(32)} ${"Password".padEnd(18)} ║`);
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════════════╣");
  for (const c of creds) {
    const notes = c.notes ? ` [${c.notes}]` : "";
    console.log(`║ ${c.role.padEnd(28)} ${c.name.padEnd(18)} ${c.email.padEnd(32)} ${c.password.padEnd(18)} ║`);
  }
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════════════════╝");
  console.log("\n✅  Demo seed complete.\n");
}

main()
  .catch((e) => {
    console.error("❌  Seed failed:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
