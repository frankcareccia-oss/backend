-- Merchant branded consumer experience
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "websiteUrl" VARCHAR(500);
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "merchantSlug" VARCHAR(100);
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "brandLogo" VARCHAR(500);
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "brandColor" VARCHAR(7);
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "brandAccent" VARCHAR(7);
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "brandFont" VARCHAR(100);
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "brandTagline" VARCHAR(200);
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "brandScrapedAt" TIMESTAMP(3);
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "brandOverrides" JSONB;

-- Unique index on slug for branded URL routing
CREATE UNIQUE INDEX IF NOT EXISTS "Merchant_merchantSlug_key" ON "Merchant"("merchantSlug");
