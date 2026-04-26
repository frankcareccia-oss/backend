-- AlterTable
ALTER TABLE "Consumer" ADD COLUMN IF NOT EXISTS "preferredLocale" VARCHAR(5) NOT NULL DEFAULT 'en';
