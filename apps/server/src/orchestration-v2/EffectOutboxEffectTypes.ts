import type { CommandId, RunId, ThreadId } from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import type { OrchestrationEffectRequestV2, OrchestrationEffectStatusV2 } from "./EffectOutbox.ts";

export const REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS = [
  "provider-turn.reattach",
  "provider-runtime.continue",
  "provider-session.detach",
  "provider-thread.rollback",
  "checkpoint.capture",
  "scheduled-tasks.cleanup",
  "terminal.cleanup",
  "preview.cleanup",
  "device.release",
  "attachment.cleanup",
  "thread-title.generate",
  "delegated-tasks.stop",
  "computer-use.stop",
] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;

export const PROCESS_BOUND_EFFECT_TYPES = [
  "provider-turn.start",
  "provider-turn.interrupt",
  "provider-turn.steer",
  "provider-turn.restart",
  "runtime-request.respond",
] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;

export interface OrchestrationEffectV2 {
  readonly id: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationEffectRequestV2;
  readonly status: OrchestrationEffectStatusV2;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
}

export interface PendingOrchestrationEffectV2 {
  readonly id: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationEffectRequestV2;
  readonly availableAt?: DateTime.Utc;
}

export interface StartGuardSnapshot {
  readonly blockedThreads: ReadonlyArray<ThreadId>;
  readonly survivors: ReadonlyArray<{ readonly threadId: ThreadId; readonly sourceRunId: RunId }>;
}
