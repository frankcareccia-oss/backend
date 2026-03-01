-- CreateTable
CREATE TABLE "PosCredential" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "pinHash" VARCHAR(255) NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSetupToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosSetupToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosCredential_userId_key" ON "PosCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PosSetupToken_tokenHash_key" ON "PosSetupToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PosSetupToken_userId_idx" ON "PosSetupToken"("userId");

-- CreateIndex
CREATE INDEX "PosSetupToken_expiresAt_idx" ON "PosSetupToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "PosCredential" ADD CONSTRAINT "PosCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSetupToken" ADD CONSTRAINT "PosSetupToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

