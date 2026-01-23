/*
  Warnings:

  - A unique constraint covering the columns `[phoneE164]` on the table `Consumer` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Consumer_phoneE164_key" ON "Consumer"("phoneE164");
