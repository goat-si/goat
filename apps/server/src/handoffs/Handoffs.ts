import { describeHolderForPerson } from "../cua/computerUseGrants.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  EnvironmentAuthorizationError,
  AuthSessionId,
  ThreadId,
  type SecretRequestAnswerInput,
  SecretRequestError,
  CommandId,
  Handoff,
  HandoffError,
  type ServerSettingsError,
  HandoffHuman,
  MessageId,
  handoffSummary,
  isHandoffPending,
  isClockedHandoffPath,
  endsWithItsRun,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  TurnItemId,
  type HandoffReadInput,
  type HandoffRespondInput,
  type HandoffSummary,
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
import * as ServerSettings from "../serverSettings.ts";
import { ThreadArchiveGate } from "../orchestration-v2/ThreadArchiveGate.ts";
import { canResolveHumanStep, sessionResolver } from "./HumanStepAuthority.ts";
import { CONSUMED, expiredAt, makeComputerUseContinuations } from "./computerUseContinuations.ts";
import { makeExpiryHolds } from "./expiryHolds.ts";
import { makeComputerUseStanding, type CreateInput } from "./computerUseStanding.ts";
import { startComputerUseSettingsObserver } from "./computerUseSettingsObserver.ts";
import { makeHandoffClientLabel } from "./handoffClientLabel.ts";
import { targetKey } from "./targetKey.ts";
import * as PersonStop from "./computerUsePersonStop.ts";
import { storeName, matchesArgs } from "./handoffDigest.ts";
import { decodeAddress, unavailable } from "./handoffDecode.ts";
import { SshProgressBinding } from "./sshProgressBinding.ts";
export { SshProgressBinding } from "./sshProgressBinding.ts";

import {
  PROVIDER_CONTINUATION_PATHS,
  isProviderContinuationPath,
  type ProviderContinuationPath,
} from "./providerContinuationPaths.ts";
export {
  isProviderContinuationPath,
  type ProviderContinuationPath,
} from "./providerContinuationPaths.ts";
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
    // A person ended this computer use grant after approving it; the sweep drops it with the rest.
    Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("computer_use_ended") }),
    Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("computer_use_consumed") }),
  ]),
);
const encodePrivatePayload = Schema.encodeEffect(PrivatePayload);
const decodePrivatePayload = Schema.decodeUnknownEffect(PrivatePayload);
const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Handoff)),
);
const decodeRunStatus = Schema.decodeUnknownEffect(Schema.NullOr(OrchestrationV2RunStatus));
type Continuations = Effect.Success<ReturnType<typeof makeComputerUseContinuations>>;

