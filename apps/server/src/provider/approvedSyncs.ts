import {
  type AuthSessionId,
  type EnvironmentAuthorizationError,
  type Handoff,
  HandoffError,
  type HandoffRespondInput,
  ProviderHostSyncError,
  ProviderSyncInput,
  ProviderSyncState,
  TurnItemId,
  isHandoffPending,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type * as Handoffs from "../handoffs/Handoffs.ts";
import type { SshHostCaller } from "../sshRemote/SshHostAuthorization.ts";

export const HOST_SYNC_PATH = "provider.host_sync";
/** An approval may start its sync this long after the person answered, including after a restart. */
const START_WINDOW = { minutes: 15 };
const RESTARTED =
  "GOAT restarted on this machine before this host finished. Call goat_provider_host_matrix to see its state.";
const MAY_HAVE_RUN =
  "GOAT restarted while this sync was starting, so it may have run. Call goat_provider_host_matrix to see each host.";
const TOO_OLD =
  "The person approved this sync, but GOAT stopped before it started and the approval is now too old to start. Call goat_provider_sync to ask again.";

/**
 * What an approved sync has done, kept in the approval handoff's encrypted payload: `starting`
 * before any work is registered, then the syncId, then the final per-host result without sign-in
 * codes. A start that never happened is `failed`.
 */
const Progress = Schema.Struct({
  starting: Schema.optionalKey(Schema.Literal(true)),
  syncId: Schema.optionalKey(Schema.String),
  failed: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(ProviderSyncState),
});
type Progress = typeof Progress.Type;
const decodeProgress = Schema.decodeUnknownEffect(Progress);
const decodeInput = Schema.decodeUnknownEffect(ProviderSyncInput);
const readProgress = Schema.decodeUnknownOption(Progress);

const OK_PHASES: ReadonlySet<string> = new Set(["installed", "signed_in"]);

/**
 * What the thread that asked hears once its approved sync settled: whether it started, and how
 * each host ended. Sign-in codes are never part of the recorded result.
 */
export const settledSyncWake = (progress: unknown) => {
  const settled = Option.getOrUndefined(readProgress(progress));
  if (settled?.failed !== undefined)
    return {
      summary: "failed",
      text: `${settled.failed} Ask again only if the user still wants it.`,
    };
  const hosts = settled?.result?.hosts ?? [];
  if (hosts.length === 0)
    return {
      summary: "settled",
      text: "The sync settled; goat_provider_host_matrix shows each host.",
    };
  const failed = hosts.filter((host) => !OK_PHASES.has(host.phase));
  const name = (host: (typeof hosts)[number]) => host.host ?? "this machine";
  return {
    summary:
      failed.length === 0
        ? "applied"
        : failed.length === hosts.length
          ? "failed"
          : "partly applied",
    text: [
      `The sync finished on ${hosts.length - failed.length} of ${hosts.length} host(s).`,
      ...failed.map(
        (host) =>
          `${name(host)}: ${host.phase}${host.message === undefined ? "" : ` (${host.message})`}.`,
      ),
      "goat_provider_host_matrix shows each host.",
    ].join(" "),
  };
};

const fail = (code: ProviderHostSyncError["code"], detail: string) =>
  new ProviderHostSyncError({ code, detail });

const withoutLogin = (state: ProviderSyncState): ProviderSyncState => ({
  ...state,
  hosts: state.hosts.map(({ login: _login, ...host }) => host),
});

/** Typed failures carry text safe to show; anything else stays generic. */
const startFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  const message =
    Option.isSome(error) &&
    typeof error.value === "object" &&
    error.value !== null &&
    "message" in error.value &&
    typeof error.value.message === "string"
      ? error.value.message
      : "an unexpected error stopped it.";
  return `The person approved this sync, but it did not start: ${message}`;
};

/** The approval card stored the request with hosts [] and version null for the defaults. */
const requestOf = (args: Readonly<Record<string, unknown>>) => {
  const { hosts, version, ...rest } = args;
  return decodeInput({
    ...rest,
    ...(Array.isArray(hosts) && hosts.length > 0 ? { hosts } : {}),
    ...(typeof version === "string" ? { version } : {}),
  }).pipe(Effect.mapError(() => fail("invalid_request", "The approved request is unreadable.")));
};

export interface ApprovedSyncLauncher<Prepared> {
  /** Checks the approver's live grant and resolves the request. Nothing runs yet. */
  readonly prepare: (
    input: ProviderSyncInput,
    approvedBy: AuthSessionId,
    requester: string,
  ) => Effect.Effect<Prepared, ProviderHostSyncError | EnvironmentAuthorizationError>;
  /** Registers the sync, or joins an identical running one, and forks its hosts. */
  readonly launch: (
    prepared: Prepared,
    settle: (state: ProviderSyncState) => Effect.Effect<void>,
  ) => Effect.Effect<ProviderSyncState, ProviderHostSyncError>;
  readonly isTracked: (syncId: string) => boolean;
}

