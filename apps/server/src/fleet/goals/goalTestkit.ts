import {
  type FleetGoal,
  FleetGoalId,
  type FleetGoalSpec,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";

import { initialStatus } from "./goalPlan.ts";

export const testSpec = (overrides: Partial<FleetGoalSpec> = {}): FleetGoalSpec => ({
  kind: "pr_bundle",
  project: { host: null, projectId: ProjectId.make("project:test"), cwd: null },
  repo: "goat-si/goat",
  targets: [],
  workers: {
    count: 1,
    perTarget: false,
    hostSelector: {},
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    fallbackChain: null,
    runtimeMode: "full-access",
    promptTemplate: "Work on {{target}} on {{branch}}.",
    workspace: { baseRef: "dev", branchPrefix: "goal/test", startFromOrigin: false },
    onHostLost: "reschedule",
  },
  doneWhen: [{ type: "thread_reported_result" }],
  limits: {
    maxWorkers: 3,
    maxAttemptsPerWorker: 3,
    maxTurns: 40,
    maxWallClockMs: 24 * 60 * 60 * 1000,
    maxTokens: null,
  },
  paused: false,
  ...overrides,
});

export const testGoal = (id: string, overrides: Partial<FleetGoal> = {}): FleetGoal => ({
  id: FleetGoalId.make(id),
  title: "Test goal",
  generation: 1,
  owner: {
    kind: "thread",
    threadId: ThreadId.make("thread:owner"),
    mcpOwner: null,
    runtimeModeCeiling: "full-access",
  },
  spec: testSpec(),
  status: initialStatus(),
  deletionRequestedAt: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  ...overrides,
});
