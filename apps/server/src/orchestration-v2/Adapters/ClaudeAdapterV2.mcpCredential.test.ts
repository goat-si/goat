// @effect-diagnostics nodeBuiltinImport:off - the fake Claude CLI uses Node streams
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ProviderSessionId, ThreadId } from "@goat/contracts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CLAUDE_TEST_MODEL_SELECTION } from "./ClaudeTestInput.testkit.ts";

const layerAdapterTest = layerClaudeAdapterTest;

function makeFakeClaudeCli(answerSetServers = true) {
  const spawns: Array<SpawnOptions> = [];
  const controlRequests: Array<object> = [];
  const stdins: Array<NodeStream.PassThrough> = [];
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    spawns.push(options);
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    stdins.push(stdin);
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      killed: false,
      exitCode: null as number | null,
      kill: () => {
        stdout.end();
        child.emit("exit", null, "SIGTERM");
        return true;
      },
    });
    let pending = "";
    stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type !== "control_request") continue;
        controlRequests.push(frame.request);
        const setServers = frame.request.subtype === "mcp_set_servers";
        if (setServers && !answerSetServers) continue;
        const response = {
          subtype: "success",
          request_id: frame.request_id,
          response: setServers ? { added: [], removed: [], errors: {} } : {},
        };
        stdout.write(`${JSON.stringify({ type: "control_response", response })}\n`);
      }
    });
    stdin.on("end", () => {
      stdout.end();
      child.emit("exit", 0, null);
    });
    return child;
  };
  const closed = () => stdins.length > 0 && stdins.every((stdin) => stdin.writableEnded);
  return { spawn, spawns, controlRequests, closed };
}

describe("ClaudeAdapterV2 MCP credential channel", () => {
  const goatMcpServer = {
    type: "http" as const,
    url: "http://127.0.0.1:43123/mcp",
    headers: { Authorization: "Bearer dummy-mcp-credential" },
  };
  const openWith = (
    cli: ReturnType<typeof makeFakeClaudeCli>,
    native?: ProviderEventLoggers.EventNdjsonLogger,
  ) =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      return yield* runner.open({
        threadId: ThreadId.make("thread-claude-mcp-channel"),
        providerSessionId: ProviderSessionId.make("provider-session-claude-mcp-channel"),
        options: {
          ...ClaudeAdapterV2.makeClaudeQueryOptions({
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            nativeThreadId: "native-thread-claude-mcp-channel",
            title: "Existing T3 title",
            resume: false,
            cwd: null,
            environment: { PATH: "/usr/bin" },
            mcpServers: { goat: goatMcpServer },
          }),
          pathToClaudeCodeExecutable: "/opt/claude/cli.js",
          spawnClaudeCodeProcess: cli.spawn,
        },
      });
    }).pipe(
      Effect.provide(ClaudeAdapterV2.layerQueryRunner),
      Effect.provideService(ProviderEventLoggers.ProviderEventLoggers, {
        ...ProviderEventLoggers.NoOpProviderEventLoggers,
        native,
      }),
      Effect.provide(layerAdapterTest),
    );

  it.effect("commits queued delivery before interruptible protocol logging", () =>
    Effect.gen(function* () {
      const logging = yield* Deferred.make<void>();
      let committed = false;
      const cli = makeFakeClaudeCli();
      const session = yield* openWith(cli, {
        filePath: "/tmp/claude-queued-delivery.log",
        write: () =>
          committed
            ? Deferred.succeed(logging, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        close: () => Effect.void,
      });
      const offering = yield* session
        .offer(ClaudeAdapterV2.makeClaudeUserMessage({ text: "Inspect the attachment." }), () => {
          committed = true;
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(logging);
      yield* Fiber.interrupt(offering);
      assert.isTrue(committed);
      committed = false;
      yield* session.close;
    }),
  );

  it.effect("sends MCP servers over stdin, not argv or the environment", () =>
    Effect.gen(function* () {
      const cli = makeFakeClaudeCli();
      const session = yield* openWith(cli);
      yield* session.close;

      assert.deepInclude(cli.controlRequests, {
        subtype: "mcp_set_servers",
        servers: { goat: goatMcpServer },
      });
      assert.deepInclude(
        cli.controlRequests.find((request) => Reflect.get(request, "subtype") === "initialize"),
        { title: "Existing T3 title" },
      );
      const spawned = JSON.stringify(cli.spawns);
      assert.notInclude(spawned, "--title");
      assert.notInclude(spawned, "--mcp-config");
      assert.notInclude(spawned, "dummy-mcp-credential");
    }),
  );
});
