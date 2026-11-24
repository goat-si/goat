import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { piRecordField as field, piRecordString as string } from "./rpc.ts";
import type { ActivePiTurn } from "./turnState.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const prefix = "PI_SUBAGENT_ASYNC_JSON:";
const statuses = new Map<string, Status>([
  ["queued", "pending"],
  ["running", "running"],
  ["paused", "waiting"],
  ["complete", "completed"],
  ["partial", "completed"],
  ["failed", "failed"],
  ["rejected", "failed"],
  ["stopped", "interrupted"],
]);
type Status = "pending" | "running" | "waiting" | "completed" | "failed" | "interrupted";
type Member = { id: string; agent: string; model: string | undefined; status: Status };
type Tracked = {
  turn: ActivePiTurn;
  toolCallId: string;
  emitted: Map<string, { key: string; member: Member }>;
};

export function makeAsyncSubagents(callbacks: {
  member: (turn: ActivePiTurn, toolCallId: string, member: Member) => Effect.Effect<void>;
  pending: (turn: ActivePiTurn, pending: boolean) => Effect.Effect<void>;
}) {
  const tracked = new Map<string, Tracked>();
  let latest: ReadonlyArray<unknown> = [];
  const update = Effect.fnUntraced(function* (id: string, entry: Tracked, run: unknown) {
    const children = field(run, "children");
    let childrenSettled = true;
    for (const child of Array.isArray(children) ? children.slice(0, 256) : []) {
      const childId = string(child, "id"),
        agent = string(child, "agent");
      const state = string(child, "state");
      const status = state === undefined ? undefined : statuses.get(state);
      if (
        string(child, "kind") !== "step" ||
        childId === undefined ||
        agent === undefined ||
        status === undefined
      )
        continue;
      if (status === "running" || status === "pending" || status === "waiting")
        childrenSettled = false;
      const model = string(child, "model");
      const key = `${status}:${model ?? ""}`;
      if (entry.emitted.get(childId)?.key === key) continue;
      const member = { id: childId, agent, model, status };
      entry.emitted.set(childId, { key, member });
      yield* callbacks.member(entry.turn, entry.toolCallId, member);
    }
    const state = string(run, "state");
    const status = state === undefined ? undefined : statuses.get(state);
    if (
      status === undefined ||
      status === "running" ||
      status === "pending" ||
      status === "waiting"
    )
      return;
    if (!childrenSettled) return;
    for (const { member } of entry.emitted.values()) {
      if (["running", "pending", "waiting"].includes(member.status))
        yield* callbacks.member(entry.turn, entry.toolCallId, {
          ...member,
          status: status === "completed" ? "completed" : "interrupted",
        });
    }
    tracked.delete(id);
    if (
      ![...tracked.values()].some(
        (other) => other.turn.providerTurn.id === entry.turn.providerTurn.id,
      )
    )
      yield* callbacks.pending(entry.turn, false);
  });
  const track = Effect.fnUntraced(function* (id: string, turn: ActivePiTurn, toolCallId: string) {
    if (tracked.has(id) || tracked.size >= 128) return;
    const entry = { turn, toolCallId, emitted: new Map<string, { key: string; member: Member }>() };
    tracked.set(id, entry);
    yield* callbacks.pending(turn, true);
    const run = latest.find((value) => string(value, "id") === id);
    if (run !== undefined) yield* update(id, entry, run);
  });
  const snapshot = Effect.fnUntraced(function* (lines: unknown) {
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      if (typeof line !== "string" || !line.startsWith(prefix) || line.length > 262144) continue;
      const runs = field(Option.getOrUndefined(decodeJson(line.slice(prefix.length))), "runs");
      if (!Array.isArray(runs)) continue;
      latest = runs.slice(0, 128);
      for (const run of latest) {
        const id = string(run, "id");
        const entry = id === undefined ? undefined : tracked.get(id);
        if (id !== undefined && entry !== undefined) yield* update(id, entry, run);
      }
    }
  });
  const clear = Effect.fnUntraced(function* (turn?: ActivePiTurn) {
    const turns = new Set<ActivePiTurn>();
    for (const [id, entry] of tracked) {
      if (turn !== undefined && entry.turn !== turn) continue;
      for (const { member } of entry.emitted.values()) {
        if (["running", "pending", "waiting"].includes(member.status))
          yield* callbacks.member(entry.turn, entry.toolCallId, {
            ...member,
            status: "interrupted",
          });
      }
      turns.add(entry.turn);
      tracked.delete(id);
    }
    for (const ended of turns) yield* callbacks.pending(ended, false);
    if (turn === undefined) latest = [];
  });
  return { track, snapshot, clear };
}
