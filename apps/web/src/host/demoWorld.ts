// Demo world for the fake host: the Part 1 boards' content in English (design/paper/part1/*.jsx).
// Faces match the board avatars (2R-1: GOAT round/zinc, Reviewer squircle/ember, CI Watch bean/clay,
// Release Notes hex/goat, Browser Hand cloud/moss, Standup shield/slate, Scout pebble/dusk).
import { blankCard, item, line, type FakeThread, type FakeWorld } from "./fakeHost.ts";
import type { BotProfile, LogLine, ThreadCard } from "./wire.ts";

/** The boards' clock: 28 Nov 2026, 3:41 PM local. */
export const DEMO_NOW = new Date(2026, 10, 28, 15, 41, 0);
const at = (h: number, m: number, s = 0, dayOffset = 0) => new Date(2026, 10, 28 + dayOffset, h, m, s).toISOString();
const MODEL = { instanceId: "codex", model: "gpt-6.1-sol" };
const ENGINE = MODEL;

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
  const card = { ...blankCard(`t-${botId}`, "bot", title, o.updatedAt ?? at(15, 0), { botId, parent: null, model: MODEL.model, cwd: "~/Developer/opencodex", projectId: "opencodex" }), ...o };
  return thread(card, [[card.updatedAt, created(card)], ...events]);
}

