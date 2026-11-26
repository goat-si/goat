import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { MemoryService } from "./MemoryService.ts";

export const promotionMemoryId = (
  thread: M.ScopedThreadRef,
  key: string,
  stableUuid: (text: string) => string,
) => M.MemoryId.make(stableUuid(`${thread.environmentId}:${thread.threadId}:promotion:${key}`));

/** `conversationMemoryEnabled` is the live pause policy; a paused environment shows no saved preference. */
export const makeSavedPreferenceReader = (
  environmentId: M.EnvironmentId,
  stableUuid: (text: string) => string,
  read: MemoryService["Service"]["read"],
  conversationMemoryEnabled: Effect.Effect<boolean>,
) =>
  Effect.fn("MemoryService.savedThreadPreference")(function* (
    input: M.ThreadMemoryInput,
    permit: Parameters<typeof read>[1],
  ) {
    if (!(yield* conversationMemoryEnabled)) return null;
    const { memorySpaceId, threadId } = input;
    const memoryId = promotionMemoryId({ environmentId, threadId }, "user", stableUuid);
    const item = yield* read({ memorySpaceId, memoryId, includeMarks: true }, permit).pipe(
      Effect.catchTags({
        MemoryStoreConflict: (error) =>
          error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (
      item?.status !== "active" ||
      item.pendingSync ||
      item.marks?.provenance === "unverified" ||
      item.localAvailability.exposure !== "visible" ||
      item.scope.kind !== "user"
    )
      return null;
    const origin = item.revision.provenance.sourceThread;
    if (origin?.environmentId !== environmentId || origin.threadId !== threadId) return null;
    // A pause that committed during the read withdraws the answer.
    return (yield* conversationMemoryEnabled) ? { memorySpaceId, memoryId } : null;
  });
