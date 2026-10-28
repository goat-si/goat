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

export interface CheckRun {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
}

export type MergeVerdict =
  | { readonly merge: true; readonly run: CheckRun; readonly knownFailure?: string }
  | { readonly merge: false; readonly reason: string };

/**
 * GitHub reads a required check from its newest run on the commit, and a re-run or an ignored
 * event's republished result is always the newest, so the highest id decides.
 */
export function mergeVerdict(
  runs: ReadonlyArray<CheckRun>,
  head: string,
  knownFailure?: string,
): MergeVerdict {
  const run = runs.reduce<CheckRun | undefined>(
    (newest, candidate) => (newest === undefined || candidate.id > newest.id ? candidate : newest),
    undefined,
  );
  if (run === undefined) return { merge: false, reason: `no ${RESULT_CHECK} on ${head} yet` };
  if (run.status !== "completed") {
    return { merge: false, reason: `${RESULT_CHECK} on ${head} is ${run.status}: ${run.html_url}` };
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
      `repos/${repo}/commits/${head}/check-runs?check_name=${RESULT_CHECK}&filter=all&per_page=100`,
      "--jq",
      ".check_runs",
    ]),
  ) as ReadonlyArray<CheckRun>;
  const verdict = mergeVerdict(runs, head, values["known-failure"]);
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
