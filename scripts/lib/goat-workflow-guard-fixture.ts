// @effect-diagnostics nodeBuiltinImport:off - builds real git repositories and hook layouts on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

export const sourceRoot = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
export const zero = "0".repeat(40);
export const workflowPath = ".github/workflows/goat-ci.yml";
export const upstreamPath = ".github/workflows/upstream.yaml";
export const runnerLabels = ["self-hosted", "linux", "x64", "goat", "epyc"];
export const baseJob = { "runs-on": runnerLabels, steps: [{ run: "echo ok" }] };
export const trustedRunner =
  '${{ (github.event_name == \'workflow_dispatch\' || github.event.pull_request.head.repo.full_name == github.repository) && fromJSON(\'["self-hosted","linux","x64","goat","epyc"]\') || \'ubuntu-24.04\' }}';
export const lightRunner = trustedRunner.replace('"epyc"]', '"epyc-light"]');
export const gateJob = { ...baseJob, "runs-on": lightRunner };
export const validWorkflow = `on:
  push:
jobs:
  ci:
    runs-on: [self-hosted, linux, x64, goat, epyc]
    steps:
      - run: echo ok
`;
export const yamlRefusal =
  "goat pre-push: repository yaml@2.* is unavailable or unloadable; run vp i; refusing to push";
export const advice =
  "goat pre-push: disable Actions (gh api -X PUT repos/goat-si/goat/actions/permissions -F enabled=false), push, disable the new workflows, then re-enable Actions.";
const temporaryRoots: string[] = [];

function executable(name: string) {
  for (const directory of (NodeProcess.env.PATH ?? "").split(NodePath.delimiter)) {
    const candidate = NodePath.join(directory, name);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // Continue looking for the executable in the host's PATH.
    }
  }
  throw new Error(`test prerequisite unavailable: ${name}`);
}

export const gitExecutable = executable("git");
const yamlStore = NodePath.join(sourceRoot, "node_modules/.pnpm");
const yamlPackageName = NodeFS.readdirSync(yamlStore)
  .filter((name) => name.startsWith("yaml@2."))
  .sort()[0];
if (!yamlPackageName) throw new Error("tests require repository yaml@2.*; run vp i");
const yamlName = yamlPackageName;
export const yamlSource = NodePath.join(yamlStore, yamlName, "node_modules/yaml");

export function workflow(job: unknown = baseJob, on: unknown = { push: null }) {
  return JSON.stringify({ on, jobs: { ci: job } });
}

export const screenshotPermissions = {
  contents: "read",
  issues: "read",
  "pull-requests": "read",
  checks: "write",
};

export function screenshotWorkflow(patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    on: { pull_request: null },
    jobs: {
      ci: baseJob,
      "screenshot-gate": { ...gateJob, permissions: screenshotPermissions, ...patch },
    },
  });
}

