import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  exposureForPlayerGw,
  populationWeightedCaptainInfo,
} from "./getTeamImpact.js";

const stat = {
  total_points: 23,
  selected: 1_000,
  ranked_count: 10_000,
  goals: 0,
  assists: 0,
  clean_sheets: 0,
  goals_conceded: 0,
  defensive_contribution: 0,
  saves: 0,
  bonus: 0,
  minutes: 90,
};

const emptyExposureInfo = () => ({
  exposures: new Map(),
  perGwSampleSize: new Map<number, number>(),
});

const emptyCaptainInfo = () => ({
  rates: new Map<string, { cap_rate: number; tc_rate: number }>(),
  perGwSampleSize: new Map<number, number>(),
});

void describe("exposureForPlayerGw", () => {
  void it("prefers causal rank-band full-XV exposure when the sample is healthy", () => {
    const result = exposureForPlayerGw(
      449,
      2,
      stat,
      {
        exposures: new Map([
          ["449:2", { ownership_pct: 0.42, eo: 0.85, sample_size: 80 }],
        ]),
        perGwSampleSize: new Map([[2, 80]]),
      },
      {
        rates: new Map([["449:2", { cap_rate: 0.7, tc_rate: 0 }]]),
        perGwSampleSize: new Map([[2, 80]]),
      },
      {
        rates: new Map([["449:2", { cap_rate: 0.9, tc_rate: 0 }]]),
        perGwSampleSize: new Map([[2, 1_000]]),
      },
    );

    assert.deepEqual(result, {
      ownershipPct: 0.42,
      eo: 0.85,
      usedRankBandExposure: true,
    });
  });

  void it("uses population-weighted captaincy when rank-band full-XV exposure is light", () => {
    const result = exposureForPlayerGw(
      449,
      2,
      stat,
      emptyExposureInfo(),
      emptyCaptainInfo(),
      {
        rates: new Map([["449:2", { cap_rate: 0.25, tc_rate: 0.01 }]]),
        perGwSampleSize: new Map([[2, 1_000]]),
      },
    );

    assert.equal(result.usedRankBandExposure, false);
    assert.equal(result.ownershipPct, 0.26);
    assert.ok(Math.abs(result.eo - 0.53) < 0.000_001);
  });

  void it("falls back to official ownership when sampled captaincy is also light", () => {
    const result = exposureForPlayerGw(
      449,
      2,
      stat,
      emptyExposureInfo(),
      emptyCaptainInfo(),
      {
        rates: new Map([["449:2", { cap_rate: 0.25, tc_rate: 0.01 }]]),
        perGwSampleSize: new Map([[2, 49]]),
      },
    );

    assert.deepEqual(result, {
      ownershipPct: 0.1,
      eo: 0.1,
      usedRankBandExposure: false,
    });
  });
});

void describe("populationWeightedCaptainInfo", () => {
  void it("weights stratified samples by their real manager populations", () => {
    const rows = [
      // The top strata are deliberately sampled much more densely than the
      // tail. A plain pooled rate would therefore be badly top-heavy.
      {
        gw: 2,
        stratum: 1 as const,
        captain_element: 449,
        captain_multiplier: 2,
        n: 800,
        ranked_count: 1_000_000,
      },
      {
        gw: 2,
        stratum: 1 as const,
        captain_element: 999,
        captain_multiplier: 2,
        n: 200,
        ranked_count: 1_000_000,
      },
      {
        gw: 2,
        stratum: 2 as const,
        captain_element: 449,
        captain_multiplier: 2,
        n: 500,
        ranked_count: 1_000_000,
      },
      {
        gw: 2,
        stratum: 2 as const,
        captain_element: 999,
        captain_multiplier: 2,
        n: 500,
        ranked_count: 1_000_000,
      },
      {
        gw: 2,
        stratum: 3 as const,
        captain_element: 449,
        captain_multiplier: 2,
        n: 10,
        ranked_count: 1_000_000,
      },
      {
        gw: 2,
        stratum: 3 as const,
        captain_element: 999,
        captain_multiplier: 2,
        n: 90,
        ranked_count: 1_000_000,
      },
    ];

    const result = populationWeightedCaptainInfo(rows);

    // 80% of 10k + 50% of 90k + 10% of 900k = 143k of 1m.
    assert.ok(
      Math.abs((result.rates.get("449:2")?.cap_rate ?? 0) - 0.143) < 0.000_001,
    );
    assert.equal(result.perGwSampleSize.get(2), 100);
  });

  void it("rejects a weighted fallback when a populated stratum is absent", () => {
    const result = populationWeightedCaptainInfo([
      {
        gw: 2,
        stratum: 1,
        captain_element: 449,
        captain_multiplier: 2,
        n: 100,
        ranked_count: 1_000_000,
      },
      {
        gw: 2,
        stratum: 2,
        captain_element: 449,
        captain_multiplier: 2,
        n: 100,
        ranked_count: 1_000_000,
      },
    ]);

    assert.equal(result.perGwSampleSize.has(2), false);
    assert.equal(result.rates.size, 0);
  });
});
