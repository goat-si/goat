export type Telemetry<A> =
  | { readonly status: "available"; readonly value: A }
  | { readonly status: "missing"; readonly reason: string };

export const available = <A>(value: A): Telemetry<A> => ({ status: "available", value });
export const missing = (reason: string): Telemetry<never> => ({ status: "missing", reason });

export interface Distribution {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export interface OperationMeasurements {
  offered: number;
  completed: number;
  failed: number;
  errors: string[];
}

/** Nearest-rank percentiles include every completed operation, including failures. */
export function distribution(samples: ReadonlyArray<number>): Telemetry<Distribution> {
  if (samples.length === 0) return missing("No samples collected");
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    return missing("Samples contain a negative or non-finite value");
  }
  const sorted = samples.toSorted((a, b) => a - b);
  const rank = (percentile: number) => sorted[Math.ceil(sorted.length * percentile) - 1] ?? 0;
  return available({
    count: sorted.length,
    p50Ms: rank(0.5),
    p95Ms: rank(0.95),
    p99Ms: rank(0.99),
    maxMs: sorted.at(-1) ?? 0,
  });
}

export function shortTable(
  rows: ReadonlyArray<readonly [string, Telemetry<Distribution>]>,
  operations: Readonly<Record<string, OperationMeasurements>> = {},
): string {
  const lines = ["Measurement                 count    p50 ms    p95 ms    p99 ms    max ms"];
  for (const [name, measurement] of rows) {
    if (measurement.status === "missing") {
      lines.push(`${name}: MISSING (${measurement.reason})`);
      continue;
    }
    const row = measurement.value;
    lines.push(
      `${name.padEnd(28)}${String(row.count).padStart(5)}${[row.p50Ms, row.p95Ms, row.p99Ms, row.maxMs].map((value) => value.toFixed(2).padStart(10)).join("")}`,
    );
  }
  for (const [name, counters] of Object.entries(operations)) {
    lines.push(
      `${name}: offered=${counters.offered} completed=${counters.completed} failed=${counters.failed}`,
    );
    for (const error of counters.errors) lines.push(`  ERROR: ${error}`);
  }
  return lines.join("\n");
}
