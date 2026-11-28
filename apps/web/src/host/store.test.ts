import { describe, expect, it } from "vitest";
import { apply, deriveThread, emptyState, emptyThread, mergeLines, type HostState } from "./store.ts";
import { line, item } from "./fakeHost.ts";
import type { HostFrame, LogLine, ThreadCard } from "./wire.ts";
import { blankCard } from "./fakeHost.ts";

const card = (id: string, cardSeq: number, patch: Partial<ThreadCard> = {}): ThreadCard => ({ ...blankCard(id, "bot", id, "2026-11-28T00:00:00Z", { botId: id, parent: null, model: "m", cwd: "~" }), cardSeq, ...patch });
const withSub = (): HostState => ({ ...emptyState(), cardsSubId: "c1", threads: { t: emptyThread("t", "s1") } });
const run = (s: HostState, ...frames: HostFrame[]) => frames.reduce((acc, f) => apply(acc, f).state, s);
const ev = (l: LogLine): HostFrame => ({ type: "thread_event", subId: "s1", threadId: "t", line: l });

describe("cards", () => {
  it("upserts by cardSeq, removes, and resets", () => {
    let s = run(withSub(), { type: "card_changed", subId: "c1", card: card("a", 5) }, { type: "card_changed", subId: "c1", card: card("a", 3, { title: "stale" }) });
    expect(s.cards.a!.title).toBe("a");
    s = run(s, { type: "card_changed", subId: "c1", card: card("b", 6) }, { type: "card_removed", subId: "c1", threadId: "a", cardSeq: 7 });
    expect(Object.keys(s.cards)).toEqual(["b"]);
    s = run(s, { type: "cards_reset", subId: "c1", reason: "epoch_changed", epoch: "e2" });
    expect(s.cards).toEqual({});
  });
  it("drops frames from a stale subscription", () => {
    const s = run(withSub(), { type: "card_changed", subId: "old", card: card("a", 1) });
    expect(s.cards).toEqual({});
    const s2 = run(s, { type: "thread_event", subId: "stale", threadId: "t", line: line(1, "t", { type: "run.finished", runId: "r", outcome: "completed" }) });
    expect(s2.threads.t!.lines).toHaveLength(0);
  });
});

describe("thread fold", () => {
  const accepted = (seq: number, id: string, text: string) => line(seq, "2026-11-28T01:00:00Z", { type: "input.accepted", inputId: id, from: { kind: "user" }, mode: "followup", text, clientRequestId: "c-" + id });
  it("shows a user message once its run starts, then the bot answer", () => {
    const s = run(withSub(),
      ev(accepted(1, "i1", "hello")),
      ev(line(2, "t", { type: "run.started", runId: "r1", inputIds: ["i1"], generation: 1, engineRef: null })),
      ev(line(3, "t", { type: "item.completed", runId: "r1", engineLocator: null, item: item("t", "r1", "a1", "t", { type: "assistant_message", messageId: "m", text: "hi", streaming: false }) })),
      ev(line(4, "t", { type: "run.finished", runId: "r1", outcome: "completed" })));
    const d = deriveThread(s.threads.t);
    expect(d.entries.map((e) => e.kind)).toEqual(["user", "bot"]);
    expect(d.activeRunId).toBeNull();
    expect(d.acceptedClientRequestIds.has("c-i1")).toBe(true);
  });
  it("keeps inputs accepted during a run in the queue, applies input.changed", () => {
    const s = run(withSub(),
      ev(line(1, "t", { type: "run.started", runId: "r1", inputIds: [], generation: 1, engineRef: null })),
      ev(accepted(2, "q1", "one")), ev(accepted(3, "q2", "two")), ev(accepted(4, "q3", "three")),
      ev(line(5, "t", { type: "input.changed", inputId: "q1", text: "one!" })),
      ev(line(6, "t", { type: "input.changed", inputId: "q3", position: 0 })),
      ev(line(7, "t", { type: "input.changed", inputId: "q2", cancelled: true })));
    expect(deriveThread(s.threads.t).queued.map((q) => [q.inputId, q.text])).toEqual([["q3", "three"], ["q1", "one!"]]);
  });
  it("opens and resolves requests; checkpoint restores open requests and queue", () => {
    const opened = line(1, "t", { type: "request.opened", requestId: "rq", runId: null, itemId: null, kind: "decision", summary: "Merge?", options: [{ id: "merge", label: "Merge", consequence: "Merges it" }] });
    let s = run(withSub(), ev(opened));
    expect(deriveThread(s.threads.t).openRequests[0]!.options![0]!.label).toBe("Merge");
    s = run(s, ev(line(2, "t", { type: "request.resolved", requestId: "rq", outcome: "answered", optionId: "merge" })));
    expect(deriveThread(s.threads.t).openRequests).toHaveLength(0);
    const fold = { activeRunId: null, activeRunInputIds: [], activeRunReachedEngine: false, heldInputs: [], runningChildIds: [], lastRunOutcome: null, counters: { inputs: 0, runs: 0, items: 0 },
      queuedInputs: [{ inputId: "q9", text: "later", mode: "followup" as const, source: { kind: "user" as const } }],
      openRequests: [{ requestId: "rq2", runId: null, itemId: null, kind: "approval" as const, summary: "OK?" }] };
    const s2 = run(withSub(), ev(line(40, "t", { type: "checkpoint", card: card("t", 1), fold })));
    const d2 = deriveThread(s2.threads.t);
    expect(s2.threads.t!.hasOlder).toBe(true);
    expect(d2.openRequests.map((r) => r.requestId)).toEqual(["rq2"]);
    expect(d2.queued.map((q) => q.text)).toEqual(["later"]);
  });
  it("thread_reset clears the thread", () => {
    const s = run(withSub(), ev(accepted(1, "i1", "x")), { type: "thread_reset", subId: "s1", threadId: "t", reason: "too_far_behind", epoch: "e" });
    expect(s.threads.t!.lines).toHaveLength(0);
  });
  it("merges pages by seq and drops stale page answers", () => {
    let s = run(withSub(), ev(accepted(5, "i5", "five")));
    s = { ...s, threads: { t: { ...s.threads.t!, pageReqId: "p1", hasOlder: true } } };
    const older = [accepted(3, "i3", "three"), accepted(5, "i5", "five")];
    expect(run(s, { type: "page", reqId: "nope", threadId: "t", lines: older, hasMore: false }).threads.t!.lines).toHaveLength(1);
    const s2 = run(s, { type: "page", reqId: "p1", threadId: "t", lines: older, hasMore: false });
    expect(s2.threads.t!.lines.map((l) => l.seq)).toEqual([3, 5]);
    expect(s2.threads.t!.hasOlder).toBe(false);
    expect(mergeLines([accepted(2, "a", "a")], [accepted(1, "b", "b")]).map((l) => l.seq)).toEqual([1, 2]);
  });
});

