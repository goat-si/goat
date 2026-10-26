"use strict";

// A re-run of a real goat-ci run refreshes the goat-ci-result an ignored event republished (#1691).
// These tests hold its properties: only a re-run attempt acts, only the newest later run decides,
// and only when that run is an ignored-event run of the same pull request; a still-running one is
// cancelled and finished before its re-run; and every API failure fails the job.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { follower, main } = require("./goat-ci-rerun-republish.cjs");

const SHA = "abc";
const OWN = { id: 10, created_at: "2026-10-26T10:00:00Z" };
const run = (
  id,
  created,
  { ignored = true, number = 7, status = "completed", sha = SHA } = {},
) => ({
  id,
  event: "pull_request",
  status,
  head_sha: sha,
  created_at: created,
  display_title: "Fix it (#" + number + (ignored ? ", ignored event)" : ")"),
  html_url: "https://github.com/goat-si/goat/actions/runs/" + id,
});
const pick = (runs) =>
  follower(runs, { number: 7, sha: SHA, ownRunId: OWN.id, ownCreatedAt: OWN.created_at });

/** A fake GitHub API: GET answers from routes, POSTs are recorded and answered from posts. */
function api({ runs, statuses = {}, posts = {} }) {
  const calls = [];
  const fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname + new URL(url).search;
    calls.push(method + " " + path.replace("/repos/goat-si/goat", ""));
    if (method === "POST") {
      const status = posts[path.split("/").slice(-2).join("/")] ?? 201;
      return { ok: status < 300, status, json: async () => ({}) };
    }
    if (path.includes("/workflows/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ total_count: runs.length, workflow_runs: runs }),
      };
    }
    const id = Number(path.split("/").at(-1));
    if (id === OWN.id) return { ok: true, status: 200, json: async () => OWN };
    const next = statuses[id]?.shift() ?? "completed";
    return { ok: true, status: 200, json: async () => ({ id, status: next }) };
  };
  return { fetch, calls };
}
const env = (attempt) => ({
  GITHUB_RUN_ATTEMPT: String(attempt),
  GITHUB_RUN_ID: String(OWN.id),
  GITHUB_REPOSITORY: "goat-si/goat",
  GITHUB_TOKEN: "t",
  HEAD_SHA: SHA,
  PR_NUMBER: "7",
});
const quiet = { sleep: async () => {}, log: () => {} };
const posts = (calls) => calls.filter((call) => call.startsWith("POST"));

describe("refreshing a republished goat-ci-result after a re-run", () => {
  it("does nothing, and calls nothing, on a first attempt", async () => {
    const { fetch, calls } = api({ runs: [run(11, "2026-10-26T10:05:00Z")] });
    assert.equal(await main(env(1), { ...quiet, fetch }), 0);
    assert.deepEqual(calls, []);
  });

  it("re-runs the newest later ignored-event run of the same pull request", async () => {
    const { fetch, calls } = api({
      runs: [run(11, "2026-10-26T10:05:00Z"), run(12, "2026-10-26T10:06:00Z")],
    });
    assert.equal(await main(env(2), { ...quiet, fetch }), 0);
    assert.deepEqual(posts(calls), ["POST /actions/runs/12/rerun"]);
  });

  it("leaves it to a newer real run, an older ignored run, and another pull request's run", () => {
    assert.equal(
      pick([run(11, "2026-10-26T10:05:00Z"), run(12, "2026-10-26T10:06:00Z", { ignored: false })]),
      null,
    );
    assert.equal(pick([run(9, "2026-10-26T09:00:00Z")]), null);
    assert.equal(pick([run(11, "2026-10-26T10:05:00Z", { number: 8 })]), null);
    assert.equal(pick([run(11, "2026-10-26T10:05:00Z", { sha: "def" })]), null);
  });

  it("cancels a still-running ignored run and re-runs it only once it has completed", async () => {
    const { fetch, calls } = api({
      runs: [run(11, "2026-10-26T10:05:00Z", { status: "in_progress" })],
      statuses: { 11: ["in_progress", "completed"] },
    });
    assert.equal(await main(env(3), { ...quiet, fetch }), 0);
    const order = calls.filter((call) => call.includes("/runs/11"));
    assert.deepEqual(order, [
      "POST /actions/runs/11/cancel",
      "GET /actions/runs/11",
      "GET /actions/runs/11",
      "POST /actions/runs/11/rerun",
    ]);
  });

  it("fails the job when the cancel or the re-run is refused", async () => {
    for (const refused of ["11/cancel", "11/rerun"]) {
      const { fetch } = api({
        runs: [run(11, "2026-10-26T10:05:00Z", { status: "in_progress" })],
        posts: { [refused]: 403 },
      });
      const lines = [];
      assert.equal(
        await main(env(2), { sleep: async () => {}, log: (line) => lines.push(line), fetch }),
        1,
      );
      assert.match(lines.at(-1), /::error title=goat-ci-result::.*Re-run the newest ignored-event/);
    }
  });

  it("fails the job when an ignored run never finishes cancelling", async () => {
    const { fetch } = api({
      runs: [run(11, "2026-10-26T10:05:00Z", { status: "in_progress" })],
      statuses: { 11: Array.from({ length: 100 }, () => "in_progress") },
    });
    assert.equal(await main(env(2), { ...quiet, fetch }), 1);
  });
});
