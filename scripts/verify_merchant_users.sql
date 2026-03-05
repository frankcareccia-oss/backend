-- ==========================================
-- PerkValet Merchant User Verification
-- ==========================================

-- Show the last 10 users created
SELECT
  id,
  email,
  "firstName",
  "lastName",
  "phoneRaw",
  "phoneCountry",
  "phoneE164",
  status,
  "createdAt"
FROM "User"
ORDER BY id DESC
LIMIT 10;


-- Show merchant memberships
SELECT
  mu.id,
  mu."merchantId",
  mu."userId",
  mu.role,
  mu.status,
  u.email
FROM "MerchantUser" mu
JOIN "User" u ON u.id = mu."userId"
ORDER BY mu.id DESC
LIMIT 10;


-- Show users tied to merchant 1
SELECT
  u.id,
  u.email,
  mu.role,
  mu.status,
  u."firstName",
  u."lastName"
FROM "User" u
JOIN "MerchantUser" mu
  ON mu."userId" = u.id
WHERE mu."merchantId" = 1
ORDER BY u.id;


-- Verify the test user specifically
SELECT
  u.id,
  u.email,
  u."firstName",
  u."lastName",
  mu.role,
  mu.status,
  mu."merchantId"
FROM "User" u
JOIN "MerchantUser" mu
  ON mu."userId" = u.id
WHERE u.email LIKE 'api-test%';