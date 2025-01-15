export type GameweekData = {
    Player_ID: string;
} & GameweekEvent;
  
export type Blacklist = {
    ID: Number;
    Reason: string;
}

export type GameweekEvent = {
    event: number;
    points: number;
    total_points: number;
    rank: number;
    rank_sort: number;
    overall_rank: number;
    percentile_rank: number;
    bank: number;
    value: number;
    event_transfers: number;
    event_transfers_cost: number;
    points_on_bench: number;
};

export type PastSeason = {
    season_name: string;
    total_points: number;
    rank: number;
};

export type Chip = {
    name: string;
    time: string;
    event: number;
};

export type PlayerHistory = {
    current: GameweekEvent[]; // Array of gameweek events
    past: PastSeason[]; // Array of past season performances
    chips: Chip[]; // Array of chips played
};
  