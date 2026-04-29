import { fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";

export type ManagerTrajectoryPoint = {
  gw: number;
  overall_rank: number;
  gw_rank: number;
  points: number;
  total_points: number;
  // Number of transfers the user made entering this GW. The free first
  // transfer is counted; only `event_transfers_cost` reveals whether any
  // were "hits" (-4 / extra transfer).
  event_transfers: number;
  // Total -4 hits taken this GW (i.e., paid transfer count). 0 = no hits,
  // 4 = one hit, 8 = two hits, etc. Useful for overlaying "did the user
  // take a hit this GW" on the trajectory chart.
  event_transfers_cost: number;
};

export type ManagerTrajectoryResponse = {
  entry_id: number;
  gws: ManagerTrajectoryPoint[];
};

export const getManagerTrajectory = async (
  entryId: number,
): Promise<ManagerTrajectoryResponse> => {
  const history = await fetchEntryHistory(entryId);
  const events = history.current ?? [];
  return {
    entry_id: entryId,
    gws: events.map((ev) => ({
      gw: ev.event,
      overall_rank: ev.overall_rank,
      gw_rank: ev.rank,
      points: netPointsForEvent(ev),
      total_points: ev.total_points,
      event_transfers: ev.event_transfers,
      event_transfers_cost: ev.event_transfers_cost,
    })),
  };
};
