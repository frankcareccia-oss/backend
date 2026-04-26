-- Your Voice: triggered email templates + merchant winback config

-- Add winbackDays to Merchant
ALTER TABLE "Merchant" ADD COLUMN IF NOT EXISTS "winbackDays" INTEGER NOT NULL DEFAULT 30;

-- EmailTemplate model
CREATE TABLE IF NOT EXISTS "EmailTemplate" (
    "id" SERIAL PRIMARY KEY,
    "merchantId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "styleChoice" TEXT,
    "personalNote" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailTemplate_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "EmailTemplate_merchantId_eventType_language_key" ON "EmailTemplate"("merchantId", "eventType", "language");
CREATE INDEX IF NOT EXISTS "EmailTemplate_merchantId_eventType_idx" ON "EmailTemplate"("merchantId", "eventType");
