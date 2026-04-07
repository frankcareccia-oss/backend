-- CreateTable
CREATE TABLE "PosConnection" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "posType" VARCHAR(32) NOT NULL,
    "externalMerchantId" VARCHAR(128) NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosLocationMap" (
    "id" SERIAL NOT NULL,
    "posConnectionId" INTEGER NOT NULL,
    "externalLocationId" VARCHAR(128) NOT NULL,
    "externalLocationName" VARCHAR(255),
    "pvStoreId" INTEGER NOT NULL,
    "pvStoreName" VARCHAR(255),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosLocationMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosConnection_merchantId_idx" ON "PosConnection"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "PosConnection_merchantId_posType_key" ON "PosConnection"("merchantId", "posType");

-- CreateIndex
CREATE INDEX "PosConnection_posType_externalMerchantId_idx" ON "PosConnection"("posType", "externalMerchantId");

-- CreateIndex
CREATE INDEX "PosLocationMap_pvStoreId_idx" ON "PosLocationMap"("pvStoreId");

-- CreateIndex
CREATE INDEX "PosLocationMap_externalLocationId_idx" ON "PosLocationMap"("externalLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "PosLocationMap_posConnectionId_externalLocationId_key" ON "PosLocationMap"("posConnectionId", "externalLocationId");

-- AddForeignKey
ALTER TABLE "PosConnection" ADD CONSTRAINT "PosConnection_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosLocationMap" ADD CONSTRAINT "PosLocationMap_posConnectionId_fkey" FOREIGN KEY ("posConnectionId") REFERENCES "PosConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
