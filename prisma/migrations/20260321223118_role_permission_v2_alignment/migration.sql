/*
  Warnings:

  - The values [store_admin,store_subadmin] on the enum `MerchantRole` will be removed. If these variants are still used in the database, this will fail.
  - The values [admin,subadmin] on the enum `StorePermissionLevel` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "MerchantRole_new" AS ENUM ('owner', 'merchant_admin', 'ap_clerk', 'merchant_employee');
ALTER TABLE "MerchantUser" ALTER COLUMN "role" TYPE "MerchantRole_new" USING ("role"::text::"MerchantRole_new");
ALTER TYPE "MerchantRole" RENAME TO "MerchantRole_old";
ALTER TYPE "MerchantRole_new" RENAME TO "MerchantRole";
DROP TYPE "public"."MerchantRole_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "StorePermissionLevel_new" AS ENUM ('store_admin', 'store_subadmin', 'pos_access');
ALTER TABLE "public"."StoreUser" ALTER COLUMN "permissionLevel" DROP DEFAULT;
ALTER TABLE "StoreUser" ALTER COLUMN "permissionLevel" TYPE "StorePermissionLevel_new" USING ("permissionLevel"::text::"StorePermissionLevel_new");
ALTER TYPE "StorePermissionLevel" RENAME TO "StorePermissionLevel_old";
ALTER TYPE "StorePermissionLevel_new" RENAME TO "StorePermissionLevel";
DROP TYPE "public"."StorePermissionLevel_old";
ALTER TABLE "StoreUser" ALTER COLUMN "permissionLevel" SET DEFAULT 'store_admin';
COMMIT;

-- AlterTable
ALTER TABLE "StoreUser" ALTER COLUMN "permissionLevel" SET DEFAULT 'store_admin';