-- Replace billingAddressJson with flat address fields on BillingAccount
ALTER TABLE "BillingAccount"
  ADD COLUMN "billingAddress1" VARCHAR(200),
  ADD COLUMN "billingCity"     VARCHAR(100),
  ADD COLUMN "billingState"    VARCHAR(50),
  ADD COLUMN "billingPostal"   VARCHAR(20);

ALTER TABLE "BillingAccount" DROP COLUMN "billingAddressJson";
