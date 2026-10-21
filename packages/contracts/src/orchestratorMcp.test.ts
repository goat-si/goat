import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpPendingRequestRespondInput,
  OrchestratorMcpPendingRequestRespondResult,
  OrchestratorMcpPendingRequestReadResult,
  OrchestratorMcpPendingRequestListInput,
  OrchestratorMcpLaunchedQuestionsResult,
  OrchestratorMcpThreadWaitResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpReviewFindingsRecordInput,
  OrchestratorMcpReviewFindingsRecordResult,
  OrchestratorMcpReviewFindingsExportInput,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpCapabilitiesResult,
} from "./orchestratorMcp.ts";

const decodePendingRequestRespondInput = Schema.decodeUnknownSync(
  OrchestratorMcpPendingRequestRespondInput,
);
const decodePendingRequestRespondResult = Schema.decodeUnknownSync(
  OrchestratorMcpPendingRequestRespondResult,
);
const decodePendingRequestReadResult = Schema.decodeUnknownSync(
  OrchestratorMcpPendingRequestReadResult,
);
const decodePendingRequestListInput = Schema.decodeUnknownSync(
  OrchestratorMcpPendingRequestListInput,
);
const decodeLaunchedQuestionsResult = Schema.decodeUnknownSync(
  OrchestratorMcpLaunchedQuestionsResult,
);
const decodeThreadWaitResult = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitResult);
const decodeReviewFindingsRecordResult = Schema.decodeUnknownSync(
  OrchestratorMcpReviewFindingsRecordResult,
);
const decodeReviewFindingsExportInput = Schema.decodeUnknownSync(
  OrchestratorMcpReviewFindingsExportInput,
);

const decodeStrictCreateThreadsInput = Schema.decodeUnknownSync(OrchestratorMcpCreateThreadsInput, {
  onExcessProperty: "error",
});
const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);

it("bounds explicit question hosts and ignored wait request IDs", () => {
  const hosts = Array.from({ length: 16 }, (_, i) => `host-${i}`);
  expect(decodePendingRequestListInput({ scope: "launched", hosts }).hosts).toEqual(hosts);
  expect(() =>
    decodePendingRequestListInput({ scope: "launched", hosts: [...hosts, "extra"] }),
  ).toThrow();
  const ignoreRequestIds = Array.from({ length: 50 }, (_, i) => `question-${i}`);
  expect(decodeThreadWaitInput({ threadId: "thread", ignoreRequestIds }).ignoreRequestIds).toEqual(
    ignoreRequestIds,
  );
  expect(() =>
    decodeThreadWaitInput({ threadId: "thread", ignoreRequestIds: [...ignoreRequestIds, "extra"] }),
  ).toThrow();
  expect(() => decodeThreadWaitInput({ threadId: "thread", ignoreRequestIds: [""] })).toThrow();
  expect(
    decodeThreadWaitInput({ threadId: "thread", ignoreRequestIds: [] }).ignoreRequestIds,
  ).toEqual([]);
  expect(decodeThreadWaitInput({ threadId: "thread" })).not.toHaveProperty("ignoreRequestIds");
});

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });

  it("decodes remote workspaces and a nullable host-qualified task handle", () => {
    for (const workspace of [
      { type: "cwd" },
      { type: "worktree", branch: "feature/task" },
      { type: "existing_worktree", worktreePath: "/workspace/task" },
    ]) {
      const input = decodeDelegateTaskInput({
        task: "Inspect",
        target: { host: "build-box" },
        remote: { cwd: "/workspace/repo", workspace },
      });
      expect(input.remote?.workspace).toEqual(workspace);
      expect(input.target?.host).toBe("build-box");
    }
    const result = decodeDelegateTaskResult({
      taskId: "task",
      host: "build-box",
      childThreadId: null,
      childRunId: null,
      childNodeId: "task",
      status: "failed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "codex",
      model: null,
      summary: "launch outcome unknown",
      resultContextTransferId: null,
      latestTerminalRunId: null,
      latestTerminalStatus: "failed",
      latestTerminalSummary: "launch outcome unknown",
      latestTerminalResultContextTransferId: null,
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });
    expect(result.childThreadId).toBeNull();
    expect(result.reviewLedger).toBeUndefined();
    const reviewLedger = [
      {
        kind: "decision",
        entryId: "entry",
        findingId: "finding",
        severity: "low",
        cites: null,
        summary: "Review finding",
        decision: "accepted",
        evidence: null,
        recordedAt: "2026-10-17T00:00:00.000Z",
        recordedByRunId: null,
      },
    ];
    expect(decodeDelegateTaskResult({ ...result, reviewLedger }).reviewLedger).toEqual(
      reviewLedger,
    );
    expect(() =>
      decodeDelegateTaskInput({
        task: "Inspect",
        target: { host: " " },
        remote: { cwd: "/workspace/repo" },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegateTaskInput({
        task: "Inspect",
        target: { host: "build-box" },
        remote: { cwd: " " },
      }),
    ).toThrow();
  });
});

