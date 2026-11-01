// @effect-diagnostics-next-line nodeBuiltinImport:off -- canonical body-free locator integrity.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
import { readOwnerSourceRows } from "./memoryOwnerSourceRows.ts";

export interface MemoryOwnerSourceReadCommitted {
  readonly policy: M.MemoryOwnerSourceReadPolicy;
  readonly version: number;
}
/** L5 maps its committed settings port here; no settings I/O under the Store lock. */
export class MemoryOwnerSourceReadPolicyPort extends Context.Service<
  MemoryOwnerSourceReadPolicyPort,
  {
    readonly read: Effect.Effect<MemoryOwnerSourceReadCommitted>;
    readonly changes: Effect.Effect<
      Stream.Stream<MemoryOwnerSourceReadCommitted>,
      never,
      Scope.Scope
    >;
    readonly recordRevokeAck: (
      ack: M.MemorySourceReadRevokeAck,
    ) => Effect.Effect<MemoryOwnerSourceReadCommitted, Service.MemoryAccessError>;
  }
>()("goat/memory/MemoryOwnerSourceReader/MemoryOwnerSourceReadPolicyPort") {}

const encodeInput = Schema.encodeSync(Schema.fromJsonString(M.MemoryHubSourceReadRequestInput));
export const sourceReadInput = (
  request: M.MemorySourceReadRequest,
): M.MemoryHubSourceReadRequestInput => ({
  protocolVersion: 1,
  memorySpaceId: request.memorySpaceId,
  memoryId: request.memoryId,
  requestId: request.requestId,
  sourceThread: request.sourceThread,
  sourceWatermark: request.sourceWatermark,
  messageIds: request.messageIds,
  limit: request.limit,
  ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  authorizedScopes: request.authorizedScopes,
});
export const sourceReadLocatorDigest = (input: M.MemoryHubSourceReadRequestInput) =>
  NodeCrypto.createHash("sha256").update(encodeInput(input)).digest("hex");
const denied = Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" }));
const strict = { onExcessProperty: "error" } as const;
const decodeRequest = Schema.decodeUnknownEffect(M.MemorySourceReadRequest);
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
const decodeOutcome = Schema.decodeUnknownEffect(M.MemorySourceReadOutcome);
const encodeOutcome = Schema.encodeEffect(Schema.fromJsonString(M.MemorySourceReadOutcome));
const encodeWatermark = Schema.encodeSync(Schema.fromJsonString(M.MemorySourceWatermark));

export class MemoryOwnerSourceReader extends Context.Service<
  MemoryOwnerSourceReader,
  {
    readonly policy: MemoryOwnerSourceReadPolicyPort["Service"] | undefined;
    /** Used only after authenticated collect on Sync's current pinned hub route. */
    readonly permit: (
      request: M.MemorySourceReadRequest,
    ) => Effect.Effect<void, Service.MemoryAccessError>;
    readonly reader: Service.MemoryOwnerCommittedReader & {
      readonly readForRelay: (
        request: M.MemorySourceReadRequest,
        permit: Effect.Effect<void, Service.MemoryAccessError>,
      ) => Effect.Effect<
        {
          readonly outcome: M.MemorySourceReadOutcome;
          readonly validate: Effect.Effect<void, Service.MemoryServiceError>;
        },
        Service.MemoryServiceError
      >;
    };
  }
>()("goat/memory/MemoryOwnerSourceReader") {}

