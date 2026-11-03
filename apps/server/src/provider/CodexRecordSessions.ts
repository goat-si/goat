import { ProviderInstanceId, type ProviderSessionId, type ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type {
  CodexDetachedAppServerError,
  DetachedAppServerRecord,
} from "./CodexDetachedAppServer.ts";
import type { CodexInstanceRecordKey } from "./CodexSurvivors.ts";

type RecordSession = Pick<DetachedAppServerRecord, "instanceId" | "providerSessionId">;

/** A record serves exactly the provider session it names; one from before sessions were recorded serves none. */
export const servesSession = (
  record: RecordSession,
  instanceId: string,
  providerSessionId: string | null | undefined,
) =>
  record.instanceId === instanceId &&
  record.providerSessionId !== undefined &&
  record.providerSessionId === providerSessionId;

/** A record without a session may hold any session's threads, so it counts against all of them. */
export const blocksSession = (
  record: RecordSession,
  instanceId: string,
  providerSessionId: string | null | undefined,
) =>
  record.instanceId === instanceId &&
  (record.providerSessionId === undefined || record.providerSessionId === providerSessionId);

export const recordKey = (record: DetachedAppServerRecord): CodexInstanceRecordKey => ({
  instanceId: ProviderInstanceId.make(record.instanceId),
  recordName: record.name,
  ...(record.providerSessionId === undefined
    ? {}
    : { providerSessionId: record.providerSessionId }),
});

/**
 * Gives records written before sessions were recorded the session their evidence names, before any
 * reader picks records by session. A fence names its thread's session. Otherwise the instance's
 * running provider turns name one session, used only when the instance has a single such record.
 * Every other record keeps no session, so it blocks its whole instance as it did before.
 */
export const bootstrapRecordSessions = Effect.fn("CodexRecordSessions.bootstrap")(
  function* (input: {
    readonly records: ReadonlyArray<DetachedAppServerRecord>;
    readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
    readonly assignSession: (
      key: CodexInstanceRecordKey,
      providerSessionId: ProviderSessionId,
    ) => Effect.Effect<void, CodexDetachedAppServerError>;
  }) {
    const legacy = input.records.filter((record) => record.providerSessionId === undefined);
    if (legacy.length === 0) return input.records;
    const countByInstance = new Map<string, number>();
    for (const record of legacy)
      countByInstance.set(record.instanceId, (countByInstance.get(record.instanceId) ?? 0) + 1);
    let running:
      | Option.Option<ReadonlyMap<string, ReadonlySet<ProviderSessionId | null>>>
      | undefined;
    const assigned = new Map<string, ProviderSessionId>();
    for (const record of legacy) {
      const fences = [...(record.stopObligations ?? []), ...(record.goalBlocks ?? [])];
      let candidates: Option.Option<ReadonlySet<ProviderSessionId | null>>;
      if (fences.length > 0) {
        candidates = yield* fenceSessions(input.projections, record.instanceId, fences);
      } else if (countByInstance.get(record.instanceId) === 1) {
        running ??= yield* runningSessions(input.projections);
        candidates = Option.map(
          running,
          (byInstance) => byInstance.get(record.instanceId) ?? new Set(),
        );
      } else continue;
      if (Option.isNone(candidates) || candidates.value.size !== 1) continue;
      const [providerSessionId] = candidates.value;
      if (providerSessionId == null) continue;
      const written = yield* input
        .assignSession(recordKey(record), providerSessionId)
        .pipe(Effect.option);
      if (Option.isSome(written)) assigned.set(record.name, providerSessionId);
      else
        yield* Effect.logWarning("Could not record the session of a Codex process", {
          recordName: record.name,
        });
    }
    return input.records.map((record) => {
      const providerSessionId = assigned.get(record.name);
      return providerSessionId === undefined ? record : { ...record, providerSessionId };
    });
  },
);

/** A fence whose thread or provider thread is gone falls back to the instance's shared session, as goal recovery does. */
const fenceSessions = Effect.fn("CodexRecordSessions.fenceSessions")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  instanceId: string,
  fences: ReadonlyArray<{ readonly threadId: ThreadId; readonly nativeThreadId: string }>,
) {
  const providerInstanceId = ProviderInstanceId.make(instanceId);
  const shared = IdAllocator.derive.providerSession({ providerInstanceId });
  const sessions = new Set<ProviderSessionId | null>();
  for (const fence of fences) {
    const session = yield* projections.getThreadRecords(fence.threadId, ["providerThreads"]).pipe(
      Effect.map(
        (records) =>
          records.providerThreads.find(
            (thread) =>
              thread.providerInstanceId === providerInstanceId &&
              thread.nativeThreadRef?.nativeId === fence.nativeThreadId,
          )?.providerSessionId ?? shared,
      ),
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(shared) }),
      Effect.option,
    );
    if (Option.isNone(session)) return Option.none();
    sessions.add(session.value);
  }
  return Option.some(sessions);
});

/** The sessions of running Codex provider turns, per instance; null marks a turn without a session. */
const runningSessions = Effect.fn("CodexRecordSessions.runningSessions")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
) {
  return yield* Effect.gen(function* () {
    const byInstance = new Map<string, Set<ProviderSessionId | null>>();
    for (const threadId of yield* projections.getRecoveryThreadIds("runtime-cleanup")) {
      const projection = yield* projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.void }));
      if (!projection) continue;
      for (const turn of projection.providerTurns) {
        if (turn.status !== "running") continue;
        const thread = projection.providerThreads.find((item) => item.id === turn.providerThreadId);
        if (thread?.driver !== "codex") continue;
        const sessions = byInstance.get(thread.providerInstanceId) ?? new Set();
        sessions.add(thread.providerSessionId);
        byInstance.set(thread.providerInstanceId, sessions);
      }
    }
    return byInstance;
  }).pipe(Effect.option);
});
