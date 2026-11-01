import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import {
  CheckpointId,
  ProviderInstanceId,
  type ThreadReplicaPayload,
  EnvironmentId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { launcher, target, projectId, run1 } from "./LaunchWatchService.testkit.ts";

export const remoteRead = (input: {
  readonly itemCount: number;
  readonly items?: ReadonlyArray<unknown>;
  readonly nextPosition?: number;
  readonly recentRuns?: ReadonlyArray<unknown>;
}) => ({
  thread: {
    threadId: target,
    projectId: "remote-project",
    title: "Remote fix",
    createdBy: "agent",
    creationSource: "mcp",
    status: "completed",
    latestRunId: run1,
    activeRunId: null,
    providerInstanceId: "codex",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: "goat/remote",
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 1,
    itemCount: input.itemCount,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  },
  recentRuns: input.recentRuns ?? [],
  items: input.items ?? [],
  nextPosition: input.nextPosition ?? null,
  hasMore: input.nextPosition !== undefined,
});

export const watchReplica = (now: number): ThreadReplicaPayload => {
  const context = "Checkpoint context";
  const bytes = Buffer.from("fixture bundle");
  return {
    sourceEnvironmentId: EnvironmentId.make("box-env"),
    sourceThreadId: target,
    runId: run1,
    checkpointId: CheckpointId.make("cp-1"),
    repositoryKey: "github.com/example/recovery",
    capturedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    headOid: "a".repeat(40),
    commitOid: "b".repeat(40),
    replicaRef: "refs/goat/replicas/watch/0",
    bytes: bytes.length,
    sha256: ThreadReplicaService.replicaDigest(bytes),
    contextSha256: ThreadReplicaService.replicaDigest(context),
    contextKind: "bounded_conversation",
    context,
    bundleBase64: bytes.toString("base64"),
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  };
};
export const replicaWatchInput = {
  launcherThreadId: launcher,
  host: "box",
  threadId: target,
  projectId: null,
  title: "Recover me",
  runId: run1,
} as const;
export const recoveryInput = {
  ...replicaWatchInput,
  fromReplicatedCheckpoint: true,
  expectedRunId: run1,
  destinationHost: "destination",
  destinationProjectId: projectId,
} as const;
export const recoveryGrant = Effect.succeed({
  runtimeMode: "full-access",
  interactionMode: "default",
} as const);