const make = Effect.gen(function* () {
  const policyOption = yield* Effect.serviceOption(MemoryOwnerSourceReadPolicyPort);
  const policy = Option.getOrUndefined(policyOption);
  const settings = yield* Settings.MemoryHubCommittedSettings;
  const store = yield* Store.MemoryStore;
  const service = yield* Service.MemoryService;
  const sql = yield* SqlClient.SqlClient;
  const local = yield* (yield* Environment.ServerEnvironmentIdentity).getEnvironmentId;
  const query = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError(
        (cause) => new Store.MemoryStorageError({ stage: "owner-source-read", cause }),
      ),
    );
  const permit = Effect.fn("MemoryOwnerSourceReader.permit")(function* (
    input: M.MemorySourceReadRequest,
  ) {
    const request = yield* decodeRequest(input, strict).pipe(
      Effect.mapError(() => new Service.MemoryAccessError({ code: "route_unavailable" })),
    );
    if (!policy) return yield* denied;
    const binding = yield* settings.read.pipe(
      Effect.mapError(() => new Service.MemoryAccessError({ code: "fenced" })),
    );
    const committed = yield* policy.read;
    const now = yield* Clock.currentTimeMillis;
    if (
      binding.settings.mode === "disabled" ||
      binding.settings.memorySpaceId !== request.memorySpaceId ||
      request.sourceThread.environmentId !== local ||
      !request.stamp ||
      request.stamp.requesterCredentialVersion < 1 ||
      request.stamp.locatorDigest !== sourceReadLocatorDigest(sourceReadInput(request)) ||
      Date.parse(request.expiresAtHubTime) <= now ||
      Date.parse(request.expiresAtHubTime) > now + M.MEMORY_SOURCE_READ_TIMEOUT_MS ||
      !committed.policy.allowedRequesterEnvironmentIds.includes(request.requesterEnvironmentId) ||
      !committed.policy.enrollments.some(
        (e) =>
          e.state === "active" &&
          e.memorySpaceId === request.memorySpaceId &&
          e.ownerEnvironmentId === local &&
          e.requesterEnvironmentId === request.requesterEnvironmentId,
      )
    )
      return yield* denied;
  });
  const readCommitted: Service.MemoryOwnerCommittedReader["readCommitted"] = Effect.fn(
    "MemoryOwnerSourceReader.readCommitted",
  )(function* (request, reauthorize) {
    yield* reauthorize;
    yield* permit(request);
    if (!policy) return yield* denied;
    const captured = yield* policy.read;
    const binding = yield* settings.read.pipe(
      Effect.mapError(() => new Service.MemoryAccessError({ code: "fenced" })),
    );
    const fence = Effect.gen(function* () {
      yield* reauthorize;
      yield* permit(request);
      const current = yield* policy.read;
      const currentBinding = yield* settings.read.pipe(
        Effect.mapError(() => new Service.MemoryAccessError({ code: "fenced" })),
      );
      if (
        current.version !== captured.version ||
        current.policy.ownerPolicyEpoch !== captured.policy.ownerPolicyEpoch ||
        currentBinding.version !== binding.version
      )
        return yield* new Service.MemoryAccessError({ code: "fenced" });
    });
    return yield* store.transact(
      Effect.gen(function* () {
        yield* fence;
        const input = {
          memorySpaceId: request.memorySpaceId,
          memoryId: request.memoryId,
          sourceThread: request.sourceThread,
          messageIds: request.messageIds,
          limit: request.limit,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        };
        const before = yield* service.prepareSourceRead(input, fence);
        if (
          encodeWatermark(before.request.sourceWatermark) !==
          encodeWatermark(request.sourceWatermark)
        )
          return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
        const thread = yield* query(
          sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=${request.sourceThread.threadId} AND deleted_at IS NULL`,
        );
        const boundary = yield* query(
          sql<{
            event_id: string;
            sequence: number;
          }>`SELECT event_id,sequence FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${request.sourceThread.threadId} AND event_id IN (${request.sourceWatermark.fromEventId},${request.sourceWatermark.toEventId}) AND sequence<=${request.sourceWatermark.throughSequence} LIMIT 2`,
        );
        if (
          !thread.length ||
          !boundary.some((e) => e.event_id === request.sourceWatermark.fromEventId) ||
          !boundary.some(
            (e) =>
              e.event_id === request.sourceWatermark.toEventId &&
              e.sequence === request.sourceWatermark.throughSequence,
          )
        )
          return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
        const rows = yield* query(
          readOwnerSourceRows(sql, {
            threadId: request.sourceThread.threadId,
            throughSequence: request.sourceWatermark.throughSequence,
            messageIds: request.messageIds,
          }),
        );
        if (
          rows.length !== request.messageIds.length ||
          rows.some((row) => row.bytes > M.MEMORY_SOURCE_READ_OUTCOME_MAX_BYTES)
        )
          return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
        const cursor =
          request.cursor === undefined
            ? 0
            : rows.findIndex((row) => request.cursor === `source:${row.sequence}`) + 1;
        if (request.cursor !== undefined && cursor === 0)
          return yield* new Store.MemoryStoreConflict({ code: "invalid_cursor" });
        const messages = yield* Effect.forEach(rows, (row) =>
          query(decodeMessage(row.payload_json, strict)),
        );
        const selected = messages
          .slice(cursor, cursor + request.limit)
          .map((m) => ({ messageId: m.id, text: m.text }));
        const outcome = {
          kind: "available" as const,
          page: {
            sourceThread: request.sourceThread,
            watermark: request.sourceWatermark,
            messages: selected,
            nextCursor:
              cursor + selected.length < messages.length
                ? `source:${rows[cursor + selected.length - 1]!.sequence}`
                : null,
          },
        };
        if (scanMemoryValue(outcome).kind !== "allowed")
          return { kind: "unavailable" as const, code: "secret_detected" as const };
        const checked = yield* decodeOutcome(outcome, strict).pipe(
          Effect.mapError(() => new Store.MemoryStoreConflict({ code: "payload_too_large" })),
        );
        yield* query(encodeOutcome(checked));
        const after = yield* service.prepareSourceRead(input, fence);
        if (
          before.generation !== after.generation ||
          encodeWatermark(after.request.sourceWatermark) !==
            encodeWatermark(request.sourceWatermark)
        )
          return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
        yield* fence;
        return checked;
      }),
    );
  });
  const readForRelay: MemoryOwnerSourceReader["Service"]["reader"]["readForRelay"] = Effect.fn(
    "MemoryOwnerSourceReader.readForRelay",
  )(function* (request, reauthorize) {
    const input = {
      memorySpaceId: request.memorySpaceId,
      memoryId: request.memoryId,
      sourceThread: request.sourceThread,
      messageIds: request.messageIds,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    };
    const before = yield* service.prepareSourceRead(input, reauthorize);
    const outcome = yield* readCommitted(request, reauthorize);
    // Re-run bounded source SQL in a fresh transaction after transport preparation,
    // including every retry. The closure lasts only for this in-flight response.
    const validate = Effect.gen(function* () {
      const current = yield* readCommitted(request, reauthorize);
      const after = yield* service.prepareSourceRead(input, reauthorize);
      if (
        before.generation !== after.generation ||
        (yield* query(encodeOutcome(current))) !== (yield* query(encodeOutcome(outcome)))
      )
        return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
    });
    return { outcome, validate };
  });
  return MemoryOwnerSourceReader.of({ policy, permit, reader: { readCommitted, readForRelay } });
});
export const layer = Layer.effect(MemoryOwnerSourceReader, make);
