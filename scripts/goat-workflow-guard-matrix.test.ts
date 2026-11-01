import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  baseJob,
  fixture,
  gateJob,
  matrixRunner,
  removeFixtures,
  workflow,
} from "./lib/goat-workflow-guard-fixture.ts";

afterEach(removeFixtures);

describe("goat pre-push guard: per-entry matrix runner", () => {
  it("allows the ci matrix to pick its pool per entry behind the trust test", () => {
    const f = fixture({ workflow: workflow({ ...baseJob, "runs-on": matrixRunner }) });
    expect(f.hook(f.record(f.sha)).status).toBe(0);
  });

  it("refuses a matrix pool that would send fork pull requests to EPYC", () => {
    const untrusted =
      '${{ matrix.runner == \'epyc\' && fromJSON(\'["self-hosted","linux","x64","goat","epyc"]\') || \'ubuntu-24.04\' }}';
    const f = fixture({ workflow: workflow({ ...baseJob, "runs-on": untrusted }) });
    const refused = f.hook(f.record(f.sha));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("jobs.ci.runs-on must be ubuntu-24.04");
  });

  it("allows the Windows entry only on the pinned hosted windows-2025 image (#1385)", () => {
    const windows = (image: string) =>
      matrixRunner.replace("${{ ", "${{ matrix.runner == 'windows' && '" + image + "' || ");
    const pinned = fixture({
      workflow: workflow({ ...baseJob, "runs-on": windows("windows-2025") }),
    });
    expect(pinned.hook(pinned.record(pinned.sha)).status).toBe(0);
    const moving = fixture({
      workflow: workflow({ ...baseJob, "runs-on": windows("windows-latest") }),
    });
    const refused = moving.hook(moving.record(moving.sha));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("jobs.ci.runs-on must be ubuntu-24.04");
  });

  it("keeps gate jobs off the per-entry expression", () => {
    const f = fixture({
      workflow: JSON.stringify({
        on: { pull_request: null },
        jobs: { ci: baseJob, scope: { ...gateJob, "runs-on": matrixRunner } },
      }),
    });
    const refused = f.hook(f.record(f.sha));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("jobs.scope.runs-on must be ubuntu-24.04");
  });
});
