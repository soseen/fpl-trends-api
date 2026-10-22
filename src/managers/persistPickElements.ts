import { prisma } from "../database/client.js";
import type { EntryEventPick } from "./fetchPicks.js";
import { validSquad } from "../analytics/model.js";
import { AnalyticsError } from "../analytics/errors.js";

type PersistablePick = Pick<
  EntryEventPick,
  "element" | "position" | "multiplier" | "is_captain" | "is_vice_captain"
>;

export const persistPickElements = async (
  entryId: number,
  gw: number,
  picks: ReadonlyArray<PersistablePick>,
): Promise<void> => {
  if (
    !validSquad(
      picks.map((p) => ({
        element: p.element,
        position: p.position,
        multiplier: p.multiplier,
        captain: p.is_captain,
        vice: p.is_vice_captain,
      })),
    )
  )
    throw new AnalyticsError(
      "invalid_picks",
      "FPL returned an incomplete or invalid squad.",
    );

  const values: unknown[] = [];
  const tuples = picks.map((p, i) => {
    const base = i * 7;
    values.push(
      entryId,
      gw,
      p.element,
      p.position,
      p.multiplier,
      p.is_captain,
      p.is_vice_captain,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM manager_pick_elements WHERE entry_id=${entryId} AND gw=${gw}`;
    await tx.$executeRawUnsafe(
      `
    INSERT INTO manager_pick_elements
      (entry_id, gw, element_id, position, multiplier, is_captain, is_vice)
    VALUES ${tuples.join(", ")}
    ON CONFLICT (entry_id, gw, element_id) DO UPDATE SET
      position = EXCLUDED.position,
      multiplier = EXCLUDED.multiplier,
      is_captain = EXCLUDED.is_captain,
      is_vice = EXCLUDED.is_vice,
      fetched_at = NOW()
    `,
      ...values,
    );
    const [season, event] = await Promise.all([
      tx.app_metadata.findUnique({ where: { key: "current_season" } }),
      tx.events.findUnique({
        where: { id: gw },
        select: { data_checked: true },
      }),
    ]);
    if (season)
      await tx.$executeRaw`INSERT INTO analytics_manager_sources(season,entry_id,kind,payload,finalized) VALUES (${season.value},${entryId},${`picks:${gw}`},${JSON.stringify(picks)}::jsonb,${event?.data_checked ?? false}) ON CONFLICT(season,entry_id,kind) DO UPDATE SET payload=excluded.payload,finalized=excluded.finalized,fetched_at=now()`;
  });
};
