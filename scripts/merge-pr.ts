// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a maintainer CLI that shells out to gh.
// Squash-merges a pull request only when goat-ci-result passed on its exact head. --admin skips
// branch protection, so this is the check: a bare merge landed a head whose typecheck was still
// failing and broke typecheck for every pull request, and another while its tests were running.
//
//   node scripts/merge-pr.ts <pr> [--known-failure <reason>] [--dry-run] [--repo <owner/name>]
//
// --known-failure merges a finished, unsuccessful run and records the reason on the pull
// request first, such as a failure that also happens on dev (docs/operations/merging.md).
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
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
}

export type MergeVerdict =
  | { readonly merge: true; readonly run: Run; readonly knownFailure?: string }
  | { readonly merge: false; readonly reason: string };

/**
 * Only the newest goat-ci run on the head counts, and only through its own goat-ci-result job: a
 * newer run cancelled before that job ran leaves an older success as the newest result check.
 * An ignored event's run counts too; its goat-ci-result repeats the real run's verdict.
 */
export function mergeVerdict(
  runs: ReadonlyArray<Run>,
  jobsOf: (run: Run) => ReadonlyArray<Run>,
  head: string,
  knownFailure?: string,
): MergeVerdict {
  const newest = runs.reduce<Run | undefined>(
    (latest, candidate) => (latest === undefined || candidate.id > latest.id ? candidate : latest),
    undefined,
  );
  if (newest === undefined) return { merge: false, reason: `no goat-ci run on ${head} yet` };
  if (newest.status !== "completed") {
    return {
      merge: false,
      reason: `the newest goat-ci run on ${head} is ${newest.status}: ${newest.html_url}`,
    };
  }
  const run = jobsOf(newest).find((job) => job.name === RESULT_CHECK);
  if (run === undefined || run.status !== "completed") {
    return {
      merge: false,
      reason: `the newest goat-ci run on ${head} ended ${newest.conclusion} without ${RESULT_CHECK}; re-run it: ${newest.html_url}`,
    };
  }
  if (run.conclusion === "success") return { merge: true, run };
  const reason = knownFailure?.trim();
  if (reason) return { merge: true, run, knownFailure: reason };
  return {
    merge: false,
    reason: `${RESULT_CHECK} on ${head} is ${run.conclusion}: ${run.html_url}. Fix it, re-run it, or pass --known-failure with the reason and a link to the matching dev run.`,
  };
}

function gh(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
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
  const runs = JSON.parse(
    gh([
      "api",
      `repos/${repo}/actions/workflows/goat-ci.yml/runs?head_sha=${head}&per_page=100`,
      "--jq",
      ".workflow_runs",
    ]),
  ) as ReadonlyArray<Run>;
  const jobsOf = (run: Run) =>
    JSON.parse(
      gh(["api", `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, "--jq", ".jobs"]),
    ) as ReadonlyArray<Run>;
  const verdict = mergeVerdict(runs, jobsOf, head, values["known-failure"]);
  if (!verdict.merge) {
    console.error(`not merging ${view.url}: ${verdict.reason}`);
    return 1;
  }
  console.log(`${RESULT_CHECK} ${verdict.run.conclusion} on ${head}: ${verdict.run.html_url}`);
  if (values["dry-run"]) return 0;
  if (verdict.knownFailure !== undefined) {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-merge-"));
    const body = NodePath.join(dir, "body.md");
    NodeFS.writeFileSync(
      body,
      `Merging with ${RESULT_CHECK} ${verdict.run.conclusion} on ${head} (${verdict.run.html_url}): ${verdict.knownFailure}\n`,
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
