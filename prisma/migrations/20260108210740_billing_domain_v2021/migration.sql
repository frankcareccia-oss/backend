-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('stripe');

-- CreateEnum
CREATE TYPE "BillingAccountStatus" AS ENUM ('active', 'suspended', 'canceled');

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('card', 'bank_account', 'other');

-- CreateEnum
CREATE TYPE "PaymentMethodStatus" AS ENUM ('active', 'replaced', 'expired');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'past_due', 'paid', 'void');

-- CreateEnum
CREATE TYPE "InvoiceLineSourceType" AS ENUM ('platform_fee', 'usage_fee', 'late_fee', 'adjustment');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'stripe',
    "providerCustomerId" VARCHAR(255),
    "billingEmail" VARCHAR(320) NOT NULL,
    "billingName" VARCHAR(200),
    "billingPhone" VARCHAR(32),
    "billingAddressJson" JSONB,
    "status" "BillingAccountStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" SERIAL NOT NULL,
    "billingAccountId" INTEGER NOT NULL,
    "providerPaymentMethodId" VARCHAR(255) NOT NULL,
    "type" "PaymentMethodType" DEFAULT 'card',
    "brand" VARCHAR(50),
    "last4" VARCHAR(4),
    "expMonth" INTEGER,
    "expYear" INTEGER,
    "status" "PaymentMethodStatus" NOT NULL DEFAULT 'active',
    "replacedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" SERIAL NOT NULL,
    "billingAccountId" INTEGER NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "externalInvoiceId" VARCHAR(255),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "netTermsDays" INTEGER,
    "dueAt" TIMESTAMP(3),
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
    "generationVersion" INTEGER NOT NULL DEFAULT 1,
    "relatedToInvoiceId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceCents" INTEGER,
    "amountCents" INTEGER NOT NULL,
    "sourceType" "InvoiceLineSourceType" NOT NULL,
    "sourceRefId" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "providerChargeId" VARCHAR(255),
    "payerEmail" VARCHAR(320),
    "paymentMethodId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestPayToken" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "tokenHash" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestPayToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_merchantId_key" ON "BillingAccount"("merchantId");

-- CreateIndex
CREATE INDEX "BillingAccount_providerCustomerId_idx" ON "BillingAccount"("providerCustomerId");

-- CreateIndex
CREATE INDEX "BillingAccount_status_idx" ON "BillingAccount"("status");

-- CreateIndex
CREATE INDEX "PaymentMethod_billingAccountId_status_idx" ON "PaymentMethod"("billingAccountId", "status");

-- CreateIndex
CREATE INDEX "PaymentMethod_providerPaymentMethodId_idx" ON "PaymentMethod"("providerPaymentMethodId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_billingAccountId_providerPaymentMethodId_key" ON "PaymentMethod"("billingAccountId", "providerPaymentMethodId");

-- CreateIndex
CREATE INDEX "Invoice_merchantId_status_idx" ON "Invoice"("merchantId", "status");

-- CreateIndex
CREATE INDEX "Invoice_billingAccountId_status_idx" ON "Invoice"("billingAccountId", "status");

-- CreateIndex
CREATE INDEX "Invoice_externalInvoiceId_idx" ON "Invoice"("externalInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_relatedToInvoiceId_idx" ON "Invoice"("relatedToInvoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_invoiceId_idx" ON "InvoiceLineItem"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_sourceType_sourceRefId_idx" ON "InvoiceLineItem"("sourceType", "sourceRefId");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_status_idx" ON "Payment"("invoiceId", "status");

-- CreateIndex
CREATE INDEX "Payment_providerChargeId_idx" ON "Payment"("providerChargeId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestPayToken_tokenHash_key" ON "GuestPayToken"("tokenHash");

-- CreateIndex
CREATE INDEX "GuestPayToken_invoiceId_idx" ON "GuestPayToken"("invoiceId");

-- CreateIndex
CREATE INDEX "GuestPayToken_expiresAt_idx" ON "GuestPayToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "BillingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_relatedToInvoiceId_fkey" FOREIGN KEY ("relatedToInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestPayToken" ADD CONSTRAINT "GuestPayToken_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
