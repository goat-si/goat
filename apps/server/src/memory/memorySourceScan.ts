import { MAX_CONTINUATION_CHAIN } from "@goat/shared/orchestrationV2ManualContinuation";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { readThreadConversationMemoryPolicy } from "./conversationMemoryPolicy.ts";

/** Stream events one scan statement may visit; the scan yields to the event loop between pages. */
export const MEMORY_SOURCE_SCAN_PAGE_EVENTS = 1000;
const encodeSequences = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Number)));

/**
 * App-delegated tasks and provider subagents report to their parent, whose own summary keeps
 * what lasts. Their transcripts are parent instructions and one-off verdicts, never user memory.
 */
export const delegatedChildThreadSql = (threadColumn: string) =>
  `EXISTS (SELECT 1 FROM orchestration_events c WHERE c.application_event_version=2 AND c.aggregate_kind='thread' AND c.stream_id=${threadColumn} AND c.event_type='thread.created' AND json_extract(c.payload_json,'$.lineage.relationshipToParent')='subagent')`;

export const isDelegatedChildThread = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{
    found: number;
  }>`SELECT 1 AS found FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${threadId} AND event_type='thread.created' AND json_extract(payload_json,'$.lineage.relationshipToParent')='subagent' LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0),
  );

export interface SourceMessageRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly id: string | null;
  readonly runId: string | null;
  readonly role: string | null;
  /** Settled, non-blank, and from the user or assistant. */
  readonly usable: boolean;
}

export interface SourceScan {
  readonly messages: ReadonlyArray<SourceMessageRow>;
  /** Newest `message.updated` sequence per message id, within the observed bound. */
  readonly latest: ReadonlyMap<string, number>;
  /** Status of the newest run event per run id, within the observed bound. */
  readonly runStatus: ReadonlyMap<string, string | null>;
}

/**
 * Reads a thread's message and run events once, in index order and in bounded pages, so deciding
 * which messages are current costs one pass over the stream instead of one pass per message.
 * Messages after `afterSequence` are returned; run state and later message versions count only
 * up to `observedSequence` (null for no bound).
 */
export const scanSourceStream = Effect.fn("MemoryWorker.scanSourceStream")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly observedSequence: number | null;
  },
) {
  const history = yield* readThreadConversationMemoryPolicy(sql, input.threadId);
  const paused = history
    ? sql`CASE WHEN e.event_type='message.updated' AND EXISTS(
        SELECT 1 FROM conversation_memory_excluded_messages WHERE thread_id=e.stream_id AND message_id=json_extract(e.payload_json,'$.id')
      ) THEN 1 ELSE coalesce((SELECT enabled = 0 FROM conversation_memory_policy WHERE after_sequence < e.sequence ORDER BY after_sequence DESC, generation DESC LIMIT 1), 0) END`
    : sql`0`;
  const runUserMessage = history
    ? sql`CASE WHEN event_type != 'message.updated' THEN json_extract(payload_json,'$.userMessageId') END`
    : sql`NULL`;
  const continuationParent = history
    ? sql`CASE WHEN event_type='run.created' THEN coalesce(json_extract(payload_json,'$.restartContinuationOfRunId'),
          json_extract(payload_json,'$.usageLimitContinuationOfRunId')) END`
    : sql`NULL`;
  const assignedUser = history
    ? sql`(json_extract(payload_json,'$.role')='user' AND json_extract(payload_json,'$.runId') IS NOT NULL)`
    : sql`0`;
  const excludedMessages = new Set<string>();
  const inputRuns = new Map<string, Set<string>>();
  const associate = (messageId: string, runId: string) => {
    const runs = inputRuns.get(messageId);
    if (runs) runs.add(runId);
    else inputRuns.set(messageId, new Set([runId]));
  };
  const excludedRuns = new Set<string>();
  const createdRuns = new Set<string>();
  const continuations = new Map<string, { parent: string; prompt: string | null }>();
  const messages: SourceMessageRow[] = [];
  const latest = new Map<string, number>();
  const runStatus = new Map<string, string | null>();
  const observed = input.observedSequence ?? Number.MAX_SAFE_INTEGER;
  const upper = Math.max(observed, input.throughSequence);
  let cursor = 0;
  while (cursor < upper) {
    // Index-only: the page boundary costs no row reads.
    const bound = yield* sql<{
      sequence: number;
    }>`SELECT sequence FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${input.threadId} AND sequence>${cursor} AND sequence<=${upper} ORDER BY sequence LIMIT 1 OFFSET ${MEMORY_SOURCE_SCAN_PAGE_EVENTS - 1}`;
    const end = bound[0]?.sequence ?? upper;
    const rows = yield* sql<{
      sequence: number;
      event_id: string;
      event_type: string;
      id: string | null;
      run_id: string | null;
      user_message_id: string | null;
      continuation_parent: string | null;
      role: string | null;
      usable: number | null;
      paused: number;
      status: string | null;
    }>`SELECT sequence,event_id,event_type,${paused} AS paused,${runUserMessage} AS user_message_id,${continuationParent} AS continuation_parent,json_extract(payload_json,'$.id') AS id,
      CASE WHEN event_type='message.updated' THEN json_extract(payload_json,'$.runId') END AS run_id,
      CASE WHEN event_type='message.updated' THEN json_extract(payload_json,'$.role') END AS role,
      CASE WHEN event_type='message.updated' THEN coalesce(json_extract(payload_json,'$.streaming'),0)=0 AND trim(json_extract(payload_json,'$.text'))!='' AND json_extract(payload_json,'$.role') IN ('user','assistant') END AS usable,
      CASE WHEN event_type!='message.updated' THEN json_extract(payload_json,'$.status') END AS status
      FROM orchestration_events AS e
      WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${input.threadId} AND sequence>${cursor} AND sequence<=${end}
      AND ((event_type IN ('run.created','run.updated') AND sequence<=${observed}) OR (event_type='message.updated' AND (sequence>${input.afterSequence} OR paused=1 OR ${assignedUser})))
      ORDER BY sequence`;
    for (const row of rows) {
      // A resumed edit or a late assistant response can carry the same paused input.
      if (row.paused === 1) {
        if (row.event_type === "message.updated") {
          if (row.id !== null) excludedMessages.add(row.id);
          if (row.run_id !== null) excludedRuns.add(row.run_id);
        } else if (row.event_type === "run.created" && row.id !== null) excludedRuns.add(row.id);
      }
      if (row.event_type !== "message.updated") {
        if (row.id !== null) {
          runStatus.set(row.id, row.status);
          if (history && row.event_type === "run.created") {
            createdRuns.add(row.id);
            if (row.continuation_parent !== null)
              continuations.set(row.id, {
                parent: row.continuation_parent,
                prompt: row.user_message_id,
              });
          }
          if (row.user_message_id !== null) associate(row.user_message_id, row.id);
        }
        continue;
      }
      if (history && row.role === "user" && row.id !== null && row.run_id !== null)
        associate(row.id, row.run_id);
      if (row.id !== null && row.sequence <= observed) latest.set(row.id, row.sequence);
      if (
        row.sequence > input.afterSequence &&
        row.sequence <= input.throughSequence &&
        row.paused !== 1
      )
        messages.push({
          sequence: row.sequence,
          eventId: row.event_id,
          id: row.id,
          runId: row.run_id,
          role: row.role,
          usable: row.usable === 1,
        });
    }
    if (!bound.length) break;
    cursor = end;
    yield* Effect.yieldNow;
  }
  // Queued inputs can start a run or be steered into an already running one after resume.
  for (const id of excludedMessages)
    for (const run of inputRuns.get(id) ?? []) excludedRuns.add(run);
  // The continuation prompt is generated by the server. Its authority comes from its ancestors.
  for (const [id, continuation] of continuations) {
    let parent: string | undefined = continuation.parent;
    for (let depth = 1; parent !== undefined; depth++) {
      if (depth > MAX_CONTINUATION_CHAIN || !createdRuns.has(parent) || excludedRuns.has(parent)) {
        excludedRuns.add(id);
        break;
      }
      parent = continuations.get(parent)?.parent;
    }
    if (excludedRuns.has(id) && continuation.prompt !== null)
      excludedMessages.add(continuation.prompt);
  }
  return {
    messages: history
      ? messages.filter(
          (m) =>
            !(m.id !== null && excludedMessages.has(m.id)) &&
            !(m.runId !== null && excludedRuns.has(m.runId)),
        )
      : messages,
    latest,
    runStatus,
  } satisfies SourceScan;
});

/**
 * The messages a summary may read: the current version of each settled user message, and of each
 * assistant message whose run completed, outside rolled-back runs and exclusions.
 */
export const eligibleSourceMessages = (
  scan: SourceScan,
  filter: { readonly excluded?: ReadonlySet<string>; readonly ids?: ReadonlySet<string> },
) =>
  scan.messages.filter((message) => {
    if (!message.usable) return false;
    const { id, runId } = message;
    if (filter.ids && (id === null || !filter.ids.has(id))) return false;
    // SQL `NULL NOT IN (non-empty)` is unknown, so an id-less message is excluded then too.
    if (filter.excluded?.size && (id === null || filter.excluded.has(id))) return false;
    if (id !== null && (scan.latest.get(id) ?? message.sequence) > message.sequence) return false;
    const status = runId === null ? undefined : scan.runStatus.get(runId);
    if (runId !== null && status === "rolled_back") return false;
    return message.role === "user" || status === "completed";
  });

/** The whole thread, with no bound on later versions or run state. */
export const scanWholeSource = (sql: SqlClient.SqlClient, threadId: string) =>
  scanSourceStream(sql, {
    threadId,
    afterSequence: 0,
    throughSequence: Number.MAX_SAFE_INTEGER,
    observedSequence: null,
  });

/** Payload rows of the first `limit` eligible messages, in source order. */
export const readEligibleSourceRows = Effect.fn("MemoryWorker.readEligibleSourceRows")(function* (
  sql: SqlClient.SqlClient,
  input: Parameters<typeof scanSourceStream>[1] & {
    readonly excluded: ReadonlyArray<string>;
    readonly limit: number;
  },
) {
  const scan = yield* scanSourceStream(sql, input);
  const picked = eligibleSourceMessages(scan, { excluded: new Set(input.excluded) });
  if (!picked.length) return [];
  const sequences = encodeSequences(picked.slice(0, input.limit).map((row) => row.sequence));
  return yield* sql<{
    payload_json: string;
    sequence: number;
    event_id: string;
  }>`SELECT payload_json,sequence,event_id FROM orchestration_events WHERE sequence IN (SELECT value FROM json_each(${sequences})) ORDER BY sequence`;
});
