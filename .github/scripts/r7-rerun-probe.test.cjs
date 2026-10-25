"use strict";

// Live check for #1672, removed in the next commit: fails on a run's first attempt and passes on a
// re-run, so a flaky red followed by a green re-run can be observed on one head.

const { it } = require("node:test");
const assert = require("node:assert/strict");

it("passes only on a re-run", () => {
  assert.notEqual(process.env.GITHUB_RUN_ATTEMPT ?? "1", "1");
});
