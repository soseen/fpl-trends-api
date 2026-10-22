import type { SampleManager, SquadPick } from "../model.js";
export const squad = (captainMultiplier = 2): SquadPick[] =>
  Array.from({ length: 15 }, (_, i) => ({
    element: i + 1,
    position: i + 1,
    multiplier: i === 0 ? captainMultiplier : i < 11 ? 1 : 0,
    captain: i === 0,
    vice: i === 1,
  }));
export const manager = (entry: number, stratum: 1 | 2 | 3): SampleManager => ({
  entry,
  stratum,
  transfersComplete: true,
  chipsComplete: true,
  facts: [1, 2, 3].map((gw) => ({
    gw,
    points: entry * 10 + gw,
    rank: stratum === 1 ? 5000 : stratum === 2 ? 50000 : 500000,
    transfers: 0,
    hits: 0,
    bench: 0,
    chip: null,
    captain: 1,
  })),
  picks: squad(),
  transfers: [],
});