export function fixture(
  options: {
    node?: boolean;
    gh?: boolean;
    yaml?: "real" | "missing" | "wrong-version" | "unloadable";
    workflow?: string | null;
  } = {},
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-workflow-guard-"));
  temporaryRoots.push(root);
  const repo = NodePath.join(root, "repo");
  const bare = NodePath.join(root, "goat-si/goat.git");
  const bin = NodePath.join(root, "bin");
  const home = NodePath.join(root, "home");
  const calls = NodePath.join(root, "gh-calls");
  const ghArgs = NodePath.join(root, "gh-args");
  const parser = NodePath.join(repo, "node_modules/.pnpm", yamlName, "node_modules/yaml");
  for (const directory of [
    repo,
    bin,
    home,
    NodePath.dirname(bare),
    NodePath.join(repo, ".vite-hooks/_"),
  ]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  for (const name of ["git", "sh", "basename", "dirname", "tr"]) {
    NodeFS.symlinkSync(executable(name), NodePath.join(bin, name));
  }
  if (options.node !== false) NodeFS.symlinkSync(NodeProcess.execPath, NodePath.join(bin, "node"));
  if (options.gh !== false) {
    const mock = NodePath.join(bin, "gh");
    NodeFS.writeFileSync(
      mock,
      `#!/bin/sh
printf 'call\n' >> "$MOCK_GH_CALLS"
printf '%s\n' "$@" > "$MOCK_GH_ARGS"
if [ "\${MOCK_GH_FAIL:-}" = "1" ]; then exit 1; fi
printf '%s\n' "$MOCK_DISABLED_WORKFLOWS"
`,
    );
    NodeFS.chmodSync(mock, 0o755);
  }
  const yamlMode = options.yaml ?? "real";
  if (yamlMode !== "missing") {
    NodeFS.mkdirSync(NodePath.dirname(parser), { recursive: true });
    if (yamlMode === "real") {
      NodeFS.symlinkSync(yamlSource, parser, "dir");
    } else {
      NodeFS.mkdirSync(parser);
      NodeFS.writeFileSync(
        NodePath.join(parser, "package.json"),
        JSON.stringify({
          name: "yaml",
          version: yamlMode === "wrong-version" ? "1.10.0" : "2.9.0",
          main: "missing.cjs",
        }),
      );
    }
  }
  for (const path of ["pre-push", "goat-workflow-guard.mjs", "_/h", "_/pre-push"]) {
    const target = NodePath.join(repo, ".vite-hooks", path);
    NodeFS.copyFileSync(NodePath.join(sourceRoot, ".vite-hooks", path), target);
    NodeFS.chmodSync(target, 0o755);
  }
  const env = { ...NodeProcess.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    VP_HOME: home,
    HUSKY: "1",
    VP_GIT_HOOKS: "1",
    VITE_GIT_HOOKS: "1",
    GOAT_SKIP_WORKFLOW_GUARD: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Guard fixture",
    GIT_AUTHOR_EMAIL: "guard@example.invalid",
    GIT_COMMITTER_NAME: "Guard fixture",
    GIT_COMMITTER_EMAIL: "guard@example.invalid",
    MOCK_GH_CALLS: calls,
    MOCK_GH_ARGS: ghArgs,
    MOCK_GH_FAIL: "",
    MOCK_DISABLED_WORKFLOWS: upstreamPath,
  });
  function git(...args: string[]) {
    return NodeChildProcess.execFileSync(gitExecutable, args, {
      cwd: repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  function write(path: string, content: string) {
    const target = NodePath.join(repo, path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  }
  function commit() {
    git("add", ".github", ".vite-hooks");
    git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "workflow fixture");
    return git("rev-parse", "HEAD");
  }
  function record(sha: string, ref = "refs/heads/test", remoteSha = zero) {
    return `${ref} ${sha} ${ref} ${remoteSha}\n`;
  }
  function hook(records: string, extraEnv: Record<string, string> = {}, remote = ["origin", bare]) {
    return NodeChildProcess.spawnSync("/bin/sh", ["-e", ".vite-hooks/pre-push", ...remote], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      input: records,
      encoding: "utf8",
    });
  }
  function ghCalls() {
    return NodeFS.existsSync(calls)
      ? NodeFS.readFileSync(calls, "utf8").trim().split("\n").length
      : 0;
  }
  git("init", "--initial-branch=main");
  write(".git/info/exclude", "node_modules/\n");
  git("init", "--bare", bare);
  git("remote", "add", "origin", bare);
  git("config", "core.hooksPath", ".vite-hooks/_");
  write(upstreamPath, "on: push\njobs: {}\n");
  if (options.workflow !== null) write(workflowPath, options.workflow ?? validWorkflow);
  const sha = commit();
  return { repo, bare, bin, parser, env, sha, git, write, commit, record, hook, ghCalls, ghArgs };
}

/** Deletes every fixture created since the last call; call it from afterEach. */
export function removeFixtures() {
  for (const root of temporaryRoots.splice(0))
    NodeFS.rmSync(root, { recursive: true, force: true });
}
