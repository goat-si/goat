import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  baseJob,
  fixture,
  killSwitch,
  lidgeGateRunner,
  lidgeRunner,
  removeFixtures,
  refreshWorkflow,
  runnerLabels,
  screenshotWorkflow,
  trustPredicate,
  workflow,
} from "./lib/goat-workflow-guard-fixture.ts";

afterEach(removeFixtures);

const ciRefusal =
  "jobs.ci.runs-on must be ubuntu-24.04, the hosted matrix expression, or the trusted-run lidge matrix expression";

function push(runsOn: unknown) {
  const f = fixture({ workflow: workflow({ ...baseJob, "runs-on": runsOn }) });
  return f.hook(f.record(f.sha));
}

function pushJob(name: string, runsOn: unknown) {
  const f = fixture({
    workflow:
      name === "screenshot-gate"
        ? screenshotWorkflow({ "runs-on": runsOn })
        : JSON.stringify({
            on: { pull_request: null },
            jobs: { ci: baseJob, [name]: { ...baseJob, "runs-on": runsOn } },
          }),
  });
  return f.hook(f.record(f.sha));
}

describe("goat pre-push guard: per-entry matrix runner", () => {
  it("allows the ci matrix on lidge behind the kill switch and the trust test", () => {
    expect(push(lidgeRunner).status).toBe(0);
  });

  it("allows the all-hosted matrix: windows-2025 for the Windows entry, ubuntu-24.04 for the rest", () => {
    expect(
      push("${{ matrix.runner == 'windows' && 'windows-2025' || 'ubuntu-24.04' }}").status,
    ).toBe(0);
  });

  it.each([
    [
      "without the trust test, sending fork pull requests to lidge",
      lidgeRunner.replace(` && ${trustPredicate}`, ""),
    ],
    ["without the kill switch", lidgeRunner.replace(`${killSwitch} && `, "")],
    [
      "trusting any pull request",
      lidgeRunner.replace(
        "github.event.pull_request.head.repo.full_name == github.repository",
        "github.event_name == 'pull_request'",
      ),
    ],
    [
      "a kill switch that defaults on",
      lidgeRunner.replace(killSwitch, "vars.LIDGE_RUNNERS != 'off'"),
    ],
    ["a moving hosted fallback", lidgeRunner.replace("'ubuntu-24.04'", "'ubuntu-latest'")],
    ["a moving Windows image (#1385)", lidgeRunner.replace("'windows-2025'", "'windows-latest'")],
    ["the hosted tasks on lidge too", lidgeRunner.replace("matrix.runner == 'linux' && ", "")],
    ["without its expression wrapper", lidgeRunner.slice(4, -3)],
    ["the static lidge labels", ["self-hosted", "linux", "x64", "lidge"]],
    ["the retired EPYC labels", runnerLabels],
    [
      "the retired trusted-run EPYC expression",
      `\${{ ${trustPredicate} && fromJSON('["self-hosted","linux","x64","goat","epyc"]') || 'ubuntu-24.04' }}`,
    ],
  ])("refuses the ci matrix %s", (_name, runsOn) => {
    const refused = push(runsOn);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(ciRefusal);
  });

  it.each(["scope", "result"])("keeps the matrix expression off jobs.%s", (name) => {
    const refused = pushJob(name, lidgeRunner);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `jobs.${name}.runs-on must be ubuntu-24.04 or the trusted-run lidge gate expression`,
    );
  });
});

describe("goat pre-push guard: gate job runner", () => {
  it.each(["scope", "screenshot-gate", "result"])(
    "allows jobs.%s on lidge behind the kill switch and the trust test",
    (name) => {
      expect(pushJob(name, lidgeGateRunner).status).toBe(0);
    },
  );

  it.each([
    [
      "without the trust test, sending fork pull requests to lidge",
      lidgeGateRunner.replace(` && ${trustPredicate}`, ""),
    ],
    ["without the kill switch", lidgeGateRunner.replace(`${killSwitch} && `, "")],
    [
      "trusting any pull request",
      lidgeGateRunner.replace(
        "github.event.pull_request.head.repo.full_name == github.repository",
        "github.event_name == 'pull_request'",
      ),
    ],
    [
      "a kill switch that defaults on",
      lidgeGateRunner.replace(killSwitch, "vars.LIDGE_RUNNERS != 'off'"),
    ],
    ["a moving hosted fallback", lidgeGateRunner.replace("'ubuntu-24.04'", "'ubuntu-latest'")],
    ["without its expression wrapper", lidgeGateRunner.slice(4, -3)],
    ["the static lidge labels", ["self-hosted", "linux", "x64", "lidge"]],
  ])("refuses a gate job %s", (_name, runsOn) => {
    for (const name of ["scope", "screenshot-gate", "result"]) {
      const refused = pushJob(name, runsOn);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        `jobs.${name}.runs-on must be ubuntu-24.04 or the trusted-run lidge gate expression`,
      );
    }
  });

  it.each([
    ["republish", "jobs.republish.runs-on must be ubuntu-24.04"],
    ["connect-auth-postgres", "PostgreSQL fixtures must run only on the disposable hosted runner"],
  ])("keeps jobs.%s on the hosted image", (name, message) => {
    const refused = pushJob(name, lidgeGateRunner);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(message);
  });

  it("keeps refresh-republished, the Actions writer, on the hosted image", () => {
    const f = fixture({ workflow: refreshWorkflow({ "runs-on": lidgeGateRunner }) });
    const refused = f.hook(f.record(f.sha));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("jobs.refresh-republished must run on ubuntu-24.04");
  });

  it("keeps the gate expression off the ci matrix", () => {
    const refused = push(lidgeGateRunner);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(ciRefusal);
  });
});
