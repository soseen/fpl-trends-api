-- DropIndex
DROP INDEX IF EXISTS "manager_cumulative_stratum_rejected_gw_idx";

-- DropIndex
DROP INDEX IF EXISTS "manager_summary_rejected_reason_idx";

-- AlterTable
ALTER TABLE "manager_cumulative" DROP COLUMN IF EXISTS "rejected_reason";

-- AlterTable
ALTER TABLE "manager_summary" DROP COLUMN IF EXISTS "rejected_reason",
ALTER COLUMN "last_updated" DROP DEFAULT;

-- AlterTable
ALTER TABLE "stratum_captain_picks_gw" DROP COLUMN IF EXISTS "active_picks",
ALTER COLUMN "last_rebuilt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "stratum_gw_running_stats" (
    "stratum" INTEGER NOT NULL,
    "gw" INTEGER NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "sum_cum_points" BIGINT NOT NULL,
    "sum_cum_transfers" BIGINT NOT NULL,
    "sum_cum_hits_cost" BIGINT NOT NULL,
    "sum_cum_bench" BIGINT NOT NULL,
    "sum_cum_captain_bonus" BIGINT NOT NULL,
    "sum_gws_played" BIGINT NOT NULL,
    "count_with_transfers" INTEGER NOT NULL,
    "count_with_hits" INTEGER NOT NULL,
    "count_with_bench" INTEGER NOT NULL,
    "cum_wildcards_h1" INTEGER NOT NULL,
    "cum_wildcards_h2" INTEGER NOT NULL,
    "cum_freehits_h1" INTEGER NOT NULL,
    "cum_freehits_h2" INTEGER NOT NULL,
    "cum_bboosts_h1" INTEGER NOT NULL,
    "cum_bboosts_h2" INTEGER NOT NULL,
    "last_rebuilt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stratum_gw_running_stats_pkey" PRIMARY KEY ("stratum","gw")
);