export class Handoffs extends Context.Service<
  Handoffs,
  {
    /** Internal domain API: adapters supply human instructions, agents receive only the summary. */
    readonly create: (input: CreateInput) => Effect.Effect<HandoffSummary, HandoffError>;
    readonly autoComputerUse: (
      input: CreateInput,
    ) => Effect.Effect<Option.Option<HandoffSummary>, HandoffError>;
    readonly clearComputerUseSessions: (threadId?: ThreadId) => Effect.Effect<void, HandoffError>;
    readonly stopComputerUseSessions: (
      threadId?: ThreadId,
      cutoff?: number,
    ) => Effect.Effect<ReadonlyArray<ThreadId>, HandoffError>;
    readonly revalidateComputerUse: (threadId?: ThreadId) => Effect.Effect<void, HandoffError>;
    readonly withComputerUseToggle: <A, E, R>(
      enabled: boolean,
      update: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HandoffError, R>;
    readonly withComputerUseSettings: <A, E, R>(
      patch: { readonly enableCua?: boolean; readonly cuaAllowedApps?: ReadonlyArray<string> },
      update: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HandoffError, R>;
    readonly removeComputerUseAllowedApp: (
      app: string,
      authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
    ) => Effect.Effect<void, HandoffError | ServerSettingsError>;
    readonly read: (input: HandoffReadInput) => Effect.Effect<Handoff, HandoffError>;
    /** A computer use request's answer for its waiting call; see computerUseContinuations. */
    readonly awaitComputerUseAnswer: Continuations["awaitAnswer"];
    readonly deliverComputerUseWake: Continuations["deliverWake"];
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
    readonly cancelComputerUseByPerson: (
      input: HandoffReadInput,
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
    /**
     * Whether an approved provider change is still waiting for the server to apply it, and the
     * progress it recorded once it finished (absent when it finished without one).
     */
    readonly providerApplyState: (
      input: HandoffReadInput,
    ) => Effect.Effect<{ readonly applying: boolean; readonly progress?: unknown }, HandoffError>;
    /** Whether a person ended this computer use grant after approving it, which stopped its agent. */
    readonly computerUseEndedByPerson: (handoff: Handoff) => Effect.Effect<boolean, HandoffError>;
    /** Withdraws that grant's approval wake while it has not started its turn. */
    readonly withdrawComputerUseWake: (
      input: HandoffReadInput,
    ) => Effect.Effect<void, HandoffError>;
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
    /** Keeps the expiry sweep off handoffs another service is still ending; returns its undo. */
    readonly holdExpiry: (holds: (handoffId: string) => boolean) => Effect.Effect<() => void>;
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
  const withAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Option.isSome(computerUseLeases) ? computerUseLeases.value.serializeAdmission(effect) : effect;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
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
    keepPrivate = false,
    computerUseScope?: "session" | "always",
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
        ...(computerUseScope === undefined ? {} : { computerUseScope }),
      })
      .pipe(Effect.mapError(unavailable));
    const handoff = yield* read(input);
    // Completed payloads retain continuation arguments until the next rollout consumes them.
    if (
      !keepPrivate &&
      !isHandoffPending(handoff.state) &&
      handoff.state !== "completed" &&
      !handoff.target.path.startsWith("ssh.")
    )
      yield* store.remove(storeName(input.handoffId)).pipe(Effect.mapError(unavailable));
    return handoff;
  });
  const continuations = yield* makeComputerUseContinuations({
    lock,
    serializeAdmission: withAdmission,
    read,
    expire: (input) =>
      standing
        .end(input.threadId, input.handoffId, false)
        .pipe(Effect.andThen(transition(input, "expired", { type: "server" }))),
    cancelAsAgent: (input) =>
      standing
        .end(input.threadId, input.handoffId, false)
        .pipe(
          Effect.andThen(
            transition(input, "cancelled", { type: "agent", threadId: input.threadId }),
          ),
        ),
    recordKind: (id) =>
      loadPrivate(id).pipe(
        Effect.map((payload) => (payload !== null && "kind" in payload ? payload.kind : null)),
      ),
    markConsumed: (id) => savePrivate(id, CONSUMED, true),
    removeRecord: (id) => store.remove(storeName(id)).pipe(Effect.mapError(unavailable)),
  });
  /**
   * A person ending an approved computer use grant (a card's Stop, Stop all, End computer use)
   * stops that agent (#1521). The wake reactor withdraws the grant's approval wake while it has
   * not taken the screen yet: queued behind the thread's running turn, or still starting. A turn
   * already running keeps the control the Stop ended.
   */
  const withdrawComputerUseWake = Effect.fn("Handoffs.withdrawComputerUseWake")(function* (
    input: HandoffReadInput,
  ) {
    yield* continuations.forget(input.handoffId);
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs"], { turnItemTypes: [], messageRoles: [] })
      .pipe(Effect.mapError(unavailable));
    const wake = MessageId.make(`message:handoff-wake:${input.handoffId}:completed`);
    const run = records.runs.find((candidate) => candidate.userMessageId === wake);
    if (run === undefined) return;
    // A wake run that started only after the grant ended is a turn the Stop should have kept from
    // starting. One already working before the Stop keeps going, like every other turn then.
    const ended = (yield* read(input)).resolvedAt;
    const startedAfterEnd =
      (run.status === "running" || run.status === "waiting") &&
      run.startedAt !== null &&
      ended !== undefined &&
      DateTime.toEpochMillis(run.startedAt) >= DateTime.toEpochMillis(ended);
    // A retry after a rejection needs a fresh id; the run's state decides whether one is due.
    const commandId = CommandId.make(
      `handoff:${input.handoffId}:withdraw-wake:${run.status}:${NodeCrypto.randomUUID()}`,
    );
    if (run.status === "queued")
      yield* threads
        .dispatch({ type: "queued-run.cancel", commandId, threadId: input.threadId, runId: run.id })
        .pipe(Effect.mapError(unavailable));
    else if (run.status === "preparing" || run.status === "starting" || startedAfterEnd)
      yield* threads
        .dispatch({
          type: "run.interrupt",
          commandId,
          threadId: input.threadId,
          runId: run.id,
          reason: "A person ended this thread's computer use before this turn started.",
        })
        .pipe(Effect.mapError(unavailable));
  });
  const clientLabel = makeHandoffClientLabel({ read, environment, sessions });
  const respondLocked = Effect.fn("Handoffs.respondLocked")(
    function* (
      input: HandoffRespondInput,
      sessionId: AuthSessionId | undefined,
      foregroundEpoch: number | undefined,
    ) {
      const { label, record } = yield* PersonStop.resolve({ input, sessionId, read, clientLabel });
      const isComputerUseGrant = record.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH;
      yield* standing.validate(input, record);
      // An app, or the whole screen, is one thread's; an overlapping approval waits for it to end.
      if (isComputerUseGrant && input.action === "completed" && isHandoffPending(record.state)) {
        const held = Option.isNone(computerUseLeases)
          ? Option.none()
          : yield* computerUseLeases.value
              .holder(record.requestedBy.threadId, record.apps)
              .pipe(Effect.mapError(unavailable));
        if (Option.isSome(held)) {
          const rows = yield* sql<{ readonly title: string | null }>`
            SELECT title FROM orchestration_v2_projection_threads
            WHERE thread_id = ${held.value.threadId}
          `.pipe(Effect.orElseSucceed(() => []));
          const title = rows[0]?.title?.trim();
          return yield* new HandoffError({
            reason: "conflict",
            detail: `${describeHolderForPerson(held.value, title || undefined)} End that admission first, or deny this one.`,
          });
        }
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
        const approvedBySessionId = yield* PersonStop.session(sessionId);
        yield* savePrivate(
          input.handoffId,
          { ...payload, ...namespace, approvedBySessionId },
          true,
        );
      }
      const endsApproved =
        isComputerUseGrant && input.action === "cancelled" && record.state === "completed";
      if (endsApproved || (isComputerUseGrant && isHandoffPending(record.state)))
        yield* standing.end(input.threadId, input.handoffId, endsApproved);
      yield* PersonStop.markPersonStopped(input, record, savePrivate);
      const result = yield* transition(
        input,
        input.action,
        { type: "client", label },
        // A resolved grant's payload is already settled: it may record how it ended.
        isComputerUseGrant && !isHandoffPending(record.state),
        input.computerUseScope,
      );
      yield* standing.record(input, result);
      if (
        foregroundEpoch !== undefined &&
        isComputerUseGrant &&
        isHandoffPending(record.state) &&
        record.computerUseForeground !== undefined &&
        result.state === "completed" &&
        Option.isSome(computerUseLeases)
      )
        yield* computerUseLeases.value.approveForeground(result, foregroundEpoch);
      if (isComputerUseGrant && Option.isSome(computerUseLeases))
        yield* computerUseLeases.value.changed;
      if (isComputerUseGrant) yield* continuations.answered(input.handoffId);
      if (result.state === "expired") return yield* new HandoffError({ reason: "expired" });
      if (result.state !== input.action) return yield* new HandoffError({ reason: "conflict" });
      return result;
    },
    lock.withPermits(1),
    // A computer use grant's holder check and commit must not straddle an unattended claim.
    withAdmission,
  );
  const respond = Effect.fn("Handoffs.respond")(function* (
    input: HandoffRespondInput,
    sessionId: AuthSessionId,
  ) {
    // Authorization, holder reads and lock acquisition can all overlap a person's Stop.
    const foregroundEpoch =
      input.action === "completed" && Option.isSome(computerUseLeases)
        ? yield* computerUseLeases.value.foregroundApprovalEpoch
        : undefined;
    return yield* respondLocked(input, sessionId, foregroundEpoch);
  });
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
  const createUnlocked = (input: CreateInput, automatic = false) =>
    Effect.gen(function* () {
      if (!automatic) yield* expirePending(input.requestedBy.threadId);
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
      if (!automatic && duplicate) return handoffSummary(duplicate);
      if (!automatic && pending.length >= 3)
        return yield* new HandoffError({ reason: "limit_reached" });
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
        state: automatic ? "completed" : "pending",
        expiresAt:
          input.kind === "approval" &&
          !input.target.path.startsWith("ssh.") &&
          !isClockedHandoffPath(input.target.path)
            ? null
            : (input.expiresAt ?? DateTime.add(now, { minutes: 15 })),
        createdAt: now,
        actor: automatic
          ? { type: "server" }
          : { type: "agent", threadId: input.requestedBy.threadId },
        ...(automatic ? { resolvedAt: now } : {}),
        ...(automatic ? { computerUseScope: "standing" as const } : {}),
        ...(automatic && input.computerUseConsentSequence !== undefined
          ? { computerUseConsentSequence: input.computerUseConsentSequence }
          : {}),
        ...(input.apps === undefined ? {} : { apps: input.apps }),
        ...(input.computerUseForeground === undefined
          ? {}
          : { computerUseForeground: input.computerUseForeground }),
      };
      yield* savePrivate(
        handoff.handoffId,
        automatic
          ? CONSUMED
          : {
              version: 1,
              kind: "continuation",
              ...(isProviderContinuationPath(input.target.path)
                ? { namespace: input.target.path }
                : {}),
              human: input.human,
              args: input.args,
              ...(input.sshProgress === undefined ? {} : { sshProgress: input.sshProgress }),
            },
      );
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
      if (!automatic && input.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH)
        yield* continuations.supersede(input.requestedBy.threadId, pending, handoff.handoffId);
      return handoffSummary(handoff);
    });
  const create: Handoffs["Service"]["create"] = (input) =>
    withAdmission(createUnlocked(input).pipe(lock.withPermits(1)));
  const standing = makeComputerUseStanding({
    sql,
    lock,
    leases: computerUseLeases,
    settings,
    expirePending: (threadId) => expirePending(threadId),
    create: createUnlocked,
    read: (threadId, handoffId) => read({ threadId, handoffId }),
    revoke: (handoff) =>
      Effect.gen(function* () {
        yield* savePrivate(handoff.handoffId, { version: 1, kind: "computer_use_ended" }, true);
        yield* transition(
          { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId },
          "cancelled",
          { type: "server" },
          true,
        );
      }),
  });
  if (Option.isSome(settings))
    yield* startComputerUseSettingsObserver(
      settings.value,
      standing.observeSettings,
      standing.invalidate,
    );

  const expiryHolds = makeExpiryHolds();
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
      if (row.handoff_json === null || expiryHolds.held(row.turn_item_id)) continue;
      const handoff = yield* decodeHandoff(row.handoff_json).pipe(Effect.mapError(unavailable));
      const runStatus = yield* decodeRunStatus(row.run_status).pipe(Effect.mapError(unavailable));
      if (
        expiredAt(handoff, now) ||
        (endsWithItsRun(handoff) &&
          (runStatus === null || ThreadManagement.isTerminalRunStatus(runStatus)))
      ) {
        const input = yield* decodeAddress({
          threadId: row.thread_id,
          handoffId: row.turn_item_id,
        }).pipe(Effect.mapError(unavailable));
        if (handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH)
          yield* standing.end(input.threadId, input.handoffId, false);
        yield* transition(input, "expired", { type: "server" });
        if (handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH)
          yield* continuations.answered(input.handoffId);
      }
    }
  });
  const completedContinuations = (namespace: "ssh" | ProviderContinuationPath) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      // The redundant status term matches the resolved-handoff partial index; without it this
      // poll scans every turn item.
      const rows = yield* sql<{
        handoff_json: string;
      }>`SELECT json_extract(payload_json, '$.handoff') AS handoff_json
      FROM orchestration_v2_projection_turn_items WHERE type = 'human_handoff' AND status = 'completed'
      AND status <> 'waiting' AND updated_at > ${DateTime.formatIso(DateTime.subtract(now, { hours: 24 }))}`.pipe(
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
    autoComputerUse: standing.auto,
    clearComputerUseSessions: standing.clear,
    stopComputerUseSessions: standing.stop,
    revalidateComputerUse: standing.revalidate,
    withComputerUseToggle: standing.toggle,
    withComputerUseSettings: standing.withSettings,
    removeComputerUseAllowedApp: standing.removeAllowedApp,
    read,
    open,
    respond,
    cancelComputerUseByPerson: (input) =>
      respondLocked({ ...input, action: "cancelled" }, undefined, undefined),
    sweep: withAdmission(sweepUnlocked.pipe(lock.withPermits(1))),
    holdExpiry: expiryHolds.hold,
    matchesArgs: (handoff, args) => matchesArgs(key, handoff, args),
    answerSecret,
    completedSshContinuations,
    completedProviderHomeContinuations,
    finishProviderHomeContinuation: finishProviderContinuation,
    completedProviderContinuations: completedContinuations,
    recordProviderProgress,
    finishProviderContinuation,
    readProviderProgress,
    readProviderContinuation,
    providerApplyState: (input) =>
      loadPrivate(input.handoffId).pipe(
        Effect.map((payload) =>
          payload?.kind === "continuation" && payload.approvedBySessionId !== undefined
            ? { applying: true }
            : payload?.kind === "provider_outcome"
              ? { applying: false, progress: payload.progress }
              : { applying: false },
        ),
      ),
    resolvedSshOutcomes,
    finishSshContinuation,
    bindSshContinuation,
    readSshProgressBinding,
    computerUseEndedByPerson: (handoff) =>
      handoff.target.path !== COMPUTER_USE_GRANT_HANDOFF_PATH || handoff.state !== "cancelled"
        ? Effect.succeed(false)
        : loadPrivate(handoff.handoffId).pipe(
            Effect.map((payload) => payload?.kind === "computer_use_ended"),
          ),
    withdrawComputerUseWake,
    awaitComputerUseAnswer: continuations.awaitAnswer,
    deliverComputerUseWake: continuations.deliverWake,
  });
});
export const layer = Layer.effect(Handoffs, make);