it("advertises host only for delegation targets, not create_threads", () => {
  const createSchema = Schema.toJsonSchemaDocument(OrchestratorMcpCreateThreadsInput);
  const delegateSchema = Schema.toJsonSchemaDocument(OrchestratorMcpDelegateTaskInput);
  expect(JSON.stringify(createSchema)).not.toContain('"host"');
  expect(JSON.stringify(delegateSchema)).toContain('"host"');
  expect(() =>
    decodeStrictCreateThreadsInput({
      threads: [{ target: { host: "build-box" } }],
    }),
  ).toThrow();
});

it.each(["", " \n\t"])("explains how to fix a blank pending response reason (%j)", (reason) => {
  expect(() =>
    decodePendingRequestRespondInput({
      requestId: "request",
      answers: { q: "Yes" },
      reason,
    }),
  ).toThrow("Send reason with 1–2000 characters including non-whitespace text");
});

it("keeps single select, multi select, free text and provider-specific answer values unchanged", () => {
  const args = {
    requestId: "request",
    reason: "The user chose these settings.",
    answers: {
      color: "Blue",
      features: ["Fast", "Quiet"],
      notes: "  exact text\n",
      count: 2,
      enabled: true,
    },
  };
  expect(decodePendingRequestRespondInput(args)).toEqual(args);
  const jsonSchema = JSON.stringify(
    Schema.toJsonSchemaDocument(OrchestratorMcpPendingRequestRespondInput),
  );
  expect(jsonSchema).toContain("Answers keyed by question id");
  expect(jsonSchema).toContain("Required provenance shown to the user");
});

it("accepts only boolean relay claims and advertises them to MCP callers", () => {
  const args = { requestId: "request", answers: { q: "Yes" }, reason: "The user decided." };
  for (const relayedFromUser of [true, false]) {
    expect(decodePendingRequestRespondInput({ ...args, relayedFromUser })).toEqual({
      ...args,
      relayedFromUser,
    });
  }
  expect(decodePendingRequestRespondInput(args)).not.toHaveProperty("relayedFromUser");
  for (const relayedFromUser of ["true", 1, null]) {
    expect(() => decodePendingRequestRespondInput({ ...args, relayedFromUser })).toThrow();
  }
  expect(
    JSON.stringify(Schema.toJsonSchemaDocument(OrchestratorMcpPendingRequestRespondInput)),
  ).toContain("Set true when your answer relays the user's own decision.");
});
it("decodes pending tools and optional legacy result fields", () => {
  const args = {
    threadId: "thread",
    host: "box",
    requestId: "q",
    answers: { q: " exact\n" },
    reason: "Chosen for compatibility",
    respondedBy: {
      type: "agent",
      threadId: "launcher",
      environmentId: "foreign",
      title: null,
      reason: "Chosen for compatibility",
    },
  };
  expect(decodePendingRequestRespondInput(args)).toEqual(args);
  for (const reason of ["", " \n\t", "x".repeat(2001)]) {
    expect(() =>
      decodePendingRequestRespondInput({
        ...args,
        reason,
      }),
    ).toThrow();
    expect(() =>
      decodePendingRequestRespondInput({
        ...args,
        respondedBy: { ...args.respondedBy, reason },
      }),
    ).toThrow();
  }
  expect(decodePendingRequestRespondResult({ sequence: 1 })).toEqual({ sequence: 1 });
  const read = decodePendingRequestReadResult({
    requestId: "q",
    questions: [],
  });
  expect(read.status).toBeUndefined();
  expect(read.respondedBy).toBeUndefined();
  expect(
    decodePendingRequestListInput({
      scope: "launched",
      launcherThreadId: "launcher",
      launcherEnvironmentId: "origin",
    }),
  ).toMatchObject({ scope: "launched" });
});
it("keeps launched results distinct and requires environment identity", () => {
  const decode = decodeLaunchedQuestionsResult;
  expect(() => decode({ requestIds: [] })).toThrow();
  const question = {
    host: null,
    environmentId: "here",
    threadId: "thread",
    title: "Question",
    requestId: "q",
    questions: [],
    humanRequired: false,
  };
  expect(
    decode({ questions: [question], truncated: true, unavailableHosts: [] }).questions,
  ).toEqual([question]);
  expect(() =>
    decode({
      questions: [{ ...question, environmentId: null }],
      truncated: false,
      unavailableHosts: [],
    }),
  ).toThrow();
});
it("decodes optional question wait IDs without changing run status", () => {
  const decode = decodeThreadWaitResult;
  for (const status of ["running", "completed"]) {
    expect(
      decode({
        threadId: "thread",
        runId: "run",
        status,
        timedOut: false,
        pendingRequestIds: ["q"],
      }),
    ).toMatchObject({ status, pendingRequestIds: ["q"] });
  }
  expect(
    decode({ threadId: "thread", runId: "run", status: "completed", timedOut: false })
      .pendingRequestIds,
  ).toBeUndefined();
});

