"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  FULL_LABEL,
  SERVER_LABEL,
  MEMORY_LABEL,
  TASKS,
  MEMORY_GROWTH_TESTS,
  SOURCE_SCANNING_TESTS,
  readWorkspace,
  readServerWeights,
  planServerTests,
  reachesMemoryGrowth,
  selectTasks,
  matrixFor,
  laneRun,
  planRun,
} = require("./goat-ci-scope.cjs");
const fs = require("node:fs");
const { buildImportGraph, listWorkspaceFiles } = require("./goat-ci-imports.cjs");

// The real workspace and import graphs, so these cases follow the code as it exists.
const root = path.resolve(__dirname, "../..");
const workspace = readWorkspace(root);
const graph = buildImportGraph(root);
const weights = readServerWeights(root);
const select = (...files) => selectTasks(files, workspace, { graph, weights });
const tasksFor = (...files) => select(...files).tasks;

/** A hand-made graph: files maps each file to its source text, edges lists [importer, imported]. */
function fakeGraph(files, edges = []) {
  const importers = new Map();
  for (const [from, to] of edges) {
    if (!importers.has(to)) importers.set(to, new Set());
    importers.get(to).add(from);
  }
  const sources = new Map(Object.entries(files).filter(([file]) => /\.[cm]?[jt]sx?$/.test(file)));
  return { files: new Set(Object.keys(files)), sources, importers, packageDirs: ["apps/server"] };
}

