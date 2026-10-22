import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";

type ExposureRow = {
  rank_band: number;
  gw: number;
  element_id: number;
  sample_size: number;
  squad_picks: number;
  active_picks: number;
  effective_multiplier_sum: number;
  last_rebuilt: Date;
};

// Opt in against a PostgreSQL database where the test role may create schemas.
// All fixtures live in a unique schema, which is removed after the test.
const testDatabaseUrl = process.env["EXPOSURE_TEST_DATABASE_URL"];

void test(
  "scoped exposure rebuilds match a full rebuild and preserve other gameweeks",
  { skip: !testDatabaseUrl },
  async () => {
    assert.ok(testDatabaseUrl);
    const schema = `fpl_exposure_test_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    const scopedUrl = new URL(testDatabaseUrl);
    scopedUrl.searchParams.set("schema", schema);
    process.env["DATABASE_URL"] = scopedUrl.toString();
    const { prisma } = await import("./client.js");
    const { rebuildRankBandPlayerExposure } = await import(
      "./legacyManagerReadModels.js"
    );

    const read = (): Promise<ExposureRow[]> =>
      prisma.$queryRawUnsafe<ExposureRow[]>(`
        SELECT * FROM rank_band_player_exposure_gw
        ORDER BY gw, rank_band, element_id
      `);
    const values = (rows: ExposureRow[]): Omit<ExposureRow, "last_rebuilt">[] =>
      rows.map(({ last_rebuilt: _timestamp, ...row }) => row);

    try {
      await admin.query(`
        CREATE SCHEMA "${schema}";
        SET search_path TO "${schema}";
        CREATE TABLE events (id int PRIMARY KEY, ranked_count int);
        CREATE TABLE app_metadata (key text PRIMARY KEY, value text);
        CREATE TABLE manager_history (
          entry_id int, gw int, overall_rank int, PRIMARY KEY (entry_id, gw)
        );
        CREATE TABLE manager_picks (
          entry_id int, gw int, sample_stratum int, sampled_at_gw int
        );
        CREATE TABLE manager_pick_elements (
          entry_id int, gw int, element_id int, multiplier int
        );
        CREATE TABLE rank_band_player_exposure_gw (
          rank_band int, gw int, element_id int, sample_size int,
          squad_picks int, active_picks int, effective_multiplier_sum int,
          last_rebuilt timestamptz, PRIMARY KEY (rank_band, gw, element_id)
        );
        INSERT INTO events SELECT gw, 1000000 FROM generate_series(1, 3) gw;
        INSERT INTO manager_history
        SELECT entry_id, gw, overall_rank
        FROM (VALUES (101, 5000), (102, 60000), (103, 500000))
          AS managers(entry_id, overall_rank)
        CROSS JOIN generate_series(1, 3) gw;
        INSERT INTO manager_picks
        SELECT entry_id, gw, stratum, gw
        FROM (VALUES (101, 1), (102, 2), (103, 3)) AS managers(entry_id, stratum)
        CROSS JOIN generate_series(1, 3) gw;
        INSERT INTO manager_pick_elements
        SELECT entry_id, gw, element_id, multiplier
        FROM (VALUES (101, 11, 2), (101, 12, 0), (102, 11, 1),
                     (102, 13, 2), (103, 12, 2), (103, 13, 1))
          AS picks(entry_id, element_id, multiplier)
        CROSS JOIN generate_series(1, 3) gw;
      `);

      await rebuildRankBandPlayerExposure();
      const baseline = await read();
      assert.deepEqual([...new Set(baseline.map((row) => row.gw))], [1, 2, 3]);

      // Include GW1's separate population-weighted branch as well as a later
      // GW's causal branch, and verify that changed multipliers are reflected.
      for (const gw of [3, 1]) {
        const before = await read();
        await prisma.$executeRawUnsafe(
          `UPDATE manager_pick_elements SET multiplier = 3
           WHERE entry_id = 101 AND element_id = 11 AND gw = $1`,
          gw,
        );
        await rebuildRankBandPlayerExposure({ gwOnly: gw });
        const scoped = await read();
        assert.deepEqual(
          scoped.filter((row) => row.gw !== gw),
          before.filter((row) => row.gw !== gw),
          "other gameweeks, including their publication timestamps, stay intact",
        );
        assert.notDeepEqual(
          values(scoped.filter((row) => row.gw === gw)),
          values(before.filter((row) => row.gw === gw)),
          "the selected gameweek incorporates the changed picks",
        );
        await rebuildRankBandPlayerExposure();
        assert.deepEqual(values(scoped), values(await read()));
      }

      // Losing one sampling stratum must remove the outdated selected-GW
      // snapshot while retaining all previously published historical GWs.
      const beforeMissingCoverage = await read();
      await prisma.$executeRawUnsafe(
        "DELETE FROM manager_picks WHERE gw = 3 AND sample_stratum = 2",
      );
      await rebuildRankBandPlayerExposure({ gwOnly: 3 });
      const withoutCoverage = await read();
      assert.deepEqual(
        withoutCoverage,
        beforeMissingCoverage.filter((row) => row.gw !== 3),
      );
      await rebuildRankBandPlayerExposure();
      assert.deepEqual(values(withoutCoverage), values(await read()));
    } finally {
      await prisma.$disconnect();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
