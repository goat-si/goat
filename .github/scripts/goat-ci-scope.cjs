"use strict";

// Chooses the goat-ci tasks a run needs. Runs as the goat-scope job of goat-ci.yml and hands the ci
// job its matrix.
//
// A pull request, draft or ready, gets a quick run: check, typecheck (unless only documents
// changed), and test-changed, the test files beside its changes that check:changed runs before a
// push (scripts/lib/changed-tests.ts). The full suite runs on request: the ci:full label, or a
// manual run of the branch, whose lane is all by default. The integrated lane=all runs on dev that
// gate the nightly are manual runs, so they stay full.
//
// The ci:affected label runs the tasks the changes reach instead: a change reaches a task when it
// touches a workspace package the task tests or builds, directly or through workspace dependencies
// read from the package.json files. The server suite and the memory growth suite go further and
// follow the static import graph (goat-ci-imports.cjs): only the server test files that import a
// changed file run, and the full four-shard suite when that is most of the suite anyway or the
// change is one the graph cannot place. A file it cannot place runs everything.
//
// ci:server adds the full server suite and ci:memory the memory growth suite to either kind of run.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildImportGraph, dependents, isSource, mentionsOf } = require("./goat-ci-imports.cjs");
// Node strips the types, so CI picks the same files check:changed runs before every push.
const { INGEST_SUITE_TRIGGER, testsForChanges } = require("../../scripts/lib/changed-tests.ts");

const FULL_LABEL = "ci:full";
const AFFECTED_LABEL = "ci:affected";
const SERVER_LABEL = "ci:server";
const MEMORY_LABEL = "ci:memory";
const LANES = ["all", "server", "memory-growth", "quick"];
/** The quick run's test task: the test files beside the changed files. */
const CHANGED_TESTS_TASK = "test-changed";
/** CI script tests use node:test, not Vitest. */
const NODE_TEST_RE = /^\.github\/scripts\/[^/]+\.test\.cjs$/;
const CODE_RE = /\.[cm]?[jt]sx?$/;
const SERVER_SHARDS = 4;
const SERVER_DIR = "apps/server";
const SERVER_TEST_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** goat-ci.yml runs these with GOAT_MEMORY_GROWTH=1 in the test-memory-growth task. */
const MEMORY_GROWTH_TESTS = [
  "apps/server/src/memory/MemoryImport.growth.test.ts",
  "apps/server/src/memory/MemoryReceive.growth.test.ts",
];
/** Server directories whose changes run the memory growth suite on a pull request. */
const MEMORY_GROWTH_DIRS = ["apps/server/src/memory/", "apps/server/src/persistence/"];
/**
 * Files that change how every server test runs: the Vitest configs, their setup files, and what
 * they import (the shard sequencer and its weights). A change that reaches one runs the full suite.
 */
const SERVER_RUN_CONFIG = [
  "vite.config.ts",
  "apps/server/vite.config.ts",
  "packages/shared/src/testing/longTempDir.ts",
  "apps/server/src/testUtils/gitConfig.setup.ts",
];
/** Selected server tests carrying at least this share of the suite's time run as the full suite. */
const SERVER_FULL_SHARE = 0.5;
/**
 * Server tests that read the server's own source tree instead of importing it. Any change to
 * server source can break them, so they join every related run that a server source change starts.
 * Upstream deleted the only one, V1ImportBoundary.test.ts (#22557, cycle 261021).
 */
const SOURCE_SCANNING_TESTS = [];
/** Directories whose data files the server suite reads; an unplaceable one there runs the full suite. */
const SERVER_DATA_ROOTS = ["apps/server/", "packages/"];
/** Estimated seconds one related-test shard aims for. */
const SERVER_SHARD_TARGET_SECONDS = 360;
/**
 * Estimated seconds a server test file costs on CI beyond its recorded time in shardWeights.json,
 * which records only the slowest files: the full suite took about 66 runner-minutes for 579 files
 * (goat-ci run 39029230802). Only the split decision uses it; WeightedShardSequencer still shards.
 */
const FILE_ESTIMATE_SECONDS = 6;

