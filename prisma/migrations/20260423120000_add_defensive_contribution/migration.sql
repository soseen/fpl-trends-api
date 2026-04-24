-- Add defensive_contribution columns. Nullable so the app still works
-- if FPL ever removes the field (our code already guards on null).

ALTER TABLE "footballers"
  ADD COLUMN "defensive_contribution" INTEGER,
  ADD COLUMN "defensive_contribution_per_90" DOUBLE PRECISION;

ALTER TABLE "history"
  ADD COLUMN "defensive_contribution" INTEGER;
