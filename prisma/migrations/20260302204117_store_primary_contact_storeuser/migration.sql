-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "primaryContactStoreUserId" INTEGER;

-- CreateIndex
CREATE INDEX "Store_primaryContactStoreUserId_idx" ON "Store"("primaryContactStoreUserId");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_primaryContactStoreUserId_fkey" FOREIGN KEY ("primaryContactStoreUserId") REFERENCES "StoreUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
