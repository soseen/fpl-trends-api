import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs/promises";
import pg from "pg";
import express from "express";
import { manager, squad } from "./testing/fixtures.js";
import { calculateBenchmark } from "./calculate.js";

const databaseUrl = process.env["ANALYTICS_TEST_DATABASE_URL"];
void test(
  "published analytics pipeline against PostgreSQL",
  { skip: !databaseUrl, timeout: 120_000 },
  async (t) => {
    assert.ok(databaseUrl);
    const url = new URL(databaseUrl);
    assert.match(
      url.pathname,
      /_test(?:$|\/)/,
      "Integration tests require a dedicated *_test database",
    );
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    const schema = `analytics_test_${process.pid}_${Date.now()}`;
    await admin.query(
      `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`,
    );
    // Exercise the actual new migration rather than a hand-maintained imitation.
    for (const table of [
      "app_metadata",
      "events",
      "manager_summary",
      "manager_history",
      "manager_picks",
      "manager_pick_elements",
      "manager_transfers",
      "manager_cumulative",
      "manager_range_score_buckets",
      "stratum_captain_picks_gw",
      "stratum_gw_running_stats",
      "stratum_range_xfer_avg",
      "rank_band_player_exposure_gw",
      "history",
      "footballers",
      "footballer_fixtures",
      "teams",
      "overall_rank_curve_snapshots",
      "overall_rank_curve_points",
    ]) {
      await admin.query(
        `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
    await admin.query(
      "ALTER TABLE manager_picks DROP COLUMN IF EXISTS sample_page",
    );
    await admin.query(
      await fs.readFile(
        new URL(
          "../../prisma/migrations/20261022140000_published_analytics/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await admin.query(
      await fs.readFile(
        new URL(
          "../../prisma/migrations/20261022141000_analytics_source_replay/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    url.searchParams.set("schema", schema);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env["DATABASE_URL"] = url.toString();
    process.env["ANALYTICS_READ_DATABASE_URL"] = url.toString();
    let transferUnavailable = false;
    const fpl = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      const entry = Number(req.url?.match(/entry\/(\d+)/)?.[1] ?? 1);
      if (entry === 404) {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      const facts = [1, 2, 3].map((gw) => ({
        event: gw,
        points: 12,
        total_points: 12 * gw,
        rank: 500,
        rank_sort: 500,
        overall_rank: 5000,
        percentile_rank: 1,
        bank: 0,
        value: 1000,
        event_transfers: 0,
        event_transfers_cost: 0,
        points_on_bench: 0,
      }));
      if (req.url?.includes("/history/"))
        res.end(JSON.stringify({ current: facts, past: [], chips: [] }));
      else if (req.url?.includes("/picks/"))
        res.end(
          JSON.stringify({
            active_chip: null,
            picks: squad().map((p) => ({
              element: p.element,
              position: p.position,
              multiplier: p.multiplier,
              is_captain: p.captain,
              is_vice_captain: p.vice,
            })),
            entry_history: {
              points: 12,
              total_points: 36,
              rank: 500,
              overall_rank: 5000,
            },
          }),
        );
      else if (req.url?.includes("/transfers/")) {
        if (transferUnavailable) {
          res.statusCode = 503;
          res.end("{}");
        } else res.end("[]");
      } else
        res.end(
          JSON.stringify({
            id: entry,
            name: "Fixture",
            player_first_name: "Test",
            player_last_name: "Manager",
            summary_overall_points: 36,
            summary_overall_rank: 5000,
            summary_event_points: 12,
            summary_event_rank: 500,
            current_event: 3,
          }),
        );
    });
    fpl.listen(0, "127.0.0.1");
    await once(fpl, "listening");
    const address = fpl.address();
    assert.ok(address && typeof address !== "string");
    process.env["FPL_API_BASE_URL"] = `http://127.0.0.1:${address.port}/api`;
    const { prisma } = await import("../database/client.js");
    const {
      publishBenchmark,
      enqueue,
      claimJob,
      finishJob,
      loadBenchmarks,
      withBenchmarks,
    } = await import("./store.js");
    const { analyticsRouter, analyticsErrorHandler } = await import(
      "./http.js"
    );
    const { closeReadDatabase } = await import("./readDatabase.js");
    const { prepareManager } = await import("./managerAnalysis.js");
    const { buildBenchmark } = await import("./buildBenchmark.js");
    const { readComparison, readExposure } = await import("./readers.js");
    const app = express();
    app.use("/api/manager", analyticsRouter);
    app.use(analyticsErrorHandler);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = server.address();
    assert.ok(endpoint && typeof endpoint !== "string");
    const base = `http://127.0.0.1:${endpoint.port}/api/manager`;
    try {
      await admin.query(
        `INSERT INTO app_metadata VALUES ('current_season','2026-27'),('bulk_data_refresh_version','fixture'),('manager_sample_gw','3'),('manager_sample_gw_finalized','1')`,
      );
      const historyColumns = (
        await admin.query<{ column_name: string; data_type: string }>(
          `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='history' AND is_nullable='NO' AND column_default IS NULL`,
          [schema],
        )
      ).rows;
      for (let player = 1; player <= 15; player++) {
        const elementType =
          player === 1 || player === 12
            ? 1
            : player <= 5 || player === 13
              ? 2
              : player <= 9 || player === 14
                ? 3
                : 4;
        await admin.query(
          `INSERT INTO footballers(id,web_name,code,element_type,team_code) VALUES ($1,$2,$1,$3,1)`,
          [player, `Player ${player}`, elementType],
        );
        for (let gw = 1; gw <= 3; gw++) {
          const special: Record<string, number> = {
            footballer_id: player,
            fixture_id: gw * 100 + player,
            round: gw,
            total_points: 1,
            minutes: 90,
            selected: 1000,
            opponent_team: 1,
          };
          const values = historyColumns.map(
            (c) =>
              special[c.column_name] ??
              (c.data_type === "boolean"
                ? false
                : c.data_type.includes("timestamp")
                  ? new Date()
                  : c.data_type === "text"
                    ? "0"
                    : 0),
          );
          await admin.query(
            `INSERT INTO history(${historyColumns.map((c) => `"${c.column_name}"`).join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")})`,
            values,
          );
        }
      }
      const required = await admin.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='events' AND is_nullable='NO' AND column_default IS NULL`,
        [schema],
      );
      for (let gw = 1; gw <= 3; gw++) {
        const values = required.rows.map((c) =>
          c.column_name === "id"
            ? gw
            : c.column_name === "ranked_count"
              ? 1_000_000
              : c.column_name === "finished" || c.column_name === "data_checked"
                ? true
                : c.data_type === "boolean"
                  ? false
                  : c.data_type === "character varying"
                    ? `GW${gw}`
                    : 0,
        );
        await admin.query(
          `INSERT INTO events(${required.rows.map((c) => `"${c.column_name}"`).join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")})`,
          values,
        );
        await admin.query(
          `INSERT INTO overall_rank_curve_snapshots(gw,captured_at,is_final,pages_requested,pages_sampled,managers_sampled,min_rank,max_rank) VALUES ($1,now(),true,3,3,150,1,1000000)`,
          [gw],
        );
        await admin.query(
          `INSERT INTO overall_rank_curve_points(gw,score,rank) VALUES ($1,0,1000000),($1,36,5000),($1,60,1)`,
          [gw],
        );
        const snapshot = calculateBenchmark({
          season: "2026-27",
          gw,
          population: 1_000_000,
          generatedAt: new Date().toISOString(),
          sourceRevision: `source-${gw}`,
          finalized: true,
          managers: [manager(1, 1), manager(2, 2), manager(3, 3)],
          points: new Map(),
          minimumCohort: 1,
        });
        await publishBenchmark(snapshot);
      }
      await t.test(
        "atomic publication retains the previous generation after validation fails",
        async () => {
          const before = await loadBenchmarks(1, 3),
            snapshot = before.snapshots.get(3)!;
          await assert.rejects(publishBenchmark({ ...snapshot, ranges: [] }));
          const after = await loadBenchmarks(1, 3);
          assert.equal(after.revision, before.revision);
          await withBenchmarks(before, async () => {
            const comparison = await readComparison(2, 3);
            assert.equal(comparison.top10k.avg_total_points, 25);
            const exposure = await readExposure(new Map([[3, 1]]), [1], 3, 3);
            assert.equal(exposure.exposures.get("1:3")?.eo, 2);
          });
        },
      );
      await t.test(
        "job claims are exclusive and an obsolete lease cannot acknowledge another worker",
        async () => {
          await enqueue({
            key: "claim-a",
            kind: "benchmark",
            season: "2026-27",
            start: 1,
            end: 1,
          });
          await enqueue({
            key: "claim-b",
            kind: "benchmark",
            season: "2026-27",
            start: 2,
            end: 2,
          });
          const [a, b] = await Promise.all([claimJob(), claimJob()]);
          assert.ok(a && b);
          assert.notEqual(a.id, b.id);
          await finishJob({ ...a, lease_token: b.lease_token });
          const pinned = await loadBenchmarks(1, 3);
          await assert.rejects(
            publishBenchmark(pinned.snapshots.get(3)!, undefined, {
              ...a,
              lease_token: b.lease_token,
            }),
          );
          assert.equal((await loadBenchmarks(1, 3)).revision, pinned.revision);
          assert.equal(
            (
              await admin.query<{ status: string }>(
                `SELECT status FROM analytics_jobs WHERE id=$1`,
                [a.id],
              )
            ).rows[0]?.status,
            "running",
          );
          await finishJob(a);
          await finishJob(b);
        },
      );
      await t.test(
        "API queues work, worker hydrates it, and subsequent reads return a validated complete bundle",
        async () => {
          const initial = await fetch(`${base}/1/analysis?start=1&end=3`);
          assert.equal(initial.status, 202);
          const job = await claimJob();
          assert.ok(job);
          await prepareManager(job);
          await finishJob(job);
          const response = await fetch(`${base}/1/analysis?start=1&end=3`);
          assert.equal(response.status, 200);
          const { ReadyAnalysisSchema } = await import(
            "./contracts.generated.js"
          );
          const result = ReadyAnalysisSchema.parse(await response.json());
          assert.equal(result.stale, false);
          for (const [key, section] of Object.entries(result.sections))
            assert.equal(
              section.status,
              "ready",
              `${key}: ${JSON.stringify(section)}`,
            );
          assert.equal(
            result.sections.summary.status === "ready" &&
              result.sections.summary.data.entry_id,
            1,
          );
          assert.ok(result.sections.teamImpact.status === "ready");
          assert.equal(
            result.sections.teamImpact.data.players.reduce(
              (s, p) => s + p.points_for_user,
              0,
            ),
            36,
          );
          assert.ok(
            result.sections.teamImpact.data.totals.rank_per_point !== null,
          );
          const times = await Promise.all(
            Array.from({ length: 20 }, async () => {
              const start = performance.now();
              const read = await fetch(`${base}/1/analysis?start=1&end=3`);
              assert.equal(read.status, 200);
              await read.arrayBuffer();
              return performance.now() - start;
            }),
          );
          times.sort((a, b) => a - b);
          console.info(
            JSON.stringify({
              benchmark: "20 concurrent prepared reads",
              p95Ms: Math.round(times[18] ?? 0),
            }),
          );
          assert.ok(
            (times[18] ?? Infinity) < 2000,
            "Prepared reads exceeded the integration-test latency budget",
          );
          assert.equal(
            (await fetch(`${base}/nope/analysis?start=1&end=3`)).status,
            400,
          );
          assert.equal(
            (await fetch(`${base}/1/analysis?start=1&end=38`)).status,
            400,
          );
        },
      );
      await t.test(
        "benchmark builder reads actual SQL facts and publishes all historical range keys",
        async () => {
          for (const [entry, stratum] of [
            [1, 1],
            [2, 2],
            [3, 3],
          ]) {
            await admin.query(
              `INSERT INTO manager_summary(entry_id,stratum,last_updated,has_transfer_history,has_chip_history) VALUES ($1,$2,now(),true,true)`,
              [entry, stratum],
            );
            for (let gw = 1; gw <= 3; gw++) {
              await admin.query(
                `INSERT INTO manager_history(entry_id,gw,points,overall_rank,event_transfers,event_transfers_cost,points_on_bench) VALUES ($1,$2,12,$3,0,0,0)`,
                [
                  entry,
                  gw,
                  stratum === 1 ? 5000 : stratum === 2 ? 50000 : 500000,
                ],
              );
              await admin.query(
                `INSERT INTO manager_picks(entry_id,gw,captain_element,captain_multiplier,sample_stratum,sampled_at_gw) VALUES ($1,$2,1,2,$3,$2)`,
                [entry, gw, stratum],
              );
            }
            for (const p of squad())
              await admin.query(
                `INSERT INTO manager_pick_elements(entry_id,gw,element_id,position,multiplier,is_captain,is_vice) VALUES ($1,3,$2,$3,$4,$5,$6) ON CONFLICT(entry_id,gw,element_id) DO NOTHING`,
                [entry, p.element, p.position, p.multiplier, p.captain, p.vice],
              );
          }
          await buildBenchmark("2026-27", 3);
          const snapshot = (await loadBenchmarks(1, 3)).snapshots.get(3)!;
          assert.deepEqual(snapshot.sampleCounts, [1, 1, 1]);
          assert.deepEqual(
            snapshot.ranges.map((r) => r.startGw),
            [1, 2, 3],
          );
          assert.equal(
            snapshot.ranges[1]?.buckets.reduce((s, b) => s + b.managers, 0),
            3,
          );
          const { replayBenchmark } = await import("./replay.js");
          const archived = await admin.query<{
            payload: unknown;
            source_payload: Buffer;
          }>(
            `SELECT b.payload,b.source_payload FROM analytics_publications p JOIN analytics_benchmarks b ON p.benchmark_id=b.id WHERE p.gw=3`,
          );
          assert.ok(archived.rows[0]);
          const replay = await replayBenchmark(
            archived.rows[0].payload,
            archived.rows[0].source_payload,
          );
          assert.deepEqual(replay, snapshot);
          const revision = (await loadBenchmarks(1, 3)).revision;
          await buildBenchmark("2026-27", 3);
          assert.equal(
            (await loadBenchmarks(1, 3)).revision,
            revision,
            "Unchanged facts must not republish",
          );
          await admin.query(`UPDATE manager_history SET points=13 WHERE gw=3`);
          await admin.query(
            "UPDATE history SET total_points=2 WHERE footballer_id=2 AND round=3",
          );
          await buildBenchmark("2026-27", 3);
          assert.notEqual(
            (await loadBenchmarks(1, 3)).revision,
            revision,
            "Corrected facts must invalidate the generation",
          );
          const good = (await loadBenchmarks(1, 3)).revision;
          await admin.query(
            `INSERT INTO manager_summary(entry_id,stratum,last_updated,has_chip_history,has_transfer_history) VALUES (4,1,now(),true,true)`,
          );
          await admin.query(
            `INSERT INTO manager_history(entry_id,gw,points,overall_rank,event_transfers,event_transfers_cost,points_on_bench) VALUES (4,3,999,6000,0,0,0)`,
          );
          await admin.query(
            `INSERT INTO manager_picks(entry_id,gw,captain_element,captain_multiplier,sample_stratum,sampled_at_gw) VALUES (4,3,1,2,1,3)`,
          );
          await admin.query(
            `INSERT INTO manager_pick_elements(entry_id,gw,element_id,position,multiplier,is_captain,is_vice) SELECT 4,gw,element_id,position,multiplier,is_captain,is_vice FROM manager_pick_elements WHERE entry_id=1 AND gw=3`,
          );
          await assert.rejects(
            buildBenchmark("2026-27", 3),
            /do not reconcile/,
            "One corrupt score must not enter rank buckets even when enough other squads support EO",
          );
          assert.equal((await loadBenchmarks(1, 3)).revision, good);
          await admin.query(
            "DELETE FROM manager_pick_elements WHERE entry_id=4; DELETE FROM manager_summary WHERE entry_id=4",
          );
          await admin.query("UPDATE manager_history SET points=999 WHERE gw=3");
          await admin.query(
            "UPDATE app_metadata SET value='2' WHERE key='manager_sample_gw_finalized'",
          );
          await buildBenchmark("2026-27", 3);
          assert.equal(
            (await loadBenchmarks(1, 3)).revision,
            good,
            "An incomplete replacement draw must retain the previous usable generation",
          );
          await admin.query(
            "UPDATE app_metadata SET value='1' WHERE key='manager_sample_gw_finalized'",
          );
          await assert.rejects(
            buildBenchmark("2026-27", 3),
            /do not reconcile/,
          );
          assert.equal((await loadBenchmarks(1, 3)).revision, good);
          await admin.query("UPDATE manager_history SET points=13 WHERE gw=3");
        },
      );
      await t.test(
        "expired results remain visible and polling creates one refresh job",
        async () => {
          await admin.query(
            `UPDATE analytics_manager_results SET expires_at=now()-interval '1 minute'`,
          );
          const responses = await Promise.all([
            fetch(`${base}/1/analysis?start=1&end=3`),
            fetch(`${base}/1/analysis?start=1&end=3`),
          ]);
          for (const response of responses) {
            assert.equal(response.status, 200);
            assert.equal(
              ((await response.json()) as { stale: boolean }).stale,
              true,
            );
          }
          assert.equal(
            (
              await admin.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM analytics_jobs WHERE kind='manager' AND status='queued' AND entry_id=1`,
              )
            ).rows[0]?.n,
            1,
          );
          const job = await claimJob();
          assert.ok(job);
          await finishJob(job);
        },
      );
      await t.test(
        "permanent upstream failures surface with a typed error",
        async () => {
          assert.equal(
            (await fetch(`${base}/404/analysis?start=1&end=3`)).status,
            202,
          );
          const job = await claimJob();
          assert.ok(job);
          const { errorInfo } = await import("./errors.js");
          try {
            await prepareManager(job);
            assert.fail("A missing manager must not publish a result");
          } catch (error) {
            const info = errorInfo(error);
            assert.equal(info.code, "manager_not_found");
            assert.equal(info.retryable, false);
            await finishJob(job, info);
          }
          const failed = await fetch(`${base}/404/analysis?start=1&end=3`);
          assert.equal(failed.status, 404);
        },
      );
      await t.test(
        "database deadlines cancel a slow serving query and the pool recovers",
        async () => {
          const { readDatabase } = await import("./readDatabase.js");
          const started = performance.now();
          await assert.rejects(
            readDatabase().query("SELECT pg_sleep(3)"),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "57014",
          );
          assert.ok(performance.now() - started < 2900);
          assert.equal(
            (await readDatabase().query<{ n: number }>("SELECT 1 AS n")).rows[0]
              ?.n,
            1,
          );
        },
      );
      await t.test(
        "partial refresh preserves the last successful transfer section",
        async () => {
          const { ReadyAnalysisSchema } = await import(
            "./contracts.generated.js"
          );
          const before = ReadyAnalysisSchema.parse(
            (
              await admin.query<{ payload: unknown }>(
                "SELECT payload FROM analytics_manager_results WHERE entry_id=1",
              )
            ).rows[0]?.payload,
          );
          await admin.query(
            "UPDATE analytics_manager_sources SET fetched_at=now()-interval '2 minutes' WHERE entry_id=1 AND kind='transfers'",
          );
          transferUnavailable = true;
          try {
            await enqueue({
              key: "partial-refresh",
              kind: "manager",
              season: "2026-27",
              entry: 1,
              start: 1,
              end: 3,
            });
            const job = await claimJob();
            assert.ok(job);
            await prepareManager(job);
            await finishJob(job);
            const after = ReadyAnalysisSchema.parse(
              (
                await admin.query<{ payload: unknown }>(
                  "SELECT payload FROM analytics_manager_results WHERE entry_id=1",
                )
              ).rows[0]?.payload,
            );
            assert.equal(
              after.sectionErrors["transfers"]?.code,
              "incomplete_transfers",
            );
            assert.deepEqual(
              after.sections.transfers,
              before.sections.transfers,
            );
            assert.equal(
              after.sectionGeneratedAt["transfers"],
              before.sectionGeneratedAt["transfers"],
            );
            assert.equal(after.sections.summary.status, "ready");
          } finally {
            transferUnavailable = false;
          }
        },
      );
      await t.test(
        "working-fact pruning refuses incomplete replay coverage",
        async () => {
          const { pruneWorkingFacts } = await import("./retention.js");
          await assert.rejects(
            pruneWorkingFacts(true),
            /all gameweeks must have finalized replay archives/,
          );
          assert.equal(
            (
              await admin.query<{ n: number }>(
                "SELECT COUNT(*)::int AS n FROM manager_summary",
              )
            ).rows[0]?.n,
            3,
          );
        },
      );
      await t.test(
        "saved analysis survives a simulated storage-write failure",
        async () => {
          await admin.query(`CREATE FUNCTION fail_analytics_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated storage exhaustion' USING ERRCODE='53100'; END $$;
          CREATE TRIGGER fail_enqueue BEFORE INSERT OR UPDATE ON analytics_jobs FOR EACH STATEMENT EXECUTE FUNCTION fail_analytics_enqueue()`);
          try {
            const saved = await fetch(
              `${base}/1/analysis?start=1&end=3&refresh=true`,
            );
            assert.equal(saved.status, 200);
            const { ReadyAnalysisSchema } = await import(
              "./contracts.generated.js"
            );
            const data = ReadyAnalysisSchema.parse(await saved.json());
            assert.equal(data.stale, true);
            assert.equal(
              data.sectionErrors["refresh"]?.code,
              "database_unavailable",
            );
            assert.equal(data.sections.summary.status, "ready");
            assert.equal(
              (await fetch(`${base}/222/analysis?start=1&end=3`)).status,
              503,
            );
          } finally {
            await admin.query(
              "DROP TRIGGER fail_enqueue ON analytics_jobs; DROP FUNCTION fail_analytics_enqueue()",
            );
          }
        },
      );
      await t.test(
        "fixture replacement uses natural keys, handles postponed games and rolls back failed batches",
        async () => {
          const { replaceFootballersFixtures } = await import(
            "../database/insertFootballersFixtures.js"
          );
          await admin.query(
            "ALTER TABLE footballer_fixtures ADD FOREIGN KEY(footballer_id) REFERENCES footballers(id)",
          );
          await admin.query(
            "INSERT INTO footballer_fixtures(id,footballer_id,fixture_id,difficulty) VALUES (10,1,900,1),(900,2,901,1)",
          );
          const fixture = {
            id: 900,
            is_home: true,
            difficulty: 3,
            team_h: 1,
            team_h_score: null,
            team_a: 2,
            team_a_score: null,
            event: 4,
            finished: false,
            minutes: 0,
            provisional_start_time: false,
            kickoff_time: "2026-10-24T14:00:00Z",
            event_name: "Gameweek 4",
          };
          const snapshot = {
            "1": { fixtures: [fixture] },
            "2": {
              fixtures: [
                {
                  ...fixture,
                  is_home: false,
                  event: null,
                  kickoff_time: null,
                  event_name: null,
                },
              ],
            },
          };
          await replaceFootballersFixtures(snapshot);
          const before = (
            await admin.query(
              "SELECT * FROM footballer_fixtures ORDER BY footballer_id,fixture_id",
            )
          ).rows;
          assert.equal(before.length, 2);
          assert.equal(
            before[0]["id"],
            10,
            "Existing player/fixture IDs must remain stable",
          );
          assert.equal(
            before[1]["fixture_id"],
            900,
            "Stale membership must be removed even when its serial ID equals a wanted FPL ID",
          );
          assert.equal(before[1]["kickoff_time"], null);
          await replaceFootballersFixtures(snapshot);
          assert.deepEqual(
            (
              await admin.query(
                "SELECT * FROM footballer_fixtures ORDER BY footballer_id,fixture_id",
              )
            ).rows,
            before,
          );
          const invalid = {
            "1": {
              fixtures: [
                { ...fixture, difficulty: 5 },
                ...Array.from({ length: 499 }, (_, i) => ({
                  ...fixture,
                  id: 1000 + i,
                })),
              ],
            },
            "999999": { fixtures: [fixture] },
          };
          await assert.rejects(replaceFootballersFixtures(invalid));
          assert.deepEqual(
            (
              await admin.query(
                "SELECT * FROM footballer_fixtures ORDER BY footballer_id,fixture_id",
              )
            ).rows,
            before,
            "A later batch failure must roll back updates, inserts and deletions",
          );
          await assert.rejects(
            replaceFootballersFixtures({}),
            /Empty player snapshot/,
          );
          await assert.rejects(
            replaceFootballersFixtures({
              "1": { fixtures: [fixture, fixture] },
            }),
            /Duplicate player fixture/,
          );
        },
      );
      await t.test(
        "bulk refresh locks exclude competing callers and release after failure",
        async () => {
          const { withBulkRefreshLock } = await import(
            "../database/bulkRefreshLock.js"
          );
          let release = () => {};
          const hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          let started = () => {};
          const ready = new Promise<void>((resolve) => {
            started = resolve;
          });
          const first = withBulkRefreshLock(async () => {
            started();
            await hold;
          });
          try {
            await ready;
            assert.equal(
              await withBulkRefreshLock(() => {
                throw new Error("Competing refresh must not execute");
              }),
              false,
            );
          } finally {
            release();
            await first;
          }
          await assert.rejects(
            withBulkRefreshLock(() => {
              throw new Error("Failed refresh");
            }),
            /Failed refresh/,
          );
          assert.equal(await withBulkRefreshLock(async () => {}), true);
        },
      );
      await t.test(
        "manager reset retires jobs and cached results while retaining replay archives",
        async () => {
          const { resetManagerAnalytics } = await import(
            "../database/resetManagerAnalytics.js"
          );
          const before = (
            await admin.query<{ n: number }>(
              "SELECT count(*)::int n FROM analytics_benchmarks",
            )
          ).rows[0]!.n;
          assert.ok(before > 0);
          await resetManagerAnalytics();
          for (const table of [
            "analytics_jobs",
            "analytics_manager_results",
            "analytics_manager_sources",
            "analytics_publications",
            "manager_summary",
          ])
            assert.equal(
              (
                await admin.query<{ n: number }>(
                  `SELECT count(*)::int n FROM ${table}`,
                )
              ).rows[0]!.n,
              0,
              table,
            );
          assert.equal(
            (
              await admin.query<{ n: number }>(
                "SELECT count(*)::int n FROM analytics_benchmarks",
              )
            ).rows[0]!.n,
            before,
          );
        },
      );
    } finally {
      await closeReadDatabase();
      await prisma.$disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => fpl.close(() => resolve()));
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
