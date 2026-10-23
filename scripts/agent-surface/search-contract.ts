// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain Node script; the server's Effect runtime is driven through servedCatalog.ts.
/**
 * The search contract of GOAT's agent surface at the checked-out commit:
 *
 * 1. Each task an agent does daily is found by one goat_describe query, phrased the way an agent
 *    would type it, and its path is callable through goat_call by a thread.
 * 2. A search never implies absence or completeness when it returned less than everything that
 *    matched (aside-codemode issue #41; D16 in docs/internals/agent-surface.md). Checked against
 *    the server's own per-resource searches, so the script keeps no second index.
 *
 *   node scripts/agent-surface/search-contract.ts [--json]
 *
 * Queries are fixed; changing one changes what is measured, so add new phrasings instead of
 * tuning old ones until they pass. Exit 1 when a task or a completeness check fails.
 */
import { loadServedCatalog, type CallResult } from "./servedCatalog.ts";

interface Task {
  readonly task: string;
  /** Any of these paths answers the task. */
  readonly paths: ReadonlyArray<string>;
  readonly queries: ReadonlyArray<string>;
}

/** Results an agent reads before giving up on a search. */
const TOP = 5;

const TASKS: ReadonlyArray<Task> = [
  {
    task: "launch a thread on a remote host",
    paths: ["ssh.thread_launch"],
    queries: [
      "launch remote thread",
      "start thread on another machine",
      "run thread on remote host",
      "ssh launch",
    ],
  },
  {
    task: "read a launched thread's result",
    paths: ["thread.read", "thread.status", "ssh.reports", "task.read"],
    queries: [
      "read thread result",
      "remote thread result",
      "launched thread status",
      "thread final answer",
    ],
  },
  {
    task: "answer a pending question",
    paths: ["pending_request.respond", "decision.answer"],
    queries: [
      "answer pending question",
      "respond to question",
      "reply to pending request",
      "answer user input",
    ],
  },
  {
    task: "watch a pull request until merge",
    paths: ["pull_request.watch"],
    queries: ["watch pull request", "watch PR", "babysit pr checks", "pr merge watch"],
  },
  {
    task: "check host pressure",
    paths: ["host.status"],
    queries: ["host pressure", "check host load", "machine cpu memory load", "which host has room"],
  },
];

interface Entry {
  readonly path: string;
  readonly available?: { readonly now: boolean; readonly reason?: string };
}
interface Search {
  readonly depth: "search";
  readonly entries: ReadonlyArray<Entry>;
  readonly truncated: boolean;
}

const catalog = await loadServedCatalog();
const valueOf = (result: CallResult) =>
  result.structuredContent as Record<string, unknown> | undefined;
const describe = async (args: object) => valueOf(await catalog.callAsThread("goat_describe", args));
const search = async (query: string, resource?: string) =>
  (await describe(resource === undefined ? { query } : { query, path: resource })) as
    | Search
    | undefined;

/** goat_call with no arguments: callable when it reaches argument checks or the handler. */
const callable = async (path: string) => {
  const envelope = valueOf(await catalog.callAsThread("goat_call", { path, args: {} })) as
    | {
        readonly status?: string;
        readonly error?: { readonly code?: string; readonly reason?: string };
      }
    | undefined;
  const reason = envelope?.error?.reason;
  const ok =
    envelope?.status === "ok" ||
    reason === "invalid_params" ||
    // Inert services stop a read with no required argument inside its handler.
    reason === "tool_error" ||
    envelope?.status === "needs_human";
  return {
    ok,
    outcome: envelope?.status === "ok" ? "ok" : (reason ?? envelope?.status ?? "no envelope"),
  };
};

const resources = (
  (await describe({})) as { readonly resources: ReadonlyArray<{ readonly resource: string }> }
).resources.map(({ resource }) => resource);

/** Every path the server matches for a query, gathered resource by resource. */
const allMatches = async (query: string) => {
  const found = new Set<string>();
  let capped = false;
  for (const resource of resources) {
    const result = await search(query, resource);
    for (const entry of result?.entries ?? []) found.add(entry.path);
    capped ||= result?.truncated === true;
  }
  return { found, capped };
};

const completeness = async (query: string) => {
  const top = await search(query);
  const all = await allMatches(query);
  const returned = top?.entries.length ?? 0;
  // Claims complete but the server matches more paths than it returned: issue #41.
  const silentLoss = top?.truncated === false && all.found.size > returned;
  // Says nothing matched while some resource matches.
  const falseAbsence = returned === 0 && all.found.size > 0;
  return {
    query,
    returned,
    truncated: top?.truncated ?? null,
    matching: all.capped ? ">=" + all.found.size : all.found.size,
    pass: !silentLoss && !falseAbsence,
  };
};

const tasks = [];
for (const task of TASKS) {
  const queries = [];
  for (const query of task.queries) {
    const result = await search(query);
    const rank = result?.entries.findIndex((entry) => task.paths.includes(entry.path)) ?? -1;
    queries.push({
      query,
      rank: rank === -1 ? null : rank + 1,
      returned: result?.entries.length ?? 0,
      truncated: result?.truncated ?? null,
    });
  }
  const calls = [];
  for (const path of task.paths) calls.push({ path, ...(await callable(path)) });
  const found = queries.some((query) => query.rank !== null && query.rank <= TOP);
  tasks.push({ task: task.task, queries, calls, pass: found && calls.some((call) => call.ok) });
}
const checks = [];
for (const task of TASKS) for (const query of task.queries) checks.push(await completeness(query));
// Broad words that match more than one page must report truncation.
for (const query of ["thread", "list", "read"]) checks.push(await completeness(query));
await catalog.dispose();

const report = { top: TOP, tasks, completeness: checks };
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  const lines = [
    "| Task | Query | Rank | Returned | Truncated |",
    "| --- | --- | ---: | ---: | --- |",
  ];
  for (const task of tasks)
    for (const query of task.queries)
      lines.push(
        "| " +
          (task.pass ? "" : "FAIL ") +
          task.task +
          " | " +
          query.query +
          " | " +
          (query.rank ?? "-") +
          " | " +
          query.returned +
          " | " +
          query.truncated +
          " |",
      );
  lines.push("", "goat_call as a thread, no arguments:");
  for (const task of tasks)
    for (const call of task.calls)
      lines.push("- " + call.path + ": " + call.outcome + (call.ok ? "" : " (not callable)"));
  lines.push(
    "",
    "| Completeness query | Returned | Truncated | Server matches | Pass |",
    "| --- | ---: | --- | ---: | --- |",
  );
  for (const check of checks)
    lines.push(
      "| " +
        check.query +
        " | " +
        check.returned +
        " | " +
        check.truncated +
        " | " +
        check.matching +
        " | " +
        (check.pass ? "yes" : "NO") +
        " |",
    );
  console.log(lines.join("\n"));
}
process.exitCode = tasks.every((task) => task.pass) && checks.every((check) => check.pass) ? 0 : 1;
