/*
  Warnings:

  - You are about to drop the `GuestPayToken` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterEnum
ALTER TYPE "BillingProvider" ADD VALUE 'manual';

-- DropForeignKey
ALTER TABLE "GuestPayToken" DROP CONSTRAINT "GuestPayToken_invoiceId_fkey";

-- AlterTable
ALTER TABLE "InvoiceLineItem" ADD COLUMN     "sourceInvoiceId" INTEGER;

-- DropTable
DROP TABLE "GuestPayToken";

-- CreateIndex
CREATE INDEX "InvoiceLineItem_sourceInvoiceId_idx" ON "InvoiceLineItem"("sourceInvoiceId");

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_sourceInvoiceId_fkey" FOREIGN KEY ("sourceInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
