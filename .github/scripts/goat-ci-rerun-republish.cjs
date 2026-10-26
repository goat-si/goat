"use strict";

// After a re-run of a real goat-ci run (#1691). GitHub reads the required goat-ci-result from the
// newest goat-ci suite on the head commit, and a re-run stays in its run's original suite. When an
// ignored event (a title or body edit, a label other than ci:*) came later, its republish job
// already repeated the first verdict into the newer suite, and nothing refreshed it. This job runs
// last in the re-run attempt and re-runs that ignored run, so its mirror repeats this attempt's
// verdict. A still-running ignored run is cancelled first: once completed it cannot keep an old
// decision, and its new attempt reads this run only after this run completes.
//
// It never reports a verdict itself. A newer real run decides on its own, so it is left alone.

const { realRunSuffix } = require("./goat-ci-result-mirror.cjs");

const WORKFLOW = "goat-ci.yml";
const CANCEL_POLL_MS = 10_000;
const CANCEL_POLLS = 60;

/** The suffix goat-ci.yml's run-name gives an ignored-event run of this pull request. */
const ignoredRunSuffix = (number) => " (#" + number + ", ignored event)";

/**
 * The newest goat-ci pull_request run on sha created after this run, when it is an ignored-event run
 * of the same pull request; null when there is none or the newest one is a real run.
 */
function follower(runs, { number, sha, ownRunId, ownCreatedAt }) {
  const after = runs.filter(
    (run) =>
      run.event === "pull_request" &&
      run.head_sha === sha &&
      String(run.id) !== String(ownRunId) &&
      // Created after this run; within one second the larger id is the later run.
      (Date.parse(run.created_at) > Date.parse(ownCreatedAt) ||
        (Date.parse(run.created_at) === Date.parse(ownCreatedAt) && run.id > Number(ownRunId))) &&
      (run.display_title.endsWith(ignoredRunSuffix(number)) ||
        run.display_title.endsWith(realRunSuffix(number))),
  );
  after.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const newest = after[0];
  return newest && newest.display_title.endsWith(ignoredRunSuffix(number)) ? newest : null;
}

async function request(method, url, token, fetchImpl, wait) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + token,
        "x-github-api-version": "2022-11-28",
      },
    }).catch(() => ({ ok: false, status: 0 }));
    // cancel answers 202 and rerun 201, both without a body this script reads.
    if (response.ok) return method === "GET" ? response.json() : null;
    const transient = response.status === 0 || response.status >= 500;
    if (!transient || attempt >= 3)
      throw new Error(method + " " + url + " returned " + response.status);
    await wait(1000 * attempt);
  }
}

async function main(env = process.env, io = {}) {
  const fetchImpl = io.fetch ?? fetch;
  const wait = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = io.log ?? console.log;
  if (!(Number(env.GITHUB_RUN_ATTEMPT) > 1)) return 0;
  const token = env.GITHUB_TOKEN;
  const number = Number(env.PR_NUMBER);
  const sha = env.HEAD_SHA;
  const repo = (env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + env.GITHUB_REPOSITORY;
  const get = (url) => request("GET", url, token, fetchImpl, wait);
  const post = (url) => request("POST", url, token, fetchImpl, wait);
  try {
    const own = await get(repo + "/actions/runs/" + env.GITHUB_RUN_ID);
    const runs = [];
    for (let page = 1; page <= 10; page += 1) {
      const body = await get(
        repo +
          "/actions/workflows/" +
          WORKFLOW +
          "/runs?event=pull_request&head_sha=" +
          sha +
          "&per_page=100&page=" +
          page,
      );
      runs.push(...body.workflow_runs);
      if (runs.length >= body.total_count || body.workflow_runs.length === 0) break;
    }
    const target = follower(runs, { number, sha, ownRunId: own.id, ownCreatedAt: own.created_at });
    if (target === null) {
      log("no ignored-event run follows this run on " + sha + "; nothing to refresh");
      return 0;
    }
    let status = target.status;
    if (status !== "completed") {
      log("cancelling " + target.html_url + " so its next attempt reads this one");
      await post(repo + "/actions/runs/" + target.id + "/cancel");
      for (let poll = 0; status !== "completed"; poll += 1) {
        if (poll >= CANCEL_POLLS) throw new Error(target.html_url + " did not finish cancelling");
        await wait(CANCEL_POLL_MS);
        status = (await get(repo + "/actions/runs/" + target.id)).status;
      }
    }
    await post(repo + "/actions/runs/" + target.id + "/rerun");
    log(
      "::notice title=goat-ci-result::re-ran " +
        target.html_url +
        " to repeat this attempt's verdict",
    );
    return 0;
  } catch (error) {
    log(
      "::error title=goat-ci-result::could not refresh the republished goat-ci-result (" +
        (error?.message ?? String(error)) +
        "). Re-run the newest ignored-event goat-ci run of #" +
        number +
        " by hand after this run finishes.",
    );
    return 1;
  }
}

module.exports = { ignoredRunSuffix, follower, main };

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
