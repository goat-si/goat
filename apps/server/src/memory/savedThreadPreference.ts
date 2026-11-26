import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { MemoryService } from "./MemoryService.ts";

export const promotionMemoryId = (
  thread: M.ScopedThreadRef,
  key: string,
  stableUuid: (text: string) => string,
) => M.MemoryId.make(stableUuid(`${thread.environmentId}:${thread.threadId}:promotion:${key}`));

export const makeSavedPreferenceReader = (
  environmentId: M.EnvironmentId,
  stableUuid: (text: string) => string,
  read: MemoryService["Service"]["read"],
) =>
  Effect.fn("MemoryService.savedThreadPreference")(function* (
    input: M.ThreadMemoryInput,
    permit: Parameters<typeof read>[1],
  ) {
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
    return origin?.environmentId === environmentId && origin.threadId === threadId
      ? { memorySpaceId, memoryId }
      : null;
  });
