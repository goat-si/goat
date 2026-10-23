import {
  type Handoff,
  ProviderHostSyncError,
  ProviderSyncInput,
  TurnItemId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type * as Handoffs from "../handoffs/Handoffs.ts";
import type { SshHostCaller } from "../sshRemote/SshHostAuthorization.ts";

const fail = (code: ProviderHostSyncError["code"], detail: string) =>
  new ProviderHostSyncError({ code, detail });

const startFailed = (reason: string) =>
  fail("start_failed", `The person approved this sync, but it did not start: ${reason}`);

/** The arguments the approval card was created with; see ProviderHostSync.requestApproval. */
const decodeApprovedArgs = Schema.decodeUnknownEffect(
  Schema.Struct({
    driver: Schema.String,
    hosts: Schema.Array(Schema.String),
    version: Schema.NullOr(Schema.String),
    login: Schema.Boolean,
  }),
);
const decodeInput = Schema.decodeUnknownEffect(ProviderSyncInput);

/** What an approval became, kept with the handoff so status can answer after a restart. */
const ApprovedOutcome = Schema.Union([
  Schema.Struct({ syncId: Schema.String }),
  Schema.Struct({ failed: Schema.String }),
]);
const decodeOutcome = Schema.decodeUnknownOption(ApprovedOutcome);

/**
 * What each approved provider sync became: the sync it started, or why it never started, so
 * status can say so instead of "not started yet". The approval's arguments and outcome live in
 * the persisted handoff; the maps also answer callers outside the requesting thread.
 */
export const makeApprovedSyncs = Effect.fn("ProviderHostSync.makeApprovedSyncs")(function* (
  handoffs: Handoffs.Handoffs["Service"],
  path: Handoffs.ProviderContinuationPath,
) {
  const started = new Map<string, string>();
  const failedStarts = new Map<string, string>();
  // A repeated approval replays the handoff's completed transition, so only this lock keeps
  // two approvals of one handoff from starting two syncs.
  const lock = yield* Semaphore.make(1);

  /** Starts the sync a completed approval asked for, once, and records what became of it. */
  const startApproved = Effect.fn("ProviderHostSync.startApproved")(function* <
    E extends { readonly message: string },
    R,
  >(handoff: Handoff, start: (input: ProviderSyncInput) => Effect.Effect<string, E, R>) {
    const address = { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId };
    const entry = (yield* handoffs.completedProviderContinuations(path)).find(
      (candidate) => candidate.handoff.handoffId === handoff.handoffId,
    );
    if (entry === undefined) {
      // An earlier approval of this handoff already started it or recorded why it could not.
      if ((yield* handoffs.readProviderProgress(address)) !== undefined) return;
      failedStarts.set(handoff.handoffId, "its request could not be read. Ask again.");
      return yield* Effect.logWarning("Approved provider sync has no stored request.");
    }
    const exit = yield* Effect.exit(
      decodeApprovedArgs(entry.args).pipe(
        Effect.flatMap(({ hosts, version, ...rest }) =>
          decodeInput({
            ...rest,
            ...(hosts.length === 0 ? {} : { hosts }),
            ...(version === null ? {} : { version }),
          }),
        ),
        Effect.mapError(() => fail("invalid_request", "its request could not be read. Ask again.")),
        Effect.flatMap(start),
      ),
    );
    let outcome: typeof ApprovedOutcome.Type;
    if (Exit.isSuccess(exit)) {
      started.set(handoff.handoffId, exit.value);
      outcome = { syncId: exit.value };
    } else {
      // Typed failures carry text safe to show; anything else stays generic.
      const error = Cause.findErrorOption(exit.cause);
      outcome = {
        failed: Option.isSome(error) ? error.value.message : "an unexpected error stopped it.",
      };
      failedStarts.set(handoff.handoffId, outcome.failed);
      yield* Effect.logWarning("Approved provider sync did not start.");
    }
    // The sync already runs or already failed; a lost record only costs status after a restart.
    yield* handoffs
      .finishProviderContinuation(address, outcome)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record what an approved provider sync became.", cause),
        ),
      );
  }, lock.withPermits(1));

  /** The sync an approval started, or a terminal error saying why there is none. */
  const syncFor = Effect.fn("ProviderHostSync.syncForApproval")(function* (
    handoffId: string,
    caller: SshHostCaller,
  ) {
    const known = started.get(handoffId);
    if (known !== undefined) return known;
    const failure = failedStarts.get(handoffId);
    if (failure !== undefined) return yield* startFailed(failure);
    const thread = caller.kind === "mcp" ? caller.scope.thread : undefined;
    const address =
      thread === undefined
        ? undefined
        : { threadId: thread.threadId, handoffId: TurnItemId.make(handoffId) };
    const unreadable = () => fail("unavailable", "Could not read the approval. Try again.");
    const handoff =
      address === undefined
        ? undefined
        : yield* handoffs.read(address).pipe(
            Effect.catchTags({
              HandoffError: (error) =>
                error.reason === "not_found"
                  ? Effect.succeed(undefined)
                  : Effect.fail(unreadable()),
            }),
          );
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
      case "completed": {
        const outcome =
          address === undefined
            ? Option.none()
            : decodeOutcome(
                yield* handoffs.readProviderProgress(address).pipe(Effect.mapError(unreadable)),
              );
        if (Option.isSome(outcome))
          return "syncId" in outcome.value
            ? outcome.value.syncId
            : yield* startFailed(outcome.value.failed);
        return yield* fail(
          "not_found",
          "This approval's sync is no longer tracked: it was approved more than a day ago, or this server restarted before it started. Call goat_provider_host_matrix to see each host.",
        );
      }
      default:
        return yield* fail(
          "not_found",
          "That approval has not started a sync yet. Ask the person to approve it.",
        );
    }
  });

  return { startApproved, syncFor };
});
