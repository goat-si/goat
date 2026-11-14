import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestProviderHost from "../../../provider-testing/src/TestProviderHost.ts";
import * as DocumentText from "../../../../apps/server/src/provider/DocumentText.ts";
import { makeTurnInput } from "../../../../apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { makeMockRuntime } from "../../../../apps/server/src/orchestration-v2/Adapters/AcpMockRuntime.testkit.ts";
import { makeFxAdapterV2 } from "./adapter.ts";
import { FxSettings } from "../settings.ts";
import * as Schema from "effect/Schema";

const decodeFxSettings = Schema.decodeEffect(FxSettings);

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
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fx-session-" });
      const oldPath = path.join(root, "old");
      const newPath = path.join(root, "new");
      for (const dir of [oldPath, newPath]) {
        yield* fs.makeDirectory(dir);
        yield* fs.writeFileString(path.join(dir, "fx"), "#!/bin/sh\n");
        yield* fs.chmod(path.join(dir, "fx"), 0o755);
      }
      const host = { PATH: oldPath };
      const launches: Array<{ env: NodeJS.ProcessEnv | undefined; launch: unknown }> = [];
      const instanceId = ProviderInstanceId.make("acp-environment");
      const makeRuntime = makeMockRuntime({
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        mockAgentPath: yield* path.fromFileUrl(
          new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
        ),
        wrapRuntime: (runtime) => ({
          ...runtime,
          request: () => Effect.succeed({}),
          prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
        }),
      });
      const adapter = yield* makeFxAdapterV2({
        instanceId,
        settings: yield* decodeFxSettings({}),
        environment: host,
        currentEnvironment: Effect.sync(() => host),
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
            environment: { PATH: oldPath },
            executable: path.join(oldPath, "fx"),
          },
          {
            environment: { PATH: oldPath },
            executable: path.join(oldPath, "fx"),
          },
          {
            environment: { PATH: newPath },
            executable: path.join(newPath, "fx"),
          },
        ],
      );
      assert.notStrictEqual(launches[0]?.env, host);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

// The executable fixture uses a POSIX shell.
it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "finds a workspace-relative fx and launches it with the session's own PATH",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "fx-relative-" });
      const executable = path.join(workspace, "bin", "fx");
      yield* fs.makeDirectory(path.join(workspace, "bin"));
      const receipt = path.join(workspace, "receipt");
      const agent = yield* path.fromFileUrl(
        new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
      );
      yield* fs.writeFileString(
        executable,
        '#!/bin/sh\nprintf "%s\\n%s\\n" "$0" "$PATH" > "$TEST_RECEIPT"\nexec "$TEST_NODE" "$TEST_AGENT"\n',
      );
      yield* fs.chmod(executable, 0o755);
      const instanceId = ProviderInstanceId.make("fx-relative-path");
      const adapter = yield* makeFxAdapterV2({
        instanceId,
        settings: yield* decodeFxSettings({}),
        environment: {
          PATH: "bin",
          TEST_RECEIPT: receipt,
          TEST_NODE: process.execPath,
          TEST_AGENT: agent,
        },
        currentEnvironment: Effect.succeed({
          PATH: "bin",
          TEST_RECEIPT: receipt,
          TEST_NODE: process.execPath,
          TEST_AGENT: agent,
        }),
        selfInvocation: yield* resolveSelfInvocation(),
      });
      const result = yield* adapter
        .openSession({
          threadId: ThreadId.make("fx-relative-thread"),
          providerSessionId: ProviderSessionId.make("fx-relative"),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: workspace,
          }),
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.deepEqual((yield* fs.readFileString(receipt)).trimEnd().split("\n"), [
        executable,
        "bin",
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
);
