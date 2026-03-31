-- CreateEnum
CREATE TYPE "PromoItemType" AS ENUM ('visit', 'any_purchase', 'single_product', 'product_bundle');

-- CreateEnum
CREATE TYPE "PromoMechanic" AS ENUM ('stamps', 'points');

-- CreateEnum
CREATE TYPE "PromoRewardType" AS ENUM ('free_item', 'discount_pct', 'discount_fixed', 'custom');

-- CreateEnum
CREATE TYPE "OfferSetScope" AS ENUM ('merchant', 'store');

-- CreateEnum
CREATE TYPE "PromoStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "OfferSetStatus" AS ENUM ('draft', 'active', 'expired', 'archived');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('pending', 'granted', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "PromoItem" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "type" "PromoItemType" NOT NULL,
    "status" "PromoStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoItemSku" (
    "id" SERIAL NOT NULL,
    "promoItemId" INTEGER NOT NULL,
    "sku" VARCHAR(100) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PromoItemSku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "mechanic" "PromoMechanic" NOT NULL,
    "earnPerUnit" INTEGER NOT NULL DEFAULT 1,
    "threshold" INTEGER NOT NULL,
    "maxGrantsPerVisit" INTEGER,
    "rewardType" "PromoRewardType" NOT NULL,
    "rewardValue" INTEGER,
    "rewardSku" VARCHAR(100),
    "rewardNote" VARCHAR(500),
    "status" "PromoStatus" NOT NULL DEFAULT 'active',
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionItem" (
    "promotionId" INTEGER NOT NULL,
    "promoItemId" INTEGER NOT NULL,

    CONSTRAINT "PromotionItem_pkey" PRIMARY KEY ("promotionId","promoItemId")
);

-- CreateTable
CREATE TABLE "OfferSet" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "token" VARCHAR(64) NOT NULL,
    "scope" "OfferSetScope" NOT NULL DEFAULT 'merchant',
    "status" "OfferSetStatus" NOT NULL DEFAULT 'draft',
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferSetPromotion" (
    "offerSetId" INTEGER NOT NULL,
    "promotionId" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OfferSetPromotion_pkey" PRIMARY KEY ("offerSetId","promotionId")
);

-- CreateTable
CREATE TABLE "OfferSetStore" (
    "offerSetId" INTEGER NOT NULL,
    "storeId" INTEGER NOT NULL,

    CONSTRAINT "OfferSetStore_pkey" PRIMARY KEY ("offerSetId","storeId")
);

-- CreateTable
CREATE TABLE "ConsumerPromoProgress" (
    "id" SERIAL NOT NULL,
    "consumerId" INTEGER NOT NULL,
    "promotionId" INTEGER NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "stampCount" INTEGER NOT NULL DEFAULT 0,
    "pointBalance" INTEGER NOT NULL DEFAULT 0,
    "milestonesAvailable" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarned" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumerPromoProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoRedemption" (
    "id" SERIAL NOT NULL,
    "progressId" INTEGER NOT NULL,
    "promotionId" INTEGER NOT NULL,
    "consumerId" INTEGER NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "pointsDecremented" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'pending',
    "redemptionToken" VARCHAR(64),
    "redemptionTokenExpiresAt" TIMESTAMP(3),
    "grantedAt" TIMESTAMP(3),
    "grantedByUserId" INTEGER,
    "grantedByStoreId" INTEGER,
    "grantNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromoItem_merchantId_status_idx" ON "PromoItem"("merchantId", "status");

-- CreateIndex
CREATE INDEX "PromoItemSku_promoItemId_idx" ON "PromoItemSku"("promoItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoItemSku_promoItemId_sku_key" ON "PromoItemSku"("promoItemId", "sku");

-- CreateIndex
CREATE INDEX "Promotion_merchantId_status_idx" ON "Promotion"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OfferSet_token_key" ON "OfferSet"("token");

-- CreateIndex
CREATE INDEX "OfferSet_merchantId_status_idx" ON "OfferSet"("merchantId", "status");

-- CreateIndex
CREATE INDEX "OfferSet_token_idx" ON "OfferSet"("token");

-- CreateIndex
CREATE INDEX "OfferSetPromotion_offerSetId_sortOrder_idx" ON "OfferSetPromotion"("offerSetId", "sortOrder");

-- CreateIndex
CREATE INDEX "ConsumerPromoProgress_merchantId_idx" ON "ConsumerPromoProgress"("merchantId");

-- CreateIndex
CREATE INDEX "ConsumerPromoProgress_promotionId_idx" ON "ConsumerPromoProgress"("promotionId");

-- CreateIndex
CREATE INDEX "ConsumerPromoProgress_consumerId_milestonesAvailable_idx" ON "ConsumerPromoProgress"("consumerId", "milestonesAvailable");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumerPromoProgress_consumerId_promotionId_key" ON "ConsumerPromoProgress"("consumerId", "promotionId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoRedemption_redemptionToken_key" ON "PromoRedemption"("redemptionToken");

-- CreateIndex
CREATE INDEX "PromoRedemption_consumerId_status_idx" ON "PromoRedemption"("consumerId", "status");

-- CreateIndex
CREATE INDEX "PromoRedemption_merchantId_status_idx" ON "PromoRedemption"("merchantId", "status");

-- CreateIndex
CREATE INDEX "PromoRedemption_progressId_idx" ON "PromoRedemption"("progressId");

-- CreateIndex
CREATE INDEX "PromoRedemption_redemptionToken_idx" ON "PromoRedemption"("redemptionToken");

-- AddForeignKey
ALTER TABLE "PromoItem" ADD CONSTRAINT "PromoItem_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoItemSku" ADD CONSTRAINT "PromoItemSku_promoItemId_fkey" FOREIGN KEY ("promoItemId") REFERENCES "PromoItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionItem" ADD CONSTRAINT "PromotionItem_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionItem" ADD CONSTRAINT "PromotionItem_promoItemId_fkey" FOREIGN KEY ("promoItemId") REFERENCES "PromoItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferSet" ADD CONSTRAINT "OfferSet_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferSetPromotion" ADD CONSTRAINT "OfferSetPromotion_offerSetId_fkey" FOREIGN KEY ("offerSetId") REFERENCES "OfferSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferSetPromotion" ADD CONSTRAINT "OfferSetPromotion_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferSetStore" ADD CONSTRAINT "OfferSetStore_offerSetId_fkey" FOREIGN KEY ("offerSetId") REFERENCES "OfferSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferSetStore" ADD CONSTRAINT "OfferSetStore_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumerPromoProgress" ADD CONSTRAINT "ConsumerPromoProgress_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "Consumer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumerPromoProgress" ADD CONSTRAINT "ConsumerPromoProgress_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumerPromoProgress" ADD CONSTRAINT "ConsumerPromoProgress_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_progressId_fkey" FOREIGN KEY ("progressId") REFERENCES "ConsumerPromoProgress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "Consumer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_grantedByStoreId_fkey" FOREIGN KEY ("grantedByStoreId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
