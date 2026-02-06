-- CreateEnum
CREATE TYPE "MailTriggerType" AS ENUM ('auto', 'manual');

-- CreateEnum
CREATE TYPE "MailEventStatus" AS ENUM ('sent', 'failed');

-- CreateTable
CREATE TABLE "MailEvent" (
    "id" SERIAL NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "triggerType" "MailTriggerType" NOT NULL,
    "idempotencyKey" VARCHAR(255),
    "invoiceId" INTEGER,
    "paymentId" INTEGER,
    "actorRole" VARCHAR(40) NOT NULL,
    "actorUserId" INTEGER,
    "template" VARCHAR(120) NOT NULL,
    "toEmail" VARCHAR(320) NOT NULL,
    "status" "MailEventStatus" NOT NULL DEFAULT 'failed',
    "error" TEXT,
    "transport" VARCHAR(40),
    "providerMessageId" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "MailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailEvent_category_idx" ON "MailEvent"("category");

-- CreateIndex
CREATE INDEX "MailEvent_invoiceId_idx" ON "MailEvent"("invoiceId");

-- CreateIndex
CREATE INDEX "MailEvent_paymentId_idx" ON "MailEvent"("paymentId");

-- CreateIndex
CREATE INDEX "MailEvent_actorUserId_idx" ON "MailEvent"("actorUserId");

-- CreateIndex
CREATE INDEX "MailEvent_createdAt_idx" ON "MailEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailEvent_triggerType_idempotencyKey_key" ON "MailEvent"("triggerType", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "MailEvent" ADD CONSTRAINT "MailEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailEvent" ADD CONSTRAINT "MailEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailEvent" ADD CONSTRAINT "MailEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
