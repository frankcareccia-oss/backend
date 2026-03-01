-- Migration: store phone + contact fields
-- Generated to match the current Store schema (contact + phone fields) and remove drift.

ALTER TABLE "Store"
ADD COLUMN     "contactEmail"        VARCHAR(320),
ADD COLUMN     "contactName"         VARCHAR(120),
ADD COLUMN     "contactPhoneCountry" TEXT NOT NULL DEFAULT 'US',
ADD COLUMN     "contactPhoneE164"    VARCHAR(20),
ADD COLUMN     "contactPhoneRaw"     TEXT,
ADD COLUMN     "phoneCountry"        TEXT NOT NULL DEFAULT 'US',
ADD COLUMN     "phoneE164"           VARCHAR(20),
ADD COLUMN     "phoneRaw"            TEXT;

CREATE INDEX "Store_contactPhoneE164_idx" ON "Store"("contactPhoneE164");
CREATE INDEX "Store_phoneE164_idx" ON "Store"("phoneE164");
