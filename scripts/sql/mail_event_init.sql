-- Mail-Flow-1: create MailEvent persistence without touching other tables
-- Safe to run multiple times (uses IF NOT EXISTS patterns where possible).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MailTriggerType') THEN
    CREATE TYPE "MailTriggerType" AS ENUM ('auto', 'manual');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MailEventStatus') THEN
    CREATE TYPE "MailEventStatus" AS ENUM ('sent', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "MailEvent" (
  "id" SERIAL PRIMARY KEY,

  -- Classification
  "category" VARCHAR(80) NOT NULL,
  "triggerType" "MailTriggerType" NOT NULL,

  -- Idempotency
  "idempotencyKey" VARCHAR(255),

  -- Optional linkages
  "invoiceId" INTEGER,
  "paymentId" INTEGER,

  -- Actor
  "actorRole" VARCHAR(40) NOT NULL,
  "actorUserId" INTEGER,

  -- Addressing + template
  "template" VARCHAR(120) NOT NULL,
  "toEmail" VARCHAR(320) NOT NULL,

  -- Outcome
  "status" "MailEventStatus" NOT NULL DEFAULT 'failed',
  "error" TEXT,
  "transport" VARCHAR(40),
  "providerMessageId" VARCHAR(255),

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),

  CONSTRAINT "MailEvent_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT "MailEvent_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT "MailEvent_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Idempotency uniqueness (matches Prisma)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='MailEvent_triggerType_idempotencyKey_key'
  ) THEN
    CREATE UNIQUE INDEX "MailEvent_triggerType_idempotencyKey_key"
      ON "MailEvent" ("triggerType", "idempotencyKey");
  END IF;
END $$;

-- Supporting indexes
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='MailEvent_category_idx') THEN
    CREATE INDEX "MailEvent_category_idx" ON "MailEvent" ("category");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='MailEvent_invoiceId_idx') THEN
    CREATE INDEX "MailEvent_invoiceId_idx" ON "MailEvent" ("invoiceId");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='MailEvent_paymentId_idx') THEN
    CREATE INDEX "MailEvent_paymentId_idx" ON "MailEvent" ("paymentId");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='MailEvent_actorUserId_idx') THEN
    CREATE INDEX "MailEvent_actorUserId_idx" ON "MailEvent" ("actorUserId");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='MailEvent_createdAt_idx') THEN
    CREATE INDEX "MailEvent_createdAt_idx" ON "MailEvent" ("createdAt");
  END IF;
END $$;
