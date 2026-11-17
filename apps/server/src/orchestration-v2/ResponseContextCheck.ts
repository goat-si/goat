import type {
  ComposerContextId,
  ComposerContextRecord,
  EnvironmentId,
  ResponseContextRecord,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

export interface CheckedResponseContexts {
  readonly records: ReadonlyArray<ComposerContextRecord>;
  readonly checkedResponseIds: ReadonlySet<ComposerContextId>;
}

const isResponse = (record: ComposerContextRecord): record is ResponseContextRecord =>
  record.kind === "response" && "citation" in record;

/**
 * A reply names a response by ids its client chose. An agent is told to read it only when the
 * item is an assistant message of the receiving thread, or of the thread that thread shows its
 * history from, on this server. Subagents stay only when that thread ran them here. Every other
 * response record is left unchecked, which the provider text shows as unavailable.
 */
export const checkResponseContexts = Effect.fn("ResponseContextCheck.check")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly records: ReadonlyArray<ComposerContextRecord>;
  readonly store: Pick<ProjectionStoreV2Shape, "getThread" | "getTurnItem" | "getThreadRecords">;
}) {
  const checkedResponseIds = new Set<ComposerContextId>();
  if (!input.records.some(isResponse)) {
    return { records: input.records, checkedResponseIds } satisfies CheckedResponseContexts;
  }
  const thread = yield* input.store.getThread(input.threadId);
  const readable = new Set<ThreadId>([input.threadId]);
  if (thread.sideChatOf) readable.add(thread.sideChatOf);
  if (thread.forkedFrom?.type === "run") readable.add(thread.forkedFrom.threadId);

  const records: ComposerContextRecord[] = [];
  for (const record of input.records) {
    if (!isResponse(record)) {
      records.push(record);
      continue;
    }
    const { citation } = record;
    if (citation.environmentId !== input.environmentId || !readable.has(citation.threadId))
      continue;
    const item = yield* input.store.getTurnItem({
      threadId: citation.threadId,
      itemId: record.itemId,
    });
    if (item?.type !== "assistant_message" || item.messageId !== citation.messageId) continue;
    const named = record.subagents ?? [];
    const children =
      named.length === 0
        ? new Set<ThreadId>()
        : new Set(
            (yield* input.store.getThreadRecords(citation.threadId, [
              "subagents",
            ])).subagents.flatMap((subagent) =>
              subagent.childThreadId === null ? [] : [subagent.childThreadId],
            ),
          );
    const subagents = named.filter(
      (subagent) => subagent.environmentId === undefined && children.has(subagent.threadId),
    );
    const { subagents: _named, ...rest } = record;
    records.push(subagents.length > 0 ? { ...rest, subagents } : rest);
    checkedResponseIds.add(record.contextId);
  }
  return { records, checkedResponseIds } satisfies CheckedResponseContexts;
});
