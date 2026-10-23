import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  EnvironmentAuthorizationError,
  AuthSessionId,
  SshHostAlias,
  SshHostResult,
  EnvironmentId,
  ThreadId,
  type SecretRequestAnswerInput,
  SecretRequestError,
  CommandId,
  Handoff,
  HandoffError,
  HandoffHuman,
  handoffSummary,
  isHandoffPending,
  isClockedHandoffPath,
  isHubDeviceHandoffPath,
  endsWithItsRun,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  TurnItemId,
  type HandoffReadInput,
  type HandoffRespondInput,
  type HandoffSummary,
  type NodeId,
  type RunId,
  OrchestrationV2RunStatus,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- AEAD encrypts human-only instructions outside the event log.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { itemHandoff } from "../orchestration-v2/handoffState.ts";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import { ThreadArchiveGate } from "../orchestration-v2/ThreadArchiveGate.ts";
import { canResolveHumanStep, sessionResolver } from "./HumanStepAuthority.ts";

export const SshProgressBinding = Schema.Struct({
  host: SshHostAlias,
  aliasGeneration: Schema.Int,
  operationId: Schema.String,
  completion: Schema.optional(
    Schema.Struct({
      result: SshHostResult,
      aliasRevision: Schema.optional(Schema.String),
    }),
  ),
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type SshProgressBinding = typeof SshProgressBinding.Type;
/** Provider approvals whose approval the server applies, keeping their arguments until it does. */
const PROVIDER_CONTINUATION_PATHS = [
  "provider.home_request",
  "provider.host_sync",
  "provider.settings",
  "provider.setup",
] as const;
export type ProviderContinuationPath = (typeof PROVIDER_CONTINUATION_PATHS)[number];
const isProviderContinuationPath = (path: string): path is ProviderContinuationPath =>
  (PROVIDER_CONTINUATION_PATHS as ReadonlyArray<string>).includes(path);
const ContinuationPayload = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("continuation"),
  human: HandoffHuman,
  args: Schema.Record(Schema.String, Schema.Unknown),
  approvedBySessionId: Schema.optional(AuthSessionId),
  sshProgress: Schema.optional(SshProgressBinding),
  namespace: Schema.optional(Schema.Literals(PROVIDER_CONTINUATION_PATHS)),
  /** What an approved provider change has done so far; its owning service decodes it. */
  progress: Schema.optional(Schema.Unknown),
});
const PrivatePayload = Schema.fromJsonString(
  Schema.Union([
    ContinuationPayload,
    Schema.Struct({
      version: Schema.Literal(1),
      kind: Schema.Literal("progress_only"),
      sshProgress: SshProgressBinding,
      retainUntil: Schema.Number,
    }),
    // A finished provider change keeps what it did, apart from the arguments it ran with.
    Schema.Struct({
      version: Schema.Literal(1),
      kind: Schema.Literal("provider_outcome"),
      namespace: Schema.Literals(PROVIDER_CONTINUATION_PATHS),
      progress: Schema.Unknown,
      retainUntil: Schema.Number,
    }),
    // Legacy non-SSH payloads remain readable, but are never resumed as SSH work.
    Schema.Struct({
      version: Schema.optional(Schema.Literal(0)),
      kind: Schema.optional(Schema.Literal("legacy")),
      human: HandoffHuman,
      args: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ]),
);
const encodePrivatePayload = Schema.encodeEffect(PrivatePayload);
const decodePrivatePayload = Schema.decodeUnknownEffect(PrivatePayload);
const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Handoff)),
);
const decodeRunStatus = Schema.decodeUnknownEffect(Schema.NullOr(OrchestrationV2RunStatus));
const decodeAddress = Schema.decodeUnknownEffect(
  Schema.Struct({ threadId: Handoff.fields.requestedBy.fields.threadId, handoffId: TurnItemId }),
);
const storeName = (id: string) =>
  `handoff-${NodeCrypto.createHash("sha256").update(id).digest("hex")}`;
const unavailable = (cause: unknown) => new HandoffError({ reason: "unavailable", cause });
const targetKey = (args: Readonly<Record<string, unknown>>) =>
  JSON.stringify(args, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );

