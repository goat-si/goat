import {
  CommandId,
  isOrchestrationV2WorkActive,
  latestProviderTurnForAttempt,
  ProviderDriverKind,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as RecoveryFailure from "./CodexSurvivorRecoveryFailure.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as Detached from "./CodexDetachedAppServerLive.ts";
import { CodexDetachedAppServerError } from "./CodexDetachedAppServer.ts";
import type { CodexSurvivorBinding, CodexSurvivors } from "./CodexSurvivors.ts";

export const classifyRecovery = Effect.fn("CodexSurvivors.classifyRecovery")(function* (input: {
  readonly detached: Detached.CodexDetachedAppServers["Service"];
  readonly survivors: CodexSurvivors["Service"];
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly outbox: EffectOutbox.EffectOutboxV2["Service"];
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly sink: EventSink.EventSinkV2["Service"];
  readonly ids: IdAllocator.IdAllocatorV2["Service"];
  readonly skipThreads?: ReadonlySet<ThreadId>;
}) {
  const records = yield* input.detached.loadRecords;
  const globalBlock = records.globalBlock;
  const settings = yield* input.settings.getSettings;
  const threadIds = yield* input.projections.getRecoveryThreadIds("runtime-cleanup");
  const protectedThreads = new Set<ThreadId>();
  const blockedThreads = new Set<ThreadId>();
  const bindings: CodexSurvivorBinding[] = [];
  for (const threadId of threadIds) {
    if (input.skipThreads?.has(threadId)) continue;
    const projection = yield* input.projections
      .getRuntimeRecoveryProjection(threadId)
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.void }));
    if (!projection) continue;
    const sources = yield* input.outbox.continuationSourceRunIds(threadId);
    const missing = sources.filter(
      (id) =>
        !projection.runs.some((run) => run.id === id || run.restartContinuationOfRunId === id),
    );
    const extra =
      missing.length === 0
        ? []
        : (yield* input.projections.getThreadRecords(threadId, ["runs"], { runIds: missing })).runs;
    runLoop: for (const run of [...projection.runs, ...extra]) {
      if (!["preparing", "starting", "running", "waiting"].includes(run.status)) {
        if (run.status !== "cancelled") continue;
        const pending = yield* input.outbox.get(`effect:restart-continuation:${run.id}`);
        if (
          Option.isNone(pending) ||
          pending.value.request.type !== "provider-runtime.continue" ||
          pending.value.request.sourceRunId !== run.id ||
          !["pending", "running", "succeeded"].includes(pending.value.status)
        )
          continue;
      }
      const providerThread = projection.providerThreads.find(
        (value) => value.id === run.providerThreadId,
      );
      if (providerThread?.driver !== "codex") continue;
      if (globalBlock !== undefined) {
        if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
        if (run.activeAttemptId) {
          const own = yield* input.projections.getThreadRecords(threadId, ["providerTurns"], {
            ancestryRunIds: [run.id],
          });
          const turn = latestProviderTurnForAttempt(own.providerTurns, run.activeAttemptId);
          if (turn)
            yield* RecoveryFailure.reportUnverified({ ...input, run, turn }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not report the Codex recovery block", { threadId, cause }),
              ),
            );
        }
        protectedThreads.add(threadId);
        blockedThreads.add(threadId);
        continue;
      }
      if (run.restartContinuationOfRunId !== undefined && run.activeAttemptId) {
        const own = yield* input.projections.getThreadRecords(threadId, ["providerTurns"], {
          ancestryRunIds: [run.id],
        });
        const ownTurn = latestProviderTurnForAttempt(own.providerTurns, run.activeAttemptId);
        if (
          ownTurn &&
          (!ownTurn.nativeTurnRef?.nativeId ||
            ownTurn.id !==
              IdAllocator.derive.providerTurn({
                driver: ProviderDriverKind.make("codex"),
                nativeTurnId: `${ownTurn.nativeTurnRef.nativeId}:restart:${run.id}`,
              }))
        )
          continue;
      }
      const matches = records.filter(
        (value) =>
          value.instanceId === run.providerInstanceId &&
          value.state === "running" &&
          value.stderrMode === "discard",
      );
      if (matches.length === 0) {
        if (run.restartContinuationOfRunId !== undefined && run.activeAttemptId !== null) {
          const records = yield* input.projections.getThreadRecords(threadId, ["providerTurns"], {
            ancestryRunIds: [run.id],
          });
          const turn = latestProviderTurnForAttempt(records.providerTurns, run.activeAttemptId);
          if (
            turn?.nativeTurnRef?.nativeId &&
            turn.id ===
              IdAllocator.derive.providerTurn({
                driver: ProviderDriverKind.make("codex"),
                nativeTurnId: `${turn.nativeTurnRef.nativeId}:restart:${run.id}`,
              })
          ) {
            if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
            yield* RecoveryFailure.reportUnverified({ ...input, run, turn }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not report the Codex recovery block", { threadId, cause }),
              ),
            );
            protectedThreads.add(threadId);
            blockedThreads.add(threadId);
          }
        }
        continue;
      }
      const nativeThread = providerThread.nativeThreadRef;
      if (
        !nativeThread ||
        !nativeThread.nativeId ||
        nativeThread.strength !== "strong" ||
        nativeThread.driver !== "codex"
      ) {
        if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
        if (run.activeAttemptId) {
          const own = yield* input.projections.getThreadRecords(threadId, ["providerTurns"], {
            ancestryRunIds: [run.id],
          });
          const turn = latestProviderTurnForAttempt(own.providerTurns, run.activeAttemptId);
          if (turn)
            yield* RecoveryFailure.reportUnverified({ ...input, run, turn }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not report the Codex recovery block", { threadId, cause }),
              ),
            );
        }
        protectedThreads.add(threadId);
        blockedThreads.add(threadId);
        continue;
      }
      const ancestryIds: RunId[] = [run.id];
      let ancestor = run.restartContinuationOfRunId;
      while (ancestor !== undefined) {
        if (ancestryIds.includes(ancestor) || ancestryIds.length >= 32) {
          if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
          protectedThreads.add(threadId);
          blockedThreads.add(threadId);
          continue runLoop;
        }
        ancestryIds.push(ancestor);
        const prior = yield* input.projections.getThreadRecords(threadId, ["runs"], {
          runIds: [ancestor],
        });
        const source = prior.runs.find((value) => value.id === ancestor);
        if (!source) {
          if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
          protectedThreads.add(threadId);
          blockedThreads.add(threadId);
          continue runLoop;
        }
        ancestor = source.restartContinuationOfRunId;
      }
      const ancestry = yield* input.projections.getThreadRecords(
        threadId,
        ["runs", "attempts", "providerTurns", "turnItems"],
        {
          runIds: ancestryIds,
          ancestryRunIds: ancestryIds,
          turnItemRunIds: ancestryIds,
          turnItemTypes: ["run_interrupt_request"],
        },
      );
      let turn = latestProviderTurnForAttempt(ancestry.providerTurns, run.activeAttemptId);
      if (!turn && run.restartContinuationOfRunId !== undefined) {
        const source = ancestry.runs.find((value) => value.id === run.restartContinuationOfRunId);
        turn = latestProviderTurnForAttempt(ancestry.providerTurns, source?.activeAttemptId);
      }
      if (turn && turn.status !== "running" && run.restartContinuationOfRunId === undefined)
        continue;
      if (
        !turn ||
        !turn.nativeTurnRef ||
        !turn.nativeTurnRef.nativeId ||
        turn.nativeTurnRef.strength !== "strong" ||
        turn.nativeTurnRef.driver !== "codex"
      ) {
        if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
        if (turn)
          yield* RecoveryFailure.reportUnverified({ ...input, run, turn }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not report the Codex recovery block", { threadId, cause }),
            ),
          );
        protectedThreads.add(threadId);
        blockedThreads.add(threadId);
        continue;
      }
      const turnOwner = ancestry.attempts.find(
        (attempt) => attempt.id === turn.runAttemptId,
      )?.runId;
      const salted =
        turnOwner !== undefined &&
        turn.id ===
          IdAllocator.derive.providerTurn({
            driver: ProviderDriverKind.make("codex"),
            nativeTurnId: `${turn.nativeTurnRef.nativeId}:restart:${turnOwner}`,
          });
      if (run.restartContinuationOfRunId !== undefined && turnOwner === run.id && !salted) continue;
      if (turn.status !== "running" && salted)
        return yield* new CodexDetachedAppServerError({
          detail: "The completed Codex survivor requires terminal settlement.",
        });
      const record = matches[0];
      if (record === undefined) continue;
      const binding: CodexSurvivorBinding = {
        instanceId: run.providerInstanceId,
        recordName: record.name,
        threadId,
        sourceRunId: run.restartContinuationOfRunId ?? run.id,
        nativeThreadId: nativeThread.nativeId,
        nativeTurnId: turn.nativeTurnRef.nativeId,
      };
      if (matches.length !== 1) {
        for (const match of matches)
          yield* input.survivors
            .recordStopObligation(
              { instanceId: binding.instanceId, recordName: match.name },
              binding,
            )
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not persist the Codex recovery fence", {
                  threadId,
                  cause,
                }),
              ),
            );
        if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
        yield* RecoveryFailure.reportUnverified({ ...input, run, turn }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not report the Codex recovery block", { threadId, cause }),
          ),
        );
        protectedThreads.add(threadId);
        blockedThreads.add(threadId);
        continue;
      }
      const classification = yield* input.survivors
        .classifyRecord(binding)
        .pipe(Effect.orElseSucceed(() => ({ type: "unverifiable" as const })));
      if (classification.type !== "verified") {
        if (!salted) continue;
        if (classification.type === "gone" && !classification.possibleLeftovers?.length) {
          const settled = yield* RecoveryFailure.settleLost({
            ...input,
            run,
            turn,
            attempt: ancestry.attempts.find((value) => value.id === run.activeAttemptId),
            node: projection.nodes.find((value) => value.id === run.rootNodeId),
          });
          if (
            !settled ||
            Option.isNone(
              yield* input.survivors.clearStopObligation(binding, binding).pipe(Effect.option),
            )
          ) {
            protectedThreads.add(threadId);
            blockedThreads.add(threadId);
          }
        } else {
          yield* input.survivors.recordStopObligation(binding, binding).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not persist the Codex recovery fence", {
                threadId,
                cause,
              }),
            ),
          );
          if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
          yield* RecoveryFailure.reportUnverified({ ...input, run, turn }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not report the Codex recovery block", { threadId, cause }),
            ),
          );
          protectedThreads.add(threadId);
          blockedThreads.add(threadId);
        }
        continue;
      }
      const pendingStop = yield* input.outbox.hasUnsettledInterrupt(
        threadId,
        ancestry.providerTurns.map((value) => value.id),
      );
      const storedStops = yield* input.survivors.getStopObligations(threadId);
      const { lineage, forkedFrom } = projection.thread;
      const taskId =
        run.delegatedTaskId ?? (forkedFrom?.type === "node" ? forkedFrom.nodeId : undefined);
      let parentStop = false;
      if (lineage.relationshipToParent === "subagent" && lineage.parentThreadId !== null) {
        if (taskId === undefined)
          return yield* new CodexDetachedAppServerError({
            detail: "The Codex parent work cannot be identified for recovery.",
          });
        const parent = yield* input.projections.getThreadRecords(lineage.parentThreadId, [
          "subagents",
        ]);
        const task = parent.subagents.find((value) => value.id === taskId);
        if (task === undefined)
          return yield* new CodexDetachedAppServerError({
            detail: "The Codex parent work cannot be identified for recovery.",
          });
        if (
          task.runId !== null &&
          task.result === null &&
          isOrchestrationV2WorkActive(task.status)
        ) {
          const parentRecords = yield* input.projections.getThreadRecords(
            lineage.parentThreadId,
            ["turnItems", "providerTurns"],
            {
              turnItemRunIds: [task.runId],
              turnItemTypes: ["run_interrupt_request"],
              ancestryRunIds: [task.runId],
            },
          );
          parentStop =
            parentRecords.turnItems.some((item) => item.type === "run_interrupt_request") ||
            (yield* input.outbox.hasUnsettledInterrupt(
              lineage.parentThreadId,
              parentRecords.providerTurns.map((value) => value.id),
            ));
        }
      }
      const committedStop =
        ancestry.turnItems.some((item) => item.type === "run_interrupt_request") ||
        parentStop ||
        pendingStop ||
        storedStops.some(
          ({ block }) =>
            block.nativeThreadId === binding.nativeThreadId &&
            block.nativeTurnId === binding.nativeTurnId,
        );
      const stopRequested =
        committedStop ||
        resolveProjectSettings(settings, projection.thread.projectId).settings
          .codexTurnsSurviveServerStop === "off";
      const result = yield* input.survivors
        .classifyExisting(binding, stopRequested)
        .pipe(Effect.option);
      if (Option.isSome(result) && ["stopped", "completed", "failed"].includes(result.value)) {
        const attempt = ancestry.attempts.find((value) => value.id === run.activeAttemptId);
        if (!attempt || !run.activeAttemptId) {
          protectedThreads.add(threadId);
          blockedThreads.add(threadId);
          continue;
        }
        const now = yield* DateTime.now;
        const outcome =
          result.value === "completed"
            ? ("completed" as const)
            : result.value === "failed"
              ? ("failed" as const)
              : ("interrupted" as const);
        const commandId = CommandId.make(`command:survivor-interrupted:${run.id}:${turn.id}`);
        const node = projection.nodes.find((value) => value.id === run.rootNodeId);
        const waiting = outcome === "completed" && node?.checkpointScopeId != null;
        const committed = yield* input.sink.writeIfRunCurrent({
          threadId,
          runId: run.id,
          activeAttemptId: run.activeAttemptId,
          expectedStatus: run.status,
          commandId,
          effects:
            waiting && node?.checkpointScopeId
              ? [
                  {
                    id: `effect:checkpoint.capture:${run.id}`,
                    commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
                    threadId,
                    request: {
                      type: "checkpoint.capture",
                      runId: run.id,
                      scopeId: node.checkpointScopeId,
                    },
                  },
                ]
              : [],
          events: [
            ...(outcome === "completed"
              ? [
                  {
                    id: yield* input.ids.allocate.event({ threadId, commandId }),
                    type: "turn-item.updated" as const,
                    threadId,
                    runId: run.id,
                    occurredAt: now,
                    payload: {
                      id: IdAllocator.derive.turnItemFromProviderItem({
                        driver: ProviderDriverKind.make("codex"),
                        nativeItemId: `stop-completed:${turn.id}`,
                      }),
                      threadId,
                      runId: run.id,
                      nodeId: run.rootNodeId,
                      providerThreadId: run.providerThreadId,
                      providerTurnId: turn.id,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 1,
                      status: "completed" as const,
                      title: null,
                      startedAt: now,
                      completedAt: now,
                      updatedAt: now,
                      type: "run_interrupt_result" as const,
                      message:
                        "The Codex turn finished before it could be stopped. Work it did while the GOAT server was down is not shown here.",
                    },
                  },
                ]
              : []),
            {
              id: yield* input.ids.allocate.event({ threadId, commandId }),
              type: "provider-turn.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...turn, status: outcome, completedAt: now },
            },
            {
              id: yield* input.ids.allocate.event({ threadId, commandId }),
              type: "run-attempt.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...attempt, status: outcome, completedAt: now },
            },
            {
              id: yield* input.ids.allocate.event({ threadId, commandId }),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                ...run,
                status: waiting ? "waiting" : outcome,
                completedAt: waiting ? null : now,
                ...(outcome === "interrupted"
                  ? {
                      terminationCause: {
                        kind: committedStop ? ("person_stop" as const) : ("unknown" as const),
                      },
                    }
                  : outcome === "failed"
                    ? { terminationCause: { kind: "provider_error" as const } }
                    : {}),
              },
            },
            ...(node
              ? [
                  {
                    id: yield* input.ids.allocate.event({ threadId, commandId }),
                    type: "node.updated" as const,
                    threadId,
                    runId: run.id,
                    occurredAt: now,
                    payload: {
                      ...node,
                      status: waiting ? ("waiting" as const) : outcome,
                      completedAt: waiting ? null : now,
                    },
                  },
                ]
              : []),
          ],
        });
        if (!committed.committed)
          return yield* new CodexDetachedAppServerError({
            detail: "The interrupted Codex turn changed during recovery.",
          });
        const cancelled = yield* input.outbox.cancelContinuations(threadId, [
          run.id,
          ...(run.restartContinuationOfRunId ? [run.restartContinuationOfRunId] : []),
        ]);
        yield* input.outbox.signalCancellations(cancelled);
        const cleared = yield* input.survivors
          .clearStopObligation(binding, binding)
          .pipe(Effect.option);
        if (Option.isNone(cleared)) {
          protectedThreads.add(threadId);
          blockedThreads.add(threadId);
        }
        continue;
      }
      if (Option.isNone(result)) {
        yield* input.survivors
          .recordGoalBlock(binding, binding)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not persist the Codex goal fence", { threadId, cause }),
            ),
          );
        yield* input.survivors
          .recordStopObligation(binding, binding)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not persist the Codex recovery fence", { threadId, cause }),
            ),
          );
      }
      const preserved = yield* input.detached.preserveForRecovery(record.name).pipe(Effect.option);
      if (Option.isNone(preserved)) {
        const current = yield* input.survivors
          .classifyRecord(binding)
          .pipe(Effect.orElseSucceed(() => ({ type: "unverifiable" as const })));
        if (salted && current.type === "gone" && !current.possibleLeftovers?.length) {
          const settled = yield* RecoveryFailure.settleLost({
            ...input,
            run,
            turn,
            attempt: ancestry.attempts.find((value) => value.id === run.activeAttemptId),
            node: projection.nodes.find((value) => value.id === run.rootNodeId),
          });
          if (
            settled &&
            Option.isSome(
              yield* input.survivors.clearStopObligation(binding, binding).pipe(Effect.option),
            )
          )
            continue;
          protectedThreads.add(threadId);
          blockedThreads.add(threadId);
          continue;
        }
        yield* input.survivors
          .recordStopObligation(binding, binding)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not persist the Codex recovery fence", { threadId, cause }),
            ),
          );
        if (input.survivors.blockThread) yield* input.survivors.blockThread(threadId);
        yield* RecoveryFailure.reportUnverified({ ...input, run, turn }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not report the Codex recovery block", { threadId, cause }),
          ),
        );
        protectedThreads.add(threadId);
        blockedThreads.add(threadId);
        continue;
      }
      if (Option.isNone(result) || result.value === "blocked" || stopRequested) {
        protectedThreads.add(threadId);
        blockedThreads.add(threadId);
      } else if (result.value === "survivor") {
        if (
          bindings.some(
            (value) =>
              value.instanceId === binding.instanceId && value.threadId === binding.threadId,
          )
        )
          return yield* new CodexDetachedAppServerError({
            detail: "Multiple Codex turns prevent safe recovery of this thread.",
          });
        bindings.push(binding);
        protectedThreads.add(threadId);
      }
    }
  }
  yield* input.survivors.replace(bindings);
  return { protectedThreads, blockedThreads };
});
export const settleTerminalRuns = Effect.fn("CodexSurvivors.settleTerminalRuns")(function* (input: {
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly sink: EventSink.EventSinkV2["Service"];
  readonly outbox: EffectOutbox.EffectOutboxV2["Service"];
  readonly survivors: CodexSurvivors["Service"];
  readonly ids: IdAllocator.IdAllocatorV2["Service"];
  readonly detached: Detached.CodexDetachedAppServers["Service"];
}) {
  const settledThreads = new Set<ThreadId>();
  const records = yield* input.detached.loadRecords;
  if (records.globalBlock !== undefined) return settledThreads;
  const threadIds = new Set([
    ...(yield* input.projections.getRecoveryThreadIds("runtime-cleanup")),
    ...records.flatMap((record) => (record.stopObligations ?? []).map((stop) => stop.threadId)),
  ]);
  for (const threadId of threadIds) {
    const projection = yield* input.projections
      .getRuntimeRecoveryProjection(threadId)
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.void }));
    if (!projection) continue;
    const stops = yield* input.survivors.getStopObligations(threadId);
    for (const run of projection.runs) {
      if (!run.activeAttemptId || (!run.restartContinuationOfRunId && stops.length === 0)) continue;
      const ancestry = yield* input.projections.getThreadRecords(
        threadId,
        ["attempts", "providerTurns"],
        { ancestryRunIds: [run.id] },
      );
      const attempt = ancestry.attempts.find((value) => value.id === run.activeAttemptId);
      const turn = latestProviderTurnForAttempt(ancestry.providerTurns, run.activeAttemptId);
      if (
        !attempt ||
        !turn ||
        !turn.nativeTurnRef?.nativeId ||
        turn.nativeTurnRef.strength !== "strong" ||
        turn.nativeTurnRef.driver !== "codex"
      )
        continue;
      const salted = IdAllocator.derive.providerTurn({
        driver: ProviderDriverKind.make("codex"),
        nativeTurnId: `${turn.nativeTurnRef.nativeId}:restart:${run.id}`,
      });
      const providerThread =
        projection.providerThreads.find((value) => value.id === run.providerThreadId) ??
        (yield* input.projections.getThreadRecords(threadId, [
          "providerThreads",
        ])).providerThreads.find((value) => value.id === run.providerThreadId);
      const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
      const matchingStop = stops.some(
        (entry) =>
          entry.block.nativeThreadId === nativeThreadId &&
          entry.block.nativeTurnId === turn.nativeTurnRef?.nativeId,
      );
      if (
        (turn.id !== salted && !matchingStop) ||
        !["completed", "interrupted", "failed"].includes(turn.status)
      )
        continue;
      const sourceIds = [
        run.id,
        ...(run.restartContinuationOfRunId ? [run.restartContinuationOfRunId] : []),
      ];
      if (
        ["preparing", "starting", "running", "waiting"].includes(run.status) &&
        !(run.status === "waiting" && turn.status === "completed" && attempt.status === "completed")
      ) {
        const node = projection.nodes.find((value) => value.id === run.rootNodeId);
        if (!node)
          return yield* new CodexDetachedAppServerError({
            detail: "The completed Codex survivor has no recoverable root node.",
          });
        const ended = turn.completedAt ?? (yield* DateTime.now);
        const status =
          turn.status === "completed"
            ? ("completed" as const)
            : turn.status === "interrupted"
              ? ("interrupted" as const)
              : ("failed" as const);
        const waiting = status === "completed" && node.checkpointScopeId !== null;
        const runStatus = waiting ? ("waiting" as const) : status;
        const commandId = CommandId.make(`command:survivor-terminal:${run.id}:${turn.id}`);
        const eventId = () => input.ids.allocate.event({ threadId, commandId });
        const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> =
          node.checkpointScopeId !== null && status !== "failed"
            ? [
                {
                  id: `effect:checkpoint.capture:${run.id}`,
                  commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
                  threadId,
                  request: {
                    type: "checkpoint.capture",
                    runId: run.id,
                    scopeId: node.checkpointScopeId,
                  },
                },
              ]
            : [];
        const result = yield* input.sink.writeIfRunCurrent({
          threadId,
          runId: run.id,
          activeAttemptId: run.activeAttemptId,
          expectedStatus: run.status,
          commandId,
          effects,
          events: [
            {
              id: yield* eventId(),
              type: "run-attempt.updated",
              threadId,
              runId: run.id,
              nodeId: node.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: ended,
              payload: { ...attempt, status, completedAt: ended },
            },
            {
              id: yield* eventId(),
              type: "run.updated",
              threadId,
              runId: run.id,
              nodeId: node.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: ended,
              payload: {
                ...run,
                status: runStatus,
                completedAt: waiting ? null : ended,
                ...(status === "failed"
                  ? { terminationCause: { kind: "provider_error" as const } }
                  : status === "interrupted"
                    ? { terminationCause: { kind: "unknown" as const } }
                    : {}),
              },
            },
            {
              id: yield* eventId(),
              type: "node.updated",
              threadId,
              runId: run.id,
              nodeId: node.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: ended,
              payload: { ...node, status: runStatus, completedAt: waiting ? null : ended },
            },
          ],
        });
        if (!result.committed)
          return yield* new CodexDetachedAppServerError({
            detail: "The completed Codex survivor changed during recovery.",
          });
      } else if (!["completed", "interrupted", "failed", "waiting"].includes(run.status)) continue;
      const cancelled = yield* input.outbox.cancelContinuations(threadId, sourceIds);
      yield* input.outbox.signalCancellations(cancelled);
      for (const entry of stops)
        if (
          entry.block.nativeThreadId === nativeThreadId &&
          entry.block.nativeTurnId === turn.nativeTurnRef.nativeId &&
          (yield* RecoveryFailure.hasNativeTerminalEvidence({
            survivors: input.survivors,
            record: entry.record,
            block: entry.block,
          }))
        )
          yield* input.survivors
            .clearStopObligation(entry.record, entry.block)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not clear the Codex stop fence", { threadId, cause }),
              ),
            );
      if (turn.id === salted) settledThreads.add(threadId);
    }
  }
  return settledThreads;
});
