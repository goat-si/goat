import { ProviderInstanceId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as CodexSurvivors from "./CodexSurvivors.ts";
import type * as CodexDetached from "./CodexDetachedAppServerLive.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";

export const attachGoalOnlySessions = Effect.fn("CodexGoalSessionRecovery.attach")(
  function* (input: {
    readonly detached: CodexDetached.CodexDetachedAppServers["Service"];
    readonly survivors: CodexSurvivors.CodexSurvivors["Service"];
    readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
    readonly sessions: ProviderSessionManager.ProviderSessionManagerV2["Service"];
    readonly projects?: ProjectStore.ProjectStoreV2["Service"];
  }) {
    const records = yield* input.detached.loadRecords;
    if (
      records.globalBlock !== undefined ||
      !records.some((record) => (record.goalBlocks?.length ?? 0) > 0)
    )
      return;
    const bindings = yield* input.survivors.list;
    const processed = new Set<string>();
    for (const record of records) {
      if ((record.goalBlocks?.length ?? 0) === 0 || processed.has(record.instanceId)) continue;
      processed.add(record.instanceId);
      if (records.filter((entry) => entry.instanceId === record.instanceId).length !== 1) {
        yield* Effect.logWarning("Multiple Codex records prevent goal session recovery", {
          instanceId: record.instanceId,
        });
        continue;
      }
      if (
        record.state !== "running" ||
        record.stderrMode !== "discard" ||
        bindings.some((binding) => binding.recordName === record.name)
      )
        continue;
      const instanceId = ProviderInstanceId.make(record.instanceId);
      const classification = yield* input.survivors
        .classifyRecord({ instanceId, recordName: record.name })
        .pipe(Effect.option);
      if (Option.isNone(classification) || classification.value.type !== "verified") {
        yield* Effect.logWarning("Could not verify a retained Codex goal process", {
          instanceId,
          recordName: record.name,
        });
        continue;
      }
      for (const goal of record.goalBlocks ?? []) {
        const opened = yield* Effect.gen(function* () {
          const projection = yield* input.projections.getThreadRecords(goal.threadId, [
            "providerThreads",
            "providerSessions",
          ]);
          if (projection.thread.deletedAt !== null) return false;
          const providerThread = projection.providerThreads.find(
            (thread) =>
              thread.providerInstanceId === instanceId &&
              thread.nativeThreadRef?.nativeId === goal.nativeThreadId,
          );
          const providerSessionId =
            providerThread?.providerSessionId ??
            IdAllocator.derive.providerSession({ providerInstanceId: instanceId });
          const oldSession = projection.providerSessions.find(
            (session) => session.id === providerSessionId,
          );
          const project =
            projection.thread.worktreePath === null && input.projects !== undefined
              ? yield* input.projects.get(projection.thread.projectId)
              : Option.none();
          const cwd =
            projection.thread.worktreePath ??
            (Option.isSome(project) ? project.value.workspaceRoot : null);
          yield* input.sessions.open({
            threadId: goal.threadId,
            providerSessionId,
            modelSelection: { ...projection.thread.modelSelection, instanceId },
            runtimePolicy: {
              runtimeMode: projection.thread.runtimeMode,
              interactionMode: projection.thread.interactionMode,
              cwd,
            },
            ...(oldSession === undefined ? {} : { resumeFromSession: oldSession }),
            initialNativeThreadId: goal.nativeThreadId,
          });
          return true;
        }).pipe(
          Effect.timeoutOption("15 seconds"),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("Could not reconnect a Codex goal session", {
                instanceId,
                threadId: goal.threadId,
                cause,
              }).pipe(Effect.as(Option.none())),
          ),
        );
        if (Option.isSome(opened) && opened.value) break;
        if (Option.isNone(opened))
          yield* Effect.logWarning("Codex goal session was not attached", {
            instanceId,
            threadId: goal.threadId,
          });
      }
    }
  },
);
