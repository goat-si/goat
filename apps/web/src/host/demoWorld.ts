// Demo world for the fake host: the Part 1 boards' content in English (design/paper/part1/*.jsx).
// Faces match the board avatars (2R-1: GOAT round/zinc, Reviewer squircle/ember, CI Watch bean/clay,
// Release Notes hex/goat, Browser Hand cloud/moss, Standup shield/slate, Scout pebble/dusk).
import { blankCard, item, line, type FakeThread, type FakeWorld } from "./fakeHost.ts";
import type { BotProfile, LogLine, ThreadCard } from "./wire.ts";

/** The boards' clock: 28 Nov 2026, 3:41 PM local. */
export const DEMO_NOW = new Date(2026, 10, 28, 15, 41, 0);
const at = (h: number, m: number, s = 0, dayOffset = 0) => new Date(2026, 10, 28 + dayOffset, h, m, s).toISOString();
const ENGINE = { driver: "codex" as const, model: "gpt-6.1-sol", runtimeMode: "full-access" };

type Ev = Parameters<typeof line>[2];
function thread(card: ThreadCard, events: Array<[string, Ev]>): FakeThread {
  const lines: LogLine[] = events.map(([t, ev], i) => line(i + 1, t, ev));
  return { card: { ...card, appliedSeq: lines.length }, lines };
}
const created = (c: ThreadCard): Ev => ({ type: "thread.created", kind: c.kind, title: c.title, projectId: c.projectId, botId: c.botId, parent: c.parent, engine: c.engine, followUpMode: c.followUpMode });
const tool = (threadId: string, runId: string, id: string, t: string, verb: string, summary: string, status: "completed" | "running" = "completed"): Ev => ({
  type: "item.completed", runId, engineLocator: null,
  item: { ...item(threadId, runId, id, t, { type: "dynamic_tool", toolName: verb, input: null, toolSummary: summary }), status },
});
const say = (threadId: string, runId: string, id: string, t: string, text: string): Ev => ({
  type: "item.completed", runId, engineLocator: null,
  item: item(threadId, runId, id, t, { type: "assistant_message", messageId: `m-${id}`, text, streaming: false }),
});
const userIn = (inputId: string, text: string, from: "user" | "system" = "user"): Ev => ({ type: "input.accepted", inputId, from: { kind: from }, mode: "followup", text, clientRequestId: `demo-${inputId}` });

function botThread(botId: string, title: string, o: Partial<ThreadCard>, events: Array<[string, Ev]> = []): FakeThread {
  const card = { ...blankCard(`t-${botId}`, "bot", title, o.updatedAt ?? at(15, 0), { botId, parent: null, model: ENGINE.model, cwd: "~/Developer/opencodex", projectId: "opencodex" }), ...o };
  return thread(card, [[card.updatedAt, created(card)], ...events]);
}