it("decodes review history without accepting server-owned outcome fields as input", () => {
  const decode = Schema.decodeUnknownSync(OrchestratorMcpReviewFindingsRecordInput, {
    onExcessProperty: "error",
  });
  const decision = {
    kind: "decision",
    findingId: "finding",
    severity: "critical",
    cites: "a.ts:1",
    summary: "Guard the edge",
    decision: "accepted",
    evidence: null,
  };
  expect(decode({ taskId: "review", entries: [decision] }).entries).toEqual([decision]);
  expect(() => decode({ taskId: "review", entries: [] })).toThrow();
  expect(() =>
    decode({ taskId: "review", entries: [{ ...decision, entryId: "forged" }] }),
  ).toThrow();
  const outcome = {
    kind: "outcome",
    findingId: "finding",
    link: { kind: "test", ref: "failure.test.ts" },
  };
  expect(decode({ taskId: "review", entries: [outcome] }).entries).toEqual([outcome]);
  expect(() =>
    decode({ taskId: "review", entries: [{ ...outcome, outcome: "unneeded" }] }),
  ).toThrow();
  const recorded = {
    ...decision,
    entryId: "entry",
    recordedAt: "2026-10-17T00:00:00.000Z",
    recordedByRunId: null,
  };
  expect(
    decodeReviewFindingsRecordResult({
      taskId: "review",
      reviewLedger: [recorded],
      findings: [{ decision: recorded, latestOutcome: null }],
    }).reviewLedger,
  ).toEqual([recorded]);
  const exportInput = decodeReviewFindingsExportInput;
  expect(
    exportInput({ from: "2026-10-16T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z", limit: 1 })
      .limit,
  ).toBe(1);
  expect(() =>
    exportInput({ from: "2026-10-16T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z", limit: 1_001 }),
  ).toThrow();
});

const decodeThreadWaitInput = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput);

it("run-fenced sends are destination-local and ordinary host sends retain their wire shape", () => {
  const decode = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput);
  expect(
    decode({ threadId: "worker", message: "correct", expectedLatestRunId: "old-run" })
      .expectedLatestRunId,
  ).toBe("old-run");
  expect(() =>
    decode({
      threadId: "worker",
      host: "remote",
      message: "correct",
      expectedLatestRunId: "old-run",
    }),
  ).toThrow();
  expect(decode({ threadId: "worker", host: "remote", message: "human followup" })).toEqual({
    threadId: "worker",
    host: "remote",
    message: "human followup",
  });
});
it("capability snapshots remain compatible when run-fenced send support is absent", () => {
  const decode = Schema.decodeUnknownSync(OrchestratorMcpCapabilitiesResult);
  const old = {
    parentThreadId: null,
    inheritedProviderInstanceId: null,
    inheritedModel: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    providers: [],
    features: {
      appOwnedSubagents: true,
      asyncPolling: true,
      cancellation: true,
      batchThreadCreation: true,
      threadManagement: true,
      incrementalThreadRead: true,
      scheduledTasks: true,
      maxBatchThreads: 20,
    },
  };
  expect(decode(old).features.runFencedThreadSend).toBeUndefined();
  expect(
    decode({ ...old, features: { ...old.features, runFencedThreadSend: true } }).features
      .runFencedThreadSend,
  ).toBe(true);
});
