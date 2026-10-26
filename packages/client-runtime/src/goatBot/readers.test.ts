import {
  ChannelConversationId,
  ChannelTaskId,
  type ChannelTaskChip,
  EnvironmentId,
  OrchestrationV2TurnItemJson,
  ThreadId,
  RunId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildGoatBotTimeline } from "./rows.ts";
import { goatBotItemReaders, presentTaskChip } from "./readers.ts";

const chip = (overrides: Partial<ChannelTaskChip> = {}): ChannelTaskChip => ({
  taskId: ChannelTaskId.make("task-1"),
  conversationId: ChannelConversationId.make("conv-1"),
  taskVersion: 3,
  title: "Re-verify the Opus 5.5 call",
  status: "running",
  originKind: "goat",
  requesterLabel: "Jun",
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:01:00.000Z",
  worker: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("worker") },
  openQuestionCount: 0,
  ...overrides,
});

describe("presentTaskChip", () => {
  it("links a running task to its worker thread", () => {
    expect(presentTaskChip(chip())).toEqual({
      key: "task-1",
      revision: 3,
      title: "Re-verify the Opus 5.5 call",
      statusLabel: "Working",
      tone: "active",
      sourceLabel: null,
      continuationLabel: null,
      updatedAt: "2026-10-12T12:01:00.000Z",
      summary: null,
      attentionLabel: null,
      evidenceLabels: [],
      pullRequests: [],
      target: { kind: "thread", environmentId: "env", threadId: "worker" },
    });
  });

  it("explains a missing worker by how far the task got", () => {
    const { worker: _worker, ...noWorker } = chip();
    expect(presentTaskChip({ ...noWorker, status: "received" }).target).toEqual({
      kind: "none",
      label: "Not started yet",
    });
    expect(presentTaskChip({ ...noWorker, status: "failed" })).toMatchObject({
      statusLabel: "Failed",
      tone: "danger",
      target: { kind: "none", label: "No worker thread" },
    });
  });

  it("keeps the previous machine visible while a moved task waits for its new worker", () => {
    const { worker: _worker, ...withoutWorker } = chip();
    const card = presentTaskChip({
      ...withoutWorker,
      status: "received",
      movedFrom: {
        host: "mac-studio",
        generation: 1,
        at: "2026-10-12T12:01:00.000Z",
        replicaCapturedAt: "2026-10-12T12:00:00.000Z",
      },
    });
    expect(card.continuationLabel).toBe("Continued from mac-studio");
    expect(card.target).toEqual({ kind: "none", label: "Not started yet" });
    expect(presentTaskChip(chip()).continuationLabel).toBeNull();
  });

  it("names where outside requests came from", () => {
    expect(presentTaskChip(chip({ originKind: "slack" })).sourceLabel).toBe("Slack · Jun");
    expect(presentTaskChip(chip({ originKind: "mcp" })).sourceLabel).toBe("Agent · Jun");
    expect(presentTaskChip(chip({ originKind: "imessage" })).sourceLabel).toBe("iMessage · Jun");
  });

  it("names the machine that runs remote work", () => {
    const worker = {
      environmentId: EnvironmentId.make("remote-env"),
      threadId: ThreadId.make("worker"),
      host: "mac-studio",
    };
    expect(presentTaskChip(chip({ originKind: "slack", worker }))).toMatchObject({
      sourceLabel: "Slack · Jun · on mac-studio",
      target: {
        kind: "thread",
        environmentId: "remote-env",
        threadId: "worker",
        host: "mac-studio",
      },
    });
  });

  it("flags a completed task whose worker did not report, even with an open question count", () => {
    for (const openQuestionCount of [0, 2]) {
      expect(
        presentTaskChip(
          chip({ status: "completed", completionReport: "missing", openQuestionCount }),
        ),
      ).toMatchObject({ statusLabel: "Done", attentionLabel: "Finished without a report" });
    }
    expect(
      presentTaskChip(
        chip({ status: "running", completionReport: "missing", openQuestionCount: 1 }),
      ).attentionLabel,
    ).toBe("1 question");
  });

  it.each(["present", undefined] as const)(
    "preserves question labels when completion report is %s",
    (completionReport) => {
      for (const [openQuestionCount, label] of [
        [0, null],
        [1, "1 question"],
        [3, "3 questions"],
      ] as const) {
        expect(
          presentTaskChip(
            chip({
              status: "completed",
              ...(completionReport === undefined ? {} : { completionReport }),
              openQuestionCount,
            }),
          ).attentionLabel,
        ).toBe(label);
      }
    },
  );
  it("says why the work runs where it runs, before and after the worker starts", () => {
    const { worker: _worker, ...noWorker } = chip();
    expect(
      presentTaskChip({
        ...noWorker,
        status: "dispatching",
        placementReason: "Codex (work) · 12% weekly used",
      }).sourceLabel,
    ).toBe("Codex (work) · 12% weekly used");
    const worker = {
      environmentId: EnvironmentId.make("remote-env"),
      threadId: ThreadId.make("worker"),
      host: "mac-studio",
    };
    expect(
      presentTaskChip(
        chip({ originKind: "slack", worker, placementReason: "Codex · 46% weekly used" }),
      ).sourceLabel,
    ).toBe("Slack · Jun · on mac-studio · Codex · 46% weekly used");
    expect(
      presentTaskChip(chip({ worker, placementReason: "mac-studio · Codex · 20% weekly used" }))
        .sourceLabel,
    ).toBe("on mac-studio · Codex · 20% weekly used");
    expect(
      presentTaskChip({
        ...noWorker,
        status: "dispatching",
        placementReason: "mac-studio · Codex · 20% weekly used",
      }).sourceLabel,
    ).toBe("mac-studio · Codex · 20% weekly used");
  });

  it("shows an answer without the agent's report trailers or empty checks", () => {
    const card = presentTaskChip(
      chip({
        status: "completed",
        completionReport: "present",
        summary:
          "OpenCodex has 17.8k stars: https://github.com/example/opencodex\nNOT RUN: separate tests.",
        observed: {
          pullRequests: [],
          needsYou: [],
          result: { runId: RunId.make("run-answer"), observedCheckPending: false },
        },
      }),
    );
    expect(card.summary).toBe("OpenCodex has 17.8k stars: https://github.com/example/opencodex");
    expect(card.evidenceLabels).toEqual([]);
    expect(card.sourceLabel).toBeNull();
  });

  it("keeps code work's checks and what it did not run", () => {
    const codeChip = (summary: string) =>
      chip({
        status: "completed",
        summary,
        observed: {
          pullRequests: [],
          needsYou: [],
          result: {
            runId: RunId.make("run-code"),
            tests: { ok: true },
            observedCheckPending: false,
          },
        },
      });
    expect(presentTaskChip(codeChip("Fixed it.\nNOT RUN: browser tests")).evidenceLabels).toEqual([
      "Reported tests: passed",
      "GOAT check: not run",
      "Not run: browser tests",
    ]);
    expect(presentTaskChip(codeChip("Fixed it.\nNOT RUN: none")).evidenceLabels).toEqual([
      "Reported tests: passed",
      "GOAT check: not run",
    ]);
  });

  it("counts open questions and drops an empty summary", () => {
    expect(presentTaskChip(chip({ openQuestionCount: 1, status: "waiting_input" }))).toMatchObject({
      statusLabel: "Needs your input",
      tone: "attention",
      attentionLabel: "1 question",
    });
    expect(presentTaskChip(chip({ openQuestionCount: 3 })).attentionLabel).toBe("3 questions");
    expect(presentTaskChip(chip({ summary: "  " })).summary).toBeNull();
    expect(presentTaskChip(chip({ summary: "Found the cause" })).summary).toBe("Found the cause");
  });

  it("shows what the worker thread waits on without changing the status", () => {
    const observed = (
      needsYou: NonNullable<ChannelTaskChip["observed"]>["needsYou"],
      usageLimitResetAt?: string,
    ) => ({
      observed: {
        pullRequests: [],
        needsYou,
        ...(usageLimitResetAt === undefined ? {} : { usageLimitResetAt }),
      },
    });
    const since = "2026-10-12T12:02:00.000Z";
    expect(
      presentTaskChip(
        chip({
          openQuestionCount: 1,
          ...observed([
            { kind: "question", since },
            { kind: "approval", since },
            { kind: "approval", since },
          ]),
        }),
      ),
    ).toMatchObject({ statusLabel: "Working", attentionLabel: "2 questions · 2 approvals" });
    expect(presentTaskChip(chip(observed([{ kind: "usage_limit", since }]))).attentionLabel).toBe(
      "Usage limit: resume needed",
    );
    expect(presentTaskChip(chip(observed([], "2026-10-12T17:00:00.000Z"))).attentionLabel).toBe(
      "Usage limit: resumes after reset",
    );
  });

  it("lists the worker's pull requests with their state", () => {
    const pullRequests = [
      {
        repository: "goat-si/goat",
        number: 41,
        url: "https://github.com/goat-si/goat/pull/41",
        state: "merged" as const,
        watching: false,
      },
      {
        repository: "goat-si/goat",
        number: 42,
        url: "https://github.com/goat-si/goat/pull/42",
        state: "open" as const,
        watching: true,
      },
    ];
    expect(
      presentTaskChip(chip({ observed: { pullRequests, needsYou: [] } })).pullRequests,
    ).toEqual([
      {
        key: "goat-si/goat#41",
        label: "#41 · merged",
        url: "https://github.com/goat-si/goat/pull/41",
      },
      {
        key: "goat-si/goat#42",
        label: "#42 · watching",
        url: "https://github.com/goat-si/goat/pull/42",
      },
    ]);
  });
});

