"use strict";

// goat-ci-result for an ignored event republishes a real run's verdict (#1672). These tests hold
// the security property: only a finished success of a real pull_request goat-ci run on the same head
// passes, and nothing an ignored, manual or foreign check reports can stand in for it.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { newestRealResult, verdict, main } = require("./goat-ci-result-mirror.cjs");

const ACTIONS = { id: 15368 };
let nextId = 1;
const check = (suite, name, conclusion, completedAt, app = ACTIONS) => ({
  id: nextId++,
  name,
  app,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  completed_at: completedAt,
  check_suite: { id: suite },
  html_url: "https://github.com/goat-si/goat/runs/" + suite + "-" + name,
});
// A real goat-ci run: goat-scope ran, so its check carries the real name.
const real = (suite, conclusion, completedAt) => [
  check(suite, "goat-scope", "success", completedAt),
  check(suite, "goat-ci-result", conclusion, completedAt),
];
const run = (suite, event = "pull_request") => ({ check_suite_id: suite, event });

describe("goat-ci-result for an ignored event", () => {
  it("republishes the newest real verdict, so an edit after a red run stays red", () => {
    const result = newestRealResult({
      runs: [run(1), run(2)],
      checkRuns: [
        ...real(1, "success", "2026-10-25T10:00:00Z"),
        ...real(2, "failure", "2026-10-25T11:00:00Z"),
      ],
    });
    assert.equal(result.conclusion, "failure");
    assert.equal(verdict(result, "abc").code, 1);
  });

  it("ignores a newer success from another ignored run, a manual run or another app", () => {
    const result = newestRealResult({
      runs: [run(1), run(2), run(3, "workflow_dispatch")],
      checkRuns: [
        ...real(1, "failure", "2026-10-25T10:00:00Z"),
        // Another ignored run: no goat-scope check in its suite.
        check(2, "goat-ci-result", "success", "2026-10-25T11:00:00Z"),
        ...real(3, "success", "2026-10-25T12:00:00Z"),
        ...real(1, "success", "2026-10-25T13:00:00Z").map((c) => ({ ...c, app: { id: 1 } })),
      ],
    });
    assert.equal(result.conclusion, "failure");
  });

  it("follows a re-run that finished after an earlier failure", () => {
    const result = newestRealResult({
      runs: [run(1)],
      checkRuns: [
        ...real(1, "failure", "2026-10-25T10:00:00Z"),
        ...real(1, "success", "2026-10-25T11:00:00Z"),
      ],
    });
    assert.equal(verdict(result, "abc").code, 0);
  });

  it("fails while no real run has finished goat-ci-result", () => {
    const result = newestRealResult({ runs: [run(1)], checkRuns: real(1, null, null) });
    assert.equal(result, null);
    assert.equal(verdict(result, "abc").code, 1);
  });

  it("passes only success", () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "skipped",
      "neutral",
      "timed_out",
      "action_required",
    ]) {
      assert.equal(verdict({ conclusion, html_url: "u" }, "abc").code, 1, conclusion);
    }
    assert.equal(verdict({ conclusion: "success", html_url: "u" }, "abc").code, 0);
  });

  it("reads the head commit's goat-ci runs and Actions checks, and fails when GitHub refuses", async () => {
    const urls = [];
    const respond = (status, payload) => async (url) => {
      urls.push(url);
      return { ok: status === 200, status, json: async () => payload(url) };
    };
    const env = { HEAD_SHA: "abc", GITHUB_REPOSITORY: "goat-si/goat", GITHUB_TOKEN: "t" };
    const payload = (url) =>
      url.includes("/actions/workflows/goat-ci.yml/runs?event=pull_request&head_sha=abc&")
        ? { workflow_runs: [run(1)] }
        : { check_runs: real(1, "success", "2026-10-25T10:00:00Z") };
    assert.equal(await main(env, respond(200, payload)), 0);
    assert.ok(urls.some((url) => url.includes("/commits/abc/check-runs?filter=all&app_id=15368&")));
    await assert.rejects(main(env, respond(403, payload)), /returned 403/);
  });
});
