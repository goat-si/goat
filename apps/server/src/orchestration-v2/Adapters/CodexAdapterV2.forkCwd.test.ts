import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { CODEX_TEST_RUNTIME_POLICY } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

const forkResult = (nativeThreadId: string, forkedFromId: string, cwd: string) => ({
  thread: {
    id: nativeThreadId,
    sessionId: nativeThreadId,
    forkedFromId,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1782622440,
    updatedAt: 1782622440,
    status: { type: "idle" },
    path: `/tmp/${nativeThreadId}.jsonl`,
    cwd,
    cliVersion: "0.144.0",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  },
  model: "gpt-5.4",
  modelProvider: "openai",
  serviceTier: null,
  cwd,
  instructionSources: [],
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  reasoningEffort: "medium",
});

it.effect("a native fork starts the forked Codex thread in the target thread's cwd", () =>
  Effect.gen(function* () {
    const nativeThreadId = "cwd-source-thread";
    const forkThreadId = "cwd-fork-thread";
    const targetCwd = "/tmp/goat-fork-target";
    // The session, and the source thread with it, work in CODEX_TEST_RUNTIME_POLICY.cwd.
    assert.notEqual(CODEX_TEST_RUNTIME_POLICY.cwd, targetCwd);
    const transcript = makeCodexReplayTranscript({
      scenario: "codex-fork-target-cwd",
      entries: [
        ...codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "cwd-source-turn",
          prompt: "unused",
        }).slice(0, 5),
        {
          type: "expect_outbound",
          label: "thread/fork",
          frame: {
            id: 3,
            method: "thread/fork",
            params: {
              threadId: nativeThreadId,
              cwd: targetCwd,
              config: CodexAdapterV2.CODEX_THREAD_CONFIG,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "thread/fork",
          frame: {
            id: 3,
            result: forkResult(forkThreadId, nativeThreadId, targetCwd),
          },
        },
      ],
    });
    const forkParams: Array<unknown> = [];
    const harness = yield* makeCodexReplayHarness(
      transcript,
      () => Effect.void,
      (method, params) =>
        Effect.sync(() => {
          if (method === "thread/fork") forkParams.push(params);
        }),
    );

    const forked = yield* harness.runtime.forkThread({
      sourceProviderThread: harness.providerThread,
      targetThreadId: ThreadId.make("thread-fork-target-cwd"),
      runtimePolicy: { ...CODEX_TEST_RUNTIME_POLICY, cwd: targetCwd },
    });

    assert.equal(forked.nativeThreadRef?.nativeId, forkThreadId);
    assert.lengthOf(forkParams, 1);
    assert.propertyVal(forkParams[0], "cwd", targetCwd);
  }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
);
