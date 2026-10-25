"use strict";

// goat-ci-result for an ignored goat-ci event: a title or body edit, or a label other than ci:*.
// GitHub reads a required check from the newest goat-ci check suite on the head commit, and an
// ignored event creates one too (#1672). That run waits in the pull request's concurrency group
// until the real run ends, then this script republishes the newest finished goat-ci-result of a real
// pull_request run on the same head: success passes, any other conclusion fails, and a head without
// one fails. A real run's suite has a goat-scope check, which leaves out other ignored runs; manual
// runs are a different event. Both endpoints are public for a public repository, so the job needs
// no permission beyond the workflow's.

const RESULT = "goat-ci-result";
const SCOPE = "goat-scope";
const WORKFLOW = "goat-ci.yml";
// GitHub Actions, the app the dev ruleset requires goat-ci-result from.
const ACTIONS_APP_ID = 15368;

/** The newest finished goat-ci-result check run of a real pull_request goat-ci run, or null. */
function newestRealResult({ runs, checkRuns }) {
  const pullRequestSuites = new Set(
    runs.filter((run) => run.event === "pull_request").map((run) => run.check_suite_id),
  );
  const actions = checkRuns.filter((check) => check.app?.id === ACTIONS_APP_ID);
  const realSuites = new Set(
    actions
      .filter((check) => check.name === SCOPE)
      .map((check) => check.check_suite?.id)
      .filter((suite) => pullRequestSuites.has(suite)),
  );
  const results = actions.filter(
    (check) =>
      check.name === RESULT &&
      check.status === "completed" &&
      realSuites.has(check.check_suite?.id),
  );
  results.sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at) || b.id - a.id);
  return results[0] ?? null;
}

/** Only a real success passes; the message says where the verdict came from. */
function verdict(result, sha) {
  if (result === null) {
    return {
      code: 1,
      message:
        "no goat-ci run on " +
        sha +
        " has a finished goat-ci-result. Push, or re-run the newest goat-ci run of this pull request.",
    };
  }
  const source = result.conclusion + " from " + result.html_url;
  return result.conclusion === "success"
    ? { code: 0, message: "goat-ci-result is " + source }
    : {
        code: 1,
        message:
          "goat-ci-result is " +
          source +
          ". A title or body edit, or a label other than ci:*, runs no CI; push a fix or re-run that run.",
      };
}

async function pages(url, key, token, fetchImpl) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    let response;
    for (let attempt = 1; ; attempt += 1) {
      response = await fetchImpl(url + "&per_page=100&page=" + page, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer " + token,
          "x-github-api-version": "2022-11-28",
        },
      }).catch(() => ({ ok: false, status: 0 }));
      const transient = response.status === 0 || response.status >= 500;
      if (response.ok || !transient || attempt >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
    if (!response.ok) throw new Error("GET " + url + " returned " + response.status);
    const items = (await response.json())[key];
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

async function main(env = process.env, fetchImpl = fetch) {
  const sha = env.HEAD_SHA;
  const repo = (env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + env.GITHUB_REPOSITORY;
  const [runs, checkRuns] = await Promise.all([
    pages(
      repo + "/actions/workflows/" + WORKFLOW + "/runs?event=pull_request&head_sha=" + sha,
      "workflow_runs",
      env.GITHUB_TOKEN,
      fetchImpl,
    ),
    pages(
      repo + "/commits/" + sha + "/check-runs?filter=all&app_id=" + ACTIONS_APP_ID,
      "check_runs",
      env.GITHUB_TOKEN,
      fetchImpl,
    ),
  ]);
  const { code, message } = verdict(newestRealResult({ runs, checkRuns }), sha);
  console.log((code === 0 ? "::notice" : "::error") + " title=goat-ci-result::" + message);
  return code;
}

module.exports = { newestRealResult, verdict, main };

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
