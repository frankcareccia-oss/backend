-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceIdHash" VARCHAR(255) NOT NULL,
    "label" VARCHAR(120),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceVerifyToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceIdHash" VARCHAR(255) NOT NULL,
    "tokenHash" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceVerifyToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrustedDevice_userId_idx" ON "TrustedDevice"("userId");

-- CreateIndex
CREATE INDEX "TrustedDevice_expiresAt_idx" ON "TrustedDevice"("expiresAt");

-- CreateIndex
CREATE INDEX "TrustedDevice_revokedAt_idx" ON "TrustedDevice"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_userId_deviceIdHash_key" ON "TrustedDevice"("userId", "deviceIdHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceVerifyToken_tokenHash_key" ON "DeviceVerifyToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DeviceVerifyToken_userId_idx" ON "DeviceVerifyToken"("userId");

-- CreateIndex
CREATE INDEX "DeviceVerifyToken_expiresAt_idx" ON "DeviceVerifyToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceVerifyToken" ADD CONSTRAINT "DeviceVerifyToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
