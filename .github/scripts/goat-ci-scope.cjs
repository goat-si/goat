"use strict";

// Chooses the goat-ci tasks a pull request needs. Runs as the goat-scope job of
// goat-ci.yml and hands the ci job its matrix. A change reaches a task when it
// touches a workspace package the task tests or builds, directly or through
// workspace dependencies read from the package.json files. A file this script
// cannot place runs everything, so a new kind of file costs CI time instead of
// skipping a check. Manual runs and the ci:full label also run everything.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const FULL_LABEL = "ci:full";
const SERVER_SHARDS = 4;

/** Every task in the order goat-ci lists them. */
const TASKS = [
  "check",
  "typecheck",
  "test",
  "test-desktop",
  "test-contracts",
  "test-client-runtime",
  "test-mobile-memory",
  "test-shared",
  "test-memory-growth",
  "build",
  "test-server",
];

/** Workspace packages each task tests or builds. A change in their dependency closure selects the task. */
const TASK_ROOTS = {
  test: [
    "packages/ssh",
    "apps/web",
    "packages/provider-core",
    "packages/provider-opencode",
    "packages/provider-cursor",
    "packages/provider-grok",
    "packages/provider-acp",
  ],
  "test-desktop": ["apps/desktop"],
  "test-contracts": ["packages/contracts"],
  "test-client-runtime": ["packages/client-runtime"],
  "test-mobile-memory": ["apps/mobile"],
  "test-shared": ["packages/shared"],
  "test-server": ["apps/server"],
  build: ["apps/desktop", "apps/server"],
};

/**
 * apps/server lists @goat/web only so its build runs after the web build. Server
 * tests never load the web app, so test tasks skip that edge; build keeps it.
 */
const BUILD_ONLY_EDGES = [["apps/server", "apps/web"]];

/** Directories outside apps/ and packages/ that only typecheck and lint cover. */
const TYPECHECK_ONLY_RE = /^(?:infra\/[^/]+|oxlint-plugin-goat)\//;

/** Prose that only the check task (formatting) reads. */
function isDocument(file) {
  if (/^(?:docs|devlog|structure)\//.test(file)) return true;
  return !file.includes("/") && /\.md$/i.test(file);
}

/**
 * The memory growth suite runs for over an hour, so it follows the code it
 * measures: apps/server/src/memory and persistence, the server's own top-level
 * files and configuration, and the contracts and shared packages it encodes
 * with. Other server directories reach it only through a full run.
 */
function reachesMemoryGrowth(file) {
  if (file.startsWith("packages/contracts/") || file.startsWith("packages/shared/")) return true;
  if (!file.startsWith("apps/server/")) return false;
  const inSource = /^apps\/server\/src\/([^/]+)\//.exec(file);
  if (!inSource) return true;
  return inSource[1] === "memory" || inSource[1] === "persistence";
}

/** Reads apps/* and packages/* package.json files into a map of directory to workspace dependencies. */
function readWorkspace(root) {
  const manifests = new Map();
  for (const parent of ["apps", "packages"]) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(root, parent, entry.name, "package.json");
      if (!entry.isDirectory() || !fs.existsSync(file)) continue;
      manifests.set(parent + "/" + entry.name, JSON.parse(fs.readFileSync(file, "utf8")));
    }
  }
  const byName = new Map([...manifests].map(([dir, manifest]) => [manifest.name, dir]));
  const workspace = new Map();
  for (const [dir, manifest] of manifests) {
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    const deps = Object.entries(declared)
      .filter(
        ([name, range]) =>
          typeof range === "string" && range.startsWith("workspace:") && byName.has(name),
      )
      .map(([name]) => byName.get(name));
    workspace.set(dir, deps);
  }
  return workspace;
}

/** Packages reachable from roots through workspace dependencies, roots included. */
function closure(workspace, roots, skippedEdges = []) {
  const skipped = new Set(skippedEdges.map(([from, to]) => from + "\0" + to));
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const dep of workspace.get(dir) ?? []) {
      if (!skipped.has(dir + "\0" + dep)) queue.push(dep);
    }
  }
  return seen;
}

/** The workspace package directory that owns file, or undefined. */
function packageOf(workspace, file) {
  const match = /^(apps|packages)\/([^/]+)\//.exec(file);
  if (!match) return undefined;
  const dir = match[1] + "/" + match[2];
  return workspace.has(dir) ? dir : undefined;
}

/**
 * Decides which tasks the changed files reach. Returns { full, tasks, reasons }
 * where reasons maps each selected task (or "full") to the first file that chose it.
 */
