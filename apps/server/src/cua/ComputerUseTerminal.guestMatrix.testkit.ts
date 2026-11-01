import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { replaceWithTerminal, type ComputerUseTerminalReason } from "./ComputerUseTerminal.ts";
import {
  finishCellResponse,
  makeCellAuthority,
  watchCellTerminals,
} from "../screenCode/ScreenCellAuthority.ts";
import { ScreenHostBridge } from "../screenCode/ScreenHostBridge.ts";
import { screenRunLimits } from "../screenCode/ScreenRunLimits.ts";

export const guestCompletion = (input: {
  readonly possible: boolean;
  readonly reasons: readonly ComputerUseTerminalReason[];
}) =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    const cells = makeCellAuthority(undefined);
    const { terminals, evidence } = watchCellTerminals(bridge, cells);
    const id = "run\0turn";
    yield* cells.begin(id, "cell", "thread");
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const reason = replaceWithTerminal("none", ...input.reasons).reason;
    if (reason === undefined) return yield* Effect.die("expected terminal reason");
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            Effect.fail({ code: reason, effectStarted: input.possible, nextStep: "interrupted" }),
          ),
        ),
    });
    const context = {
      runId: "run",
      turnId: "turn",
      cellId: "cell",
      threadId: "thread",
      environmentId: "env",
      limits: screenRunLimits(),
      invocation: {
        environmentId: EnvironmentId.make("env"),
        capabilities: new Set<"preview">(),
        issuedAt: 0,
        requestNamespace: "test",
        client: undefined,
        thread: {
          threadId: ThreadId.make("thread"),
          providerSessionId: "s",
          providerInstanceId: ProviderInstanceId.make("p"),
        },
      },
    };
    const pending = yield* bridge
      .handle(
        {
          t: "call",
          runId: "run",
          turnId: "turn",
          cellId: "cell",
          callId: 1,
          method: "list_apps",
          args: {},
          deadlineMillis: 60000,
        },
        context,
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const collected = bridge.takeCellImagesNow("run", "turn", "cell");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(pending);
    const outcome = yield* Effect.succeed({
      runId: "run",
      turnId: "turn",
      cellId: "cell",
      status: "failed" as const,
      console: [],
      journal: collected.journal,
      truncated: [],
      availability: [],
      imageMetadata: [],
      images: [],
      error: { name: "Error", message: "guest failed" },
    }).pipe(finishCellResponse({ id, cellId: "cell", cells, terminals, evidence }), Effect.result);
    if (outcome._tag !== "Failure") return yield* Effect.die("expected terminal failure");
    return replaceWithTerminal(outcome.failure);
  });