/** Every task in the order goat-ci lists them. */
const TASKS = [
  "check",
  "typecheck",
  "test",
  "test-ssh",
  "test-desktop",
  "test-contracts",
  "test-client-runtime",
  "test-mobile",
  "test-shared",
  "test-ingest",
  "test-memory-growth",
  "build",
  "test-server",
];
/** Matrix order: the quick run's test job follows the checks. */
const MATRIX_ORDER = ["check", "typecheck", CHANGED_TESTS_TASK, ...TASKS.slice(2)];

/** Workspace packages each task tests or builds. A change in their dependency closure selects the task. */
const TASK_ROOTS = {
  test: [
    "apps/web",
    "packages/provider-core",
    "packages/provider-opencode",
    "packages/provider-cursor",
    "packages/provider-grok",
    "packages/provider-acp",
  ],
  "test-ssh": ["packages/ssh"],
  "test-desktop": ["apps/desktop"],
  "test-contracts": ["packages/contracts"],
  "test-client-runtime": ["packages/client-runtime"],
  "test-mobile": ["apps/mobile"],
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

/** Recorded seconds per server test file, keyed relative to apps/server. */
function readServerWeights(root) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, SERVER_DIR, "src/testUtils/shardWeights.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

const serverKey = (file) => file.slice(SERVER_DIR.length + 1);

/**
 * Which server test files the changed files reach. Returns { mode, files, shards, reason, reached }:
 * mode "none" (no server test imports a change), "related" (files, keyed relative to apps/server,
 * in shards), or "full" (the whole suite in four shards). reached maps each related file to the
 * changed file that reached it.
 */
function planServerTests(changed, graph, weights) {
  const full = (reason) => ({
    mode: "full",
    files: [],
    shards: SERVER_SHARDS,
    reason,
    reached: new Map(),
  });
  const seeds = new Map();
  const isServerData = (file) =>
    !isSource(file) && SERVER_DATA_ROOTS.some((dir) => file.startsWith(dir));
  for (const file of changed) {
    if (SERVER_RUN_CONFIG.includes(file)) return full(file + " configures every server test");
    const mentions = mentionsOf(graph, file);
    for (const mention of mentions) if (!seeds.has(mention)) seeds.set(mention, file);
    if (!graph.files.has(file)) {
      // Deleted. Code that imported it changed too (or fails typecheck); code that still names it
      // by path is in mentions. A deleted data file that nothing names may still be read through a
      // computed path.
      if (isServerData(file) && mentions.length === 0)
        return full("deleted " + file + " is not named anywhere");
      continue;
    }
    seeds.set(file, file);
    if (
      isServerData(file) &&
      !graph.importers.has(file) &&
      !graph.namers?.has(file) &&
      mentions.length === 0
    ) {
      return full("nothing imports or names " + file);
    }
  }
  const reach = dependents(graph, seeds.keys());
  // Imports alone decide whether a change reaches the test configuration: a config that names a
  // build entry in a string does not run it.
  const imported = dependents(
    graph,
    changed.filter((file) => graph.files.has(file)),
    { importsOnly: true },
  );
  const config = SERVER_RUN_CONFIG.find((file) => imported.has(file));
  if (config) return full(imported.get(config) + " reaches " + config);

  const allTests = [...graph.sources.keys()].filter(
    (file) => file.startsWith(SERVER_DIR + "/") && SERVER_TEST_RE.test(file),
  );
  const seconds = (file) => (weights[serverKey(file)] ?? 0) + FILE_ESTIMATE_SECONDS;
  const sourceChange = changed.find(
    (file) => file.startsWith(SERVER_DIR + "/src/") && isSource(file) && !SERVER_TEST_RE.test(file),
  );
  const origin = (file) => seeds.get(reach.get(file)) ?? sourceChange;
  const selected = allTests.filter(
    (file) =>
      reach.has(file) || (sourceChange !== undefined && SOURCE_SCANNING_TESTS.includes(file)),
  );
  if (selected.length === 0) {
    return {
      mode: "none",
      files: [],
      shards: 0,
      reason: "no server test imports a change",
      reached: new Map(),
    };
  }
  const total = allTests.reduce((sum, file) => sum + seconds(file), 0);
  const chosen = selected.reduce((sum, file) => sum + seconds(file), 0);
  if (chosen >= total * SERVER_FULL_SHARE) {
    return full(
      selected.length +
        " related files carry " +
        Math.round((100 * chosen) / total) +
        "% of the suite's time",
    );
  }
  const reached = new Map(selected.sort().map((file) => [serverKey(file), origin(file)]));
  return {
    mode: "related",
    files: [...reached.keys()],
    shards: Math.max(
      1,
      Math.min(SERVER_SHARDS, selected.length, Math.ceil(chosen / SERVER_SHARD_TARGET_SECONDS)),
    ),
    reason: selected.length + " related files, about " + Math.round(chosen / 60) + " min estimated",
    reached,
  };
}

/** The memory growth suite runs when a memory or persistence change reaches one of its files. */
function reachesMemoryGrowth(changed, graph) {
  const seeds = changed.filter(
    (file) => graph.files.has(file) && MEMORY_GROWTH_DIRS.some((dir) => file.startsWith(dir)),
  );
  if (seeds.length === 0) return undefined;
  const reach = dependents(graph, seeds);
  const test = MEMORY_GROWTH_TESTS.find((file) => reach.has(file));
  return test ? reach.get(test) : undefined;
}

/**
 * Decides which tasks the changed files reach. Returns { full, tasks, reasons, server } where
 * reasons maps each selected task (or "full") to the first file that chose it and server is the
 * plan for test-server. Without a graph the server suite runs in full when selected.
 */
function selectTasks(files, workspace, { graph, weights = {} } = {}) {
  const reasons = new Map();
  const choose = (task, file) => {
    if (!reasons.has(task)) reasons.set(task, file);
  };
  const changed = new Map();
  for (const file of files) {
    if (isDocument(file)) continue;
    // A dependency change can move any task, and the release version check reads every manifest.
    if (path.posix.basename(file) === "package.json") return everything(file);
    // The ingest Worker's suite covers its SQL and config and the shared allowlist.
    if (INGEST_SUITE_TRIGGER.test(file)) choose("test-ingest", file);
    if (TYPECHECK_ONLY_RE.test(file)) {
      choose("typecheck", file);
      continue;
    }
    const dir = packageOf(workspace, file);
    if (dir === undefined) return everything(file);
    choose("typecheck", file);
    if (!changed.has(dir)) changed.set(dir, file);
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

  let server = { mode: "none", files: [], shards: 0, reason: "", reached: new Map() };
  if (reasons.has("test-server")) {
    server = graph
      ? planServerTests(files, graph, weights)
      : {
          mode: "full",
          files: [],
          shards: SERVER_SHARDS,
          reason: reasons.get("test-server"),
          reached: new Map(),
        };
    if (server.mode === "none") reasons.delete("test-server");
    else if (server.mode === "full") reasons.set("test-server", server.reason);
  }
  const growth = graph ? reachesMemoryGrowth(files, graph) : undefined;
  if (growth) choose("test-memory-growth", growth);
  else if (server.mode === "full" && /configures every server test|reaches /.test(server.reason)) {
    choose("test-memory-growth", server.reason);
  }
  const tasks = TASKS.filter((task) => reasons.has(task));
  return { full: false, tasks, reasons, server };

  function everything(file) {
    return {
      full: true,
      tasks: [...TASKS],
      reasons: new Map([["full", file]]),
      server: {
        mode: "full",
        files: [],
        shards: SERVER_SHARDS,
        reason: "full run",
        reached: new Map(),
      },
    };
  }
}

/** The ci job matrix; test-server expands into its shards. Each entry carries the job title. */
function matrixFor(tasks, server = { mode: "full", shards: SERVER_SHARDS }) {
  const include = [];
  for (const task of MATRIX_ORDER) {
    if (!tasks.includes(task)) continue;
    if (task === "test-server") {
      const related = server.mode === "related";
      const count = related ? server.shards : SERVER_SHARDS;
      for (let shard = 1; shard <= count; shard += 1) {
        include.push({
          task,
          title: "test-server " + (related ? "related " : "") + shard + "/" + count,
          shard,
          shard_count: count,
          related,
        });
      }
    } else {
      include.push({ task, title: task });
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

/** Labels on the PR now, so a re-run sees labels added after the event. */
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

/** The PR's labels: the event's, the label this event added, and the live ones when readable. */
async function labelsOf(env, payload, fetchImpl) {
  const labels = new Set((payload.pull_request?.labels ?? []).map((label) => label.name));
  if (payload.label?.name) labels.add(payload.label.name);
  try {
    for (const name of await liveLabels(env, fetchImpl)) labels.add(name);
  } catch (error) {
    // Labels only widen a run; path selection already errs toward running more.
    console.log(
      "::warning::Could not read live PR labels (" + error.message + "); using the event's labels.",
    );
  }
  return labels;
}

const fullServer = (reason) => ({
  mode: "full",
  files: [],
  shards: SERVER_SHARDS,
  reason,
  reached: new Map(),
});

/** The tasks a manual run's lane selects. */
function laneRun(lane) {
  const reasons = (tasks, why) => new Map(tasks.map((task) => [task, why]));
  const why = "lane " + lane;
  if (lane === "server") {
    return {
      full: false,
      tasks: ["test-server"],
      reasons: reasons(["test-server"], why),
      server: fullServer(why),
    };
  }
  if (lane === "memory-growth") {
    return {
      full: false,
      tasks: ["test-memory-growth"],
      reasons: reasons(["test-memory-growth"], why),
      server: fullServer(why),
    };
  }
  if (lane === "quick") {
    return {
      full: false,
      tasks: ["check", "typecheck"],
      reasons: reasons(["check", "typecheck"], why),
      server: fullServer(why),
    };
  }
  return {
    full: true,
    tasks: [...TASKS],
    reasons: new Map([["full", why]]),
    server: fullServer(why),
  };
}

/**
 * The quick run for a pull request: check always, typecheck unless only documents changed, and
 * test-changed when the changes select tests (scripts/lib/changed-tests.ts). changedTests splits
 * them by runner.
 */
function quickRun(changed, root) {
  const reasons = new Map([["check", "quick run"]]);
  const placed = changed.find((file) => !isDocument(file));
  if (placed !== undefined) reasons.set("typecheck", placed);
  const code = changed.filter((file) => CODE_RE.test(file));
  const tests = [...testsForChanges(root, code, changed)].sort();
  const changedTests = {
    vitest: tests.filter((file) => !NODE_TEST_RE.test(file)),
    node: tests.filter((file) => NODE_TEST_RE.test(file)),
  };
  if (tests.length > 0) {
    reasons.set(CHANGED_TESTS_TASK, tests.length + " test file(s) for the changes");
  }
  return {
    full: false,
    quick: true,
    tasks: MATRIX_ORDER.filter((task) => reasons.has(task)),
    reasons,
    server: { mode: "none", files: [], shards: 0, reason: "quick run", reached: new Map() },
    changedTests,
  };
}

const noChangedTests = () => ({ vitest: [], node: [] });

/** One line for goat-ci-result: what kind of run this was and how to widen it. */
function noteFor(result, branch = "<branch>") {
  // GITHUB_OUTPUT takes one note=value line; a file name in a reason may hold a newline.
  return oneLine(describeRun(result, branch));
}

const oneLine = (text) => text.replace(/[\r\n]+/g, " ");

function describeRun(result, branch) {
  if (result.full) return "Full run: " + result.reasons.get("full") + ".";
  const ran = result.tasks.join(", ") || "nothing";
  const fullRun =
    " label, or run gh workflow run goat-ci.yml --ref " + branch + " (lane all by default).";
  if (result.quick) {
    return "Quick run (" + ran + "). The full suite did not run: add the " + FULL_LABEL + fullRun;
  }
  return "Partial run (" + ran + "). For the full suite add the " + FULL_LABEL + fullRun;
}

/**
 * The whole decision for one run: a manual run follows its lane; a pull request gets the quick
 * run unless a label asks for more.
 */
async function planRun({ env, payload, root, fetchImpl, files }) {
  const result = await planTasks({ env, payload, root, fetchImpl, files });
  const planned = { quick: false, changedTests: noChangedTests(), ...result };
  return { ...planned, note: noteFor(planned, env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME) };
}

async function planTasks({ env, payload, root, fetchImpl, files }) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    const lane = LANES.includes(env.INPUT_LANE) ? env.INPUT_LANE : "all";
    return laneRun(lane);
  }
  const labels = await labelsOf(env, payload, fetchImpl);
  if (labels.has(FULL_LABEL))
    return { ...laneRun("all"), reasons: new Map([["full", FULL_LABEL + " label"]]) };
  const changed = files === undefined ? changedFiles(root) : files;
  if (changed === undefined) {
    return { ...laneRun("all"), reasons: new Map([["full", "HEAD is not the PR merge commit"]]) };
  }
  const result = labels.has(AFFECTED_LABEL)
    ? {
        ...selectTasks(changed, readWorkspace(root), {
          graph: buildImportGraph(root),
          weights: readServerWeights(root),
        }),
        quick: false,
        affected: true,
      }
    : quickRun(changed, root);
  if (result.full) return result;
  const tasks = new Set(result.tasks);
  const reasons = new Map(result.reasons);
  let server = result.server;
  if (labels.has(SERVER_LABEL) && !(tasks.has("test-server") && server.mode === "full")) {
    tasks.add("test-server");
    reasons.set("test-server", SERVER_LABEL + " label");
    server = fullServer(SERVER_LABEL + " label");
  }
  if (labels.has(MEMORY_LABEL) && !tasks.has("test-memory-growth")) {
    tasks.add("test-memory-growth");
    reasons.set("test-memory-growth", MEMORY_LABEL + " label");
  }
  return {
    ...result,
    tasks: MATRIX_ORDER.filter((task) => tasks.has(task)),
    reasons,
    server,
  };
}

function summaryLines(result) {
  const kind = result.full
    ? "Full run: " + result.reasons.get("full")
    : result.quick
      ? "Quick run: check, typecheck and the tests beside the changes."
      : result.affected
        ? "Run of what the changes reach (" + AFFECTED_LABEL + " label)."
        : "Partial run: " + [...new Set(result.reasons.values())].join(", ") + ".";
  const lines = [
    "### goat-ci scope",
    "",
    kind,
    ...(result.full
      ? []
      : [
          "",
          "Labels widen it: " +
            FULL_LABEL +
            " (everything), " +
            AFFECTED_LABEL +
            " (what the changes reach), " +
            SERVER_LABEL +
            " (full server suite), " +
            MEMORY_LABEL +
            " (memory growth). A manual run of the branch runs everything: " +
            "gh workflow run goat-ci.yml --ref <branch>.",
        ]),
    "",
    "| Task | Chosen by |",
    "| --- | --- |",
    ...result.tasks.map(
      (task) => "| " + task + " | " + (result.full ? "full run" : result.reasons.get(task)) + " |",
    ),
  ];
  const changedTests = [...result.changedTests.vitest, ...result.changedTests.node];
  if (changedTests.length > 0) {
    lines.push("", "#### Changed tests", "", ...changedTests.map((file) => "- " + file));
  }
  if (result.tasks.includes("test-server")) {
    lines.push(
      "",
      "#### Server tests",
      "",
      result.server.mode === "related"
        ? "Related files only (" +
            result.server.reason +
            ") in " +
            result.server.shards +
            " shard(s):"
        : "Full suite in four shards: " + result.server.reason + ".",
    );
    if (result.server.mode === "related") {
      lines.push("", "| Test file | Reached from |", "| --- | --- |");
      for (const [file, seed] of result.server.reached)
        lines.push("| " + file + " | " + seed + " |");
    }
  }
  return lines;
}

async function main(env = process.env, fetchImpl = fetch) {
  const payload = env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const result = await planRun({ env, payload, root: process.cwd(), fetchImpl });
  const matrix = matrixFor(result.tasks, result.server);
  const lines = summaryLines(result);
  console.log(lines.join("\n"));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      "matrix=" +
        JSON.stringify(matrix) +
        "\nserver_files=" +
        JSON.stringify(result.server.files) +
        "\nchanged_tests=" +
        JSON.stringify(result.changedTests.vitest) +
        "\nchanged_node_tests=" +
        JSON.stringify(result.changedTests.node) +
        "\nnote=" +
        result.note +
        "\n",
    );
  }
  return { ...result, matrix };
}

module.exports = {
  FULL_LABEL,
  AFFECTED_LABEL,
  SERVER_LABEL,
  MEMORY_LABEL,
  LANES,
  TASKS,
  CHANGED_TESTS_TASK,
  MEMORY_GROWTH_TESTS,
  SERVER_RUN_CONFIG,
  SOURCE_SCANNING_TESTS,
  isDocument,
  readWorkspace,
  readServerWeights,
  closure,
  planServerTests,
  reachesMemoryGrowth,
  selectTasks,
  matrixFor,
  laneRun,
  planRun,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