type Continuation = Effect.Success<
  ReturnType<Handoffs.Handoffs["Service"]["completedProviderContinuations"]>
>[number];

/**
 * Approved provider syncs, durable in the approval handoff (handoffs own continuations, D9), so a
 * restart neither loses an approval nor replays one whose sync may already have run.
 */
export const makeApprovedSyncs = Effect.fn("ProviderHostSync.makeApprovedSyncs")(function* <
  Prepared,
>(handoffs: Handoffs.Handoffs["Service"], launcher: ApprovedSyncLauncher<Prepared>) {
  const lock = yield* Semaphore.make(1);
  // Approvals this process is starting (null) or running (syncId); resume never touches them.
  const live = new Map<string, string | null>();
  // Finished syncs whose result could not be written yet; the binding stays until it is.
  const unsettled = new Map<string, { readonly handoff: Handoff; readonly result: Progress }>();

  const addressOf = (handoff: Handoff) => ({
    threadId: handoff.requestedBy.threadId,
    handoffId: handoff.handoffId,
  });
  const finish = (handoff: Handoff, progress: Progress) =>
    handoffs.finishProviderContinuation(addressOf(handoff), progress);

  const settle = (handoff: Handoff, result: Progress) =>
    finish(handoff, result).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.sync(() => unsettled.set(handoff.handoffId, { handoff, result })).pipe(
            Effect.andThen(Effect.logWarning("Could not record a finished provider sync.", cause)),
          ),
        onSuccess: () =>
          Effect.sync(() => {
            unsettled.delete(handoff.handoffId);
            live.delete(handoff.handoffId);
          }),
      }),
    );
  const settler = (handoff: Handoff) => (state: ProviderSyncState) =>
    settle(handoff, { syncId: state.syncId, result: withoutLogin(state) });

  const begin = Effect.fn("ProviderHostSync.startApproved")(
    function* (entry: Continuation) {
      const { handoff } = entry;
      const id = handoff.handoffId;
      const prepared = yield* Effect.exit(
        requestOf(entry.args).pipe(
          Effect.flatMap((input) =>
            launcher.prepare(
              input,
              entry.approvedBySessionId,
              `thread:${handoff.requestedBy.threadId}`,
            ),
          ),
        ),
      );
      if (Exit.isFailure(prepared))
        return yield* finish(handoff, { failed: startFailure(prepared.cause) });
      // Intent, registration and forks happen together or not at all, so no registered sync is
      // left unlaunched and every recorded start is one that may have run.
      const started = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          live.set(id, null);
          const intent = yield* Effect.exit(
            handoffs.recordProviderProgress(addressOf(handoff), { starting: true }),
          );
          // Nothing ran; the next resume starts it.
          if (Exit.isFailure(intent)) return Option.none<ProviderSyncState>();
          const launched = yield* Effect.exit(launcher.launch(prepared.value, settler(handoff)));
          if (Exit.isFailure(launched)) {
            yield* finish(handoff, { failed: startFailure(launched.cause) }).pipe(Effect.ignore);
            return Option.none<ProviderSyncState>();
          }
          if (live.has(id)) live.set(id, launched.value.syncId);
          return Option.some(launched.value);
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) && Option.isSome(exit.value)
              ? Effect.void
              : Effect.sync(() => live.delete(id)),
          ),
        ),
      );
      if (Option.isNone(started)) return;
      // After the sync settled the payload is an outcome and this write is refused, harmlessly.
      yield* handoffs
        .recordProviderProgress(addressOf(handoff), {
          syncId: started.value.syncId,
          result: withoutLogin(started.value),
        })
        .pipe(Effect.ignore);
    },
    Effect.catchCause((cause) => Effect.logWarning("Approved provider sync did not start.", cause)),
  );

  /** A start this process no longer tracks: the server stopped while it ran or started. */
  const interrupted = (progress: Progress): Progress =>
    progress.syncId !== undefined && progress.result !== undefined
      ? {
          syncId: progress.syncId,
          result: {
            ...progress.result,
            done: true,
            hosts: progress.result.hosts.map((host) =>
              ["signed_in", "failed", "cancelled", "update_runtime"].includes(host.phase)
                ? host
                : { ...host, phase: "failed", message: RESTARTED },
            ),
          },
        }
      : {
          ...(progress.syncId === undefined ? {} : { syncId: progress.syncId }),
          failed: MAY_HAVE_RUN,
        };

  const resumeOne = Effect.fn("ProviderHostSync.resumeApproved")(
    function* (entry: Continuation) {
      const { handoff } = entry;
      if (live.has(handoff.handoffId)) return;
      if (entry.progress === undefined) {
        const answered = DateTime.add(handoff.resolvedAt ?? handoff.createdAt, START_WINDOW);
        if (DateTime.isGreaterThan(yield* DateTime.now, answered))
          return yield* finish(handoff, { failed: TOO_OLD });
        return yield* begin(entry);
      }
      const progress = yield* decodeProgress(entry.progress).pipe(
        Effect.orElseSucceed((): Progress => ({})),
      );
      if (progress.syncId !== undefined && launcher.isTracked(progress.syncId)) return;
      yield* finish(handoff, interrupted(progress));
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not resume an approved provider sync.", cause),
    ),
  );

  const resume = Effect.gen(function* () {
    for (const { handoff, result } of [...unsettled.values()]) yield* settle(handoff, result);
    for (const entry of yield* handoffs.completedProviderContinuations(HOST_SYNC_PATH))
      yield* resumeOne(entry);
  }).pipe(lock.withPermits(1));

  /** Approving runs once: a second click on an answered card is a conflict and starts nothing. */
  const respond = Effect.fn("ProviderHostSync.respondApproval")(function* (
    input: HandoffRespondInput,
    sessionId: AuthSessionId,
  ) {
    if (input.action !== "completed") return yield* handoffs.respond(input, sessionId);
    const record = yield* handoffs.read(input);
    if (!isHandoffPending(record.state)) return yield* new HandoffError({ reason: "conflict" });
    const handoff = yield* handoffs.respond(input, sessionId);
    const entry = (yield* handoffs.completedProviderContinuations(HOST_SYNC_PATH)).find(
      (candidate) => candidate.handoff.handoffId === handoff.handoffId,
    );
    if (entry !== undefined) yield* begin(entry);
    return handoff;
  }, lock.withPermits(1));

  /** Why a handoff has no sync: read from the persisted handoff in the asking thread. */
  const explain = Effect.fn("ProviderHostSync.explainUnstarted")(function* (
    handoff: Handoff | undefined,
  ) {
    switch (handoff?.state) {
      case "declined":
        return yield* fail("declined", "The person declined this sync, so it will not run.");
      case "expired":
        return yield* fail(
          "expired",
          "This approval expired before anyone answered it. Call goat_provider_sync to ask again.",
        );
      case "cancelled":
        return yield* fail("cancelled", "This approval was cancelled, so the sync will not run.");
      case "failed":
        return yield* fail("start_failed", "This approval failed, so the sync did not start.");
      case "completed":
        return yield* fail(
          "not_found",
          "This approval has no sync on record: it ended more than a day ago or has not started yet. Call goat_provider_host_matrix to see each host.",
        );
      default:
        return yield* fail(
          "not_found",
          "That approval has not started a sync yet. Ask the person to approve it.",
        );
    }
  });

  /**
   * The sync an approval started, read from the caller's own approval handoff, with its final
   * result once it settled. Only the thread that asked holds the handoff.
   */
  const lookup = Effect.fn("ProviderHostSync.lookupApproved")(function* (
    handoffId: string,
    caller: SshHostCaller,
  ) {
    const thread = caller.kind === "mcp" ? caller.scope.thread : undefined;
    if (thread === undefined) return yield* explain(undefined);
    const address = { threadId: thread.threadId, handoffId: TurnItemId.make(handoffId) };
    const unreadable = () => fail("unavailable", "Could not read the approval. Try again.");
    const handoff = yield* handoffs.read(address).pipe(
      Effect.catchTags({
        HandoffError: (error) =>
          error.reason === "not_found" ? Effect.succeed(undefined) : Effect.fail(unreadable()),
      }),
    );
    if (handoff === undefined) return yield* explain(undefined);
    const stored = yield* handoffs.readProviderProgress(address).pipe(Effect.mapError(unreadable));
    const progress =
      stored === undefined
        ? undefined
        : yield* decodeProgress(stored).pipe(Effect.mapError(unreadable));
    if (progress?.failed !== undefined) return yield* fail("start_failed", progress.failed);
    const syncId = progress?.syncId ?? live.get(handoffId) ?? undefined;
    if (syncId === undefined) return yield* explain(handoff);
    return progress?.result === undefined ? { syncId } : { syncId, result: progress.result };
  });

  return { respond, resume, lookup };
});

export type ApprovedSyncs = Effect.Success<ReturnType<typeof makeApprovedSyncs>>;
