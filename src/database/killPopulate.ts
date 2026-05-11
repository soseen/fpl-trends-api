import "dotenv/config";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Kill any in-flight populate-managers run by signalling the PID in the
// lockfile and cleaning up. Used by `npm run deploy` to ensure the next
// cron tick picks up the freshly-deployed dist/, rather than letting a
// stale process keep running old code until it finishes.
//
// Non-fatal: always exits 0. Worst case (signal fails / lockfile missing
// / cross-user) the in-flight populate keeps running for one more tick,
// which is the same situation we'd be in without this script.

const LOCKFILE_PATH = path.join(os.tmpdir(), "fpl-populate-managers.lock");
const POLL_INTERVAL_MS = 500;
const SIGTERM_GRACE_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const removeLockfile = (): void => {
  try {
    fs.unlinkSync(LOCKFILE_PATH);
  } catch {
    /* ignore */
  }
};

const main = async (): Promise<void> => {
  let contents: string;
  try {
    contents = fs.readFileSync(LOCKFILE_PATH, "utf8");
  } catch {
    console.info("[killPopulate] No lockfile — nothing to kill.");
    return;
  }

  const pid = parseInt(contents.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    console.info(
      "[killPopulate] Lockfile has unparseable PID — removing and exiting.",
    );
    removeLockfile();
    return;
  }

  if (!isAlive(pid)) {
    console.info(
      `[killPopulate] PID ${pid} is not alive — removing stale lockfile.`,
    );
    removeLockfile();
    return;
  }

  console.info(`[killPopulate] Sending SIGTERM to populate-managers PID ${pid}…`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.warn(
      `[killPopulate] Failed to signal PID ${pid}: ${(err as Error).message}. Skipping.`,
    );
    return;
  }

  const deadline = Date.now() + SIGTERM_GRACE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!isAlive(pid)) {
      console.info(`[killPopulate] PID ${pid} exited cleanly.`);
      removeLockfile();
      return;
    }
  }

  console.warn(
    `[killPopulate] PID ${pid} ignored SIGTERM after ${SIGTERM_GRACE_MS / 1000}s — sending SIGKILL.`,
  );
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    console.warn(
      `[killPopulate] Failed to SIGKILL PID ${pid}: ${(err as Error).message}.`,
    );
  }
  removeLockfile();
};

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.warn("[killPopulate] Non-fatal error:", (err as Error).message);
  }
}
