// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a maintainer CLI that shells out to gh.
// Squash-merges a pull request only when goat-ci-result passed on its exact head. --admin skips
// branch protection, so this is the check: a bare merge landed a head whose typecheck was still
// failing and broke typecheck for every pull request, and another while its tests were running.
//
//   node scripts/merge-pr.ts <pr> [--known-failure <reason>] [--dry-run] [--repo <owner/name>]
//
// --known-failure merges finished, unsuccessful runs and records the reason on the pull request
// first, such as a failure that also happens on dev (docs/operations/merging.md).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const DEFAULT_REPO = "goat-si/goat";
const RESULT_CHECK = "goat-ci-result";

/** A goat-ci workflow run, or one of its jobs, as the Actions API returns them. */
export interface Run {
  readonly id: number;
  readonly name?: string | undefined;
  readonly event?: string | undefined;
  readonly display_title?: string | undefined;
  readonly created_at?: string | undefined;
  readonly run_attempt?: number | undefined;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
}

export type MergeVerdict =
  | {
      readonly merge: true;
      readonly governing: ReadonlyArray<Run>;
      readonly results: ReadonlyArray<Run>;
      readonly knownFailure?: string;
    }
  | { readonly merge: false; readonly reason: string };

const byCreation = (a: Run, b: Run) =>
  Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "") || b.id - a.id;

/**
 * The newest real pull request run and the newest manual lane=all run on the head. Ignored-event
 * runs only repeat an older verdict and partial lanes test less, so neither governs; a failed full
 * run stays in force until a later full run passes. Titles come from run-name in goat-ci.yml.
 */
export function governingRuns(runs: ReadonlyArray<Run>, pr: number): ReadonlyArray<Run> {
  const real = (run: Run) =>
    run.event === "pull_request" && run.display_title?.endsWith(` (#${pr})`) === true;
  const full = (run: Run) =>
    run.event === "workflow_dispatch" && run.display_title?.startsWith("goat-ci all on ") === true;
  return [real, full].flatMap((kind) => runs.filter(kind).toSorted(byCreation).slice(0, 1));
}

/**
 * A real pull request run is required: a manual run skips the screenshot gate, and a head may
 * carry no pull request run at all. Each governing run must have finished, at its latest
 * attempt, with its own goat-ci-result.
 */
export function mergeVerdict(
  governing: ReadonlyArray<Run>,
  jobsOf: (run: Run) => ReadonlyArray<Run>,
  head: string,
  knownFailure?: string,
): MergeVerdict {
  if (!governing.some((run) => run.event === "pull_request")) {
    return { merge: false, reason: `no goat-ci pull request run on ${head} yet` };
  }
  const results: Array<Run> = [];
  for (const run of governing) {
    if (run.status !== "completed") {
      return { merge: false, reason: `goat-ci run on ${head} is ${run.status}: ${run.html_url}` };
    }
    const result = jobsOf(run).find((job) => job.name === RESULT_CHECK);
    if (result === undefined || result.status !== "completed") {
      return {
        merge: false,
        reason: `goat-ci run on ${head} ended ${run.conclusion} without ${RESULT_CHECK}; re-run it: ${run.html_url}`,
      };
    }
    results.push(result);
  }
  const failed = results.filter((result) => result.conclusion !== "success");
  if (failed.length === 0) return { merge: true, governing, results };
  const reason = knownFailure?.trim();
  if (reason) return { merge: true, governing, results, knownFailure: reason };
  return {
    merge: false,
    reason: `${RESULT_CHECK} on ${head} is ${failed.map((result) => `${result.conclusion}: ${result.html_url}`).join(", ")}. Fix it, re-run it, or pass --known-failure with the reason and a link to the matching dev run.`,
  };
}

/** The same runs, at the same attempt and status, still govern. */
export function sameEvidence(before: ReadonlyArray<Run>, after: ReadonlyArray<Run>): boolean {
  const key = (runs: ReadonlyArray<Run>) =>
    runs.map((run) => `${run.id}/${run.run_attempt}/${run.status}`).join(" ");
  return key(before) === key(after);
}

function gh(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function main(argv: ReadonlyArray<string>): number {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "known-failure": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      repo: { type: "string", default: DEFAULT_REPO },
    },
  });
  const pr = positionals[0];
  if (pr === undefined || positionals.length !== 1 || !/^\d+$/.test(pr)) {
    console.error("usage: node scripts/merge-pr.ts <pr> [--known-failure <reason>] [--dry-run]");
    return 2;
  }
  const repo = values.repo;
  const view = JSON.parse(gh(["pr", "view", pr, "-R", repo, "--json", "state,headRefOid,url"])) as {
    state: string;
    headRefOid: string;
    url: string;
  };
  if (view.state !== "OPEN") {
    console.error(`${view.url} is ${view.state}`);
    return 1;
  }
  const head = view.headRefOid;
  // Every page: a failed full run can sit behind a hundred newer ignored-event runs.
  const list = (path: string, key: string): ReadonlyArray<Run> =>
    gh([
      "api",
      "--paginate",
      path,
      "--jq",
      `.${key}[] | {id, name, event, display_title, created_at, run_attempt, status, conclusion, html_url}`,
    ])
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Run);
  const governing = () =>
    governingRuns(
      list(
        `repos/${repo}/actions/workflows/goat-ci.yml/runs?head_sha=${head}&per_page=100`,
        "workflow_runs",
      ),
      Number(pr),
    );
  const jobsOf = (run: Run) =>
    list(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, "jobs");
  const runs = governing();
  const verdict = mergeVerdict(runs, jobsOf, head, values["known-failure"]);
  if (!verdict.merge) {
    console.error(`not merging ${view.url}: ${verdict.reason}`);
    return 1;
  }
  // A run that started or re-ran while the jobs were read would decide instead.
  if (!sameEvidence(runs, governing())) {
    console.error(
      `not merging ${view.url}: goat-ci changed on ${head} while it was read; try again`,
    );
    return 1;
  }
  for (const result of verdict.results)
    console.log(`${RESULT_CHECK} ${result.conclusion} on ${head}: ${result.html_url}`);
  if (values["dry-run"]) return 0;
  if (verdict.knownFailure !== undefined) {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-merge-"));
    const body = NodePath.join(dir, "body.md");
    NodeFS.writeFileSync(
      body,
      `Merging with ${RESULT_CHECK} on ${head} at ${verdict.results.map((result) => `${result.conclusion} (${result.html_url})`).join(", ")}: ${verdict.knownFailure}\n`,
    );
    try {
      gh(["pr", "comment", pr, "-R", repo, "--body-file", body]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }
  gh(["pr", "merge", pr, "-R", repo, "--admin", "--squash", "--match-head-commit", head]);
  console.log(`merged ${view.url} at head ${head}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
