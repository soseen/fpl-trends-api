import { fetchEntryHistory } from "./fetchManager.js";
import { netPointsForEvent } from "./activityFilter.js";

export type ManagerTrajectoryPoint = {
  gw: number;
  overall_rank: number;
  gw_rank: number;
  points: number;
  total_points: number;
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
    })),
  };
};