describe("text_append", () => {
  it("appends at the UTF-16 offset and asks for a resync on mismatch", () => {
    const base = withSub();
    const a = apply(base, { type: "text_append", subId: "s1", threadId: "t", itemId: "x", offset: 0, text: "hi 👋" });
    expect(a.state.threads.t!.streaming.x).toBe("hi 👋");
    const b = apply(a.state, { type: "text_append", subId: "s1", threadId: "t", itemId: "x", offset: "hi 👋".length, text: "!" });
    expect(b.state.threads.t!.streaming.x).toBe("hi 👋!");
    const c = apply(b.state, { type: "text_append", subId: "s1", threadId: "t", itemId: "x", offset: 4, text: "?" });
    expect(c.outgoing).toEqual([{ type: "resync_item", subId: "s1", itemId: "x" }]);
    expect(c.state.threads.t!.streaming.x).toBe("hi 👋!");
  });
  it("fixes the stream kind at the first delta, keeps it on resync, clears it when the item completes", () => {
    let s = run(withSub(), { type: "text_append", subId: "s1", threadId: "t", itemId: "r", offset: 0, text: "think", streamKind: "reasoning_text" });
    s = run(s, { type: "text_append", subId: "s1", threadId: "t", itemId: "r", offset: 5, text: "ing" });
    expect(s.threads.t!.streamKinds.r).toBe("reasoning_text");
    s = run(s, { type: "text_append", subId: "s1", threadId: "t", itemId: "r", offset: 0, text: "thinking!" });
    expect(s.threads.t!.streamKinds.r).toBe("reasoning_text");
    s = run(s, { type: "text_append", subId: "s1", threadId: "t", itemId: "a", offset: 0, text: "answer" });
    expect(s.threads.t!.streamKinds.a).toBe("assistant_text");
    // Only answer text is the bot speaking.
    expect(deriveThread(s.threads.t).entries.map((e) => e.kind === "bot" ? e.text : e.kind)).toEqual(["answer"]);
    s = run(s, ev(line(1, "t", { type: "item.completed", runId: "r1", engineLocator: null, item: item("t", "r1", "r", "t", { type: "reasoning", text: "thinking!", streaming: false }) })));
    expect(s.threads.t!.streamKinds).toEqual({ a: "assistant_text" });
    expect(s.threads.t!.streaming).toEqual({ a: "answer" });
  });
  it("keeps the latest live usage of the subscription", () => {
    const usage = { usedTokens: 1200, maxTokens: 200000 } as never;
    const s = run(withSub(), { type: "thread_usage", subId: "s1", threadId: "t", usage, updatedAt: "2026-11-29T01:00:00Z" },
      { type: "thread_usage", subId: "stale", threadId: "t", usage, updatedAt: "2026-11-29T02:00:00Z" });
    expect(s.threads.t!.usage).toEqual({ usage, updatedAt: "2026-11-29T01:00:00Z" });
  });
  it("answers ping with pong", () => {
    expect(apply(withSub(), { type: "ping", at: "now" }).outgoing).toEqual([{ type: "pong", at: "now" }]);
  });
});
