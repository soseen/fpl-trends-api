/*
  Warnings:

  - A unique constraint covering the columns `[id]` on the table `footballers` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "footballers" ALTER COLUMN "id" DROP DEFAULT;
DROP SEQUENCE "footballers_id_seq";

-- CreateIndex
CREATE UNIQUE INDEX "footballers_id_key" ON "footballers"("id");
