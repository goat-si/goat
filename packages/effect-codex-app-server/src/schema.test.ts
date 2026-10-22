import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";

const isGetAccountResponse = Schema.is(CodexSchema.V2GetAccountResponse);
const isThreadReadResponse = Schema.is(CodexSchema.V2ThreadReadResponse);
const isThreadResumeResponse = Schema.is(CodexSchema.V2ThreadResumeResponse);
const isThreadForkResponse = Schema.is(CodexSchema.V2ThreadForkResponse);
const isTurnCompletedNotification = Schema.is(CodexSchema.V2TurnCompletedNotification);
const decodeThreadResumeResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeResponse);

it("keeps async questions in live notifications and thread history", () => {
  const item = {
    type: "agentMessage",
    id: "question-1",
    text: "Which package?\n- pnpm\n- npm\n\nWhat should it be named?",
    phase: "final_answer",
    delivery: "async",
    questions: [
      { title: "Which package manager?", options: ["pnpm", "npm"] },
      { title: "What should it be named?" },
    ],
  } as const;
  for (const schema of [
    CodexSchema.ServerNotification__ThreadItem,
    CodexSchema.V2ItemStartedNotification__ThreadItem,
    CodexSchema.V2ItemCompletedNotification__ThreadItem,
    CodexSchema.V2ThreadReadResponse__ThreadItem,
    CodexSchema.V2ThreadResumeResponse__ThreadItem,
  ]) {
    assert.deepEqual(Schema.decodeSync(schema)(item), item);
  }
});

it("accepts Codex 0.150 multi-agent values", () => {
  const schemas = [
    CodexSchema.ServerNotification__SubAgentActivityKind,
    CodexSchema.V2ItemStartedNotification__SubAgentActivityKind,
    CodexSchema.V2ItemCompletedNotification__SubAgentActivityKind,
    CodexSchema.V2ThreadReadResponse__SubAgentActivityKind,
    CodexSchema.V2ThreadResumeResponse__SubAgentActivityKind,
  ];

  for (const schema of schemas) {
    assert.equal(Schema.is(schema)("completed"), true);
  }

  for (const tool of ["sendMessage", "followupTask", "interruptAgent", "listAgents"]) {
    assert.equal(Schema.is(CodexSchema.ServerNotification__CollabAgentTool)(tool), true);
    assert.equal(Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentTool)(tool), true);
  }

  assert.equal(
    Schema.is(CodexSchema.ServerNotification__CollabAgentToolCallStatus)("interrupted"),
    true,
  );
  assert.equal(
    Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentToolCallStatus)("interrupted"),
    true,
  );

  const resumeResponse = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.150.0",
      createdAt: 0,
      cwd: "/tmp/project",
      ephemeral: false,
      id: "root-thread",
      modelProvider: "openai",
      preview: "",
      projectId: null,
      sessionId: "session-1",
      source: "cli",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              agentsStates: {},
              id: "item-1",
              receiverThreadIds: ["child-thread"],
              senderThreadId: "root-thread",
              status: "interrupted",
              tool: "followupTask",
              type: "collabAgentToolCall",
            },
          ],
        },
      ],
      updatedAt: 0,
    },
  };

  assert.equal(Schema.is(CodexSchema.V2ThreadResumeResponse)(resumeResponse), true);
});

it("accepts Codex misalignment policy errors for thread responses", () => {
  const failedThread = {
    cliVersion: "0.150.0",
    createdAt: 0,
    cwd: "/tmp/project",
    ephemeral: false,
    id: "thread-1",
    modelProvider: "openai",
    preview: "",
    projectId: null,
    sessionId: "session-1",
    source: "cli",
    status: { type: "idle" },
    turns: [
      {
        error: {
          codexErrorInfo: "misalignmentPolicyViolation",
          message: "Misalignment policy violation",
        },
        id: "turn-1",
        items: [],
        status: "failed",
      },
    ],
    updatedAt: 0,
  };
  const resumeLikeResponse = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: failedThread,
  };
  assert.equal(isThreadReadResponse({ thread: failedThread }), true);
  assert.equal(isThreadResumeResponse(resumeLikeResponse), true);
  assert.equal(isThreadForkResponse(resumeLikeResponse), true);
  const decodedResume = decodeThreadResumeResponse(resumeLikeResponse);
  assert.equal(decodedResume.thread.turns[0]?.error?.codexErrorInfo, "misalignmentPolicyViolation");
  assert.equal(
    isTurnCompletedNotification({
      threadId: "thread-1",
      turn: {
        error: {
          codexErrorInfo: "misalignmentPolicyViolation",
          message: "Misalignment policy violation",
        },
        id: "turn-1",
        items: [],
        status: "failed",
      },
    }),
    true,
  );
});

