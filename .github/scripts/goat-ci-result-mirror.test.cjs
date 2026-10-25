"use strict";

// goat-ci-result for an ignored event repeats the governing run's verdict (#1672). These tests hold
// the security property: only the newest real goat-ci run of the same pull request on the same head
// decides, only its own finished, successful goat-ci-result job passes, and nothing older, foreign,
// ignored, manual or incomplete can stand in for it.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { governingRun, verdict, main } = require("./goat-ci-result-mirror.cjs");

const SHA = "abc";
const run = (
  id,
  created,
  { status = "completed", title = "Fix it (#7)", sha = SHA, event = "pull_request" } = {},
) => ({
  id,
  event,
  status,
  head_sha: sha,
  display_title: title,
  created_at: created,
  html_url: "https://github.com/goat-si/goat/actions/runs/" + id,
});
const job = (conclusion, name = "goat-ci-result") => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  html_url: "https://github.com/goat-si/goat/job/" + name,
});
const pick = (runs) => governingRun(runs, { number: 7, sha: SHA, ownRunId: 99 });

describe("goat-ci-result for an ignored event", () => {
  it("lets the newest real run decide even when an older run was re-run later or the newer one was cancelled", () => {
    const older = run(1, "2026-10-25T10:00:00Z");
    const newer = run(2, "2026-10-25T11:00:00Z");
    assert.equal(pick([older, newer]).id, 2);
    assert.equal(verdict(newer, [job("cancelled")]).code, 1);
    // Cancelled before goat-ci-result existed.
    assert.equal(verdict(newer, [job("cancelled", "goat-scope")]).code, 1);
  });

  it("ignores another pull request on the same head, ignored and manual runs, other heads and itself", () => {
    const real = run(1, "2026-10-25T10:00:00Z");
    const runs = [
      real,
      run(2, "2026-10-25T11:00:00Z", { title: "Fix it (#8)" }),
      run(3, "2026-10-25T11:00:00Z", { title: "Fix it (#7) (#8)" }),
      run(4, "2026-10-25T11:00:00Z", { title: "Fix it (#7, ignored event)" }),
      run(5, "2026-10-25T11:00:00Z", {
        title: "goat-ci all on fix (#7)",
        event: "workflow_dispatch",
      }),
      run(6, "2026-10-25T11:00:00Z", { sha: "def" }),
      run(99, "2026-10-25T12:00:00Z"),
    ];
    assert.equal(pick(runs), real);
    assert.equal(pick(runs.slice(1, 6)), null);
  });

  it("passes only one finished, successful goat-ci-result job", () => {
    const real = run(1, "2026-10-25T10:00:00Z");
    for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out", null]) {
      assert.equal(verdict(real, [job(conclusion)]).code, 1, String(conclusion));
    }
    assert.equal(verdict(real, []).code, 1);
    assert.equal(verdict(real, [job("success"), job("success")]).code, 1);
    assert.equal(verdict(real, [job("success")]).code, 0);
  });

  describe("main", () => {
    const env = {
      HEAD_SHA: SHA,
      PR_NUMBER: "7",
      GITHUB_RUN_ID: "99",
      GITHUB_REPOSITORY: "goat-si/goat",
      GITHUB_TOKEN: "t",
    };
    // A fake API whose governing run finishes after the given number of listings.
    const api = ({
      pendingListings = 0,
      runs = [run(1, "2026-10-25T10:00:00Z")],
      jobs = [job("success")],
      status = 200,
      total,
    } = {}) => {
      let listings = 0;
      const urls = [];
      const fetch = async (url) => {
        urls.push(url);
        let body;
        if (url.includes("/actions/workflows/goat-ci.yml/runs?event=pull_request&head_sha=abc&")) {
          listings += 1;
          const done = listings > pendingListings;
          const listed = runs.map((r) => ({ ...r, status: done ? r.status : "in_progress" }));
          body = { total_count: total ?? listed.length, workflow_runs: listed };
        } else if (url.includes("/actions/runs/1/jobs?filter=latest&")) {
          body = { total_count: jobs.length, jobs };
        } else throw new Error("unexpected " + url);
        return { ok: status === 200, status, json: async () => body };
      };
      return { fetch, urls };
    };
    const io = (fake, clock = { t: 0 }) => ({
      fetch: fake.fetch,
      sleep: async (ms) => {
        clock.t += ms;
      },
      now: () => clock.t,
      log: () => {},
    });

    it("waits for the governing run to finish, then repeats its result", async () => {
      assert.equal(await main(env, io(api({ pendingListings: 3 }))), 0);
      assert.equal(await main(env, io(api({ pendingListings: 3, jobs: [job("failure")] }))), 1);
    });

    it("fails when no real run of the pull request appears on the head", async () => {
      assert.equal(await main(env, io(api({ runs: [] }))), 1);
    });

    it("fails when GitHub refuses or lists the runs incompletely", async () => {
      await assert.rejects(main(env, io(api({ status: 403 }))), /returned 403/);
      await assert.rejects(main(env, io(api({ total: 500 }))), /listed \d+ of 500/);
    });
  });
});