export function demoWorld(): FakeWorld {
  const bots: BotProfile[] = [
    { botId: "main", name: "GOAT", purpose: "Runs your other bots and answers you", face: { shape: "round", color: "zinc", goat: true }, role: "main", sessionThreadId: "t-main", defaultModelSelection: MODEL },
    { botId: "reviewer", name: "Reviewer", purpose: "Reviews PRs when they open", face: { shape: "squircle", color: "ember", goat: true }, role: "member", sessionThreadId: "t-reviewer", defaultModelSelection: MODEL },
    { botId: "browser", name: "Browser Hand", purpose: "Does things in your browser", face: { shape: "cloud", color: "moss", goat: true }, role: "member", sessionThreadId: "t-browser", defaultModelSelection: MODEL },
    { botId: "ci", name: "CI Watch", purpose: "Keeps main green", face: { shape: "bean", color: "clay", goat: true }, role: "member", sessionThreadId: "t-ci", defaultModelSelection: MODEL },
    { botId: "release", name: "Release Notes", purpose: "Drafts release notes", face: { shape: "hex", color: "goat", goat: true }, role: "member", sessionThreadId: "t-release", defaultModelSelection: MODEL },
    { botId: "standup", name: "Standup", purpose: "Posts the morning standup", face: { shape: "shield", color: "slate", goat: true }, role: "member", sessionThreadId: "t-standup", defaultModelSelection: MODEL },
    { botId: "scout", name: "Scout", purpose: "Watches new issues", face: { shape: "pebble", color: "dusk", goat: true }, role: "member", sessionThreadId: "t-scout", defaultModelSelection: MODEL },
  ];
  const R = "t-reviewer";
  const threads: Record<string, FakeThread> = {};
  const add = (t: FakeThread) => { threads[t.card.id] = t; };

  add(botThread("main", "GOAT", { updatedAt: at(15, 41), latestAnswerExcerpt: "2 decisions waiting" }));
  add(botThread("reviewer", "Reviewer", {
    updatedAt: at(15, 6), status: "needs_you", needsYou: { kind: "decision", summary: "Your call on #7712" },
    latestAnswerExcerpt: "Finished reviewing opencodex #7712.", children: { running: 1, total: 3 },
  }, [
    [at(15, 2), userIn("in-r1", "Routine On PR opened ran", "system")],
    [at(15, 2), { type: "run.started", runId: "run-r1", inputIds: ["in-r1"], generation: 1, engineRef: null }],
    [at(15, 6), say(R, "run-r1", "r1-a", at(15, 6), "Finished reviewing opencodex #7712. It loads the Antigravity model list per account, and all 81 tests pass. One catch: if the account list fails to load, the model list shows up empty.")],
    [at(15, 2, 10), { type: "child.started", childThreadId: "t-review-7712", task: "Review #7712", byItemId: "r1-tool" }],
    [at(15, 6, 22), { type: "child.reported", childThreadId: "t-review-7712", childRunId: "run-c1", status: "completed", summary: "81 passed. One catch: an empty account list leaves the model list empty.", childCursor: { epoch: "demo", seq: 9 } }],
    [at(15, 6, 30), { type: "request.opened", requestId: "req-merge", runId: "run-r1", itemId: null, kind: "decision", summary: "Merge PR #7712 into main?\nIt goes into the next npm release. The empty list can be fixed in a follow-up PR.", options: [{ id: "merge", label: "Merge", consequence: "Merges #7712 into main; it ships in the next npm release." }, { id: "fix", label: "Fix first", consequence: "Starts a fix for the empty list before merging." }, { id: "later", label: "Not now", consequence: "Leaves the PR open; you can decide later." }], recommended: "merge" }],
    [at(15, 6, 31), { type: "run.finished", runId: "run-r1", outcome: "completed" }],
  ]));
  add(botThread("browser", "Browser Hand", { updatedAt: at(15, 30), status: "needs_you", needsYou: { kind: "signin", summary: "Needs a Luma code" }, latestAnswerExcerpt: "Needs a Luma login code. Check your phone." }));
  add(botThread("ci", "CI Watch", { updatedAt: at(15, 38), status: "running", latestAnswerExcerpt: "3/5 checks passing" }));
  add(botThread("release", "Release Notes", { updatedAt: at(15, 39), status: "running", latestAnswerExcerpt: "Drafting v2.93.0" }));
  add(botThread("standup", "Standup", { updatedAt: at(7, 0, 0, -1), latestAnswerExcerpt: "Next 7:00 AM" }));
  add(botThread("scout", "Scout", { updatedAt: at(13, 40), latestAnswerExcerpt: "Quiet for 2h" }));

  // Reviewer's worker threads (Overview → Tasks, 25D-0).
  const parent = (by: string) => ({ threadId: R, byItemId: by });
  const c7712 = { ...blankCard("t-review-7712", "worker", "Review #7712", at(15, 6, 22), { botId: "reviewer", parent: parent("r1-tool"), model: MODEL.model, cwd: "~/Developer/opencodex", projectId: "opencodex" }), latestAnswerExcerpt: "81 passed." };
  add(thread(c7712, [
    [at(15, 2, 10), created(c7712)],
    [at(15, 2, 10), userIn("in-c1", "Review opencodex #7712 when it opens. Run the tests.")],
    [at(15, 2, 10), { type: "run.started", runId: "run-c1", inputIds: ["in-c1"], generation: 1, engineRef: null }],
    [at(15, 2, 30), tool("t-review-7712", "run-c1", "c1-1", at(15, 2, 30), "Checked out", "codex/pr-7712")],
    [at(15, 3, 0), tool("t-review-7712", "run-c1", "c1-2", at(15, 3, 0), "Read", "3 changed files +42 −7")],
    [at(15, 5, 0), tool("t-review-7712", "run-c1", "c1-3", at(15, 5, 0), "Ran", "pnpm test 81 passed")],
    [at(15, 6, 0), tool("t-review-7712", "run-c1", "c1-4", at(15, 6, 0), "Commented", "12 review comments")],
    [at(15, 6, 22), say("t-review-7712", "run-c1", "c1-a", at(15, 6, 22), "81 passed. One catch: if the account list fails to load, the model list shows up empty. Keeping the previous list looks safer.")],
    [at(15, 6, 22), { type: "run.finished", runId: "run-c1", outcome: "completed" }],
  ]));
  const cfix = { ...blankCard("t-fix-empty", "worker", "Fix empty list fallback", at(15, 39), { botId: "reviewer", parent: parent("r2-tool"), model: MODEL.model, cwd: "~/Developer/opencodex", projectId: "opencodex" }), status: "running" as const };
  add(thread(cfix, [
    [at(15, 30), created(cfix)],
    [at(15, 30), userIn("in-f1", "Keep the previous model list when the account list fails to load.")],
    [at(15, 30), { type: "run.started", runId: "run-f1", inputIds: ["in-f1"], generation: 1, engineRef: null }],
    [at(15, 32), tool("t-fix-empty", "run-f1", "f1-1", at(15, 32), "Read", "accountModels.ts +2 files")],
  ]));
  const c7709 = { ...blankCard("t-review-7709", "worker", "Review #7709", at(16, 10, 0, -1), { botId: "reviewer", parent: parent("r0-tool"), model: MODEL.model, cwd: "~/Developer/opencodex", projectId: "opencodex" }) };
  add(thread(c7709, [[at(16, 0, 0, -1), created(c7709)]]));

  // Person-started threads (thread mode, 1N65-1 / 1NEM-1 / 1OXX-1).
  const user = (id: string, title: string, projectId: string, o: Partial<ThreadCard>, t: string) => ({ ...blankCard(id, "user", title, t, { botId: null, parent: null, model: MODEL.model, cwd: `~/Developer/${projectId}`, projectId }), ...o });
  const B = "t-billing";
  const billing = user(B, "Refactor billing webhooks", "api-server", { status: "running" }, at(15, 40, 38));
  const cmd = (id: string, t: string, input: string, failed = false, status: "completed" | "running" = "completed"): Ev => ({ type: "item.completed", runId: id.startsWith("b2") ? "run-b2" : "run-b1", engineLocator: null,
    item: { ...item(B, id.startsWith("b2") ? "run-b2" : "run-b1", id, t, { type: "command_execution", input, title: input, ...(failed ? { exitCode: 1, outputIndicatesFailure: true } : { exitCode: 0 }) }), status } });
  add(thread(billing, [
    [at(15, 30), created(billing)],
    [at(15, 30), userIn("in-b1", "The sidebar flickers when I switch threads quickly. Can you find out why and fix it?")],
    [at(15, 30), { type: "run.started", runId: "run-b1", inputIds: ["in-b1"], generation: 1, engineRef: null }],
    [at(15, 31), tool(B, "run-b1", "b1-1", at(15, 31), "Explored", "3 files, 2 searches")],
    [at(15, 32), { type: "item.completed", runId: "run-b1", engineLocator: null, item: item(B, "run-b1", "b1-2", at(15, 32), { type: "file_change", fileName: "Sidebar.tsx", additions: 118, deletions: 22 }) }],
    [at(15, 33), cmd("b1-3", at(15, 33), "bun run typecheck")],
    [at(15, 34), cmd("b1-4", at(15, 34), "bun test sidebar.test.ts", true)],
    [at(15, 34, 12), say(B, "run-b1", "b1-a", at(15, 34, 12), "The flicker came from the sidebar list re-keying every row when the active thread changed, so React remounted the whole list on each switch. I keyed rows by thread id and memoized the row renderer; typecheck passes.")],
    [at(15, 34, 12), { type: "run.finished", runId: "run-b1", outcome: "completed" }],
    [at(15, 40, 38), { type: "run.started", runId: "run-b2", inputIds: [], generation: 1, engineRef: null }],
    [at(15, 40, 40), cmd("b2-1", at(15, 40, 40), "bun test sidebar.test.ts", false, "running")],
  ]));
  add(thread(user("t-auth", "Fix flaky auth redirect test", "web-dashboard", { status: "needs_you", needsYou: { kind: "approval", summary: "Run the e2e suite?" } }, at(15, 38)), [
    [at(15, 37), { type: "run.started", runId: "run-a1", inputIds: [], generation: 1, engineRef: null }],
    [at(15, 38), { type: "item.completed", runId: "run-a1", engineLocator: null, item: { ...item("t-auth", "run-a1", "it-e2e", at(15, 38), { type: "approval_request", requestId: "req-e2e", requestKind: "command", prompt: "bun run test:e2e", reason: "Runs the browser suite against the local dev server (about 12 minutes).",
      options: [{ decision: "accept", label: "Run once" }, { decision: "acceptForSession", label: "Allow for this session" }, { decision: "decline", label: "Decline" }] }), status: "waiting" } }],
    [at(15, 38), { type: "request.opened", requestId: "req-e2e", runId: "run-a1", itemId: "it-e2e", kind: "approval", summary: "Run the e2e suite?" }],
  ]));
  add(thread(user("t-csv", "Add CSV export to reports", "web-dashboard", { status: "needs_you", needsYou: { kind: "question", summary: "Which columns?" } }, at(15, 36)), [
    [at(15, 35), { type: "run.started", runId: "run-c1", inputIds: [], generation: 1, engineRef: null }],
    [at(15, 36), { type: "item.completed", runId: "run-c1", engineLocator: null, item: { ...item("t-csv", "run-c1", "it-cols", at(15, 36), { type: "user_input_request", requestId: "req-cols", questions: [
      { id: "columns", header: "Columns", question: "Which columns go into the export?", multiSelect: true, required: true, options: [{ label: "Date", description: "Report date" }, { label: "Amount", description: "Total" }, { label: "Customer", description: "Customer name" }] },
      { id: "name", header: "File name", question: "What should the file be called?", allowCustomAnswer: true, required: false, options: [], initialAnswer: "" },
    ] }), status: "waiting" } }],
    [at(15, 36), { type: "request.opened", requestId: "req-cols", runId: "run-c1", itemId: "it-cols", kind: "question", summary: "Which columns?" }],
  ]));
  add(thread(user("t-cron", "Migrate cron jobs to queue", "api-server", { status: "failed" }, at(15, 20)), []));
  add(thread(user("t-copy", "Update onboarding copy", "web-dashboard", {}, at(15, 10)), []));
  add(thread(user("t-mem", "Investigate memory leak in worker", "api-server", { status: "running" }, at(15, 39)), []));
  add(thread(user("t-inv", "Write migration for invoices table", "api-server", { status: "running" }, at(15, 36)), []));
  return { epoch: "demo", bots, threads };
}

/** 1OXX-1: a queued message behind the running turn. */
export function withQueue(w: FakeWorld): FakeWorld {
  const t = w.threads["t-billing"]!;
  const n = t.lines.length;
  t.lines.push(line(n + 1, at(15, 40, 50), userIn("in-q1", "Also add a regression test for the sidebar key change")));
  return w;
}
