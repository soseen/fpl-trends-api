import { prisma } from "../database/client.js";
import type { EntryEventPick } from "./fetchPicks.js";

type PersistablePick = Pick<
  EntryEventPick,
  "element" | "position" | "multiplier" | "is_captain" | "is_vice_captain"
>;

export const persistPickElements = async (
  entryId: number,
  gw: number,
  picks: ReadonlyArray<PersistablePick>,
): Promise<void> => {
  if (picks.length === 0) return;

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

  await prisma.$executeRawUnsafe(
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
};
