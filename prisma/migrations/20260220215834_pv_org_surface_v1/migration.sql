-- CreateEnum
CREATE TYPE "PvDepartment" AS ENUM ('IT', 'FINANCE', 'SUPPORT', 'EXECUTIVE', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SystemRole" ADD VALUE 'pv_support';
ALTER TYPE "SystemRole" ADD VALUE 'pv_qa';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "department" "PvDepartment";
