import * as Effect from "effect/Effect";
import type * as ProjectionStore from "./ProjectionStore.ts";
import * as CodexSurvivors from "../provider/CodexSurvivors.ts";
import * as CodexSurvivorRecovery from "../provider/CodexSurvivorRecovery.ts";
import type { CodexSurvivorBinding } from "../provider/CodexSurvivors.ts";
import type * as CodexDetached from "../provider/CodexDetachedAppServerLive.ts";
import type * as EventSink from "./EventSink.ts";
import type * as EffectOutbox from "./EffectOutbox.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";

export const excludeSurvivorFamily = Effect.fn("SurvivorRecoveryProjection.excludeSurvivorFamily")(
  function* (input: {
    readonly projection: ProjectionStore.ProjectionRuntimeRecoveryState;
    readonly bindings: ReadonlyArray<CodexSurvivorBinding>;
    readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  }) {
    const { projection } = input;
    const bindings = input.bindings.filter((binding) => binding.threadId === projection.thread.id);
    if (bindings.length === 0) return projection;
    const runIds = new Set(bindings.map((binding) => binding.sourceRunId));
    for (const run of projection.runs)
      if (run.restartContinuationOfRunId && runIds.has(run.restartContinuationOfRunId))
        runIds.add(run.id);
    const ancestry = yield* input.projections.getThreadRecords(
      projection.thread.id,
      ["attempts", "providerTurns"],
      { ancestryRunIds: [...runIds] },
    );
    const rootThreads = new Set(
      projection.providerThreads
        .filter((thread) =>
          bindings.some(
            (binding) =>
              thread.providerInstanceId === binding.instanceId &&
              thread.nativeThreadRef?.nativeId === binding.nativeThreadId,
          ),
        )
        .map((thread) => thread.id),
    );
    const turnIds = new Set(
      ancestry.providerTurns
        .filter((turn) =>
          bindings.some((binding) => turn.nativeTurnRef?.nativeId === binding.nativeTurnId),
        )
        .map((turn) => turn.id),
    );
    const nodeIds = new Set(
      ancestry.attempts
        .filter((attempt) => runIds.has(attempt.runId))
        .map((attempt) => attempt.rootNodeId),
    );
    for (const turn of ancestry.providerTurns) if (turnIds.has(turn.id)) nodeIds.add(turn.nodeId);
    for (const node of projection.nodes)
      if (node.runId !== null && runIds.has(node.runId)) nodeIds.add(node.id);
    const nativeThreads = new Set<string>();
    const nativeAgents = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const agent of projection.subagents) {
        if (agent.origin !== "provider_native" || nativeAgents.has(agent.id)) continue;
        if ((agent.runId !== null && runIds.has(agent.runId)) || nodeIds.has(agent.parentNodeId)) {
          nativeAgents.add(agent.id);
          nodeIds.add(agent.id);
          if (agent.providerThreadId !== null) nativeThreads.add(agent.providerThreadId);
          changed = true;
        }
      }
      for (const node of projection.nodes) {
        if (nodeIds.has(node.id)) continue;
        if (
          (node.parentNodeId !== null && nodeIds.has(node.parentNodeId)) ||
          (node.providerThreadId !== null && nativeThreads.has(node.providerThreadId))
        ) {
          nodeIds.add(node.id);
          changed = true;
        }
      }
    }
    for (const turn of projection.providerTurns)
      if (nativeThreads.has(turn.providerThreadId)) turnIds.add(turn.id);
    const survivorRequests = new Set(
      projection.runtimeRequests
        .filter(
          (request) =>
            nodeIds.has(request.nodeId) ||
            (request.providerTurnId !== null && turnIds.has(request.providerTurnId)),
        )
        .map((request) => request.id),
    );
    return {
      ...projection,
      runs: projection.runs.filter((run) => !runIds.has(run.id)),
      attempts: projection.attempts.filter((attempt) => !runIds.has(attempt.runId)),
      nodes: projection.nodes.filter((node) => !nodeIds.has(node.id)),
      subagents: projection.subagents.filter((agent) => !nativeAgents.has(agent.id)),
      providerThreads: projection.providerThreads.filter(
        (thread) => !rootThreads.has(thread.id) && !nativeThreads.has(thread.id),
      ),
      providerTurns: projection.providerTurns.filter(
        (turn) => !turnIds.has(turn.id) && !nativeThreads.has(turn.providerThreadId),
      ),
      messages: projection.messages.filter(
        (message) => message.runId === null || !runIds.has(message.runId),
      ),
      turnItems: projection.turnItems.filter(
        (item) =>
          (item.runId === null || !runIds.has(item.runId)) &&
          (item.nodeId == null || !nodeIds.has(item.nodeId)) &&
          (item.providerThreadId == null || !nativeThreads.has(item.providerThreadId)) &&
          !(item.type === "user_input_request" && survivorRequests.has(item.requestId)),
      ),
      runtimeRequests: projection.runtimeRequests.map((request) =>
        survivorRequests.has(request.id) && request.responseCapability.type === "message"
          ? {
              ...request,
              responseCapability: {
                type: "not_resumable" as const,
                reason: "The surviving Codex turn will reject replayed requests.",
              },
            }
          : request,
      ),
    };
  },
);

export const sessionsLiveAtStart = (
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  stoppedThisPass: ReadonlyMap<
    string,
    ProjectionStore.ProjectionRuntimeRecoveryState["providerSessions"][number]
  >,
) => {
  const sessions = new Map(projection.providerSessions.map((session) => [session.id, session]));
  for (const providerThread of projection.providerThreads) {
    const stopped =
      providerThread.providerSessionId === null
        ? undefined
        : stoppedThisPass.get(providerThread.providerSessionId);
    if (stopped !== undefined) sessions.set(stopped.id, stopped);
  }
  return [...sessions.values()];
};

export const prepare = Effect.fn("SurvivorRecoveryProjection.prepare")(function* (input: {
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly sink: EventSink.EventSinkV2["Service"];
  readonly outbox: EffectOutbox.EffectOutboxV2["Service"];
  readonly survivors: CodexSurvivors.CodexSurvivors["Service"];
  readonly detached: CodexDetached.CodexDetachedAppServers["Service"];
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly ids: IdAllocator.IdAllocatorV2["Service"];
}) {
  yield* input.detached.loadRecords;
  yield* input.outbox.setStartGuard(
    Effect.gen(function* () {
      const survivors = yield* input.survivors.list;
      const blockedThreads = yield* input.survivors.startBlockedThreads;
      return { blockedThreads, survivors };
    }),
  );
  yield* input.survivors.setStartWake(input.outbox.notifyAvailable());
  const terminalThreads = yield* CodexSurvivorRecovery.settleTerminalRuns(input);
  const classified = yield* CodexSurvivorRecovery.classifyRecovery({
    ...input,
    skipThreads: terminalThreads,
  });
  const bindings = yield* input.survivors.list;
  const sessions = yield* CodexSurvivors.survivorSessionIds({
    bindings,
    projections: input.projections,
  });
  yield* CodexSurvivors.prepareContinuations({ ...input, bindings });
  return { ...classified, terminalThreads, bindings, sessions };
});
