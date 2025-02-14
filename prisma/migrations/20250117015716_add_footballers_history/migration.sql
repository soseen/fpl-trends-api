/*
  Warnings:

  - You are about to drop the column `footballer_id` on the `history` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[element,fixture]` on the table `history` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `element` to the `history` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "history" DROP CONSTRAINT "fk_footballer";

-- AlterTable
ALTER TABLE "history" DROP COLUMN "footballer_id",
ADD COLUMN     "element" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "history_element_fixture_key" ON "history"("element", "fixture");

-- AddForeignKey
ALTER TABLE "history" ADD CONSTRAINT "history_element_fkey" FOREIGN KEY ("element") REFERENCES "footballers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