describe("goatBotItemReaders", () => {
  const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
  const baseJson = {
    id: "item-1",
    threadId: "bot",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: "2026-10-12T12:00:00.000Z",
    completedAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
  };
  const userJson = (channel: unknown) => ({
    ...baseJson,
    type: "user_message",
    messageId: "m-1",
    inputIntent: "turn_start",
    text: "hello",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    channel,
  });

  it("reads the read time and input id of a bot conversation message", () => {
    const item = decodeItem(
      userJson({
        conversationId: "conv-1",
        originKind: "goat",
        kind: "inbound",
        inputId: "in-1",
        inReplyToInputId: "in-0",
        readAt: "2026-10-12T12:00:02.000Z",
      }),
    );
    if (item.type !== "user_message") throw new Error("expected a user message");
    expect(goatBotItemReaders.message(item)).toEqual({
      tone: "reply",
      readAt: "2026-10-12T12:00:02.000Z",
      requestKey: "in-1",
      replyToKey: "in-0",
      clientKey: "m-1",
    });
  });

  it("treats metadata this build cannot read as a plain message", () => {
    const item = decodeItem(
      userJson({ conversationId: "conv-1", originKind: "goat", kind: "something_new" }),
    );
    if (item.type !== "user_message") throw new Error("expected a user message");
    expect(goatBotItemReaders.message(item)).toBeNull();
  });

  it.each(["missing", "present", undefined] as const)(
    "decodes report %s through the notification reader",
    (completionReport) => {
      const item = decodeItem({
        ...baseJson,
        type: "notification",
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Finished",
        ledgerTask: chip({
          status: "completed",
          ...(completionReport === undefined ? {} : { completionReport }),
        }),
      });
      if (item.type !== "notification") throw new Error("expected a notification");
      expect(goatBotItemReaders.taskCard(item)?.attentionLabel).toBe(
        completionReport === "missing" ? "Finished without a report" : null,
      );
    },
  );

  it("turns a notification's ledger task into a card and ignores plain notifications", () => {
    const notification = (ledgerTask: unknown) =>
      decodeItem({
        ...baseJson,
        type: "notification",
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Work updated",
        ...(ledgerTask === undefined ? {} : { ledgerTask }),
      });
    const withTask = notification(chip({ status: "completed" }));
    const plain = notification(undefined);
    const unknownStatus = notification({ ...chip(), status: "paused" });
    if (
      withTask.type !== "notification" ||
      plain.type !== "notification" ||
      unknownStatus.type !== "notification"
    ) {
      throw new Error("expected notifications");
    }
    expect(goatBotItemReaders.taskCard(withTask)).toMatchObject({
      key: "task-1",
      statusLabel: "Done",
    });
    expect(goatBotItemReaders.taskCard(plain)).toBeNull();
    expect(goatBotItemReaders.taskCard(unknownStatus)).toBeNull();
  });
});

