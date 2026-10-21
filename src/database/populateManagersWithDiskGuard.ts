import "dotenv/config";
import { statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// The production database and API share the root filesystem. Manager sample
// rebuilds can spill gigabytes of temporary data; preserve room for PostgreSQL
// recovery and checkpoints rather than starting another ingest on a full disk.
const minimumFreeBytes = 4 * 1024 ** 3;
const disk = statfsSync("/");
const freeBytes = disk.bavail * disk.bsize;
if (freeBytes < minimumFreeBytes) {
  console.warn(
    `[populateManagers] Skipped: ${(freeBytes / 1024 ** 3).toFixed(1)} GiB free; ` +
      "at least 4 GiB required on the production root filesystem.",
  );
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  ["dist/database/populateManagers.js"],
  {
    stdio: "inherit",
  },
);
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
