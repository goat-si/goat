import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@goat/contracts";
import type { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { useComposerDraftStore } from "../composerDraftStore";
import { readEnvironmentThreadRefs, readThreadShell } from "../state/entities";
import { releaseComposerDraftUploads } from "./composerDraftUploads";

/** A thread whose composer draft a parent's deletion also invalidates. */
export type ThreadChildDraft = {
  readonly id: ThreadId;
  readonly sideChatOf?: ThreadId | null | undefined;
};

/** The shells the client already holds, for when the family read is unavailable or fails. */
function readShellDrafts(environmentId: EnvironmentId): ReadonlyArray<ThreadChildDraft> {
  return readEnvironmentThreadRefs(environmentId).flatMap((ref) => {
    const shell = readThreadShell(ref);
    return shell === null ? [] : [{ id: shell.id, sideChatOf: shell.sideChatOf }];
  });
}

/**
 * The threads to read drafts from before deleting `parent`. The family read reaches side chats the
 * shell snapshot leaves out, and never blocks the delete: a client without it keeps its shells.
 */
export async function readThreadsDeletedWith(
  parent: ScopedThreadRef,
  loadFamily: () => Promise<
    AsyncResult.AsyncResult<{ readonly threads: ReadonlyArray<ThreadChildDraft> }, unknown>
  >,
): Promise<ReadonlyArray<ThreadChildDraft>> {
  const familySupported =
    appAtomRegistry.get(environmentServerConfigsAtom).get(parent.environmentId)
      ?.shellThreadFamilies === true;
  const family = familySupported ? await loadFamily() : null;
  return family?._tag === "Success" ? family.value.threads : readShellDrafts(parent.environmentId);
}

/**
 * Drops the composer drafts of `parent` and of every side chat its deletion takes with it. Forks
 * keep their drafts, as they outlive the parent.
 */
export function clearThreadDraftsDeletedWith(
  parent: ScopedThreadRef,
  threads: ReadonlyArray<ThreadChildDraft>,
): void {
  const clear = (ref: ScopedThreadRef) => {
    releaseComposerDraftUploads(ref);
    useComposerDraftStore.getState().clearDraftThread(ref);
  };
  clear(parent);
  for (const thread of threads) {
    if (thread.sideChatOf === parent.threadId) {
      clear(scopeThreadRef(parent.environmentId, thread.id));
    }
  }
}
