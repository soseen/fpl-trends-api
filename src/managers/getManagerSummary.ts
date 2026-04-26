import { fetchEntrySummary } from "./fetchManager.js";
import type { EntrySummary } from "./types.js";

export type ManagerSummaryResponse = {
  entry_id: number;
  name: string;
  player_first_name: string;
  player_last_name: string;
  total_points: number | null;
  overall_rank: number | null;
  current_event: number | null;
};

const toResponse = (e: EntrySummary): ManagerSummaryResponse => ({
  entry_id: e.id,
  name: e.name,
  player_first_name: e.player_first_name,
  player_last_name: e.player_last_name,
  total_points: e.summary_overall_points,
  overall_rank: e.summary_overall_rank,
  current_event: e.current_event,
});

export const getManagerSummary = async (
  entryId: number,
): Promise<ManagerSummaryResponse> => {
  const entry = await fetchEntrySummary(entryId);
  return toResponse(entry);
};
