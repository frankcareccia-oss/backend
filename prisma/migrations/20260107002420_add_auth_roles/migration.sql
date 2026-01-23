/*
  Warnings:

  - You are about to drop the column `role` on the `User` table. All the data in the column will be lost.
  - Made the column `merchantId` on table `Store` required. This step will fail if there are existing NULL values in that column.
  - Made the column `merchantId` on table `StoreQr` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `passwordHash` to the `User` table without a default value. This is not possible if the table is not empty.
  - Made the column `updatedAt` on table `User` required. This step will fail if there are existing NULL values in that column.
  - Made the column `merchantId` on table `Visit` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('pv_admin', 'user');

-- AlterTable
ALTER TABLE "Store" ALTER COLUMN "merchantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "StoreQr" ALTER COLUMN "merchantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "passwordHash" TEXT NOT NULL,
ADD COLUMN     "systemRole" "SystemRole" NOT NULL DEFAULT 'user',
ALTER COLUMN "updatedAt" SET NOT NULL;

-- AlterTable
ALTER TABLE "Visit" ALTER COLUMN "merchantId" SET NOT NULL;
