// A player's attributable point difference from the comparison cohort.
// EO is represented as a multiplier (106.6% = 1.066), not a percentage.
// The same formula covers starters, captains, benched players, and players
// the manager did not own (multiplier 0).
export const effectivePointExcess = (
  managerMultiplier: number,
  effectiveOwnership: number,
  playerPoints: number,
): number => (managerMultiplier - effectiveOwnership) * playerPoints;
