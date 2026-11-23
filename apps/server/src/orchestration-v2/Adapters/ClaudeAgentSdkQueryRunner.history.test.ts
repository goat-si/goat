import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import { ProviderEventLoggers } from "@goat/provider-core/server/ProviderEventLoggers";
import {
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryOpenInput,
  layerQueryRunner,
} from "./ClaudeAdapterV2.ts";
vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });
const FORK_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const sessionEntry = (uuid: string, parentUuid: string | null, message: unknown) => ({
  type: parentUuid === null ? "user" : "assistant",
  uuid,
  parentUuid,
  sessionId: FORK_SESSION_ID,
  cwd: "/repo",
  isSidechain: false,
  timestamp: "2026-10-01T00:00:00.000Z",
  message,
});

const writeClaudeSession = Effect.fnUntraced(function* (
  configDir: string,
  entries: ReadonlyArray<unknown> = [
    sessionEntry("aaaaaaaa-0000-4000-8000-000000000001", null, { role: "user", content: "hello" }),
    sessionEntry("aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000001", {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    }),
  ],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.join(configDir, "projects", "-repo");
  yield* fileSystem.makeDirectory(projectDir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(projectDir, `${FORK_SESSION_ID}.jsonl`),
    entries.map((line) => JSON.stringify(line)).join("\n"),
  );
  return projectDir;
});

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

it.effect("resumes a session whose history exceeds the status-probe output limit", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-claude-large-history-",
    });
    yield* writeClaudeSession(configDir, [
      sessionEntry("aaaaaaaa-0000-4000-8000-000000000001", null, {
        role: "user",
        content: "x".repeat(9 * 1024 * 1024),
      }),
    ]);
    const querySpy = vi
      .spyOn(ClaudeSdk, "query")
      .mockImplementation(() => ({ close: vi.fn() }) as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
    const runner = yield* ClaudeAgentSdkQueryRunner;
    const { mcpServers: _mcpServers, ...options } = resumedMcpQueryInput.options;
    const session = yield* runner.open({
      ...resumedMcpQueryInput,
      resume: true,
      options: { ...options, cwd: "/repo", env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } },
    });
    yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));
    assert.equal(querySpy.mock.calls.length, 1);
    assert.equal(querySpy.mock.calls[0]?.[0].options?.resume, FORK_SESSION_ID);
  }).pipe(Effect.provide(Layer.merge(realQueryRunner, NodeServices.layer))),
);
