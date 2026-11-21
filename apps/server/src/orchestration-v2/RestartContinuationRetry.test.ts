import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { continuationStartRetryDelayMs } from "./RestartBackgroundNote.ts";

const threadId = ThreadId.make("thread:restart");
const runId = RunId.make("run:restart");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:restart");
const sessionId = ProviderSessionId.make("session:restart");
const attemptId = RunAttemptId.make("attempt:restart");
const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");

function makeProjection() {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("restart-project"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6" },
        providerThreadId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [
      { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("turn:restart"),
        providerThreadId,
        runAttemptId: attemptId,
        status: "running",
      },
    ],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("backs off twice from a continuation the provider never took, then lets it fail", () => {
  const base = makeProjection();
  const failedStart = (id: string, of: RunId) => ({
    ...base.runs[0]!,
    id: RunId.make(id),
    activeAttemptId: RunAttemptId.make(`attempt:${id}`),
    status: "failed" as const,
    restartContinuationOfRunId: of,
  });
  const first = failedStart("run:retry-1", runId);
  const second = failedStart("run:retry-2", first.id);
  const third = failedStart("run:retry-3", second.id);
  const projection = (failureClass = "provider_error", inputDelivery = "unsent") =>
    ({
      runs: [{ ...base.runs[0]!, status: "cancelled" }, first, second, third],
      attempts: [first, second, third].map((run) => ({ id: run.activeAttemptId, inputDelivery })),
      turnItems: [first, second, third].map((run) => ({
        id: `error:${run.id}`,
        type: "error",
        status: "failed",
        runId: run.id,
        nodeId: run.rootNodeId,
        ordinal: 1,
        updatedAt: now,
        failure: { class: failureClass, message: "Failed.", code: null, retryable: null },
      })),
    }) as unknown as Parameters<typeof continuationStartRetryDelayMs>[1];
  assert.deepEqual(
    [first, second, third].map((run) => continuationStartRetryDelayMs(run, projection())),
    [60_000, 180_000, undefined],
  );
  for (const failureClass of ["usage_limit", "permission_error", "validation_error"])
    assert.isUndefined(continuationStartRetryDelayMs(first, projection(failureClass)));
  // Once the provider took the prompt, starting again would repeat the turn.
  assert.isUndefined(
    continuationStartRetryDelayMs(first, projection("provider_error", "accepted")),
  );
});
