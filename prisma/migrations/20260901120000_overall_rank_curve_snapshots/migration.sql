CREATE TABLE "overall_rank_curve_snapshots" (
    "gw"               INTEGER   NOT NULL,
    "captured_at"      TIMESTAMP(3) NOT NULL,
    "is_final"         BOOLEAN   NOT NULL,
    "pages_requested"  INTEGER   NOT NULL,
    "pages_sampled"    INTEGER   NOT NULL,
    "managers_sampled" INTEGER   NOT NULL,
    "min_rank"         INTEGER   NOT NULL,
    "max_rank"         INTEGER   NOT NULL,

    CONSTRAINT "overall_rank_curve_snapshots_pkey" PRIMARY KEY ("gw")
);

CREATE TABLE "overall_rank_curve_points" (
    "gw"    INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "rank"  INTEGER NOT NULL,

    CONSTRAINT "overall_rank_curve_points_pkey" PRIMARY KEY ("gw", "score")
);

CREATE INDEX "overall_rank_curve_points_gw_rank_idx"
    ON "overall_rank_curve_points"("gw", "rank");

ALTER TABLE "overall_rank_curve_points"
    ADD CONSTRAINT "overall_rank_curve_points_gw_fkey"
    FOREIGN KEY ("gw") REFERENCES "overall_rank_curve_snapshots"("gw")
    ON DELETE CASCADE ON UPDATE CASCADE;
