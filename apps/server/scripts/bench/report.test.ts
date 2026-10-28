import { assert, it } from "@effect/vitest";
import { available, distribution, missing, shortTable } from "./report.ts";

it("reports nearest-rank latency percentiles without mutating samples", () => {
  const samples = [100, 1, 3, 2];
  assert.deepEqual(
    distribution(samples),
    available({
      count: 4,
      p50Ms: 2,
      p95Ms: 100,
      p99Ms: 100,
      maxMs: 100,
    }),
  );
  assert.deepEqual(samples, [100, 1, 3, 2]);
  const hundred = distribution(Array.from({ length: 100 }, (_, index) => index + 1));
  assert.deepEqual(hundred, available({ count: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100 }));
});

it("keeps unavailable or invalid telemetry distinct from measured zero", () => {
  assert.equal(distribution([]).status, "missing");
  for (const value of [NaN, Infinity, -1]) assert.equal(distribution([value]).status, "missing");
  assert.deepEqual(
    distribution([0]),
    available({ count: 1, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 }),
  );
  const table = shortTable([
    ["trace", missing("Observer unavailable")],
    ["RPC", distribution([0])],
  ]);
  assert.include(table, "trace: MISSING (Observer unavailable)");
  assert.include(table, "RPC");
  assert.include(table, "0.00");
});
