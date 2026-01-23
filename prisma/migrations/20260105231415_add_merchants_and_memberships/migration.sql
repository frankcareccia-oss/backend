/*
  Warnings:

  - You are about to drop the column `isActive` on the `StoreQr` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('active', 'suspended', 'archived');

-- CreateEnum
CREATE TYPE "MerchantRole" AS ENUM ('owner', 'merchant_admin', 'store_admin', 'store_subadmin');

-- CreateEnum
CREATE TYPE "StorePermissionLevel" AS ENUM ('admin', 'subadmin');

-- CreateEnum
CREATE TYPE "VisitSource" AS ENUM ('qr_scan', 'manual', 'import');

-- DropForeignKey
ALTER TABLE "StoreQr" DROP CONSTRAINT "StoreQr_storeId_fkey";

-- DropForeignKey
ALTER TABLE "Visit" DROP CONSTRAINT "Visit_consumerId_fkey";

-- DropForeignKey
ALTER TABLE "Visit" DROP CONSTRAINT "Visit_qrId_fkey";

-- DropIndex
DROP INDEX "StoreQr_isActive_idx";

-- AlterTable
ALTER TABLE "Consumer" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "status" "EntityStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "merchantId" INTEGER,
ADD COLUMN     "status" "EntityStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "statusReason" TEXT,
ADD COLUMN     "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "StoreQr" DROP COLUMN "isActive",
ADD COLUMN     "merchantId" INTEGER,
ADD COLUMN     "status" "EntityStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "status" "EntityStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "merchantId" INTEGER,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "source" "VisitSource" NOT NULL DEFAULT 'qr_scan';

-- CreateTable
CREATE TABLE "Merchant" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "suspendedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "statusReason" TEXT,
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantUser" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "MerchantRole" NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "suspendedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "statusReason" TEXT,
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreUser" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "merchantUserId" INTEGER NOT NULL,
    "permissionLevel" "StorePermissionLevel" NOT NULL DEFAULT 'admin',
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "suspendedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "statusReason" TEXT,
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumerPhone" (
    "id" SERIAL NOT NULL,
    "consumerId" INTEGER NOT NULL,
    "phoneE164" VARCHAR(20) NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumerPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantConsumer" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "consumerId" INTEGER NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "suspendedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "statusReason" TEXT,
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantConsumer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreConsumer" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "consumerId" INTEGER NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'active',
    "suspendedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "statusReason" TEXT,
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "associatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreConsumer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Merchant_status_idx" ON "Merchant"("status");

-- CreateIndex
CREATE INDEX "MerchantUser_merchantId_idx" ON "MerchantUser"("merchantId");

-- CreateIndex
CREATE INDEX "MerchantUser_userId_idx" ON "MerchantUser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantUser_merchantId_userId_key" ON "MerchantUser"("merchantId", "userId");

-- CreateIndex
CREATE INDEX "StoreUser_storeId_idx" ON "StoreUser"("storeId");

-- CreateIndex
CREATE INDEX "StoreUser_merchantUserId_idx" ON "StoreUser"("merchantUserId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreUser_storeId_merchantUserId_key" ON "StoreUser"("storeId", "merchantUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumerPhone_phoneE164_key" ON "ConsumerPhone"("phoneE164");

-- CreateIndex
CREATE INDEX "ConsumerPhone_consumerId_idx" ON "ConsumerPhone"("consumerId");

-- CreateIndex
CREATE INDEX "ConsumerPhone_isPrimary_idx" ON "ConsumerPhone"("isPrimary");

-- CreateIndex
CREATE INDEX "MerchantConsumer_merchantId_idx" ON "MerchantConsumer"("merchantId");

-- CreateIndex
CREATE INDEX "MerchantConsumer_consumerId_idx" ON "MerchantConsumer"("consumerId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantConsumer_merchantId_consumerId_key" ON "MerchantConsumer"("merchantId", "consumerId");

-- CreateIndex
CREATE INDEX "StoreConsumer_storeId_idx" ON "StoreConsumer"("storeId");

-- CreateIndex
CREATE INDEX "StoreConsumer_consumerId_idx" ON "StoreConsumer"("consumerId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreConsumer_storeId_consumerId_key" ON "StoreConsumer"("storeId", "consumerId");

-- CreateIndex
CREATE INDEX "Consumer_status_idx" ON "Consumer"("status");

-- CreateIndex
CREATE INDEX "Store_merchantId_idx" ON "Store"("merchantId");

-- CreateIndex
CREATE INDEX "Store_status_idx" ON "Store"("status");

-- CreateIndex
CREATE INDEX "StoreQr_merchantId_idx" ON "StoreQr"("merchantId");

-- CreateIndex
CREATE INDEX "StoreQr_status_idx" ON "StoreQr"("status");

-- CreateIndex
CREATE INDEX "Visit_merchantId_createdAt_idx" ON "Visit"("merchantId", "createdAt");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantUser" ADD CONSTRAINT "MerchantUser_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantUser" ADD CONSTRAINT "MerchantUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreUser" ADD CONSTRAINT "StoreUser_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreUser" ADD CONSTRAINT "StoreUser_merchantUserId_fkey" FOREIGN KEY ("merchantUserId") REFERENCES "MerchantUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumerPhone" ADD CONSTRAINT "ConsumerPhone_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "Consumer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantConsumer" ADD CONSTRAINT "MerchantConsumer_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantConsumer" ADD CONSTRAINT "MerchantConsumer_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "Consumer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreConsumer" ADD CONSTRAINT "StoreConsumer_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreConsumer" ADD CONSTRAINT "StoreConsumer_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "Consumer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreQr" ADD CONSTRAINT "StoreQr_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreQr" ADD CONSTRAINT "StoreQr_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "Consumer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_qrId_fkey" FOREIGN KEY ("qrId") REFERENCES "StoreQr"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
