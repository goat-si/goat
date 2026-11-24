import type { OrchestrationV2ProviderThread, ProviderThreadId, ThreadId } from "@goat/contracts";
import type * as Fiber from "effect/Fiber";
import type { LiveSessionEntry } from "./ProviderSessionManager.ts";
import { isLoadKeyFor } from "./ProviderSessionKeys.ts";

export interface IdleThreadUnload {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly generation: number;
  readonly fiber: Fiber.Fiber<void, never> | null;
}

export function detachIdleThreads(
  pending: ReadonlyMap<ProviderThreadId, IdleThreadUnload>,
  threadId: ThreadId,
) {
  const remaining = new Map(pending);
  const fibers: Array<Fiber.Fiber<void, never>> = [];
  for (const [id, entry] of pending) {
    if (entry.threadId !== threadId) continue;
    remaining.delete(id);
    if (entry.fiber !== null) fibers.push(entry.fiber);
  }
  return { remaining, fibers };
}

export function claimIdleThreadUnload(
  current: Map<string, LiveSessionEntry>,
  key: string,
  runtime: LiveSessionEntry["runtime"],
  input: {
    readonly providerThreadId: ProviderThreadId;
    readonly threadId: ThreadId;
    readonly generation: number;
  },
  pending: IdleThreadUnload,
): readonly [boolean | null, Map<string, LiveSessionEntry>] {
  const latest = current.get(key);
  if (
    latest?.runtime !== runtime ||
    latest.idleThreadUnloads.get(input.providerThreadId)?.generation !== input.generation
  )
    return [null, current];
  const idleThreadUnloads = new Map(latest.idleThreadUnloads);
  idleThreadUnloads.delete(input.providerThreadId);
  const isCurrent = isLoadKeyFor(
    latest.loadedProviderThreadKeyByThread.get(input.threadId),
    pending.providerThread,
  );
  const loadedProviderThreadKeyByThread = new Map(latest.loadedProviderThreadKeyByThread);
  if (isCurrent) loadedProviderThreadKeyByThread.delete(input.threadId);
  const updated = new Map(current);
  updated.set(key, { ...latest, loadedProviderThreadKeyByThread, idleThreadUnloads });
  return [isCurrent, updated];
}
