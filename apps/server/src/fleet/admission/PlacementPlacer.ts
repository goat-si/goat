import { type CommandId, ThreadId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest of a frozen payload.
import * as NodeCrypto from "node:crypto";

import type { RuntimeMode } from "@goat/contracts";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ThreadLifecycle from "../../orchestration-v2/ThreadLifecycleService.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { type PlacementAnswer, PlacementAdmission } from "./PlacementAdmission.ts";
import { type Attempt, PlacementAttempts, PlacementAttemptsError } from "./PlacementAttempts.ts";
import { PlacementAdmissionEnabled, type PlacementArgument } from "./PlacementKey.ts";

/** What a placer may conclude about one attempt (design §11). */
export type PlacedOutcome =
  | {
      readonly _tag: "Started";
      readonly attempt: Attempt;
      readonly threadId: string;
      readonly runId: string | null;
    }
  /** The target answered from its fenced row; the next attempt may go anywhere. */
  | { readonly _tag: "NotStarted"; readonly attempt: Attempt; readonly message: string }
  /** Still unknown: retry this key on this target later; nothing goes elsewhere meanwhile. */
  | { readonly _tag: "Unknown"; readonly attempt: Attempt; readonly message: string };

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const argumentOf = (attempt: Attempt): PlacementArgument => ({
  ownerKey: attempt.ownerKey,
  attempt: attempt.attempt,
  issuedAt: DateTime.formatIso(DateTime.makeUnsafe(attempt.issuedAt)),
});

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

type RemoteLaunch = Omit<SshRemoteDispatch.SshLaunchInput, "placement" | "host" | "target">;

/** A remote attempt as frozen before its first send: the launch, and each attachment's bytes by digest. */
interface FrozenRemote {
  readonly launch: RemoteLaunch;
  readonly attachments: ReadonlyArray<{ readonly id: string; readonly sha256: string }>;
}

export type RecoveredOutcome =
  | PlacedOutcome
  /** No attempt was ever recorded, so nothing was sent. */
  | { readonly _tag: "NotSent" }
  /** A person chose "Run again, it may duplicate"; the next attempt may start. */
  | { readonly _tag: "RerunChosen"; readonly attempt: Attempt };

export interface PlacementPlacerShape {
  /** Resends the owner's unknown attempt to its own target, or reads its settled outcome. */
  readonly recover: <P, E, R, E2>(input: {
    readonly ownerKey: string;
    readonly authorize: Effect.Effect<RuntimeMode, E, R>;
    readonly local: (commandId: CommandId, payload: P) => Effect.Effect<unknown, E2>;
  }) => Effect.Effect<RecoveredOutcome, PlacementAttemptsError | E, R>;
  readonly latestAttempt: (
    ownerKey: string,
  ) => Effect.Effect<Attempt | null, PlacementAttemptsError>;
  /** Whether this owner has ever sent a placed attempt; without one nothing was sent. */
  readonly hasAttempt: (ownerKey: string) => Effect.Effect<boolean, PlacementAttemptsError>;
  /** One attempt on another GOAT over SSH dispatch; a retry resends the frozen payload. */
  readonly placeRemote: <E, R>(input: {
    readonly ownerKey: string;
    readonly host: string;
    readonly launch: RemoteLaunch;
    readonly authorize: Effect.Effect<RuntimeMode, E, R>;
  }) => Effect.Effect<PlacedOutcome, PlacementAttemptsError | E, R>;
  /** One attempt on this machine, through its own admission. */
  readonly placeLocal: <P, E>(input: {
    readonly ownerKey: string;
    readonly payload: P;
    /** Builds the launch from the frozen payload, so a retry launches what was first asked. */
    readonly launch: (commandId: CommandId, payload: P) => Effect.Effect<unknown, E>;
  }) => Effect.Effect<PlacedOutcome, PlacementAttemptsError>;
}

export class PlacementPlacer extends Context.Service<PlacementPlacer, PlacementPlacerShape>()(
  "goat/fleet/admission/PlacementPlacer",
) {}

const LOCAL_TARGET = "local";
const CLEANUP_BATCH = 20;
const MAINTENANCE_EVERY = Duration.minutes(10);

const make = Effect.gen(function* () {
  const attempts = yield* PlacementAttempts;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const admission = yield* Effect.serviceOption(PlacementAdmission);
  const lifecycle = yield* Effect.serviceOption(ThreadLifecycle.ThreadLifecycleService);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);

  /** Each attachment's current local bytes by digest; null when one cannot be read. */
  const attachmentDigests = Effect.fn("PlacementPlacer.attachmentDigests")(function* (
    launch: RemoteLaunch,
  ) {
    const requested = launch.attachments ?? [];
    if (requested.length === 0) return [];
    if (Option.isNone(config) || Option.isNone(fileSystem)) return null;
    const digests: Array<{ readonly id: string; readonly sha256: string }> = [];
    for (const attachment of requested) {
      const path = resolveAttachmentPathById({
        attachmentsDir: config.value.attachmentsDir,
        attachmentId: attachment.id,
      });
      const bytes =
        path === null
          ? null
          : yield* fileSystem.value.readFile(path).pipe(Effect.orElseSucceed(() => null));
      if (bytes === null) return null;
      digests.push({
        id: attachment.id,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
    return digests;
  });

  /** Archives idle threads that not-started placements left on this host; failures retry later. */
  const cleanUp = Effect.fn("PlacementPlacer.cleanUp")(function* <E, R>(
    host: string,
    authorize: Effect.Effect<RuntimeMode, E, R>,
  ) {
    const pending = yield* attempts.pendingCleanups(host, CLEANUP_BATCH);
    for (const row of pending) {
      const threadId = row.cleanupThreadId;
      if (threadId === null) continue;
      const archived: Effect.Effect<
        unknown,
        | E
        | SshRemoteDispatch.SshRemoteDispatchError
        | ThreadLifecycle.ThreadLifecycleError
        | string,
        R
      > =
        host === LOCAL_TARGET
          ? Option.isNone(lifecycle)
            ? Effect.fail("no thread lifecycle here")
            : lifecycle.value.archive({
                threadId: ThreadId.make(threadId),
                commandId: ("placement-cleanup:" + threadId) as CommandId,
              })
          : dispatch.callHostTool(
              {
                host,
                tool: "goat_thread_organize",
                arguments: {
                  threadId,
                  action: "archive",
                  clientRequestId: "placement-cleanup:" + threadId,
                },
                writes: true,
                timeoutMs: 30_000,
              },
              authorize,
            );
      const done = yield* Effect.result(archived);
      if (done._tag === "Success")
        yield* attempts.clearCleanup({ ownerKey: row.ownerKey, attempt: row.attempt });
      else
        yield* Effect.logWarning("placement cleanup will retry", {
          host,
          threadId,
          cause: describe(done.failure),
        });
    }
  });

  const started = (attempt: Attempt): PlacedOutcome => ({
    _tag: "Started",
    attempt,
    threadId: attempt.threadId ?? "",
    runId: attempt.runId,
  });

  /** Sends this attempt's key with its frozen payload to its own target. */
  const sendRemote = Effect.fn("PlacementPlacer.sendRemote")(function* <E, R>(
    attempt: Attempt,
    authorize: Effect.Effect<RuntimeMode, E, R>,
  ) {
    const host = attempt.targetHost;
    yield* cleanUp(host, authorize).pipe(Effect.ignore);
    // The payload as first sent, whatever the caller would build now.
    const frozen = decodeJson(attempt.payloadJson) as FrozenRemote;
    // An upload goes afresh each time; its bytes must still be the ones this key was made for.
    const current = yield* attachmentDigests(frozen.launch);
    if (current === null || encodeJson(current) !== encodeJson(frozen.attachments)) {
      const message =
        "An attachment of this placement is gone or changed here, so nothing was sent.";
      yield* attempts.recordAnswer({
        ownerKey: attempt.ownerKey,
        attempt: attempt.attempt,
        answer: message,
      });
      return { _tag: "Unknown", attempt, message } satisfies PlacedOutcome;
    }
    const sent = yield* dispatch
      .launchThread(
        { ...frozen.launch, host, placement: argumentOf(attempt) },
        authorize.pipe(Effect.asVoid),
      )
      .pipe(Effect.result);
    if (sent._tag === "Success") {
      yield* attempts.recordStarted({
        ownerKey: attempt.ownerKey,
        attempt: attempt.attempt,
        threadId: sent.success.threadId,
        runId: sent.success.runId,
      });
      return {
        _tag: "Started",
        attempt,
        threadId: sent.success.threadId,
        runId: sent.success.runId,
      } satisfies PlacedOutcome;
    }
    const error = sent.failure;
    if (!(error instanceof SshRemoteDispatch.SshRemoteDispatchError))
      return yield* Effect.fail(error);
    yield* attempts.recordAnswer({
      ownerKey: attempt.ownerKey,
      attempt: attempt.attempt,
      answer: error.message,
    });
    // Only the target's fenced row frees a new attempt (§11 rule 7).
    if (error.remoteClassification === "placement_not_started") {
      yield* attempts.recordNotStarted({
        ownerKey: attempt.ownerKey,
        attempt: attempt.attempt,
        threadId: error.remoteThreadId ?? null,
      });
      yield* cleanUp(host, authorize).pipe(Effect.ignore);
      return { _tag: "NotStarted", attempt, message: error.message } satisfies PlacedOutcome;
    }
    return { _tag: "Unknown", attempt, message: error.message } satisfies PlacedOutcome;
  });

  const localCleanUp = cleanUp(LOCAL_TARGET, Effect.succeed("full-access" as RuntimeMode)).pipe(
    Effect.ignore,
  );

  /** Places this attempt through this machine's own admission, rebuilt from its frozen payload. */
  const sendLocal = Effect.fn("PlacementPlacer.sendLocal")(function* <P, E>(
    attempt: Attempt,
    launch: (commandId: CommandId, payload: P) => Effect.Effect<unknown, E>,
  ) {
    if (Option.isNone(admission))
      return {
        _tag: "Unknown",
        attempt,
        message: "This machine does not admit placements.",
      } satisfies PlacedOutcome;
    yield* localCleanUp;
    const frozen = decodeJson(attempt.payloadJson) as P;
    const answer: PlacementAnswer = yield* admission.value.place({
      key: {
        placer: "local",
        ownerKey: attempt.ownerKey,
        attempt: attempt.attempt,
        issuedAt: attempt.issuedAt,
      },
      digest: NodeCrypto.createHash("sha256").update(attempt.payloadJson).digest("hex"),
      launch: (commandId) => launch(commandId, frozen),
    });
    switch (answer._tag) {
      case "Started":
        yield* attempts.recordStarted({
          ownerKey: attempt.ownerKey,
          attempt: attempt.attempt,
          threadId: answer.threadId,
          runId: answer.runId,
        });
        return {
          _tag: "Started",
          attempt,
          threadId: answer.threadId,
          runId: answer.runId,
        } satisfies PlacedOutcome;
      case "NotStarted":
        yield* attempts.recordNotStarted({
          ownerKey: attempt.ownerKey,
          attempt: attempt.attempt,
          threadId: answer.threadId,
        });
        yield* localCleanUp;
        return { _tag: "NotStarted", attempt, message: answer.reason } satisfies PlacedOutcome;
      default:
        yield* attempts.recordAnswer({
          ownerKey: attempt.ownerKey,
          attempt: attempt.attempt,
          answer: answer._tag,
        });
        return {
          _tag: "Unknown",
          attempt,
          message: "This machine answered " + answer._tag + ".",
        } satisfies PlacedOutcome;
    }
  });

  const resolveFor = Effect.fn("PlacementPlacer.resolveFor")(function* (
    ownerKey: string,
    targetHost: string,
    payload: unknown,
  ) {
    return yield* attempts.resolve({
      ownerKey,
      targetHost,
      payloadJson: encodeJson(payload),
      now: yield* Clock.currentTimeMillis,
    });
  });

  const pinnedElsewhere = (attempt: Attempt): PlacedOutcome => ({
    _tag: "Unknown",
    attempt,
    message:
      "An earlier attempt on " +
      attempt.targetHost +
      " has an unknown outcome; nothing is sent elsewhere.",
  });

  const placeRemote: PlacementPlacerShape["placeRemote"] = Effect.fn("PlacementPlacer.placeRemote")(
    function* (input) {
      const digests = yield* attachmentDigests(input.launch);
      // Unreadable bytes cannot be uploaded either: nothing is sent and no attempt changes.
      if (digests === null)
        return yield* new PlacementAttemptsError({
          operation: "attachments",
          cause: "An attachment of this launch cannot be read here.",
        });
      const resolved = yield* resolveFor(input.ownerKey, input.host, {
        launch: input.launch,
        attachments: digests,
      } satisfies FrozenRemote);
      if (resolved._tag === "Started") return started(resolved.attempt);
      if (resolved._tag === "PinnedElsewhere") return pinnedElsewhere(resolved.attempt);
      return yield* sendRemote(resolved.attempt, input.authorize);
    },
  );

  const placeLocal: PlacementPlacerShape["placeLocal"] = Effect.fn("PlacementPlacer.placeLocal")(
    function* (input) {
      const resolved = yield* resolveFor(input.ownerKey, LOCAL_TARGET, input.payload);
      if (resolved._tag === "Started") return started(resolved.attempt);
      if (resolved._tag === "PinnedElsewhere") return pinnedElsewhere(resolved.attempt);
      return yield* sendLocal(resolved.attempt, input.launch);
    },
  );

  /** What a lookup of an earlier launch learns: only the attempt's own key may answer it. */
  const recover: PlacementPlacerShape["recover"] = Effect.fn("PlacementPlacer.recover")(
    function* (input) {
      const latest = yield* attempts.latest(input.ownerKey);
      if (latest === null) return { _tag: "NotSent" } as const;
      if (latest.state === "started") return started(latest);
      if (latest.state === "not_started")
        return {
          _tag: "NotStarted",
          attempt: latest,
          message: latest.lastAnswer ?? "not started",
        } as const;
      if (latest.rerunBy !== null) return { _tag: "RerunChosen", attempt: latest } as const;
      return latest.targetHost === LOCAL_TARGET
        ? yield* sendLocal(latest, input.local)
        : yield* sendRemote(latest, input.authorize);
    },
  );

  // Independent of new placements: archive what fenced attempts left, and drop settled history
  // past 30 days. Unknown attempts and the attempt counters are kept, so no key is ever reused.
  if (yield* PlacementAdmissionEnabled)
    yield* Effect.gen(function* () {
      for (const host of yield* attempts.hostsWithCleanups(CLEANUP_BATCH))
        yield* cleanUp(host, Effect.succeed<RuntimeMode>("approval-required")).pipe(Effect.ignore);
      yield* attempts.prune(yield* Clock.currentTimeMillis);
    }).pipe(
      Effect.catch((error) => Effect.logWarning("placement maintenance failed", { error })),
      Effect.repeat(Schedule.spaced(MAINTENANCE_EVERY)),
      Effect.forkIn(yield* Effect.scope),
    );

  return PlacementPlacer.of({
    recover,
    latestAttempt: attempts.latest,
    hasAttempt: Effect.fn("PlacementPlacer.hasAttempt")(function* (ownerKey: string) {
      return (yield* attempts.latest(ownerKey)) !== null;
    }),
    placeRemote,
    placeLocal,
  });
});

export const layer = Layer.effect(PlacementPlacer, make);