describe("selectTasks", () => {
  it("runs only check for documentation", () => {
    assert.deepEqual(
      tasksFor("docs/user/memory.md", "devlog/_chase/README.md", "AGENTS.md", "structure/ci.md"),
      ["check"],
    );
  });

  it("runs everything for files it cannot place", () => {
    for (const file of [
      ".github/workflows/goat-ci.yml",
      ".github/scripts/goat-ci-scope.cjs",
      "scripts/dev-runner.ts",
      "pnpm-lock.yaml",
      "vite.config.ts",
      ".vite-hooks/pre-push",
      "native/resource-monitor/src/main.rs",
      "apps/server/package.json",
      "packages/no-such-package/src/index.ts",
    ]) {
      const result = selectTasks(["docs/a.md", file], workspace, { graph, weights });
      assert.equal(result.full, true, file);
      assert.deepEqual(result.tasks, TASKS, file);
      assert.equal(result.server.mode, "full", file);
    }
  });

  it("runs only the server test files that import a server change", () => {
    const changed = "apps/server/src/channels/ChannelDispatcher.ts";
    const result = select(changed);
    assert.deepEqual(result.tasks, ["check", "typecheck", "build", "test-server"]);
    assert.equal(result.server.mode, "related");
    assert.ok(result.server.files.length > 0);
    for (const file of result.server.files) {
      assert.match(file, /^(?:src|integration)\/.*\.test\.tsx?$/);
      assert.equal(result.server.reached.get(file), changed);
    }
    assert.ok(result.server.shards >= 1 && result.server.shards <= 4);
    assert.ok(result.server.shards <= result.server.files.length);
  });

  it("runs a changed server test file", () => {
    const result = select("apps/server/src/channels/ChannelDeliveryWorker.test.ts");
    assert.equal(result.server.mode, "related");
    assert.ok(result.server.files.includes("src/channels/ChannelDeliveryWorker.test.ts"));
  });

  it("runs the full server suite when a change reaches the test configuration", () => {
    for (const file of [
      "apps/server/vite.config.ts",
      "apps/server/src/testUtils/shardWeights.json",
    ]) {
      const result = select(file);
      assert.equal(result.server.mode, "full", file);
      assert.ok(result.tasks.includes("test-server"), file);
      assert.ok(result.tasks.includes("test-memory-growth"), file);
    }
  });

  it("runs memory growth for memory and persistence code but not other server directories", () => {
    assert.ok(tasksFor("apps/server/src/memory/MemoryStore.ts").includes("test-memory-growth"));
    assert.ok(tasksFor("apps/server/src/persistence/Migrations.ts").includes("test-memory-growth"));
    assert.ok(
      !tasksFor("apps/server/src/channels/ChannelDispatcher.ts").includes("test-memory-growth"),
    );
    assert.ok(
      !tasksFor("packages/contracts/src/orchestrationV2.ts").includes("test-memory-growth"),
    );
  });

  it("does not run server tests for a web-only change but still builds", () => {
    const tasks = tasksFor("apps/web/src/components/ChatView.tsx");
    assert.ok(tasks.includes("test"));
    assert.ok(tasks.includes("build"));
    assert.ok(!tasks.includes("test-server"));
    assert.ok(!tasks.includes("test-desktop"));
  });

  it("runs every dependent task for contracts", () => {
    assert.deepEqual(
      tasksFor("packages/contracts/src/orchestrationV2.ts"),
      TASKS.filter((task) => task !== "test-memory-growth"),
    );
  });

  it("follows workspace dependencies from shared but not into contracts", () => {
    const tasks = tasksFor("packages/shared/src/format.ts");
    for (const task of [
      "test",
      "test-desktop",
      "test-client-runtime",
      "test-mobile",
      "test-shared",
      "build",
    ]) {
      assert.ok(tasks.includes(task), task);
    }
    assert.ok(!tasks.includes("test-contracts"));
  });

  it("runs the full mobile suite for mobile changes only among app suites", () => {
    for (const file of [
      "apps/mobile/src/lib/threadActivity.ts",
      "apps/mobile/src/reactCompilerCoverage.test.ts",
      "apps/mobile/src/persistence/mobile-storage.test.ts",
      "apps/mobile/src/features/notes/NoteRouteScreen.test.tsx",
      "apps/mobile/vite.config.ts",
    ]) {
      assert.deepEqual(tasksFor(file), ["check", "typecheck", "test-mobile"], file);
    }
  });

  it("runs the full mobile suite when shared client runtime changes", () => {
    assert.ok(tasksFor("packages/client-runtime/src/notes.ts").includes("test-mobile"));
  });

  it("wires the mobile matrix task to both mobile projects without a fixed file list", () => {
    assert.deepEqual(matrixFor(["test-mobile"]).include, [
      { task: "test-mobile", title: "test-mobile" },
    ]);
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/goat-ci.yml"), "utf8");
    const step = workflow.match(/- name: Test mobile\n([\s\S]*?)(?=\n\s*- name:)/)?.[1];
    assert.ok(step);
    assert.match(step, /if: matrix\.task == 'test-mobile'/);
    assert.equal(
      step.split("run:")[1].trim(),
      "vp test run --root apps/mobile --config vite.config.ts",
    );
  });

  it("typechecks infra and the lint plugin without running suites", () => {
    assert.deepEqual(tasksFor("infra/relay/src/index.ts"), ["check", "typecheck"]);
    assert.deepEqual(tasksFor("oxlint-plugin-goat/rules/no-restyle.js"), ["check", "typecheck"]);
    assert.deepEqual(tasksFor("apps/marketing/src/pages/index.astro"), ["check", "typecheck"]);
  });

  it("always includes check", () => {
    assert.deepEqual(tasksFor(), ["check"]);
  });

  it("runs the full server suite when it has no import graph", () => {
    const result = selectTasks(["apps/server/src/channels/ChannelDispatcher.ts"], workspace);
    assert.equal(result.server.mode, "full");
    assert.ok(result.tasks.includes("test-server"));
  });

  it("keeps the tests that reach a change without importing it", () => {
    const includes = (changed, test) => {
      const { server } = select(changed);
      return server.mode === "full" || server.files.includes(test);
    };
    // The test spawns a script that imports the change.
    assert.ok(
      includes(
        "apps/server/scripts/acpMockCancellationState.ts",
        "src/provider/acp/AcpJsonRpcConnection.test.ts",
      ),
    );
  });

  it("runs the replay tests of a deleted fixture", () => {
    const deleted =
      "apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/codex_transcript.ndjson";
    const without = buildImportGraph(
      root,
      listWorkspaceFiles(root).filter((file) => file !== deleted),
    );
    const { server } = selectTasks([deleted], workspace, { graph: without, weights });
    assert.notEqual(server.mode, "none");
  });

  it("lists source-scanning tests that exist", () => {
    for (const file of SOURCE_SCANNING_TESTS) assert.ok(fs.existsSync(path.join(root, file)), file);
  });
});

