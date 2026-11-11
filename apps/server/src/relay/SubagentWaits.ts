import { isSideChatThread, type ThreadId } from "@goat/contracts";
import {
  subagentRequestAwareness,
  type SubagentRequestAwareness,
} from "@goat/shared/agentAwareness";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionAwareness.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const MAX_WAITS = 2048;
const MAX_ANCESTORS = 64;

class SubagentWaitError extends Schema.TaggedError<SubagentWaitError>()("SubagentWaitError", {
  reason: Schema.String,
}) {}

export function makeSubagentWaits(threads: ThreadManagement.ThreadManagementService["Service"]) {
  const waits = new Map<
    ThreadId,
    { parentId: ThreadId; request: SubagentRequestAwareness; seen: number }
  >();
  let sweep = 0;
  let sweeping = false;
  const read = (id: ThreadId) =>
    threads
      .getAgentAwarenessSnapshot(id)
      .pipe(Effect.map((snapshot) => snapshot.threads[0] ?? null));
  // These run per event inside the relay's publish span.
  const update = Effect.fnUntraced(function* (id: ThreadId, thread: AgentAwarenessThread | null) {
    const previous = waits.get(id);
    const request =
      thread !== null && thread.archivedAt === null ? subagentRequestAwareness(thread) : null;
    if (request === null) {
      waits.delete(id);
      return previous === undefined ? [] : [previous.parentId];
    }
    if (!previous && waits.size >= MAX_WAITS)
      return yield* new SubagentWaitError({ reason: "Too many waiting subagents" });
    const seen = new Set<ThreadId>([id]);
    let current: AgentAwarenessThread | null = thread;
    for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
      if (current === null) {
        waits.delete(id);
        return previous === undefined ? [] : [previous.parentId];
      }
      if (current.lineage.relationshipToParent !== "subagent" && !isSideChatThread(current)) {
        const parentId = current.id;
        waits.set(id, { parentId, request, seen: sweep });
        return previous && previous.parentId !== parentId
          ? [previous.parentId, parentId]
          : [parentId];
      }
      const parentId = current.lineage.parentThreadId ?? current.sideChatOf ?? null;
      if (parentId === null || seen.has(parentId))
        return yield* new SubagentWaitError({ reason: "Invalid subagent lineage" });
      seen.add(parentId);
      current = yield* read(parentId);
    }
    return yield* new SubagentWaitError({ reason: "Subagent lineage exceeds limit" });
  });
  const forParent = Effect.fnUntraced(function* (parentId: ThreadId) {
    let selected: SubagentRequestAwareness | null = null;
    for (const [id, entry] of waits) {
      if (entry.parentId !== parentId) continue;
      const thread = yield* read(id);
      const request =
        thread !== null && thread.archivedAt === null ? subagentRequestAwareness(thread) : null;
      if (request === null) {
        waits.delete(id);
        continue;
      }
      waits.set(id, { parentId, request, seen: sweeping ? sweep : entry.seen });
      if (selected === null || DateTime.isGreaterThan(request.createdAt, selected.createdAt))
        selected = request;
    }
    return selected;
  });
  const beginSweep = () => {
    sweep += 1;
    sweeping = true;
  };
  const finishSweep = () => {
    sweeping = false;
    const parents = new Set<ThreadId>();
    for (const [id, entry] of waits) {
      if (entry.seen === sweep) continue;
      waits.delete(id);
      parents.add(entry.parentId);
    }
    return [...parents];
  };
  return { read, update, forParent, beginSweep, finishSweep };
}
