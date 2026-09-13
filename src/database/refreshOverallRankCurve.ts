import "dotenv/config";
import { fileURLToPath } from "node:url";
import { refreshOverallRankCurveSnapshot } from "../managers/rankCurveSnapshot.js";
import { prisma } from "./client.js";

export const refreshCurrentOverallRankCurve = async (): Promise<void> => {
  const event = await prisma.events.findFirst({
    where: { OR: [{ is_current: true }, { finished: true }] },
    orderBy: { id: "desc" },
    select: { id: true, ranked_count: true, data_checked: true },
  });
  if (!event) {
    throw new Error("No current or finished gameweek is available");
  }

  if (event.data_checked) {
    const existing = await prisma.overall_rank_curve_snapshots.findUnique({
      where: { gw: event.id },
      select: { is_final: true },
    });
    if (existing?.is_final) {
      console.info(
        `[refreshOverallRankCurve] GW${event.id} already has a final snapshot.`,
      );
      return;
    }
  }

  const snapshot = await refreshOverallRankCurveSnapshot({
    gw: event.id,
    rankedCount: event.ranked_count,
    isFinal: event.data_checked,
  });
  console.info(
    `[refreshOverallRankCurve] GW${event.id}: ${snapshot.milestones.length} score milestones from ${snapshot.pagesFetched}/${snapshot.pagesRequested} pages (ranks ${snapshot.minRank}-${snapshot.maxRank}, ${snapshot.isFinal ? "final" : "live"}).`,
  );
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await refreshCurrentOverallRankCurve();
  } catch (err) {
    console.error("[refreshOverallRankCurve] Failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