// Exercise the real codec → reader → row chain used by both renderers.
describe("memory report navigation", () => {
  const memory = {
    environmentId: "delivery-owner",
    memorySpaceId: "00000000-0000-4000-8000-000000000001",
    memoryId: "00000000-0000-4000-8000-000000000002",
    resolutionId: "00000000-0000-4000-8000-000000000003",
  };
  const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
  const reportItem = (reference: unknown) =>
    decode({
      id: "report",
      threadId: "bot",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: "2026-10-12T12:00:00.000Z",
      completedAt: "2026-10-12T12:00:00.000Z",
      updatedAt: "2026-10-12T12:00:00.000Z",
      type: "assistant_message",
      messageId: "report",
      text: "Memory resolved",
      streaming: false,
      channel: {
        conversationId: "conv",
        originKind: "goat",
        kind: "result",
        ...(reference === undefined ? {} : { memory: reference }),
      },
    });
  const timeline = (reference: unknown) => {
    const item = reportItem(reference);
    return buildGoatBotTimeline({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: item.threadId,
          sourceItemId: item.id,
          item,
        },
      ],
      pendingInputs: [],
      readers: goatBotItemReaders,
    }).filter((row) => row.kind === "bot");
  };
  it("carries the exact delivery owner, space, memory and resolution into a report row", () => {
    expect(timeline(memory)[0]).toMatchObject({ kind: "bot", text: "Memory resolved", memory });
  });
  it("keeps old metadata as plain safe text without a navigation action", () => {
    expect(timeline(undefined)[0]).not.toHaveProperty("memory");
    expect(timeline(undefined)[0]?.text).toBe("Memory resolved");
  });
  it("does not create navigation from malformed metadata", () => {
    expect(timeline({ ...memory, memoryId: "malformed" })[0]).not.toHaveProperty("memory");
  });
});

