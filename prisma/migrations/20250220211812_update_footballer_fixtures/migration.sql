/*
  Warnings:

  - You are about to drop the column `difficulty` on the `fixtures` table. All the data in the column will be lost.
  - You are about to drop the column `is_home` on the `fixtures` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "fixtures" DROP COLUMN "difficulty",
DROP COLUMN "is_home";

-- AlterTable
ALTER TABLE "footballer_fixtures" ADD COLUMN     "difficulty" INTEGER,
ADD COLUMN     "is_home" BOOLEAN;
