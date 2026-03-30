-- Add PV-assigned account number to BillingAccount
ALTER TABLE "BillingAccount" ADD COLUMN "pvAccountNumber" VARCHAR(50);

CREATE UNIQUE INDEX "BillingAccount_pvAccountNumber_key" ON "BillingAccount"("pvAccountNumber");