describe("planServerTests", () => {
  const files = {
    "apps/server/src/a.ts": "",
    "apps/server/src/a.test.ts": 'import "./a.ts";',
    "apps/server/src/b.ts": "",
    "apps/server/src/b.test.ts": 'import "./b.ts";',
    "apps/server/src/c.test.ts": "",
    "apps/server/src/d.test.ts": "",
    "apps/server/src/lonely.ts": "",
    "apps/server/src/fixtures/simple/events.jsonl": "",
    "apps/server/src/replay.test.ts": 'const scenario = "simple";',
    "apps/server/src/fixtures/orphan.bin": "",
    "apps/server/vite.config.ts": 'import "./src/testUtils/sequencer.ts";',
    "apps/server/src/testUtils/sequencer.ts": 'import weights from "./weights.json";',
    "apps/server/src/testUtils/weights.json": "",
  };
  const edges = [
    ["apps/server/src/a.test.ts", "apps/server/src/a.ts"],
    ["apps/server/src/b.test.ts", "apps/server/src/b.ts"],
    ["apps/server/vite.config.ts", "apps/server/src/testUtils/sequencer.ts"],
    ["apps/server/src/testUtils/sequencer.ts", "apps/server/src/testUtils/weights.json"],
  ];
  const fake = fakeGraph(files, edges);

  it("runs the test files that import a change", () => {
    const plan = planServerTests(["apps/server/src/a.ts"], fake, {});
    assert.equal(plan.mode, "related");
    assert.deepEqual(plan.files, ["src/a.test.ts"]);
    assert.equal(plan.shards, 1);
    assert.equal(plan.reached.get("src/a.test.ts"), "apps/server/src/a.ts");
  });

  it("runs nothing when no test imports the change", () => {
    assert.equal(planServerTests(["apps/server/src/lonely.ts"], fake, {}).mode, "none");
  });

  it("ignores deleted files", () => {
    assert.equal(planServerTests(["apps/server/src/gone.ts"], fake, {}).mode, "none");
  });

  it("follows a data file to the tests that name its scenario directory", () => {
    const plan = planServerTests(["apps/server/src/fixtures/simple/events.jsonl"], fake, {});
    assert.equal(plan.mode, "related");
    assert.deepEqual(plan.files, ["src/replay.test.ts"]);
  });

  it("runs the full suite for a data file nothing imports or names", () => {
    assert.equal(planServerTests(["apps/server/src/fixtures/orphan.bin"], fake, {}).mode, "full");
  });

  it("follows a deleted data file to the tests that still name its directory", () => {
    const plan = planServerTests(["apps/server/src/fixtures/simple/gone.jsonl"], fake, {});
    assert.equal(plan.mode, "related");
    assert.deepEqual(plan.files, ["src/replay.test.ts"]);
  });

  it("runs the full suite for a deleted data file nothing names", () => {
    assert.equal(planServerTests(["apps/server/src/data/gone.bin"], fake, {}).mode, "full");
  });

  it("runs the full suite when a change reaches the server Vitest config", () => {
    const plan = planServerTests(["apps/server/src/testUtils/weights.json"], fake, {});
    assert.equal(plan.mode, "full");
    assert.equal(plan.shards, 4);
  });

  it("runs the full suite when the related files carry half of the suite's time", () => {
    const heavy = { "src/a.test.ts": 600 };
    assert.equal(planServerTests(["apps/server/src/a.ts"], fake, heavy).mode, "full");
    assert.equal(planServerTests(["apps/server/src/b.ts"], fake, heavy).mode, "related");
  });

  it("never plans more shards than files", () => {
    const plan = planServerTests(["apps/server/src/b.ts"], fake, {
      "src/b.test.ts": 5000,
      "src/c.test.ts": 9000,
      "src/d.test.ts": 9000,
    });
    assert.equal(plan.mode, "related");
    assert.equal(plan.shards, 1);
  });
});

describe("reachesMemoryGrowth", () => {
  const [growth] = MEMORY_GROWTH_TESTS;
  const fake = fakeGraph(
    {
      [growth]: "",
      "apps/server/src/memory/MemoryThing.ts": "",
      "apps/server/src/channels/Channel.ts": "",
    },
    [
      [growth, "apps/server/src/memory/MemoryThing.ts"],
      [growth, "apps/server/src/channels/Channel.ts"],
    ],
  );

  it("follows memory and persistence changes that the growth suite imports", () => {
    assert.equal(
      reachesMemoryGrowth(["apps/server/src/memory/MemoryThing.ts"], fake),
      "apps/server/src/memory/MemoryThing.ts",
    );
  });

  it("leaves other directories to the label, a manual run, or a full run", () => {
    assert.equal(reachesMemoryGrowth(["apps/server/src/channels/Channel.ts"], fake), undefined);
  });
});