export function demoWorld(): FakeWorld {
  const bots: BotProfile[] = [
    { botId: "main", name: "GOAT", purpose: "Runs your other bots and answers you", face: { shape: "round", color: "zinc", goat: true }, role: "main", threadId: "t-main", engine: ENGINE },
    { botId: "reviewer", name: "Reviewer", purpose: "Reviews PRs when they open", face: { shape: "squircle", color: "ember", goat: true }, role: "member", threadId: "t-reviewer", engine: ENGINE },
    { botId: "browser", name: "Browser Hand", purpose: "Does things in your browser", face: { shape: "cloud", color: "moss", goat: true }, role: "member", threadId: "t-browser", engine: ENGINE },
    { botId: "ci", name: "CI Watch", purpose: "Keeps main green", face: { shape: "bean", color: "clay", goat: true }, role: "member", threadId: "t-ci", engine: ENGINE },
    { botId: "release", name: "Release Notes", purpose: "Drafts release notes", face: { shape: "hex", color: "goat", goat: true }, role: "member", threadId: "t-release", engine: ENGINE },
    { botId: "standup", name: "Standup", purpose: "Posts the morning standup", face: { shape: "shield", color: "slate", goat: true }, role: "member", threadId: "t-standup", engine: ENGINE },
    { botId: "scout", name: "Scout", purpose: "Watches new issues", face: { shape: "pebble", color: "dusk", goat: true }, role: "member", threadId: "t-scout", engine: ENGINE },
  ];
  const R = "t-reviewer";
  const threads: Record<string, FakeThread> = {};
  const add = (t: FakeThread) => { threads[t.card.id] = t; };

  add(botThread("main", "GOAT", { updatedAt: at(15, 41), lastExcerpt: "2 decisions waiting" }));
  add(botThread("reviewer", "Reviewer", {
    updatedAt: at(15, 6), status: "needs_you", needsYou: { kind: "decision", summary: "Your call on #7712" },
    lastExcerpt: "Finished reviewing opencodex #7712.", children: { running: 1, total: 3 },
  }, [
    [at(15, 2), userIn("in-r1", "Routine On PR opened ran", "system")],
    [at(15, 2), { type: "run.started", runId: "run-r1", inputIds: ["in-r1"], generation: 1, engineRef: null }],
    [at(15, 6), say(R, "run-r1", "r1-a", at(15, 6), "Finished reviewing opencodex #7712. It loads the Antigravity model list per account, and all 81 tests pass. One catch: if the account list fails to load, the model list shows up empty.")],
    [at(15, 2, 10), { type: "child.started", childThreadId: "t-review-7712", task: "Review #7712", byItemId: "r1-tool" }],
    [at(15, 6, 22), { type: "child.reported", childThreadId: "t-review-7712", childRunId: "run-c1", status: "done", summary: "81 passed. One catch: an empty account list leaves the model list empty.", childCursor: { epoch: "demo", seq: 9 } }],
    [at(15, 6, 30), { type: "request.opened", requestId: "req-merge", runId: "run-r1", itemId: null, kind: "decision", summary: "Merge PR #7712 into main?\nIt goes into the next npm release. The empty list can be fixed in a follow-up PR.", options: [{ id: "merge", label: "Merge" }, { id: "fix", label: "Fix first" }, { id: "later", label: "Not now" }], recommended: "merge" }],
    [at(15, 6, 31), { type: "run.finished", runId: "run-r1", outcome: "done" }],
  ]));
  add(botThread("browser", "Browser Hand", { updatedAt: at(15, 30), status: "needs_you", needsYou: { kind: "signin", summary: "Needs a Luma code" }, lastExcerpt: "Needs a Luma login code. Check your phone." }));
  add(botThread("ci", "CI Watch", { updatedAt: at(15, 38), status: "running", lastExcerpt: "3/5 checks passing" }));
  add(botThread("release", "Release Notes", { updatedAt: at(15, 39), status: "running", lastExcerpt: "Drafting v2.93.0" }));
  add(botThread("standup", "Standup", { updatedAt: at(7, 0, 0, -1), lastExcerpt: "Next 7:00 AM" }));
  add(botThread("scout", "Scout", { updatedAt: at(13, 40), lastExcerpt: "Quiet for 2h" }));

  // Reviewer's worker threads (Overview → Tasks, 25D-0).
  const parent = (by: string) => ({ threadId: R, byItemId: by });
  const c7712 = { ...blankCard("t-review-7712", "worker", "Review #7712", at(15, 6, 22), { botId: "reviewer", parent: parent("r1-tool"), model: ENGINE.model, cwd: "~/Developer/opencodex", projectId: "opencodex" }), lastExcerpt: "81 passed." };
  add(thread(c7712, [
    [at(15, 2, 10), created(c7712)],
    [at(15, 2, 10), userIn("in-c1", "Review opencodex #7712 when it opens. Run the tests.")],
    [at(15, 2, 10), { type: "run.started", runId: "run-c1", inputIds: ["in-c1"], generation: 1, engineRef: null }],
    [at(15, 2, 30), tool("t-review-7712", "run-c1", "c1-1", at(15, 2, 30), "Checked out", "codex/pr-7712")],
    [at(15, 3, 0), tool("t-review-7712", "run-c1", "c1-2", at(15, 3, 0), "Read", "3 changed files +42 −7")],
    [at(15, 5, 0), tool("t-review-7712", "run-c1", "c1-3", at(15, 5, 0), "Ran", "pnpm test 81 passed")],
    [at(15, 6, 0), tool("t-review-7712", "run-c1", "c1-4", at(15, 6, 0), "Commented", "12 review comments")],
    [at(15, 6, 22), say("t-review-7712", "run-c1", "c1-a", at(15, 6, 22), "81 passed. One catch: if the account list fails to load, the model list shows up empty. Keeping the previous list looks safer.")],
    [at(15, 6, 22), { type: "run.finished", runId: "run-c1", outcome: "done" }],
  ]));
  const cfix = { ...blankCard("t-fix-empty", "worker", "Fix empty list fallback", at(15, 39), { botId: "reviewer", parent: parent("r2-tool"), model: ENGINE.model, cwd: "~/Developer/opencodex", projectId: "opencodex" }), status: "running" as const };
  add(thread(cfix, [
    [at(15, 30), created(cfix)],
    [at(15, 30), userIn("in-f1", "Keep the previous model list when the account list fails to load.")],
    [at(15, 30), { type: "run.started", runId: "run-f1", inputIds: ["in-f1"], generation: 1, engineRef: null }],
    [at(15, 32), tool("t-fix-empty", "run-f1", "f1-1", at(15, 32), "Read", "accountModels.ts +2 files")],
  ]));
  const c7709 = { ...blankCard("t-review-7709", "worker", "Review #7709", at(16, 10, 0, -1), { botId: "reviewer", parent: parent("r0-tool"), model: ENGINE.model, cwd: "~/Developer/opencodex", projectId: "opencodex" }) };
  add(thread(c7709, [[at(16, 0, 0, -1), created(c7709)]]));

  // Person-started threads (thread mode, LXD-0 / C2Y-0 / 1MFK-1).
  const user = (id: string, title: string, projectId: string, o: Partial<ThreadCard>, t: string) => ({ ...blankCard(id, "user", title, t, { botId: null, parent: null, model: ENGINE.model, cwd: `~/Developer/${projectId}`, projectId }), ...o });
  const p6 = user("t-perf6", "Perf Lane 6: Shell-snapshot callers", "goat", { status: "running" }, at(15, 40));
  add(thread(p6, [
    [at(15, 30), created(p6)],
    [at(15, 30), userIn("in-p1", "Find every shell-snapshot caller, add the cache and get check:changed passing.")],
    [at(15, 30), { type: "run.started", runId: "run-p1", inputIds: ["in-p1"], generation: 1, engineRef: null }],
    [at(15, 31), tool("t-perf6", "run-p1", "p1-1", at(15, 31), "Explored", "41 call sites of shellSnapshot()")],
    [at(15, 32), tool("t-perf6", "run-p1", "p1-2", at(15, 32), "Read", "GitManager.ts +6 files")],
    [at(15, 33), { type: "item.completed", runId: "run-p1", engineLocator: null, item: item("t-perf6", "run-p1", "p1-3", at(15, 33), { type: "file_change", fileName: "shellSnapshotCache.ts", additions: 118, deletions: 22 }) }],
    [at(15, 34), { type: "item.completed", runId: "run-p1", engineLocator: null, item: item("t-perf6", "run-p1", "p1-4", at(15, 34), { type: "command_execution", input: "pnpm check:changed", title: "pnpm check:changed", exitCode: 1, outputIndicatesFailure: true }) }],
    [at(15, 34, 12), say("t-perf6", "run-p1", "p1-a", at(15, 34, 12), "The cache is in. One test depends on the cache invalidation order, so I'm changing it to wait for the cache to clear.")],
    [at(15, 34, 12), { type: "run.finished", runId: "run-p1", outcome: "done" }],
    [at(15, 40, 38), userIn("in-p2", "Make the test wait for the cache to clear.")],
    [at(15, 40, 38), { type: "run.started", runId: "run-p2", inputIds: ["in-p2"], generation: 1, engineRef: null }],
  ]));
  add(thread(user("t-t3", "T3 Code Catch-Up PR Status", "goat", { status: "needs_you", needsYou: { kind: "question", summary: "Pick the PR order" }, children: { running: 2, total: 23 } }, at(15, 20)), []));
  add(thread(user("t-sume", "Build Sume API Aggregator", "ima2-gen", { status: "needs_you", needsYou: { kind: "approval", summary: "Approve the API key change" }, children: { running: 2, total: 17 } }, at(15, 10)), []));
  add(thread(user("t-incoming", "Review Incoming PRs for N…", "opencodex", { status: "needs_you", needsYou: { kind: "decision", summary: "Merge #9179?" } }, at(15, 5)), []));
  add(thread(user("t-perf5", "Perf Lane 5: Keepalive leases", "goat", { status: "running" }, at(15, 35)), []));
  add(thread(user("t-l9", "L9 Windows check PR #525", "ima2-gen", {}, at(12, 0)), []));
  add(thread(user("t-perf4", "Perf Lane 4: Client-runtime flags", "goat", {}, at(11, 0)), []));
  add(thread(user("t-perf3", "Perf Lane 3: Trace firehose & sampling", "goat", {}, at(10, 0)), []));
  add(thread(user("t-perf1", "Perf Lane 1: Pen ControlMaster", "goat", {}, at(9, 0)), []));
  return { epoch: "demo", bots, threads };
}

/** 1MFK-1: two queued messages behind the running turn of Perf Lane 6. */
export function withQueue(w: FakeWorld): FakeWorld {
  const t = w.threads["t-perf6"]!;
  const n = t.lines.length;
  t.lines.push(line(n + 1, at(15, 40, 50), userIn("in-q1", "Also run the web tests after the cache fix")));
  t.lines.push(line(n + 2, at(15, 40, 55), userIn("in-q2", "Then open a PR against dev and link the stall report")));
  return w;
}