describe("reported tests and observed checks", () => {
  const evidenceChip = (
    observedCheck: NonNullable<NonNullable<ChannelTaskChip["observed"]>["result"]>["observedCheck"],
    pending = false,
  ) =>
    chip({
      status: "completed",
      completionReport: "present",
      observed: {
        pullRequests: [],
        needsYou: [],
        result: {
          runId: RunId.make("run-check"),
          tests: { ok: true, passed: 12 },
          observedCheckPending: pending,
          ...(observedCheck === undefined ? {} : { observedCheck }),
        },
      },
    });
  it.each([
    ["running", null, "GOAT check: running"],
    ["completed", 0, "GOAT check: passed"],
    ["completed", 3, "GOAT check: failed (exit 3)"],
    ["completed", null, "GOAT check: finished without an exit code"],
    ["timed_out", null, "GOAT check: timed out"],
    ["interrupted", null, "GOAT check: interrupted"],
    ["skipped", null, "GOAT check: skipped"],
  ] as const)("keeps Done and reported pass beside %s / %s", (status, exitCode, label) => {
    const card = presentTaskChip(
      evidenceChip({
        status,
        exitCode,
        command: "vp test run",
        durationMs: null,
        at: "2026-10-12T00:00:00.000Z",
      }),
    );
    expect(card.statusLabel).toBe("Done");
    expect(card.tone).toBe("success");
    expect(card.evidenceLabels).toEqual(["Reported tests: passed", label]);
  });
  it("never presents an absent check as a pass and retains diagnostic skip reasons", () => {
    expect(
      presentTaskChip(
        chip({
          observed: {
            pullRequests: [],
            needsYou: [],
            result: { runId: RunId.make("older-run"), tests: { ok: true } },
          },
        }),
      ).evidenceLabels,
    ).toEqual(["Reported tests: passed", "GOAT check: not available"]);
    expect(presentTaskChip(evidenceChip(undefined, true)).evidenceLabels).toEqual([
      "Reported tests: passed",
      "GOAT check: pending",
    ]);
    expect(presentTaskChip(evidenceChip(undefined)).evidenceLabels).toEqual([
      "Reported tests: passed",
      "GOAT check: not run",
    ]);
    expect(
      presentTaskChip(
        evidenceChip({
          status: "skipped",
          skipReason: "shared-checkout",
          command: "vp test run",
          exitCode: null,
          durationMs: null,
          at: "2026-10-12T00:00:00.000Z",
        }),
      ).evidenceLabels,
    ).toEqual(["Reported tests: passed", "GOAT check: skipped (shared checkout)"]);
  });
});
