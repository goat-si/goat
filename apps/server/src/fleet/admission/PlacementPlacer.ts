import { type CommandId, ThreadId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest of a frozen payload.
import * as NodeCrypto from "node:crypto";

import type { RuntimeMode } from "@goat/contracts";
import * as ThreadLifecycle from "../../orchestration-v2/ThreadLifecycleService.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { type PlacementAnswer, PlacementAdmission } from "./PlacementAdmission.ts";
import {
  type Attempt,
  PlacementAttempts,
  type PlacementAttemptsError,
} from "./PlacementAttempts.ts";
import type { PlacementArgument } from "./PlacementKey.ts";

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

export const argumentOf = (attempt: Attempt): PlacementArgument => ({
  ownerKey: attempt.ownerKey,
  attempt: attempt.attempt,
  issuedAt: DateTime.formatIso(DateTime.makeUnsafe(attempt.issuedAt)),
});

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export interface PlacementPlacerShape {
  /** One attempt on another GOAT over SSH dispatch; a retry resends the frozen payload. */
  readonly placeRemote: <E, R>(input: {
    readonly ownerKey: string;
    readonly host: string;
    readonly launch: Omit<SshRemoteDispatch.SshLaunchInput, "placement" | "host" | "target">;
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

export const LOCAL_TARGET = "local";

const make = Effect.gen(function* () {
  const attempts = yield* PlacementAttempts;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const admission = yield* Effect.serviceOption(PlacementAdmission);
  const lifecycle = yield* Effect.serviceOption(ThreadLifecycle.ThreadLifecycleService);

  /** Archives idle threads that not-started placements left on this host; failures retry later. */
  const cleanUp = Effect.fn("PlacementPlacer.cleanUp")(function* <E, R>(
    host: string,
    authorize: Effect.Effect<RuntimeMode, E, R>,
  ) {
    const pending = (yield* attempts.pendingCleanups).filter((row) => row.targetHost === host);
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

  const placeRemote: PlacementPlacerShape["placeRemote"] = Effect.fn("PlacementPlacer.placeRemote")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const resolved = yield* attempts.resolve({
        ownerKey: input.ownerKey,
        targetHost: input.host,
        payloadJson: encodeJson(input.launch),
        now,
      });
      if (resolved._tag === "Started")
        return {
          _tag: "Started",
          attempt: resolved.attempt,
          threadId: resolved.attempt.threadId ?? "",
          runId: resolved.attempt.runId,
        } as const;
      if (resolved._tag === "PinnedElsewhere")
        return {
          _tag: "Unknown",
          attempt: resolved.attempt,
          message:
            "An earlier attempt on " +
            resolved.attempt.targetHost +
            " has an unknown outcome; nothing is sent elsewhere.",
        } as const;
      const attempt = resolved.attempt;
      yield* cleanUp(input.host, input.authorize).pipe(Effect.ignore);
      // The payload as first sent, whatever the caller would build now.
      const frozen = decodeJson(attempt.payloadJson) as typeof input.launch;
      const sent = yield* dispatch
        .launchThread(
          { ...frozen, host: input.host, placement: argumentOf(attempt) },
          input.authorize.pipe(Effect.asVoid),
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
        } as const;
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
        yield* cleanUp(input.host, input.authorize).pipe(Effect.ignore);
        return { _tag: "NotStarted", attempt, message: error.message } as const;
      }
      return { _tag: "Unknown", attempt, message: error.message } as const;
    },
  );

  const placeLocal: PlacementPlacerShape["placeLocal"] = Effect.fn("PlacementPlacer.placeLocal")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const resolved = yield* attempts.resolve({
        ownerKey: input.ownerKey,
        targetHost: LOCAL_TARGET,
        payloadJson: encodeJson(input.payload),
        now,
      });
      if (resolved._tag === "Started")
        return {
          _tag: "Started",
          attempt: resolved.attempt,
          threadId: resolved.attempt.threadId ?? "",
          runId: resolved.attempt.runId,
        } as const;
      if (resolved._tag === "PinnedElsewhere")
        return {
          _tag: "Unknown",
          attempt: resolved.attempt,
          message:
            "An earlier attempt on " + resolved.attempt.targetHost + " has an unknown outcome.",
        } as const;
      const attempt = resolved.attempt;
      if (Option.isNone(admission))
        return {
          _tag: "Unknown",
          attempt,
          message: "This machine does not admit placements.",
        } as const;
      yield* cleanUp(LOCAL_TARGET, Effect.succeed("full-access" as RuntimeMode)).pipe(
        Effect.ignore,
      );
      const frozen = decodeJson(attempt.payloadJson) as typeof input.payload;
      const answer: PlacementAnswer = yield* admission.value.place({
        key: {
          placer: "local",
          ownerKey: attempt.ownerKey,
          attempt: attempt.attempt,
          issuedAt: attempt.issuedAt,
        },
        digest: NodeCrypto.createHash("sha256").update(attempt.payloadJson).digest("hex"),
        launch: (commandId) => input.launch(commandId, frozen),
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
          } as const;
        case "NotStarted":
          yield* attempts.recordNotStarted({
            ownerKey: attempt.ownerKey,
            attempt: attempt.attempt,
            threadId: answer.threadId,
          });
          yield* cleanUp(LOCAL_TARGET, Effect.succeed("full-access" as RuntimeMode)).pipe(
            Effect.ignore,
          );
          return { _tag: "NotStarted", attempt, message: answer.reason } as const;
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
          } as const;
      }
    },
  );

  return PlacementPlacer.of({ placeRemote, placeLocal });
});

export const layer = Layer.effect(PlacementPlacer, make);
