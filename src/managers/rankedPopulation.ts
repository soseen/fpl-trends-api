// FPL publishes zero ranked_count until its GW standings are processed.
// Keep published historical counts exact; live estimates use the latest
// observed ranked population, or registered entries in the opening GW.
export const rankedPopulationSql = (eventAlias: string): string => `COALESCE(
  NULLIF(${eventAlias}.ranked_count, 0),
  (SELECT MAX(previous_population.ranked_count) FROM events previous_population
   WHERE previous_population.id <= ${eventAlias}.id
     AND previous_population.ranked_count > 0),
  (SELECT NULLIF(value::int, 0) FROM app_metadata
   WHERE key = 'current_total_players'),
  15000000
)`;