it("accepts account plan slugs newer than the pinned protocol", () => {
  const planTypes = [
    "self_serve_business_prolite",
    "ent26",
    "enterprise_cbp_automation",
    "edu_plus",
    "edu_pro",
    "promax",
    "some_future_plan",
  ];

  for (const planType of planTypes) {
    const accountResponse = {
      account: {
        email: "user@example.com",
        planType,
        type: "chatgpt",
      },
      requiresOpenaiAuth: true,
    };

    assert.equal(isGetAccountResponse(accountResponse), true);
  }
});

const decodeItemCompleted = Schema.decodeUnknownSync(CodexSchema.V2ItemCompletedNotification);
const decodeHookCompleted = Schema.decodeUnknownSync(CodexSchema.V2HookCompletedNotification);
const decodeCodexErrorInfo = Schema.decodeUnknownSync(
  CodexSchema.ServerNotification__CodexErrorInfo,
);
const itemCompleted = (item: Record<string, unknown>) => ({
  threadId: "thread-1",
  turnId: "turn-1",
  completedAtMs: 1_792_570_000_000,
  item,
});
const imageGenerationItem = {
  type: "imageGeneration",
  id: "ig_1",
  status: "completed",
  revisedPrompt: "A small blue square",
  savedPath: "/home/user/.codex/generated_images/thread-1/ig_1.png",
} as const;

it("decodes image generation items from Codex 0.163 and 0.164", () => {
  // 0.156 through 0.163 always send inline base64 bytes.
  const inline = decodeItemCompleted(
    itemCompleted({ ...imageGenerationItem, result: "cG5n", failure: null }),
  ).item;
  assert.isTrue(inline.type === "imageGeneration" && "result" in inline);
  assert.include(inline, { result: "cG5n" });

  // 0.164 sends an attachment id when the upload succeeds, plus the local
  // images the generation read.
  const uploaded = decodeItemCompleted(
    itemCompleted({
      ...imageGenerationItem,
      fileId: "file_abc",
      inputImages: [{ path: "/workspace/reference.png", sha256: "ab".repeat(32) }],
      transparentBackground: true,
    }),
  ).item;
  assert.isTrue(uploaded.type === "imageGeneration" && "fileId" in uploaded);
  assert.include(uploaded, { fileId: "file_abc" });
  assert.deepEqual(uploaded.type === "imageGeneration" ? uploaded.inputImages : undefined, [
    { path: "/workspace/reference.png", sha256: "ab".repeat(32) },
  ]);

  // Rollouts written during Codex's migration carry both; the id wins.
  const migrated = decodeItemCompleted(
    itemCompleted({ ...imageGenerationItem, fileId: "file_abc", result: "" }),
  ).item;
  assert.isTrue(migrated.type === "imageGeneration" && "fileId" in migrated);
  assert.isFalse("result" in migrated);
});

it("keeps agent messages whose phase Codex added after the bindings", () => {
  for (const phase of ["final_answer", "partial_answer", "a_future_phase"]) {
    const { item } = decodeItemCompleted(
      itemCompleted({ type: "agentMessage", id: "msg-1", text: "Answer", phase }),
    );
    assert.include(item, { type: "agentMessage", phase });
  }
});

it("keeps hook runs for hook events Codex added after the bindings", () => {
  for (const eventName of ["preToolUse", "preModelRequest", "postModelRequest", "aFutureHook"]) {
    const { run } = decodeHookCompleted({
      threadId: "thread-1",
      turnId: "turn-1",
      run: {
        id: "hook-run-1",
        displayOrder: 0,
        entries: [],
        eventName,
        executionMode: "sync",
        handlerType: "command",
        scope: "turn",
        sourcePath: "/workspace/.codex/hooks.json",
        startedAt: 1_792_570_000,
        completedAt: 1_792_570_001,
        status: "completed",
      },
    });
    assert.equal(run.eventName, eventName);
  }
});

it("ignores fields newer Codex servers add", () => {
  const { item } = decodeItemCompleted(
    itemCompleted({
      type: "agentMessage",
      id: "msg-1",
      text: "Answer",
      phase: "final_answer",
      voiceSessionId: "voice-1",
      toolListMeta: { cursor: null },
    }),
  );
  assert.deepEqual(item, {
    type: "agentMessage",
    id: "msg-1",
    text: "Answer",
    phase: "final_answer",
  });
});

it("decodes retry exhaustion and unknown error infos from Codex 0.164", () => {
  assert.deepEqual(
    decodeCodexErrorInfo({ responseTooManyFailedAttempts: { httpStatusCode: 429 } }),
    {
      responseTooManyFailedAttempts: { httpStatusCode: 429 },
    },
  );
  assert.equal(decodeCodexErrorInfo("aFutureErrorCode"), "aFutureErrorCode");
  assert.deepEqual(decodeCodexErrorInfo({ aFutureError: { detail: 1 } }), {
    aFutureError: { detail: 1 },
  });
});
