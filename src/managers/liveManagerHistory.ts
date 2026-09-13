import { prisma } from "../database/client.js";
import type { PlayerHistory } from "../types.js";
import { fetchEntryHistory, fetchEntrySummary } from "./fetchManager.js";
import type { EntrySummary } from "./types.js";

// Entry history/picks can still contain yesterday's totals while the entry
// summary and Overall standings already include today's matches. Use the
// summary's coherent points/rank pair for this provisional GW only.
export const withLiveManagerSummary = (
  history: PlayerHistory,
  summary: EntrySummary,
  provisionalGw: number | null,
): PlayerHistory => {
  const points = summary.summary_event_points;
  const totalPoints = summary.summary_overall_points;
  if (
    provisionalGw === null ||
    summary.current_event !== provisionalGw ||
    totalPoints === null ||
    points === null
  )
    return history;

  return {
    ...history,
    current: history.current.map((event) =>
      event.event === provisionalGw
        ? {
            ...event,
            points,
            total_points: totalPoints,
            overall_rank: summary.summary_overall_rank ?? event.overall_rank,
          }
        : event,
    ),
  };
};

export const fetchLiveManagerHistory = async (
  entryId: number,
): Promise<PlayerHistory> => {
  const [history, summary, event] = await Promise.all([
    fetchEntryHistory(entryId),
    fetchEntrySummary(entryId),
    prisma.events.findFirst({
      where: { is_current: true, data_checked: false },
      select: { id: true },
    }),
  ]);
  return withLiveManagerSummary(history, summary, event?.id ?? null);
};
