-- Add pv_ar_clerk to SystemRole
ALTER TYPE "SystemRole" ADD VALUE IF NOT EXISTS 'pv_ar_clerk';

-- Rename store_subadmin -> pos_employee in MerchantRole (true rename, preserves data)
ALTER TYPE "MerchantRole" RENAME VALUE 'store_subadmin' TO 'pos_employee';

-- Add merchant_ap_clerk to MerchantRole
ALTER TYPE "MerchantRole" ADD VALUE IF NOT EXISTS 'merchant_ap_clerk';