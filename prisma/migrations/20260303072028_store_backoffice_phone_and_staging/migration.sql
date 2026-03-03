/*
  Warnings:

  - A unique constraint covering the columns `[posVisitId]` on the table `Visit` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[posIdempotencyKey]` on the table `Visit` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `phoneRaw` to the `Store` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "EntityStatus" ADD VALUE 'staging';

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "backOfficePhoneCountry" TEXT NOT NULL DEFAULT 'US',
ADD COLUMN     "backOfficePhoneE164" VARCHAR(20),
ADD COLUMN     "backOfficePhoneRaw" TEXT,
ADD COLUMN     "phoneCountry" TEXT NOT NULL DEFAULT 'US',
ADD COLUMN     "phoneE164" VARCHAR(20),
ADD COLUMN     "phoneRaw" TEXT NOT NULL,
ADD COLUMN     "primaryContactStoreUserId" INTEGER;

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "posEventId" VARCHAR(64),
ADD COLUMN     "posIdempotencyKey" VARCHAR(128),
ADD COLUMN     "posIdentifier" VARCHAR(320),
ADD COLUMN     "posVisitId" VARCHAR(64);

-- CreateTable
CREATE TABLE "PosReward" (
    "id" VARCHAR(64) NOT NULL,
    "posVisitId" VARCHAR(64),
    "eventId" VARCHAR(64),
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "storeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "identifier" VARCHAR(320) NOT NULL,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosReward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosReward_idempotencyKey_key" ON "PosReward"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PosReward_merchantId_storeId_createdAt_idx" ON "PosReward"("merchantId", "storeId", "createdAt");

-- CreateIndex
CREATE INDEX "PosReward_posVisitId_idx" ON "PosReward"("posVisitId");

-- CreateIndex
CREATE INDEX "Store_phoneE164_idx" ON "Store"("phoneE164");

-- CreateIndex
CREATE INDEX "Store_backOfficePhoneE164_idx" ON "Store"("backOfficePhoneE164");

-- CreateIndex
CREATE INDEX "Store_primaryContactStoreUserId_idx" ON "Store"("primaryContactStoreUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_posVisitId_key" ON "Visit"("posVisitId");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_posIdempotencyKey_key" ON "Visit"("posIdempotencyKey");

-- CreateIndex
CREATE INDEX "Visit_posVisitId_idx" ON "Visit"("posVisitId");

-- CreateIndex
CREATE INDEX "Visit_posIdempotencyKey_idx" ON "Visit"("posIdempotencyKey");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_primaryContactStoreUserId_fkey" FOREIGN KEY ("primaryContactStoreUserId") REFERENCES "StoreUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
