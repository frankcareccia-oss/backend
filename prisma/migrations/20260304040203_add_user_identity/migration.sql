-- AlterTable
ALTER TABLE "User" ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "phoneCountry" TEXT NOT NULL DEFAULT 'US',
ADD COLUMN     "phoneE164" VARCHAR(20),
ADD COLUMN     "phoneRaw" TEXT;
