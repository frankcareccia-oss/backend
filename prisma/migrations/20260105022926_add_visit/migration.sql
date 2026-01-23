-- CreateTable
CREATE TABLE "Visit" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "consumerId" INTEGER,
    "qrId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Visit_storeId_createdAt_idx" ON "Visit"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Visit_consumerId_createdAt_idx" ON "Visit"("consumerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "Consumer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_qrId_fkey" FOREIGN KEY ("qrId") REFERENCES "StoreQr"("id") ON DELETE SET NULL ON UPDATE CASCADE;
