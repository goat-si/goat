import { CommandId, type ThreadId } from "@goat/contracts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import { backgroundReads } from "@goat/shared/readerAdmission";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AutomationHold from "../automationHold.ts";
import * as CodexDetached from "../provider/CodexDetachedAppServerLive.ts";
import * as CodexSurvivors from "../provider/CodexSurvivors.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import type * as EventSink from "./EventSink.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";
import { runShutdownContinuationTasks } from "./ShutdownContinuationTasks.ts";

export type ShutdownContinuationSummary = {
  readonly candidates: number;
  readonly continued: number;
};

const prepareOrdinaryContinuations = Effect.fn(
  "ProviderRuntimeShutdown.prepareOrdinaryContinuations",
)(function* (input: {
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly sink: EventSink.EventSinkV2["Service"];
  readonly protectedThreads: ReadonlySet<ThreadId>;
}) {
  const enabled = yield* input.settings.getSettings.pipe(Effect.orElseSucceed(() => null));
  if (!enabled) return { candidates: 0, continued: 0 };
  const threadIds = (yield* backgroundReads(
    input.projections.getRecoveryThreadIds("shutdown-continuation"),
  )).filter((threadId) => !input.protectedThreads.has(threadId));
  return yield* runShutdownContinuationTasks(threadIds, (threadId) =>
    backgroundReads(
      Effect.gen(function* () {
        const projection = yield* input.projections.getRuntimeRecoveryProjection(threadId);
        if (
          !resolveProjectSettings(enabled, projection.thread.projectId).settings
            .continueThreadsAfterServerUpdate
        )
          return false;
        const cloudThreadIds = new Set(
          projection.providerThreads
            .filter((thread) => thread.cloudTask !== undefined)
            .map((thread) => thread.id),
        );
        const run = restartContinuationRun(
          {
            ...projection,
            runs: projection.runs.filter(
              (run) => run.providerThreadId === null || !cloudThreadIds.has(run.providerThreadId),
            ),
          },
          yield* DateTime.now,
        );
        if (!run) return false;
        const commandId = CommandId.make(`command:restart-prepare:${run.id}`);
        yield* input.sink.writeWithEffects({
          commandId,
          events: [],
          effects: [
            {
              id: `effect:restart-continuation:${run.id}`,
              commandId,
              threadId,
              request: { type: "provider-runtime.continue", sourceRunId: run.id },
            },
          ],
        });
        return true;
      }),
    ),
  );
});

export const prepare = Effect.fn("ProviderRuntimeShutdown.prepare")(function* (input: {
  readonly stopKind: "restart" | "quit";
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly sink: EventSink.EventSinkV2["Service"];
}) {
  const empty = { threads: new Set<ThreadId>(), sessions: new Set<string>() };
  if (yield* AutomationHold.isHeld) return { ...empty, summary: { candidates: 0, continued: 0 } };
  const detached = yield* Effect.serviceOption(CodexDetached.CodexDetachedAppServers);
  const survivors = yield* Effect.serviceOption(CodexSurvivors.CodexSurvivors);
  // A failure before any retention leaves every app-server to close with its session.
  const prepared = Option.isSome(detached)
    ? yield* backgroundReads(
        CodexSurvivors.prepareShutdownSurvivors({
          ...input,
          detached: detached.value,
          bindings: Option.isSome(survivors) ? yield* survivors.value.list : [],
        }),
      ).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Failed to prepare Codex turns to survive shutdown", { cause }).pipe(
              Effect.as(empty),
            ),
        ),
      )
    : empty;
  const ordinary = yield* prepareOrdinaryContinuations({
    ...input,
    protectedThreads: prepared.threads,
  });
  return {
    ...prepared,
    summary: {
      candidates: ordinary.candidates + prepared.threads.size,
      continued: ordinary.continued + prepared.threads.size,
    },
  };
});
