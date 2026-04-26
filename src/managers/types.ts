// Subset of /api/entry/{id}/ response we use.
export type EntrySummary = {
  id: number;
  name: string;
  player_first_name: string;
  player_last_name: string;
  summary_overall_points: number | null;
  summary_overall_rank: number | null;
  summary_event_points: number | null;
  summary_event_rank: number | null;
  current_event: number | null;
};

// Subset of /api/leagues-classic/314/standings/?page_standings=N response.
export type LeagueStandingsResponse = {
  standings: {
    has_next: boolean;
    page: number;
    results: Array<{
      entry: number;
      rank: number;
      total: number;
      player_name: string;
      entry_name: string;
    }>;
  };
};
