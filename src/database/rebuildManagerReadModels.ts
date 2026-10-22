import "dotenv/config";
import { prisma } from "./client.js";
import { enqueue, seasonState } from "../analytics/store.js";
try {
  const { season } = await seasonState();
  const latest =
    (await prisma.events.aggregate({ _max: { id: true } }))._max.id ?? 0;
  const selected = process.argv
    .find((a) => a.startsWith("--gw="))
    ?.split("=")[1];
  const gw = selected ? Number(selected) : undefined;
  if (gw !== undefined && (!Number.isInteger(gw) || gw < 1 || gw > latest))
    throw new Error("Invalid --gw value");
  const ranges =
    gw !== undefined
      ? [gw]
      : process.argv.includes("--latest")
        ? [latest]
        : Array.from({ length: latest }, (_, i) => i + 1);
  for (const end of ranges)
    if (end > 0)
      await enqueue({
        key: `benchmark:${season}:${end}`,
        kind: "benchmark",
        season,
        start: end,
        end,
      });
  console.info(
    JSON.stringify({ event: "benchmarks_enqueued", season, gameweeks: ranges }),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