export class Handoffs extends Context.Service<
  Handoffs,
  {
    /** Internal domain API: adapters supply human instructions, agents receive only the summary. */
    readonly create: (input: {
      readonly kind: Handoff["kind"];
      readonly title: string;
      readonly reason: string;
      readonly requestedBy: Handoff["requestedBy"];
      readonly target: Handoff["target"];
      readonly runId: RunId;
      readonly nodeId: NodeId;
      readonly human: HandoffHuman;
      readonly args: Readonly<Record<string, unknown>>;
      readonly expiresAt?: DateTime.Utc;
      readonly sshProgress?: SshProgressBinding;
    }) => Effect.Effect<HandoffSummary, HandoffError>;
    readonly read: (input: HandoffReadInput) => Effect.Effect<Handoff, HandoffError>;
    /** Client-only; caller supplies an authenticated, server-resolved label. */
    readonly open: (
      input: HandoffReadInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<
      { handoff: Handoff; human: HandoffHuman | null },
      HandoffError | EnvironmentAuthorizationError
    >;
    readonly respond: (
      input: HandoffRespondInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<Handoff, HandoffError | EnvironmentAuthorizationError>;
    readonly answerSecret: (
      input: SecretRequestAnswerInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, HandoffError | SecretRequestError | EnvironmentAuthorizationError>;
    readonly resolvedSshOutcomes: Effect.Effect<
      ReadonlyArray<{ readonly handoff: Handoff; readonly sshProgress: SshProgressBinding }>,
      HandoffError
    >;
    readonly completedProviderHomeContinuations: Effect.Effect<
      ReadonlyArray<{
        readonly handoff: Handoff;
        readonly args: Readonly<Record<string, unknown>>;
        readonly approvedBySessionId: AuthSessionId;
      }>,
      HandoffError
    >;
    readonly finishProviderHomeContinuation: (
      input: HandoffReadInput,
    ) => Effect.Effect<void, HandoffError>;
    /** Approved handoffs on a provider path whose change has not been applied yet. */
    readonly completedProviderContinuations: (path: ProviderContinuationPath) => Effect.Effect<
      ReadonlyArray<{
        readonly handoff: Handoff;
        readonly args: Readonly<Record<string, unknown>>;
        readonly approvedBySessionId: AuthSessionId;
        readonly progress?: unknown;
      }>,
      HandoffError
    >;
    /** Replaces the progress an approved provider change has recorded. */
    readonly recordProviderProgress: (
      input: HandoffReadInput,
      progress: unknown,
    ) => Effect.Effect<void, HandoffError>;
    /**
     * Ends a provider continuation. With progress, that record stays readable for a day after
     * the approval resolved, so approved and applied remain separate facts.
     */
    readonly finishProviderContinuation: (
      input: HandoffReadInput,
      progress?: unknown,
    ) => Effect.Effect<void, HandoffError>;
    /** The progress an approved provider change recorded, while unfinished or retained after. */
    readonly readProviderProgress: (
      input: HandoffReadInput,
    ) => Effect.Effect<unknown, HandoffError>;
    /**
     * One thread's handoff with its provider continuation, read in one load: `applying` while an
     * approved change has not finished, and the progress it recorded. No arguments leave it.
     */
    readonly readProviderContinuation: (input: HandoffReadInput) => Effect.Effect<
      {
        readonly handoff: Handoff;
        readonly applying: boolean;
        readonly progress?: unknown;
      },
      HandoffError
    >;
    readonly completedSshContinuations: Effect.Effect<
      ReadonlyArray<{
        readonly handoff: Handoff;
        readonly args: Readonly<Record<string, unknown>>;
        readonly approvedBySessionId: AuthSessionId;
        readonly sshProgress?: SshProgressBinding;
      }>,
      HandoffError
    >;
    readonly finishSshContinuation: (
      input: HandoffReadInput,
      completion?: SshProgressBinding["completion"],
    ) => Effect.Effect<void, HandoffError>;
    readonly bindSshContinuation: (
      input: HandoffReadInput,
      binding: SshProgressBinding,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, HandoffError>;
    readonly readSshProgressBinding: (
      input: HandoffReadInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<SshProgressBinding | null, HandoffError | EnvironmentAuthorizationError>;
    readonly sweep: Effect.Effect<void, HandoffError>;
    /** Whether a handoff was created with exactly these continuation arguments. */
    readonly matchesArgs: (
      handoff: Handoff,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<boolean>;
  }
>()("goat/handoffs/Handoffs") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const archiveGate = yield* ThreadArchiveGate;
  const fs = yield* FileSystem.FileSystem;
  const sessions = yield* SessionStore.SessionStore;
  const environment = yield* Effect.serviceOption(Environment.ServerEnvironment);
  const secrets = yield* SecretRequests.SecretRequests;
  const computerUseLeases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);
  const key = yield* store
    .getOrCreateRandom("handoff-encryption-key", 32)
    .pipe(Effect.mapError(unavailable));
  const lock = yield* Semaphore.make(1);
  const loadPrivate = (id: string) =>
    Effect.gen(function* () {
      const stored = yield* store.get(storeName(id)).pipe(Effect.mapError(unavailable));
      if (Option.isNone(stored)) return null;
      const plain = yield* Effect.try({
        try: () => {
          const bytes = Buffer.from(stored.value);
          const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
          decipher.setAuthTag(bytes.subarray(12, 28));
          return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
            "utf8",
          );
        },
        catch: unavailable,
      });
      return yield* decodePrivatePayload(plain).pipe(Effect.mapError(unavailable));
    });
  const savePrivate = (id: string, payload: typeof PrivatePayload.Type, replace = false) =>
    Effect.gen(function* () {
      const plain = yield* encodePrivatePayload(payload).pipe(Effect.mapError(unavailable));
      const encrypted = yield* Effect.try({
        try: () => {
          const iv = NodeCrypto.randomBytes(12);
          const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
          const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
          return Buffer.concat([iv, cipher.getAuthTag(), body]);
        },
        catch: unavailable,
      });
      yield* (
        replace ? store.set(storeName(id), encrypted) : store.create(storeName(id), encrypted)
      ).pipe(Effect.mapError(unavailable));
    });
  const read = Effect.fn("Handoffs.read")(function* (input: HandoffReadInput) {
    yield* archiveGate.restore(input.threadId);
    const rows = yield* sql<{ handoff_json: string | null }>`
      SELECT json_extract(payload_json, '$.handoff') AS handoff_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId} AND turn_item_id = ${input.handoffId}
        AND type IN ('human_handoff', 'secret_request')
    `.pipe(Effect.mapError(unavailable));
    const handoff =
      rows[0]?.handoff_json == null
        ? undefined
        : yield* decodeHandoff(rows[0].handoff_json).pipe(Effect.mapError(unavailable));
    if (!handoff) return yield* new HandoffError({ reason: "not_found" });
    return handoff;
  });
  const transition = Effect.fn("Handoffs.transition")(function* (
    input: HandoffReadInput,
    state: Handoff["state"],
    actor: Handoff["actor"],
  ) {
    yield* threads
      .dispatch({
        type: "handoff.transition",
        // Reopening must recheck expiry even when an earlier open has a receipt.
        commandId: CommandId.make(
          `handoff:${input.handoffId}:${state}${state === "opened" ? `:${NodeCrypto.randomUUID()}` : ""}`,
        ),
        threadId: input.threadId,
        handoffId: input.handoffId,
        state,
        actor,
      })
      .pipe(Effect.mapError(unavailable));
    const handoff = yield* read(input);
    // Completed payloads retain continuation arguments until the next rollout consumes them.
    if (
      !isHandoffPending(handoff.state) &&
      handoff.state !== "completed" &&
      !handoff.target.path.startsWith("ssh.")
    )
      yield* store.remove(storeName(input.handoffId)).pipe(Effect.mapError(unavailable));
    return handoff;
  });
  const clientLabel = Effect.fn("Handoffs.clientLabel")(function* (
    input: HandoffReadInput,
    sessionId: AuthSessionId,
  ) {
    const record = yield* read(input);
    // Host-bound requests are answered on the environment they would change.
    if (record.target.path.startsWith("ssh.") || isClockedHandoffPath(record.target.path)) {
      if (Option.isNone(environment)) return yield* new HandoffError({ reason: "unavailable" });
      const origin = yield* environment.value.getEnvironmentId;
      if (record.target.environmentId !== origin)
        return yield* new HandoffError({ reason: "invalid_request" });
    }
    const targetScope =
      record.target.path === "ssh.host_add" || record.target.path === "ssh.host_forget"
        ? ("settings:write" as const)
        : record.target.path.startsWith("ssh.")
          ? ("environment:maintain" as const)
          : record.target.path.startsWith("provider.")
            ? ("providers:manage" as const)
            : // Admitting an unattended thread to the screen, or changing the hub's members, is as
              // strong as changing this environment's settings.
              record.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH ||
                isHubDeviceHandoffPath(record.target.path)
              ? ("settings:write" as const)
              : ("orchestration:operate" as const);
    const active = yield* sessions.listActive().pipe(Effect.mapError(unavailable));
    const session = active.find((session) => session.sessionId === sessionId);
    if (session && !canResolveHumanStep(sessionResolver(session), "person_only"))
      return yield* new EnvironmentAuthorizationError({
        requiredScope: "orchestration:operate",
        message: "Only a person's client can act on this handoff.",
      });
    for (const requiredScope of new Set(["orchestration:operate" as const, targetScope])) {
      if (!session || !(session.permissions ?? session.scopes).includes(requiredScope))
        return yield* new EnvironmentAuthorizationError({
          requiredScope,
          message: "This client cannot act on this handoff.",
        });
    }
    return session!.client.label ?? "GOAT client";
  });
  const respond = Effect.fn("Handoffs.respond")(function* (
    input: HandoffRespondInput,
    sessionId: AuthSessionId,
  ) {
    const label = yield* clientLabel(input, sessionId);
    const record = yield* read(input);
    const isComputerUseGrant = record.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH;
    // One unattended thread per host holds the screen; a second approval waits for it to end.
    if (isComputerUseGrant && input.action === "completed" && isHandoffPending(record.state)) {
      const held = Option.isNone(computerUseLeases)
        ? Option.none()
        : yield* computerUseLeases.value
            .holder(record.requestedBy.threadId)
            .pipe(Effect.mapError(unavailable));
      if (Option.isSome(held)) return yield* new HandoffError({ reason: "conflict" });
    }
    if (
      input.action === "completed" &&
      (record.target.path.startsWith("ssh.") || isProviderContinuationPath(record.target.path)) &&
      isHandoffPending(record.state)
    ) {
      const payload = yield* loadPrivate(input.handoffId);
      if (payload === null || !("kind" in payload) || payload.kind !== "continuation")
        return yield* new HandoffError({ reason: "unavailable" });
      // Approvals asked before a path became a continuation path carry no namespace yet.
      const namespace = isProviderContinuationPath(record.target.path)
        ? { namespace: record.target.path }
        : {};
      yield* savePrivate(
        input.handoffId,
        { ...payload, ...namespace, approvedBySessionId: sessionId },
        true,
      );
    }
    const result = yield* transition(input, input.action, { type: "client", label });
    if (isComputerUseGrant && Option.isSome(computerUseLeases))
      yield* computerUseLeases.value.changed;
    if (result.state === "expired") return yield* new HandoffError({ reason: "expired" });
    if (result.state !== input.action) return yield* new HandoffError({ reason: "conflict" });
    return result;
  }, lock.withPermits(1));
  const open = Effect.fn("Handoffs.open")(function* (
    input: HandoffReadInput,
    sessionId: AuthSessionId,
  ) {
    yield* clientLabel(input, sessionId);
    const existing = yield* read(input);
    if (!isHandoffPending(existing.state)) return { handoff: existing, human: null };
    const handoff = yield* respond({ ...input, action: "opened" }, sessionId);
    if (handoff.kind === "secret") return { handoff, human: null };
    const payload = yield* loadPrivate(input.handoffId);
    if (payload === null || !("human" in payload))
      return yield* new HandoffError({ reason: "unavailable" });
    return { handoff, human: payload.human };
  });
  const create: Handoffs["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      yield* expirePending(input.requestedBy.threadId);
      // Serializes private-payload ownership, including duplicate calls with different request IDs.
      const records = yield* threads
        .getThreadRecords(input.requestedBy.threadId, ["turnItems"], {
          turnItemTypes: ["human_handoff", "secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError(unavailable));
      const dedupeKey = NodeCrypto.createHmac("sha256", key)
        .update(targetKey(input.args))
        .digest("hex");
      const pending = records.turnItems.flatMap((item) => {
        const handoff = itemHandoff(item);
        return handoff && isHandoffPending(handoff.state) ? [handoff] : [];
      });
      const duplicate = pending.find(
        (handoff) =>
          handoff.kind === input.kind &&
          handoff.target.environmentId === input.target.environmentId &&
          handoff.target.path === input.target.path &&
          handoff.dedupeKey === dedupeKey,
      );
      if (duplicate) return handoffSummary(duplicate);
      if (pending.length >= 3) return yield* new HandoffError({ reason: "limit_reached" });
      if (input.kind === "secret") return yield* new HandoffError({ reason: "invalid_request" });
      if (input.human.url !== undefined) {
        const validUrl = yield* Effect.try({
          try: () => new URL(input.human.url!),
          catch: () => new HandoffError({ reason: "invalid_request" }),
        });
        if (
          !["https:", "http:"].includes(validUrl.protocol) ||
          validUrl.username ||
          validUrl.password
        )
          return yield* new HandoffError({ reason: "invalid_request" });
      }
      const now = yield* DateTime.now;
      const handoff: Handoff = {
        handoffId: TurnItemId.make(`handoff:${NodeCrypto.randomUUID()}`),
        kind: input.kind,
        title: input.title,
        reason: input.reason,
        requestedBy: input.requestedBy,
        target: input.target,
        dedupeKey,
        state: "pending",
        expiresAt:
          input.kind === "approval" &&
          !input.target.path.startsWith("ssh.") &&
          !isClockedHandoffPath(input.target.path)
            ? null
            : (input.expiresAt ?? DateTime.add(now, { minutes: 15 })),
        createdAt: now,
        actor: { type: "agent", threadId: input.requestedBy.threadId },
      };
      yield* savePrivate(handoff.handoffId, {
        version: 1,
        kind: "continuation",
        ...(isProviderContinuationPath(input.target.path) ? { namespace: input.target.path } : {}),
        human: input.human,
        args: input.args,
        ...(input.sshProgress === undefined ? {} : { sshProgress: input.sshProgress }),
      });
      yield* threads
        .dispatch({
          type: "handoff.create",
          commandId: CommandId.make(`handoff:${handoff.handoffId}:create`),
          threadId: input.requestedBy.threadId,
          runId: input.runId,
          nodeId: input.nodeId,
          handoff,
        })
        .pipe(Effect.mapError(unavailable));
      return handoffSummary(handoff);
    }).pipe(lock.withPermits(1));

  const expirePending = Effect.fn("Handoffs.expirePending")(function* (threadId?: string) {
    // Batch pending cards with their owning run; resolved payloads are never decoded.
    const rows = yield* sql<{
      thread_id: string;
      turn_item_id: string;
      handoff_json: string | null;
      run_status: string | null;
    }>`SELECT item.thread_id, item.turn_item_id,
        json_extract(item.payload_json, '$.handoff') AS handoff_json,
        run.status AS run_status
      FROM orchestration_v2_projection_turn_items AS item
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
      WHERE item.type IN ('human_handoff', 'secret_request') AND item.status = 'waiting'
        ${threadId === undefined ? sql`` : sql`AND item.thread_id = ${threadId}`}
    `.pipe(Effect.mapError(unavailable));
    const now = yield* DateTime.now;
    for (const row of rows) {
      if (row.handoff_json === null) continue;
      const handoff = yield* decodeHandoff(row.handoff_json).pipe(Effect.mapError(unavailable));
      const runStatus = yield* decodeRunStatus(row.run_status).pipe(Effect.mapError(unavailable));
      if (
        (handoff.expiresAt !== null &&
          DateTime.toEpochMillis(handoff.expiresAt) <= DateTime.toEpochMillis(now)) ||
        (endsWithItsRun(handoff) &&
          (runStatus === null || ThreadManagement.isTerminalRunStatus(runStatus)))
      ) {
        const input = yield* decodeAddress({
          threadId: row.thread_id,
          handoffId: row.turn_item_id,
        }).pipe(Effect.mapError(unavailable));
        yield* transition(input, "expired", { type: "server" });
      }
    }
  });
  const completedContinuations = (namespace: "ssh" | ProviderContinuationPath) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const rows = yield* sql<{
        handoff_json: string;
      }>`SELECT json_extract(payload_json, '$.handoff') AS handoff_json
      FROM orchestration_v2_projection_turn_items WHERE type = 'human_handoff' AND status = 'completed'
      AND updated_at > ${DateTime.formatIso(DateTime.subtract(now, { hours: 24 }))}`.pipe(
        Effect.mapError(unavailable),
      );
      const results: Array<{
        handoff: Handoff;
        args: Readonly<Record<string, unknown>>;
        approvedBySessionId: AuthSessionId;
        sshProgress?: SshProgressBinding;
        progress?: unknown;
      }> = [];
      for (const row of rows) {
        const handoff = yield* decodeHandoff(row.handoff_json).pipe(Effect.mapError(unavailable));
        if (
          namespace === "ssh"
            ? !handoff.target.path.startsWith("ssh.")
            : handoff.target.path !== namespace
        )
          continue;
        const payload = yield* loadPrivate(handoff.handoffId);
        if (
          payload !== null &&
          "kind" in payload &&
          payload.kind === "continuation" &&
          (namespace === "ssh" || payload.namespace === namespace) &&
          payload.approvedBySessionId !== undefined
        )
          results.push({
            handoff,
            args: payload.args,
            approvedBySessionId: payload.approvedBySessionId,
            ...(payload.sshProgress === undefined ? {} : { sshProgress: payload.sshProgress }),
            ...(payload.progress === undefined ? {} : { progress: payload.progress }),
          });
      }
      return results;
    });
  const completedSshContinuations = completedContinuations("ssh");
  const completedProviderHomeContinuations = completedContinuations("provider.home_request");
  const recordProviderProgress = (input: HandoffReadInput, progress: unknown) =>
    Effect.gen(function* () {
      const handoff = yield* read(input);
      if (!isProviderContinuationPath(handoff.target.path) || handoff.state !== "completed")
        return yield* new HandoffError({ reason: "invalid_request" });
      const payload = yield* loadPrivate(input.handoffId);
      if (
        payload === null ||
        payload.kind !== "continuation" ||
        payload.approvedBySessionId === undefined
      )
        return yield* new HandoffError({ reason: "unavailable" });
      yield* savePrivate(input.handoffId, { ...payload, progress }, true);
    }).pipe(lock.withPermits(1));
  const finishProviderContinuation = (input: HandoffReadInput, progress?: unknown) =>
    Effect.gen(function* () {
      const handoff = yield* read(input);
      const path = handoff.target.path;
      if (!isProviderContinuationPath(path) || isHandoffPending(handoff.state)) return;
      if (progress === undefined) {
        yield* store.remove(storeName(input.handoffId)).pipe(Effect.mapError(unavailable));
        return;
      }
      const retainedFrom = handoff.resolvedAt ?? handoff.createdAt;
      yield* savePrivate(
        input.handoffId,
        {
          version: 1,
          kind: "provider_outcome",
          namespace: path,
          progress,
          retainUntil: DateTime.toEpochMillis(DateTime.add(retainedFrom, { hours: 24 })),
        },
        true,
      );
    }).pipe(lock.withPermits(1));
  const readProviderProgress = (input: HandoffReadInput) =>
    Effect.gen(function* () {
      const payload = yield* loadPrivate(input.handoffId);
      if (payload?.kind === "continuation") return payload.progress;
      if (
        payload?.kind === "provider_outcome" &&
        payload.retainUntil > DateTime.toEpochMillis(yield* DateTime.now)
      )
        return payload.progress;
      return undefined;
    });
  const readProviderContinuation = Effect.fn("Handoffs.readProviderContinuation")(function* (
    input: HandoffReadInput,
  ) {
    // The thread-scoped read first: another thread's handoff is not_found here.
    const handoff = yield* read(input);
    if (!isProviderContinuationPath(handoff.target.path)) return { handoff, applying: false };
    const payload = yield* loadPrivate(input.handoffId);
    if (payload?.kind === "continuation" && payload.approvedBySessionId !== undefined)
      return {
        handoff,
        applying: true,
        ...(payload.progress === undefined ? {} : { progress: payload.progress }),
      };
    if (
      payload?.kind === "provider_outcome" &&
      payload.retainUntil > DateTime.toEpochMillis(yield* DateTime.now)
    )
      return { handoff, applying: false, progress: payload.progress };
    return { handoff, applying: false };
  });
  const resolvedSshOutcomes = Effect.gen(function* () {
    const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 24 }));
    const rows = yield* sql<{
      handoff_json: string;
    }>`SELECT json_extract(payload_json, '$.handoff') AS handoff_json
      FROM orchestration_v2_projection_turn_items WHERE type = 'human_handoff'
      AND status <> 'waiting' AND updated_at > ${since}`.pipe(Effect.mapError(unavailable));
    const results: Array<{ handoff: Handoff; sshProgress: SshProgressBinding }> = [];
    for (const row of rows) {
      const handoff = yield* decodeHandoff(row.handoff_json).pipe(Effect.mapError(unavailable));
      if (
        !handoff.target.path.startsWith("ssh.") ||
        handoff.state === "completed" ||
        isHandoffPending(handoff.state)
      )
        continue;
      const payload = yield* loadPrivate(handoff.handoffId);
      if (payload?.kind === "continuation" && payload.sshProgress !== undefined)
        results.push({ handoff, sshProgress: payload.sshProgress });
    }
    return results;
  });
  const finishSshContinuation: Handoffs["Service"]["finishSshContinuation"] = (input, completion) =>
    Effect.gen(function* () {
      const handoff = yield* read(input);
      if (!handoff.target.path.startsWith("ssh.") || isHandoffPending(handoff.state)) return;
      const payload = yield* loadPrivate(input.handoffId);
      if (
        payload !== null &&
        "kind" in payload &&
        payload.kind === "continuation" &&
        payload.sshProgress !== undefined
      ) {
        const retainedFrom = handoff.resolvedAt ?? handoff.createdAt;
        yield* savePrivate(
          input.handoffId,
          {
            version: 1,
            kind: "progress_only",
            sshProgress: { ...payload.sshProgress, ...(completion ? { completion } : {}) },
            retainUntil: DateTime.toEpochMillis(DateTime.add(retainedFrom, { hours: 24 })),
          },
          true,
        );
      } else yield* store.remove(storeName(input.handoffId)).pipe(Effect.mapError(unavailable));
    }).pipe(lock.withPermits(1));
  const bindSshContinuation: Handoffs["Service"]["bindSshContinuation"] = (input, binding, args) =>
    Effect.gen(function* () {
      const handoff = yield* read(input);
      if (
        handoff.state !== "completed" ||
        !handoff.target.path.startsWith("ssh.") ||
        binding.threadId !== input.threadId ||
        binding.environmentId !== handoff.target.environmentId
      )
        return yield* new HandoffError({ reason: "invalid_request" });
      const payload = yield* loadPrivate(input.handoffId);
      if (payload === null || payload.kind !== "continuation")
        return yield* new HandoffError({ reason: "unavailable" });
      yield* savePrivate(input.handoffId, { ...payload, args, sshProgress: binding }, true);
    }).pipe(lock.withPermits(1));
  const readSshProgressBinding = (input: HandoffReadInput, sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      yield* clientLabel(input, sessionId);
      const active = yield* sessions.listActive().pipe(Effect.mapError(unavailable));
      const session = active.find((entry) => entry.sessionId === sessionId);
      if (!session || !(session.permissions ?? session.scopes).includes("orchestration:read"))
        return yield* new EnvironmentAuthorizationError({
          requiredScope: "orchestration:read",
          message: "This client cannot read this handoff.",
        });
      const handoff = yield* read(input);
      if (
        !handoff.target.path.startsWith("ssh.") ||
        !["opened", "completed"].includes(handoff.state)
      )
        return null;
      const payload = yield* loadPrivate(input.handoffId);
      if (payload === null || !("sshProgress" in payload) || payload.sshProgress === undefined)
        return null;
      if (
        payload.kind === "progress_only" &&
        payload.retainUntil <= DateTime.toEpochMillis(yield* DateTime.now)
      )
        return null;
      const binding = payload.sshProgress;
      if (
        binding.threadId !== input.threadId ||
        binding.environmentId !== handoff.target.environmentId
      )
        return yield* new HandoffError({ reason: "invalid_request" });
      // Reading the thread through its owning service also verifies it still exists.
      yield* threads
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["human_handoff"],
          messageRoles: [],
        })
        .pipe(Effect.mapError(unavailable));
      return binding;
    });
  const sweepUnlocked = Effect.gen(function* () {
    yield* expirePending();
    if (store.directory !== undefined) {
      // Reconcile orphan writes and failed deletions after crashes. A single service lock
      // keeps a sweep from removing an in-flight create's unpublished payload.
      const retained = yield* sql<{
        turn_item_id: string;
      }>`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE type IN ('human_handoff', 'secret_request') AND type = 'human_handoff' AND (status = 'waiting' OR (status <> 'waiting' AND updated_at > ${DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 24 }))}))`.pipe(
        Effect.mapError(unavailable),
      );
      const keep = new Set(retained.map((row) => `${storeName(row.turn_item_id)}.bin`));
      for (const file of yield* fs
        .readDirectory(store.directory)
        .pipe(Effect.mapError(unavailable))) {
        if (/^handoff-[a-f0-9]{64}\.bin$/.test(file) && !keep.has(file))
          yield* store.remove(file.slice(0, -4)).pipe(Effect.mapError(unavailable));
      }
    }
  });
  const sweep = sweepUnlocked.pipe(lock.withPermits(1));
  const answerSecret = Effect.fn("Handoffs.answerSecret")(function* (
    input: SecretRequestAnswerInput,
    sessionId: AuthSessionId,
  ) {
    const active = yield* sessions.listActive().pipe(Effect.mapError(unavailable));
    const session = active.find((session) => session.sessionId === sessionId);
    if (
      !session ||
      !canResolveHumanStep(sessionResolver(session), "person_only") ||
      !(session.permissions ?? session.scopes).includes("orchestration:operate")
    )
      return yield* new EnvironmentAuthorizationError({
        requiredScope: "orchestration:operate",
        message: "This client cannot answer this request.",
      });
    yield* secrets.answer(input, { type: "client", label: session.client.label ?? "GOAT client" });
  });
  return Handoffs.of({
    create,
    read,
    open,
    respond,
    sweep,
    matchesArgs: (handoff, args) =>
      Effect.sync(() => {
        const expected = Buffer.from(
          NodeCrypto.createHmac("sha256", key).update(targetKey(args)).digest("hex"),
        );
        const actual = Buffer.from(handoff.dedupeKey);
        return expected.length === actual.length && NodeCrypto.timingSafeEqual(expected, actual);
      }),
    answerSecret,
    completedSshContinuations,
    completedProviderHomeContinuations,
    finishProviderHomeContinuation: finishProviderContinuation,
    completedProviderContinuations: completedContinuations,
    recordProviderProgress,
    finishProviderContinuation,
    readProviderProgress,
    readProviderContinuation,
    resolvedSshOutcomes,
    finishSshContinuation,
    bindSshContinuation,
    readSshProgressBinding,
  });
});
export const layer = Layer.effect(Handoffs, make);
