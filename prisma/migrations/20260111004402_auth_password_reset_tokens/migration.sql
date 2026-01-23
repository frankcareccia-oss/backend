/*
  Warnings:

  - You are about to drop the column `sourceInvoiceId` on the `InvoiceLineItem` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "InvoiceLineItem" DROP CONSTRAINT "InvoiceLineItem_sourceInvoiceId_fkey";

-- DropIndex
DROP INDEX "InvoiceLineItem_sourceInvoiceId_idx";

-- AlterTable
ALTER TABLE "InvoiceLineItem" DROP COLUMN "sourceInvoiceId";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuestPayToken_tokenHash_key" ON "GuestPayToken"("tokenHash");

-- CreateIndex
CREATE INDEX "GuestPayToken_invoiceId_idx" ON "GuestPayToken"("invoiceId");

-- CreateIndex
CREATE INDEX "GuestPayToken_expiresAt_idx" ON "GuestPayToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestPayToken" ADD CONSTRAINT "GuestPayToken_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