function selectTasks(files, workspace) {
  const reasons = new Map();
  const choose = (task, file) => {
    if (!reasons.has(task)) reasons.set(task, file);
  };
  const changed = new Map();
  for (const file of files) {
    if (isDocument(file)) continue;
    // A dependency change can move any task, and the release version check reads every manifest.
    if (path.posix.basename(file) === "package.json") return everything(file);
    if (TYPECHECK_ONLY_RE.test(file)) {
      choose("typecheck", file);
      continue;
    }
    const dir = packageOf(workspace, file);
    if (dir === undefined) return everything(file);
    choose("typecheck", file);
    if (!changed.has(dir)) changed.set(dir, file);
    if (reachesMemoryGrowth(file)) choose("test-memory-growth", file);
  }
  for (const [task, roots] of Object.entries(TASK_ROOTS)) {
    const reach = closure(workspace, roots, task === "build" ? [] : BUILD_ONLY_EDGES);
    for (const [dir, file] of changed) {
      if (reach.has(dir)) {
        choose(task, file);
        break;
      }
    }
  }
  choose("check", files[0] ?? "(no changed files)");
  const tasks = TASKS.filter((task) => reasons.has(task));
  return { full: false, tasks, reasons };

  function everything(file) {
    return { full: true, tasks: [...TASKS], reasons: new Map([["full", file]]) };
  }
}

/** The ci job matrix for the selected tasks; test-server expands into its shards. */
function matrixFor(tasks) {
  const include = [];
  for (const task of TASKS) {
    if (!tasks.includes(task)) continue;
    if (task === "test-server") {
      for (let shard = 1; shard <= SERVER_SHARDS; shard += 1) {
        include.push({ task, shard, shard_count: SERVER_SHARDS });
      }
    } else {
      include.push({ task });
    }
  }
  return { include };
}

/** Files the PR merge commit changes against its base (first parent), or undefined when HEAD is not that merge. */
function changedFiles(cwd) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/);
  if (parents.length !== 3) return undefined;
  return git("diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD")
    .split("\0")
    .filter(Boolean);
}

/** Labels on the PR now, so re-running the workflow after adding ci:full takes effect. */
async function liveLabels(env, fetchImpl) {
  const url =
    (env.GITHUB_API_URL ?? "https://api.github.com") +
    "/repos/" +
    env.GITHUB_REPOSITORY +
    "/issues/" +
    env.PR_NUMBER +
    "/labels?per_page=100";
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("labels request failed with HTTP " + response.status);
  return (await response.json()).map((label) => label.name);
}

/** Why the whole matrix runs regardless of paths, or undefined for path-based selection. */
async function fullRunReason(env, payload, fetchImpl) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") return env.GITHUB_EVENT_NAME + " event";
  const labels = (payload.pull_request?.labels ?? []).map((label) => label.name);
  if (labels.includes(FULL_LABEL)) return FULL_LABEL + " label";
  try {
    if ((await liveLabels(env, fetchImpl)).includes(FULL_LABEL)) return FULL_LABEL + " label";
  } catch (error) {
    // The label only widens a run; path-based selection already errs toward running more.
    console.log(
      "::warning::Could not read live PR labels (" + error.message + "); using the event's labels.",
    );
  }
  return undefined;
}

async function main(env = process.env, fetchImpl = fetch) {
  const payload = env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const root = process.cwd();
  let result;
  const forced = await fullRunReason(env, payload, fetchImpl);
  if (forced !== undefined) {
    result = { full: true, tasks: [...TASKS], reasons: new Map([["full", forced]]) };
  } else {
    const files = changedFiles(root);
    result =
      files === undefined
        ? {
            full: true,
            tasks: [...TASKS],
            reasons: new Map([["full", "HEAD is not the PR merge commit"]]),
          }
        : selectTasks(files, readWorkspace(root));
  }
  const matrix = matrixFor(result.tasks);
  const lines = [
    "### goat-ci scope",
    "",
    result.full
      ? "Full run: " + result.reasons.get("full")
      : "Path-based run. Add the " + FULL_LABEL + " label and re-run for everything.",
    "",
    "| Task | Chosen by |",
    "| --- | --- |",
    ...result.tasks.map(
      (task) => "| " + task + " | " + (result.full ? "full run" : result.reasons.get(task)) + " |",
    ),
  ];
  console.log(lines.join("\n"));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  if (env.GITHUB_OUTPUT)
    fs.appendFileSync(env.GITHUB_OUTPUT, "matrix=" + JSON.stringify(matrix) + "\n");
  return { ...result, matrix };
}

module.exports = {
  FULL_LABEL,
  TASKS,
  isDocument,
  reachesMemoryGrowth,
  readWorkspace,
  closure,
  selectTasks,
  matrixFor,
  fullRunReason,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
