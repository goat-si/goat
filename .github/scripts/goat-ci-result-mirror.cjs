"use strict";

// goat-ci-result for an ignored goat-ci event: a title or body edit, or a label other than ci:*.
// GitHub reads a required check from the newest goat-ci check suite on the head commit, and an
// ignored event creates one too (#1672). That run's republish job runs this script, which waits for
// the governing run, the newest real goat-ci run of the same pull request on the same head (by
// creation, so a newer run decides even when it was cancelled), and repeats its goat-ci-result:
// success passes, anything else fails, and a head without a real run fails. It reads the job of
// that run, so no check another job creates under the same name can stand in for it. Both
// endpoints are public for a public repository, so the job needs no extra permission.
//
// The run listing can lag behind events: a ci:* label or retarget a moment before the edit starts a
// real run the first listing may not show yet. So it decides only once its own run is a minute old,
// and only when a second listing, taken after reading the jobs, names the same run and attempt.

const WORKFLOW = "goat-ci.yml";
const RESULT = "goat-ci-result";
const POLL_MS = 30_000;
// Covers the moment between an opened or synchronize event and its run appearing in the API.
const NO_RUN_GRACE_MS = 3 * 60_000;
// How long a real run whose event came before this run's gets to appear in the listing.
const SETTLE_MS = 60_000;

/** The end of the run-name goat-ci.yml gives a real pull_request run of this pull request. */
const realRunSuffix = (number) => " (#" + number + ")";

/** The newest real goat-ci run of pull request number on sha, other than this run, or null. */
function governingRun(runs, { number, sha, ownRunId }) {
  const real = runs.filter(
    (run) =>
      run.event === "pull_request" &&
      run.head_sha === sha &&
      String(run.id) !== String(ownRunId) &&
      run.display_title.endsWith(realRunSuffix(number)),
  );
  real.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  return real[0] ?? null;
}

/** Only a finished, successful goat-ci-result job of the governing run passes. */
function verdict(run, jobs) {
  const results = jobs.filter((job) => job.name === RESULT);
  const result = results.length === 1 ? results[0] : null;
  if (result?.status === "completed" && result.conclusion === "success") {
    return { code: 0, message: "goat-ci-result is success in " + result.html_url };
  }
  const found = result
    ? result.conclusion + " in " + result.html_url
    : "missing in " + run.html_url;
  return {
    code: 1,
    message:
      "goat-ci-result is " +
      found +
      ". A title or body edit, or a label other than ci:*, runs no CI: push a fix, or re-run that run and then this one.",
  };
}

async function get(url, token, fetchImpl, wait) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + token,
        "x-github-api-version": "2022-11-28",
      },
    }).catch(() => ({ ok: false, status: 0 }));
    if (response.ok) return response.json();
    const transient = response.status === 0 || response.status >= 500;
    if (!transient || attempt >= 3) throw new Error("GET " + url + " returned " + response.status);
    await wait(1000 * attempt);
  }
}

/** Every item of a listing; an incomplete one throws, so a missing page never decides the result. */
async function list(url, key, token, fetchImpl, wait) {
  const all = [];
  let total = 0;
  for (let page = 1; page <= 10; page += 1) {
    const body = await get(url + "&per_page=100&page=" + page, token, fetchImpl, wait);
    total = body.total_count;
    all.push(...body[key]);
    if (all.length >= total || body[key].length === 0) break;
  }
  if (all.length < total) throw new Error(url + " listed " + all.length + " of " + total);
  return all;
}

async function main(env = process.env, io = {}) {
  const fetchImpl = io.fetch ?? fetch;
  const wait = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = io.now ?? Date.now;
  const log = io.log ?? console.log;
  const sha = env.HEAD_SHA;
  const number = Number(env.PR_NUMBER);
  const repo = (env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + env.GITHUB_REPOSITORY;
  const runsUrl =
    repo + "/actions/workflows/" + WORKFLOW + "/runs?event=pull_request&head_sha=" + sha;
  const listRuns = () => list(runsUrl, "workflow_runs", env.GITHUB_TOKEN, fetchImpl, wait);
  const governing = (runs) => governingRun(runs, { number, sha, ownRunId: env.GITHUB_RUN_ID });
  const started = now();
  let waitingFor = null;
  for (;;) {
    const runs = await listRuns();
    const own = runs.find((run) => String(run.id) === String(env.GITHUB_RUN_ID));
    const run = governing(runs);
    // A re-run keeps its run's created_at, so it is settled at once.
    const settleLeft = own ? Date.parse(own.created_at) + SETTLE_MS - now() : SETTLE_MS;
    if (own && settleLeft <= 0 && run?.status === "completed") {
      const jobsUrl = repo + "/actions/runs/" + run.id + "/jobs?filter=latest";
      const jobs = await list(jobsUrl, "jobs", env.GITHUB_TOKEN, fetchImpl, wait);
      const again = governing(await listRuns());
      if (
        again?.id === run.id &&
        again.status === "completed" &&
        again.run_attempt === run.run_attempt
      ) {
        const { code, message } = verdict(run, jobs);
        log((code === 0 ? "::notice" : "::error") + " title=goat-ci-result::" + message);
        return code;
      }
      // A newer run or attempt appeared while the jobs were read; it decides instead. Listings are
      // eventually consistent and can disagree for a while, so poll rather than list again at once.
      log("the run listing changed while reading " + run.html_url + "; waiting");
      await wait(POLL_MS);
      continue;
    }
    if (!own && now() - started >= NO_RUN_GRACE_MS) {
      log("::error title=goat-ci-result::this run never appeared in " + runsUrl);
      return 1;
    }
    if (run === null && now() - started >= NO_RUN_GRACE_MS) {
      log(
        "::error title=goat-ci-result::no goat-ci run of #" +
          number +
          " tested " +
          sha +
          ". Push, or re-run its goat-ci run.",
      );
      return 1;
    }
    if (run !== null && run.id !== waitingFor) {
      waitingFor = run.id;
      log("waiting for " + run.html_url);
    }
    const settling = own && settleLeft > 0 && run?.status === "completed";
    await wait(settling ? Math.max(1000, Math.min(POLL_MS, settleLeft)) : POLL_MS);
  }
}

module.exports = { realRunSuffix, governingRun, verdict, main };

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.log("::error title=goat-ci-result::" + (error?.stack ?? String(error)));
      process.exitCode = 1;
    },
  );
}
