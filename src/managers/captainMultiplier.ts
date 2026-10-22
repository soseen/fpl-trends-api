// Rates use the whole comparison population; condition the TC share on those
// who actually captained this player before taking the mean multiplier.
export const conditionalCaptainMultiplier = (
  rates: { cap_rate: number; tc_rate: number } | undefined,
): number => {
  const captained = (rates?.cap_rate ?? 0) + (rates?.tc_rate ?? 0);
  return captained > 0 ? 2 + (rates?.tc_rate ?? 0) / captained : 2;
};
