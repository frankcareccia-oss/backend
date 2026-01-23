-- CreateTable
CREATE TABLE "Consumer" (
    "id" SERIAL NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "phoneRaw" TEXT,
    "phoneE164" VARCHAR(20),
    "phoneCountry" TEXT NOT NULL DEFAULT 'US',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Consumer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "address1" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreQr" (
    "id" SERIAL NOT NULL,
    "storeId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreQr_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Consumer_email_idx" ON "Consumer"("email");

-- CreateIndex
CREATE INDEX "Consumer_phoneE164_idx" ON "Consumer"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "StoreQr_token_key" ON "StoreQr"("token");

-- CreateIndex
CREATE INDEX "StoreQr_storeId_idx" ON "StoreQr"("storeId");

-- CreateIndex
CREATE INDEX "StoreQr_isActive_idx" ON "StoreQr"("isActive");

-- AddForeignKey
ALTER TABLE "StoreQr" ADD CONSTRAINT "StoreQr_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
