import { describe, expect, it } from "@effect/vitest";
import { BotRemoteWork, BotThreadRow, EnvironmentId, BotId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { selectHomeCurrentOpenableWork } from "./homeCurrentOpenableWork.ts";

const row = Schema.decodeUnknownSync(BotThreadRow);
const remote = Schema.decodeUnknownSync(BotRemoteWork);
const at = "2026-11-04T00:00:00.000Z";
const task = row({
  kind: "task",
  task: { taskId: "a", title: "a", status: "running", updatedAt: at },
  view: { taskId: "a", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: false,
  mainMessagesSinceQuiet: 0,
  worker: { environmentId: "source", threadId: "worker" },
});
const coding = row({
  kind: "coding",
  taskId: "a",
  environmentId: "source",
  threadId: "coding",
  state: "bound",
  lastActivityAt: at,
});
const orphan = row({
  kind: "coding",
  taskId: "other",
  environmentId: "source",
  threadId: "orphan",
  state: "bound",
  lastActivityAt: at,
});
const launch = remote({
  childWorkId: "remote",
  taskId: "a",
  callerThreadId: "caller",
  host: "box",
  state: "bound",
  lastActivityAt: at,
  environmentId: "destination",
  threadId: "coding",
});
const source = EnvironmentId.make("source");
const destination = EnvironmentId.make("destination");
const input = {
  sourceEnvironmentId: source,
  botId: BotId.make("main"),
  eligible: true,
  list: "ready" as const,
  current: { rows: [task, coding, orphan], remoteWork: [launch], mainMessageCount: 0 },
  isOpenable: (_id: EnvironmentId) => true,
};

describe("current Home links", () => {
  it("contains only links under current task rows, scoped by destination", () => {
    const value = selectHomeCurrentOpenableWork(input);
    expect(value.work.running.map((entry) => entry.row.task.taskId)).toEqual(["a"]);
    expect(value.links.map((link) => link.kind)).toEqual(["worker", "coding", "remote"]);
    expect(value.links[2]?.launchedFrom).toEqual({ environmentId: source, threadId: "caller" });
    expect(value.links.map((link) => [link.environmentId, link.threadId])).toEqual([
      ["source", "worker"],
      ["source", "coding"],
      ["destination", "coding"],
    ]);
  });
  it("drops unreachable remote links and restores them on reconnect", () => {
    const offline = selectHomeCurrentOpenableWork({
      ...input,
      isOpenable: (id) => id !== destination,
    });
    expect(offline.links.map((link) => link.environmentId)).toEqual([source, source]);
    expect(selectHomeCurrentOpenableWork(input).links).toHaveLength(3);
  });
  it("proves no links on failure or capability loss", () => {
    expect(selectHomeCurrentOpenableWork({ ...input, current: null }).links).toEqual([]);
    expect(selectHomeCurrentOpenableWork({ ...input, eligible: false }).links).toEqual([]);
  });
});
