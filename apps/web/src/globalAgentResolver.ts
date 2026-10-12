import type { EnvironmentId, ThreadId } from "@goat/contracts";

import type { DraftId } from "./composerDraftStore";
import type { GlobalAgentRef } from "./globalAgentStore";

export type GlobalAgentResolution =
  | { readonly kind: "wait" }
  | {
      readonly kind: "open-thread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | { readonly kind: "open-draft"; readonly draftId: DraftId }
  | {
      /** Promoted draft without a shell yet: still arriving, or archived elsewhere. */
      readonly kind: "confirm-thread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | { readonly kind: "create"; readonly environmentId: EnvironmentId }
  | { readonly kind: "fallback" };

/** What the composer draft store still holds for ref.draftId. */
export type GlobalAgentDraftState = "none" | "unpromoted" | "promoted";

export interface GlobalAgentResolverInput {
  /** Every environment's thread shells have loaded; absence now means gone. */
  readonly bootstrapped: boolean;
  readonly ref: GlobalAgentRef | null;
  /** Active shell for ref's thread, or null when absent (archived threads leave the active shell). */
  readonly threadShell: {
    readonly archivedAt: string | null;
    readonly deletedAt?: string | null | undefined;
  } | null;
  readonly draftState: GlobalAgentDraftState;
  /** Whether ref.environmentId is among the known environments. */
  readonly refEnvironmentKnown: boolean;
  /** Environment to create a new global agent in, or null when none qualifies. */
  readonly scratchEnvironmentId: EnvironmentId | null;
}

function createOrFallback(scratchEnvironmentId: EnvironmentId | null): GlobalAgentResolution {
  return scratchEnvironmentId !== null
    ? { kind: "create", environmentId: scratchEnvironmentId }
    : { kind: "fallback" };
}

export function resolveGlobalAgent(input: GlobalAgentResolverInput): GlobalAgentResolution {
  if (!input.bootstrapped) return { kind: "wait" };
  const { ref } = input;
  if (ref !== null) {
    if (!input.refEnvironmentKnown) return { kind: "fallback" };
    const shell = input.threadShell;
    if (shell !== null && shell.archivedAt === null && shell.deletedAt == null) {
      return { kind: "open-thread", environmentId: ref.environmentId, threadId: ref.threadId };
    }
    if (shell === null && input.draftState === "unpromoted") {
      // Never sent, so no server thread exists that could have been archived.
      return { kind: "open-draft", draftId: ref.draftId };
    }
    if (shell === null && input.draftState === "promoted") {
      return { kind: "confirm-thread", environmentId: ref.environmentId, threadId: ref.threadId };
    }
  }
  return createOrFallback(input.scratchEnvironmentId);
}

/**
 * Settles "confirm-thread": the live shell appearing within the wait means the
 * promotion was still arriving; otherwise the thread is gone (archived or
 * deleted on another client) and a new global agent replaces it.
 */
export async function confirmPromotedGlobalAgent(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Read after the wait: a machine may reconnect (and offer scratch) meanwhile. */
  readonly readScratchEnvironmentId: () => EnvironmentId | null;
  /** Resolves when any shell appears or the wait times out. */
  readonly waitForShell: () => Promise<boolean>;
  /** Re-reads the shell after the wait; the wait itself only proves presence. */
  readonly readShell: () => GlobalAgentResolverInput["threadShell"];
}): Promise<GlobalAgentResolution> {
  await input.waitForShell();
  const shell = input.readShell();
  if (shell !== null && shell.archivedAt === null && shell.deletedAt == null) {
    return { kind: "open-thread", environmentId: input.environmentId, threadId: input.threadId };
  }
  return createOrFallback(input.readScratchEnvironmentId());
}
