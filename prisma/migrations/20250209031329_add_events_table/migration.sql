/*
  Warnings:

  - A unique constraint covering the columns `[id]` on the table `events` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "events" ALTER COLUMN "id" DROP DEFAULT;
DROP SEQUENCE "events_id_seq";

-- CreateIndex
CREATE UNIQUE INDEX "events_id_key" ON "events"("id");
