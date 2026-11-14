import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestProviderHost from "../../../provider-testing/src/TestProviderHost.ts";
import * as DocumentText from "../../../../apps/server/src/provider/DocumentText.ts";
import { makeTurnInput } from "../../../../apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { makeMockRuntime } from "../../../../apps/server/src/orchestration-v2/Adapters/AcpMockRuntime.testkit.ts";
import { makeGrokAdapterV2 } from "./adapter.ts";
import { GrokSettings } from "../settings.ts";
import * as Schema from "effect/Schema";

const decodeGrokSettings = Schema.decodeEffect(GrokSettings);

const layer = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

it.live(
  "keeps the open environment and resolved launch on restart and refreshes them for a new session",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-session-" });
      const oldPath = path.join(root, "old");
      const newPath = path.join(root, "new");
      for (const dir of [oldPath, newPath]) {
        yield* fs.makeDirectory(dir);
        yield* fs.writeFileString(path.join(dir, "grok"), "#!/bin/sh\n");
        yield* fs.chmod(path.join(dir, "grok"), 0o755);
      }
      const host = { PATH: oldPath };
      const launches: Array<{ env: NodeJS.ProcessEnv | undefined; launch: unknown }> = [];
      let storedKey = "old-key";
      const instanceId = ProviderInstanceId.make("acp-environment");
      const makeRuntime = makeMockRuntime({
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        mockAgentPath: yield* path.fromFileUrl(
          new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
        ),
        wrapRuntime: (runtime) => ({
          ...runtime,
          prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
        }),
      });
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: yield* decodeGrokSettings({}),
        environment: host,
        currentEnvironment: Effect.sync(() => host),
        readStoredApiKey: Effect.sync(() => storedKey),
        hostPlatform: "darwin",
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) => {
          launches.push({ env: input.sessionEnvironment, launch: input.sessionLaunch });
          return makeRuntime(input);
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const threadId = ThreadId.make("thread-environment");
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const config = (token: string) => ({
        environmentId: EnvironmentId.make("environment"),
        threadId,
        providerSessionId: "mcp-session",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: `Bearer ${token}`,
        browserToolsAvailable: false,
      });
      yield* sessions.set(config("old"));
      const open = (id: string) =>
        adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(id),
          modelSelection,
          runtimePolicy,
        });
      const first = yield* open("first");
      host.PATH = newPath;
      storedKey = "new-key";
      const providerThread = yield* first.ensureThread({ threadId, modelSelection, runtimePolicy });
      for (const ordinal of [1]) {
        yield* first.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
            ordinal,
          }),
        );
        yield* first.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
      }
      yield* sessions.set(config("new"));
      yield* first.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 3,
        }),
      );
      yield* first.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const second = yield* open("second");
      yield* second.ensureThread({ threadId, modelSelection, runtimePolicy });
      assert.deepEqual(
        launches.map(({ env }) => env?.PATH),
        [oldPath, oldPath, newPath],
      );
      assert.deepEqual(
        launches.map(({ launch }) => launch),
        [
          {
            environment: { PATH: oldPath, XAI_API_KEY: "old-key" },
            executable: path.join(oldPath, "grok"),
          },
          {
            environment: { PATH: oldPath, XAI_API_KEY: "old-key" },
            executable: path.join(oldPath, "grok"),
          },
          {
            environment: { PATH: newPath, XAI_API_KEY: "new-key" },
            executable: path.join(newPath, "grok"),
          },
        ],
      );
      assert.notStrictEqual(launches[0]?.env, host);
    }).pipe(Effect.provide(layer), Effect.scoped),
);
