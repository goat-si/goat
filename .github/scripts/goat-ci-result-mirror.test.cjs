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
    const MINUTE = 60_000;
    // This ignored run, created when the fake clock reads 0.
    const own = run(99, new Date(0).toISOString(), { title: "Fix it (#7, ignored event)" });
    const real = (id, created, { status = "completed", attempt = 1, result = "success" } = {}) => ({
      ...run(id, created, { status }),
      run_attempt: attempt,
      jobs: status === "completed" ? [job(result)] : [job(null)],
    });
    // A fake API: listing n (from 1) shows listings[n - 1], or the last entry once they run out. The
    // jobs of a run are those of its entry in the latest listing, as filter=latest returns.
    const api = (listings, { status = 200, total } = {}) => {
      let shown = listings[0];
      let count = 0;
      const fetch = async (url) => {
        let body;
        if (url.includes("/actions/workflows/goat-ci.yml/runs?event=pull_request&head_sha=abc&")) {
          count += 1;
          shown = listings[Math.min(count, listings.length) - 1];
          body = { total_count: total ?? shown.length, workflow_runs: shown };
        } else {
          const id = url.match(/\/actions\/runs\/(\d+)\/jobs\?filter=latest&/)?.[1];
          const listed = shown.find((r) => String(r.id) === id);
          if (listed === undefined) throw new Error("unexpected " + url);
          body = { total_count: listed.jobs.length, jobs: listed.jobs };
        }
        return { ok: status === 200, status, json: async () => body };
      };
      return { fetch, listings: () => count };
    };
    const io = (fake, clock = { t: 0 }) => ({
      fetch: fake.fetch,
      sleep: async (ms) => {
        clock.t += ms;
      },
      now: () => clock.t,
      log: () => {},
    });
    const R1 = "2026-10-25T10:00:00Z";
    const R2 = "2026-10-25T11:00:00Z";

    it("waits for the governing run to finish, then repeats its result", async () => {
      const pending = [real(1, R1, { status: "in_progress" }), own];
      for (const result of ["success", "failure"]) {
        const done = [real(1, R1, { result }), own];
        const code = await main(env, io(api([pending, pending, pending, done])));
        assert.equal(code, result === "success" ? 0 : 1, result);
      }
    });

    it("does not repeat an older green while a real run started just before the edit is not listed yet", async () => {
      // A ci:* label or retarget started R2 a moment before the edit; the first listing lags behind.
      const lagging = [real(1, R1), own];
      const listed = [real(1, R1), real(2, R2, { status: "in_progress" }), own];
      const failed = [real(1, R1), real(2, R2, { result: "failure" }), own];
      assert.equal(await main(env, io(api([lagging, listed, listed, failed]))), 1);
    });

    it("waits again when the confirming listing shows a newer run or a newer attempt", async () => {
      const settled = () => ({ t: 10 * MINUTE });
      const green = [real(1, R1), own];
      const newer = [real(1, R1), real(2, R2, { status: "in_progress" }), own];
      const newerFailed = [real(1, R1), real(2, R2, { result: "failure" }), own];
      assert.equal(await main(env, io(api([green, newer, newer, newerFailed]), settled())), 1);
      // The run was re-run and its second attempt failed between the two listings.
      const rerunFailed = [real(1, R1, { attempt: 2, result: "failure" }), own];
      assert.equal(await main(env, io(api([green, rerunFailed]), settled())), 1);
    });

    it("polls instead of spinning while the listing keeps disagreeing with itself", async () => {
      const green = [real(1, R1), own];
      const newer = [real(1, R1), real(2, R2, { status: "in_progress" }), own];
      const newerFailed = [real(1, R1), real(2, R2, { result: "failure" }), own];
      const flapping = [green, newer, green, newer, green, newer, green, newer, newerFailed];
      let sleeps = 0;
      const run = io(api(flapping), { t: 10 * MINUTE });
      const sleep = run.sleep;
      run.sleep = async (ms) => {
        sleeps += 1;
        await sleep(ms);
      };
      assert.equal(await main(env, run), 1);
      // Each disagreement between a listing and its confirmation is followed by a poll interval.
      assert.ok(sleeps >= 4, "slept " + sleeps + " times");
    });

    it("decides at once on a re-run of an ignored run created long ago", async () => {
      const fake = api([[real(1, R1), own]]);
      assert.equal(await main(env, io(fake, { t: 10 * MINUTE })), 0);
      assert.equal(fake.listings(), 2);
    });

    it("fails when no real run of the pull request appears on the head", async () => {
      assert.equal(await main(env, io(api([[own]]))), 1);
    });

    it("fails when this run never appears in the listing", async () => {
      assert.equal(await main(env, io(api([[real(1, R1)]]))), 1);
    });

    it("fails when GitHub refuses or lists the runs incompletely", async () => {
      await assert.rejects(main(env, io(api([[own]], { status: 403 }))), /returned 403/);
      await assert.rejects(main(env, io(api([[own]], { total: 500 }))), /listed \d+ of 500/);
    });
  });
});
