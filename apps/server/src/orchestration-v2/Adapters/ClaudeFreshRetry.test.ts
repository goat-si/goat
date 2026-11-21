import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { NodeServices, NodeCrypto } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { ProviderEventLoggers } from "@goat/provider-core/server/ProviderEventLoggers";
import {
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryOpenInput,
  layerQueryRunner,
} from "./ClaudeAgentSdkQueryRunner.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });
const FORK_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const realQueryRunner = layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const resumedMcpQueryInput = {
  threadId: ThreadId.make("thread-restart-registration"),
  providerSessionId: ProviderSessionId.make("session-restart-registration"),
  options: {
    resume: FORK_SESSION_ID,
    model: "claude-sonnet-4-6",
    tools: [],
    permissionMode: "default",
    mcpServers: {
      "t3-code": {
        type: "http",
        url: "http://localhost:3773/mcp",
        headers: { Authorization: "Bearer test-mcp-credential" },
      },
    },
  },
} satisfies ClaudeAgentSdkQueryOpenInput;

it.effect("retries a fresh timed-out session with a new ID after disposal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(() => {
        const first = querySpy.mock.calls.length === 1;
        return {
          initializationResult: async () => ({}),
          setMcpServers: () => {
            started.resolve();
            return first
              ? new Promise<ClaudeSdk.McpSetServersResult>(() => {})
              : Promise.resolve({ added: ["t3-code"], removed: [], errors: {} });
          },
          close: vi.fn(),
          [Symbol.asyncDispose]: disposed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const { resume, ...options } = resumedMcpQueryInput.options;
      const opening = yield* runner
        .open({ ...resumedMcpQueryInput, options: { ...options, sessionId: resume } })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);
      assert.equal(result._tag, "Success");
      assert.equal(querySpy.mock.calls.length, 2);
      assert.equal(disposed.mock.calls.length, 1);
      assert.notEqual(querySpy.mock.calls[1]?.[0].options?.sessionId, resume);
      if (result._tag === "Success") yield* result.success.close;
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);