describe("matrixFor", () => {
  it("expands the full server suite into four titled shards in task order", () => {
    assert.deepEqual(matrixFor(["test-server", "check"]).include, [
      { task: "check", title: "check" },
      { task: "test-server", title: "test-server 1/4", shard: 1, shard_count: 4, related: false },
      { task: "test-server", title: "test-server 2/4", shard: 2, shard_count: 4, related: false },
      { task: "test-server", title: "test-server 3/4", shard: 3, shard_count: 4, related: false },
      { task: "test-server", title: "test-server 4/4", shard: 4, shard_count: 4, related: false },
    ]);
  });

  it("titles related shards apart from the full suite", () => {
    assert.deepEqual(matrixFor(["test-server"], { mode: "related", shards: 2 }).include, [
      {
        task: "test-server",
        title: "test-server related 1/2",
        shard: 1,
        shard_count: 2,
        related: true,
      },
      {
        task: "test-server",
        title: "test-server related 2/2",
        shard: 2,
        shard_count: 2,
        related: true,
      },
    ]);
  });

  it("lists fifteen jobs for a full run: eleven tasks and four server shards", () => {
    assert.equal(matrixFor(TASKS).include.length, 15);
  });
});

describe("laneRun", () => {
  it("runs one suite per narrow lane and everything otherwise", () => {
    assert.deepEqual(laneRun("server").tasks, ["test-server"]);
    assert.equal(laneRun("server").server.mode, "full");
    assert.deepEqual(laneRun("memory-growth").tasks, ["test-memory-growth"]);
    assert.deepEqual(laneRun("quick").tasks, ["check", "typecheck"]);
    assert.deepEqual(laneRun("all").tasks, TASKS);
    assert.equal(laneRun("all").full, true);
  });
});

describe("planRun", () => {
  const env = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "goat-si/goat",
    PR_NUMBER: "1",
    GITHUB_TOKEN: "t",
  };
  const labels = (names) => async () => ({
    ok: true,
    json: async () => names.map((name) => ({ name })),
  });
  const failing = async () => ({ ok: false, status: 502 });
  const serverChange = ["apps/server/src/channels/ChannelDispatcher.ts"];
  const pr = (extra = {}) => ({ pull_request: { labels: [], draft: false, ...extra } });

  it("follows the lane of a manual run, defaulting to all", async () => {
    const run = (lane) =>
      planRun({
        env: { GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_LANE: lane },
        payload: {},
        root,
        fetchImpl: labels([]),
      });
    assert.deepEqual((await run("server")).tasks, ["test-server"]);
    assert.deepEqual((await run("quick")).tasks, ["check", "typecheck"]);
    assert.equal((await run(undefined)).full, true);
    assert.equal((await run("nonsense")).full, true);
  });

  it("runs everything for ci:full from the event, the added label, or the live PR", async () => {
    const plan = (payload, fetchImpl) =>
      planRun({ env, payload, root, fetchImpl, files: serverChange });
    assert.equal((await plan(pr({ labels: [{ name: FULL_LABEL }] }), labels([]))).full, true);
    assert.equal((await plan({ ...pr(), label: { name: FULL_LABEL } }, labels([]))).full, true);
    assert.equal((await plan(pr(), labels([FULL_LABEL]))).full, true);
  });

  it("falls back to path selection when the live labels cannot be read", async () => {
    const result = await planRun({
      env,
      payload: pr(),
      root,
      fetchImpl: failing,
      files: serverChange,
    });
    assert.equal(result.full, false);
    assert.equal(result.server.mode, "related");
  });

  it("runs only check and typecheck for a draft", async () => {
    const result = await planRun({
      env,
      payload: pr({ draft: true }),
      root,
      fetchImpl: labels([]),
      files: serverChange,
    });
    assert.deepEqual(result.tasks, ["check", "typecheck"]);
  });

  it("widens a run with ci:server and ci:memory, drafts included", async () => {
    const result = await planRun({
      env,
      payload: pr({ draft: true }),
      root,
      fetchImpl: labels([SERVER_LABEL, MEMORY_LABEL]),
      files: serverChange,
    });
    assert.deepEqual(result.tasks, ["check", "typecheck", "test-memory-growth", "test-server"]);
    assert.equal(result.server.mode, "full");
  });
});
