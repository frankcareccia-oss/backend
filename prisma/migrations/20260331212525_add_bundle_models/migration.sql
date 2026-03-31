-- CreateTable
CREATE TABLE "Bundle" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" "ProductStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleInstance" (
    "id" SERIAL NOT NULL,
    "bundleId" INTEGER NOT NULL,
    "consumerId" INTEGER,
    "remainingUses" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BundleInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bundle_merchantId_status_idx" ON "Bundle"("merchantId", "status");

-- CreateIndex
CREATE INDEX "Bundle_categoryId_idx" ON "Bundle"("categoryId");

-- CreateIndex
CREATE INDEX "BundleInstance_bundleId_idx" ON "BundleInstance"("bundleId");

-- CreateIndex
CREATE INDEX "BundleInstance_consumerId_idx" ON "BundleInstance"("consumerId");

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleInstance" ADD CONSTRAINT "BundleInstance_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
