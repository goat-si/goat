import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as CodexError from "effect-codex-app-server/errors";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexMcpReload } from "./CodexMcpReload.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

it.effect("resumes an explicitly unloaded thread once before retrying MCP resource read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nativeThreadId = "mcp-recovery";
      const request = { threadId: nativeThreadId, server: "weather", uri: "ui://weather" };
      const contents = [{ uri: "ui://weather", text: "weather" }];
      const resumes: unknown[] = [];
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "mcp-recovery",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "unused",
              prompt: "unused",
            }).slice(0, 5),
            {
              type: "expect_outbound",
              frame: { id: 3, method: "mcpServer/resource/read", params: request },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 3,
                error: { code: -32600, message: `thread not found: ${nativeThreadId}` },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  cwd: "/current-worktree",
                  model: "gpt-current",
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              frame: { id: 4, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
            {
              type: "expect_outbound",
              frame: { id: 5, method: "mcpServer/resource/read", params: request },
            },
            { type: "emit_inbound", frame: { id: 5, result: { contents } } },
          ],
        }),
        undefined,
        (method, params) =>
          Effect.sync(() => {
            if (method === "thread/resume") resumes.push(params);
          }),
      );
      assert.ok(harness.runtime.mcpApps);
      const result = yield* harness.runtime.mcpApps!.readResource({
        providerThread: harness.providerThread,
        server: "weather",
        uri: "ui://weather",
        resolveRuntime: Effect.succeed({
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-current" },
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/current-worktree",
          },
        }),
      });
      assert.deepEqual(result.contents, contents);
      assert.isTrue(Predicate.isObject(resumes[0]));
      if (Predicate.isObject(resumes[0])) {
        assert.equal(resumes[0].model, "gpt-current");
        assert.equal(resumes[0].cwd, "/current-worktree");
      }
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        MemoryDerivedCache.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);

it.effect("never retries refusals and resumes at most once for an unloaded thread", () =>
  Effect.gen(function* () {
    let resumes = 0;
    const resume = Effect.sync(() => {
      resumes++;
    });
    const denied = new CodexError.CodexAppServerRequestError({
      code: -32000,
      errorMessage: "denied",
    });
    assert.strictEqual(
      yield* withCodexMcpReload("native", Effect.fail(denied), resume).pipe(Effect.flip),
      denied,
    );
    assert.equal(resumes, 0);
    const unloaded = new CodexError.CodexAppServerRequestError({
      code: -32600,
      errorMessage: "thread not found: native",
    });
    assert.strictEqual(
      yield* withCodexMcpReload("native", Effect.fail(unloaded), resume).pipe(Effect.flip),
      unloaded,
    );
    assert.equal(resumes, 1);
  }),
);
