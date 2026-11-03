import { ProviderInstanceId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { servesSession } from "./CodexRecordSessions.ts";
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
    for (const record of records) {
      if ((record.goalBlocks?.length ?? 0) === 0) continue;
      const providerSessionId = record.providerSessionId;
      if (
        providerSessionId === undefined ||
        records.filter((entry) => servesSession(entry, record.instanceId, providerSessionId))
          .length !== 1
      ) {
        yield* Effect.logWarning("Codex goal session recovery needs one record per session", {
          instanceId: record.instanceId,
          recordName: record.name,
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
          // Opening another session here would load this native thread in a second process.
          if (
            providerThread?.providerSessionId != null &&
            providerThread.providerSessionId !== providerSessionId
          )
            return false;
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
