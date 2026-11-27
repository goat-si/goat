import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type OrchestrationV2RuntimeRequest, RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as CodexReplay from "effect-codex-app-server/replay";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

it.effect("shows what an approval grants apart from the reason the model gave", () =>
  Effect.gen(function* () {
    const nativeThreadId = "approval-scope-thread";
    const nativeTurnId = "approval-scope-turn";
    const prompt = "Build the project.";
    const reason = "Needed to build the project.";
    const permissions = {
      fileSystem: {
        write: ["/w/out"],
        entries: [
          { access: "write", path: { type: "path", path: "/w/out" } },
          { access: "write", path: { type: "special", value: { kind: "root" } } },
          { access: "read", path: { type: "glob_pattern", pattern: "/w/docs/**/*.md" } },
          { access: "write", path: { type: "special", value: { kind: "unknown", path: "" } } },
        ],
      },
      network: { enabled: true },
    } satisfies CodexSchema.PermissionsRequestApprovalParams["permissions"];
    const request = (
      id: number,
      method: string,
      params: Record<string, unknown>,
      result: Record<string, unknown>,
    ): Array<CodexReplay.CodexAppServerReplayEntry> => [
      {
        type: "emit_inbound",
        label: method,
        frame: {
          id,
          method,
          params: { threadId: nativeThreadId, turnId: nativeTurnId, startedAtMs: 2, ...params },
        },
      },
      { type: "expect_outbound", label: method, frame: { id, result } },
    ];
    const addA = { path: "/w/a.ts", kind: { type: "add" as const }, diff: "@@ +1 @@\n+a\n" };
    const manyFiles = Array.from({ length: 21 }, (_, index) => ({
      ...addA,
      path: `/w/${String(index).padStart(2, "0")}.ts`,
    }));
    const fileChange = (
      phase: "started" | "completed",
      itemId: string,
      changes: ReadonlyArray<typeof addA>,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `fileChange/${phase}/${itemId}`,
      frame: {
        method: `item/${phase}`,
        params: {
          threadId: nativeThreadId,
          turnId: nativeTurnId,
          ...(phase === "started" ? { startedAtMs: 2 } : { completedAtMs: 3 }),
          item: {
            type: "fileChange",
            id: itemId,
            status: phase === "started" ? "inProgress" : "completed",
            changes,
          },
        },
      },
    });
    const pending = yield* Queue.unbounded<OrchestrationV2RuntimeRequest>();
    const harness = yield* makeCodexReplayHarness(
      makeCodexReplayTranscript({
        scenario: "approval-scope",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          ...request(
            0,
            "item/permissions/requestApproval",
            { itemId: "permissions", cwd: "/w", reason, permissions },
            { permissions, scope: "turn" },
          ),
          ...request(
            1,
            "item/commandExecution/requestApproval",
            {
              itemId: "command",
              cwd: "/w/app",
              reason,
              command: "pnpm install",
              networkApprovalContext: { host: "example.com", protocol: "https" },
            },
            { decision: "accept" },
          ),
          fileChange("started", "patch", manyFiles),
          ...request(
            2,
            "item/fileChange/requestApproval",
            { itemId: "patch", reason, grantRoot: "/w" },
            { decision: "accept" },
          ),
          fileChange("completed", "patch", manyFiles),
          ...request(
            3,
            "execCommandApproval",
            {
              callId: "legacy",
              conversationId: nativeThreadId,
              command: ["pnpm", "run", "build"],
              cwd: "/w/app",
              parsedCmd: [],
              reason,
            },
            { decision: "approved" },
          ),
          {
            type: "emit_inbound",
            label: `complete ${nativeTurnId}`,
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ],
      }),
      (event) =>
        event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
          ? Queue.offer(pending, event.runtimeRequest)
          : Effect.void,
    );
    yield* harness.runtime.startTurn(
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("approval-scope-attempt"),
        text: prompt,
      }),
    );
    const answerNext = Queue.take(pending).pipe(
      Effect.tap((req) =>
        harness.runtime.respondToRuntimeRequest({
          requestId: req.id,
          decision: "accept",
        }),
      ),
    );
    const requests = [yield* answerNext, yield* answerNext, yield* answerNext, yield* answerNext];
    yield* harness.firstTerminal;

    const approvalItem = (
      events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
      req: OrchestrationV2RuntimeRequest,
    ) =>
      events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "approval_request" &&
        event.turnItem.requestId === req.id
          ? [event.turnItem]
          : [],
      )[0];

    assert.deepEqual(
      requests.map((req) => {
        const item = approvalItem(harness.events, req);
        return [item?.prompt, item?.reason];
      }),
      [
        [
          "write /w/out\nwrite / (entire filesystem)\nread /w/docs/**/*.md\nwrite unknown path\nnetwork",
          reason,
        ],
        ["pnpm install\ncwd /w/app\nnetwork https example.com", reason],
        [[...manyFiles.map((file) => `add ${file.path}`), "write /w"].join("\n"), reason],
        ["pnpm run build\ncwd /w/app", reason],
      ],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        MemoryDerivedCache.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);
