"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { it } = require("node:test");
const { planRun, WINDOWS_SUITES } = require("./goat-ci-scope.cjs");

it("runs both linked Git worktree watcher proof files on Windows", async () => {
  for (const file of [
    "apps/server/src/git/GitWorkflowService.test.ts",
    "apps/server/src/vcs/VcsStatusBroadcaster.watch.test.ts",
  ]) {
    assert.ok(WINDOWS_SUITES.includes(file), file);
    const plan = await planRun({
      env: { GITHUB_EVENT_NAME: "pull_request" },
      payload: { pull_request: { labels: [], draft: false } },
      root: path.resolve(__dirname, "../.."),
      files: [file],
    });
    assert.ok(plan.tasks.includes("test-windows"), file);
  }
});
