import { describe, expect, it } from "vitest";
import { line, item } from "../../../../host/fakeHost.ts";
import type { LogLine } from "../../../../host/wire.ts";
import { projectGoat2Thread } from "./projectThread.ts";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../../session-logic.ts";
import { deriveMessagesTimelineRows } from "../../../components/chat/MessagesTimeline.logic.ts";

const T = "2026-11-28T01:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T) + s * 1000).toISOString();
const accepted = (seq: number, id: string, text: string): LogLine =>
  line(seq, at(seq), { type: "input.accepted", inputId: id, from: { kind: "user" }, mode: "followup", text, clientRequestId: "c-" + id });
const started = (seq: number, runId: string, inputIds: string[]): LogLine =>
  line(seq, at(seq), { type: "run.started", runId, inputIds, generation: 1, engineRef: null });
const finished = (seq: number, runId: string): LogLine => line(seq, at(seq), { type: "run.finished", runId, outcome: "completed" });
const answer = (seq: number, runId: string, id: string, text: string): LogLine =>
  line(seq, at(seq), { type: "item.completed", runId, engineLocator: null, item: item("t", runId, id, at(seq), { type: "assistant_message", messageId: "m-" + id, text, streaming: false }) });
const command = (seq: number, runId: string, id: string, input: string): LogLine =>
  line(seq, at(seq), { type: "item.completed", runId, engineLocator: null, item: item("t", runId, id, at(seq), { type: "command_execution", input, exitCode: 0, output: "ok" }) });

const project = (lines: LogLine[], streaming: Record<string, string> = {}) => projectGoat2Thread({ threadId: "t", lines, streaming });
const kinds = (p: ReturnType<typeof project>) => p.visibleTurnItems.map((r) => r.item.type + ":" + r.sourceItemId);

describe("projectGoat2Thread", () => {
  it("decodes user, tool and assistant items with v1's schema", () => {
    const p = project([accepted(1, "i1", "hello"), started(2, "r1", ["i1"]), command(3, "r1", "c1", "ls"), answer(4, "r1", "a1", "done"), finished(5, "r1")]);
    expect(p.undecodable).toEqual([]);
    expect(kinds(p)).toEqual(["user_message:input:i1", "command_execution:c1", "assistant_message:a1"]);
    // v1 types: dates decode to effect DateTime, positions follow the projection order
    expect(typeof p.visibleTurnItems[1]!.item.updatedAt).toBe("object");
    expect(p.visibleTurnItems.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(p.runs).toEqual([{ runId: "r1", startedAt: at(2), finishedAt: at(5), outcome: "completed" }]);
    expect(p.activeRunId).toBeNull();
  });

  it("keeps queued inputs out, never shows a cancelled one, shows a delivered one once", () => {
    const p = project([
      started(1, "r1", []), accepted(2, "q1", "queued"), accepted(3, "q2", "cancel me"), accepted(4, "s1", "steer"),
      line(5, at(5), { type: "input.changed", inputId: "q2", cancelled: true }),
      line(6, at(6), { type: "input.delivered", inputId: "s1", outcome: "accepted" }),
      line(7, at(7), { type: "item.completed", runId: "r1", engineLocator: null, item: item("t", "r1", "echo", at(7), { type: "user_message", createdBy: "user", creationSource: "web", messageId: "s1", inputIntent: "steer", text: "steer", attachments: [] }) }),
    ]);
    expect(p.undecodable).toEqual([]);
    expect(kinds(p)).toEqual(["user_message:input:s1"]);
    expect(p.visibleTurnItems[0]!.item).toMatchObject({ type: "user_message", inputIntent: "steer", runId: "r1" });
    expect(p.activeRunId).toBe("r1");
  });

  it("groups a late item under its origin run, after that run's items", () => {
    const p = project([
      accepted(1, "i1", "one"), started(2, "r1", ["i1"]), command(3, "r1", "c1", "ls"), finished(4, "r1"),
      accepted(5, "i2", "two"), started(6, "r2", ["i2"]), answer(7, "r2", "a2", "second"),
      command(8, "r1", "late", "late subagent result"),
    ]);
    expect(kinds(p)).toEqual(["user_message:input:i1", "command_execution:c1", "command_execution:late", "user_message:input:i2", "assistant_message:a2"]);
  });

  it("puts streaming text last as an in-progress assistant message of the active run", () => {
    const p = project([accepted(1, "i1", "hi"), started(2, "r1", ["i1"])], { s1: "partial" });
    expect(p.undecodable).toEqual([]);
    expect(p.visibleTurnItems.at(-1)!.item).toMatchObject({ type: "assistant_message", text: "partial", streaming: true, status: "running", runId: "r1" });
    expect(p.activeRunStartedAt).toBe(at(2));
  });

  it("feeds v1's own timeline logic: user row, a work group with the command, the answer", () => {
    const p = project([accepted(1, "i1", "hello"), started(2, "r1", ["i1"]), command(3, "r1", "c1", "ls -la"), answer(4, "r1", "a1", "done"), finished(5, "r1")]);
    const entries = deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems: p.visibleTurnItems, optimisticMessages: [] });
    expect(entries.map((e) => e.kind)).toEqual(["message", "work", "message"]);
    const rows = deriveMessagesTimelineRows({ timelineEntries: entries, isWorking: false, turnDiffSummaries: [], supportsConversationRollback: false });
    const shape = rows.map((r) => r.kind);
    expect(shape).toContain("message");
    expect(shape.some((k) => k === "work" || k === "turn-fold")).toBe(true);
  });
});
