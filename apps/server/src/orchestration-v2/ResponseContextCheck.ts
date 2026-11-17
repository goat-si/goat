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

type StoredThread = Effect.Success<ReturnType<ProjectionStoreV2Shape["getThread"]>>;

const runForkSource = (thread: StoredThread): ThreadId | null =>
  thread.forkedFrom?.type === "run" ? thread.forkedFrom.threadId : null;

/**
 * A reply names a response by ids its client chose. An agent reads it only when the item is an
 * assistant message of the receiving thread or a thread it shows history from (every run fork
 * up, side-chat parents included), on this server, with subagents that thread ran here. Every
 * other response record stays unchecked, which the provider text shows as unavailable.
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
  const readable = new Set<ThreadId>([input.threadId]);
  const walked = new Set<ThreadId>([input.threadId]);
  let thread: StoredThread | null = yield* input.store.getThread(input.threadId);
  // A side chat is a run fork too. Inherited rows keep the id of the thread that holds them, at any
  // depth; a deleted thread is never named (thread.read refuses it), what it inherited still is.
  while (thread !== null) {
    const source = runForkSource(thread);
    if (source === null || walked.has(source)) break;
    walked.add(source);
    thread = yield* input.store.getThread(source).pipe(Effect.catch(() => Effect.succeed(null)));
    if (thread !== null && thread.deletedAt === null) readable.add(source);
  }

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
