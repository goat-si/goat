import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestProviderHost from "../../../provider-testing/src/TestProviderHost.ts";
import * as DocumentText from "../../../../apps/server/src/provider/DocumentText.ts";
import { makeTurnInput } from "../../../../apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { makeMockRuntime } from "../../../../apps/server/src/orchestration-v2/Adapters/AcpMockRuntime.testkit.ts";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "./adapter.ts";

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
      const host = { PATH: "/old" };
      const launches: Array<{ env: NodeJS.ProcessEnv | undefined; launch: unknown }> = [];
      const rewrites: Array<string | undefined> = [];
      let prompts = 0;
      const instanceId = ProviderInstanceId.make("acp-environment");
      const path = yield* Path.Path;
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
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        currentEnvironment: Effect.sync(() => host),
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ProviderDriverKind.make("acp-environment"),
          capabilities: AcpProviderCapabilitiesV2,
          resolveSessionLaunch: (env: NodeJS.ProcessEnv) =>
            Effect.succeed(`executable:${env.PATH}`),
          rewriteUserText: (text, _turn, session) =>
            Effect.sync(() => {
              rewrites.push(session?.environment?.PATH);
              return text;
            }),
          watchPromptOutcome: () =>
            Effect.succeed(() =>
              Effect.sync(() =>
                ++prompts === 1
                  ? {
                      class: "transport_error" as const,
                      message: "restart",
                      code: null,
                      retryable: true,
                    }
                  : undefined,
              ),
            ),
          makeRuntime: (input) => {
            launches.push({
              env: input.sessionEnvironment,
              launch: Reflect.get(input, "sessionLaunch"),
            });
            return makeRuntime(input);
          },
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
      host.PATH = "/new";
      const providerThread = yield* first.ensureThread({ threadId, modelSelection, runtimePolicy });
      for (const ordinal of [1, 2]) {
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
        launches.map(({ env, launch }) => [env?.PATH, launch]),
        [
          ["/old", "executable:/old"],
          ["/old", "executable:/old"],
          ["/old", "executable:/old"],
          ["/new", "executable:/new"],
        ],
      );
      assert.deepEqual(rewrites, ["/old", "/old", "/old"]);
      assert.notStrictEqual(launches[0]?.env, host);
    }).pipe(Effect.provide(layer), Effect.scoped),
);
