"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  FULL_LABEL,
  TASKS,
  readWorkspace,
  selectTasks,
  matrixFor,
  fullRunReason,
} = require("./goat-ci-scope.cjs");

// The real workspace graph, so these cases follow the packages as they exist.
const workspace = readWorkspace(path.resolve(__dirname, "../.."));
const tasksFor = (...files) => selectTasks(files, workspace).tasks;

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
      const result = selectTasks(["docs/a.md", file], workspace);
      assert.equal(result.full, true, file);
      assert.deepEqual(result.tasks, TASKS, file);
    }
  });

  it("keeps a server change to the server tasks", () => {
    const tasks = tasksFor("apps/server/src/orchestration-v2/Orchestrator.ts");
    assert.deepEqual(tasks, ["check", "typecheck", "build", "test-server"]);
  });

  it("runs memory growth for memory and persistence code but not other server directories", () => {
    assert.ok(tasksFor("apps/server/src/memory/MemoryStore.ts").includes("test-memory-growth"));
    assert.ok(tasksFor("apps/server/src/persistence/Migrations.ts").includes("test-memory-growth"));
    assert.ok(tasksFor("apps/server/src/server.ts").includes("test-memory-growth"));
    assert.ok(tasksFor("apps/server/vite.config.ts").includes("test-memory-growth"));
    assert.ok(
      !tasksFor("apps/server/src/channels/ChannelDispatcher.ts").includes("test-memory-growth"),
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
    assert.deepEqual(tasksFor("packages/contracts/src/orchestrationV2.ts"), TASKS);
  });

  it("follows workspace dependencies from shared but not into contracts", () => {
    const tasks = tasksFor("packages/shared/src/format.ts");
    for (const task of [
      "test",
      "test-desktop",
      "test-client-runtime",
      "test-mobile-memory",
      "test-shared",
      "test-server",
      "build",
      "test-memory-growth",
    ]) {
      assert.ok(tasks.includes(task), task);
    }
    assert.ok(!tasks.includes("test-contracts"));
  });

  it("runs the mobile memory suite for mobile changes only among app suites", () => {
    assert.deepEqual(tasksFor("apps/mobile/src/lib/threadActivity.ts"), [
      "check",
      "typecheck",
      "test-mobile-memory",
    ]);
  });

  it("typechecks infra and the lint plugin without running suites", () => {
    assert.deepEqual(tasksFor("infra/relay/src/index.ts"), ["check", "typecheck"]);
    assert.deepEqual(tasksFor("oxlint-plugin-goat/rules/no-restyle.js"), ["check", "typecheck"]);
    assert.deepEqual(tasksFor("apps/marketing/src/pages/index.astro"), ["check", "typecheck"]);
  });

  it("always includes check", () => {
    assert.deepEqual(tasksFor(), ["check"]);
  });
});

describe("matrixFor", () => {
  it("expands the server suite into four shards in task order", () => {
    assert.deepEqual(matrixFor(["test-server", "check"]).include, [
      { task: "check" },
      { task: "test-server", shard: 1, shard_count: 4 },
      { task: "test-server", shard: 2, shard_count: 4 },
      { task: "test-server", shard: 3, shard_count: 4 },
      { task: "test-server", shard: 4, shard_count: 4 },
    ]);
  });

  it("lists fourteen jobs for a full run: ten tasks and four server shards", () => {
    assert.equal(matrixFor(TASKS).include.length, 14);
  });
});

describe("fullRunReason", () => {
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

  it("runs everything for manual runs", async () => {
    assert.equal(
      await fullRunReason({ GITHUB_EVENT_NAME: "workflow_dispatch" }, {}, labels([])),
      "workflow_dispatch event",
    );
  });

  it("honors the label from the event or from the live PR", async () => {
    const payload = { pull_request: { labels: [{ name: FULL_LABEL }] } };
    assert.equal(await fullRunReason(env, payload, labels([])), FULL_LABEL + " label");
    assert.equal(
      await fullRunReason(env, { pull_request: { labels: [] } }, labels([FULL_LABEL])),
      FULL_LABEL + " label",
    );
  });

  it("falls back to path selection when the live labels cannot be read", async () => {
    const failing = async () => ({ ok: false, status: 502 });
    assert.equal(await fullRunReason(env, { pull_request: { labels: [] } }, failing), undefined);
  });
});
