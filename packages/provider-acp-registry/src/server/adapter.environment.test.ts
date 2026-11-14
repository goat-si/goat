import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeTurnInput } from "../../../../apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { makeAcpRegistryAdapterV2 } from "./adapter.ts";

const decodeSettings = Schema.decodeEffect(AcpRegistrySettings);

it.live("keeps the resolved executable across MCP replacement and resolves a new session", () =>
  Effect.gen(function* () {
    const host: NodeJS.ProcessEnv = { PATH: "/old", GOAT_ACP_SESSION_LIFECYCLE: "1" };
    const resolutions: string[] = [];
    const spawnedEnvironments: Array<string | undefined> = [];
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const capturingSpawner = ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") {
        spawnedEnvironments.push(
          command.options.env?.GOAT_ISSUE_3079_LATE_HOST ??
            (command.options.extendEnv ? process.env.GOAT_ISSUE_3079_LATE_HOST : undefined),
        );
      }
      return spawner.spawn(command);
    });
    const original = process.env.GOAT_ISSUE_3079_LATE_HOST;
    yield* Effect.acquireRelease(
      Effect.sync(() => delete process.env.GOAT_ISSUE_3079_LATE_HOST),
      () =>
        Effect.sync(() => {
          if (original === undefined) delete process.env.GOAT_ISSUE_3079_LATE_HOST;
          else process.env.GOAT_ISSUE_3079_LATE_HOST = original;
        }),
    );
    const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
      cacheDir: process.cwd(),
      toolsDir: process.cwd(),
    });
    const instanceId = ProviderInstanceId.make("registry-session-environment");
    const adapter = yield* makeAcpRegistryAdapterV2({
      instanceId,
      settings: yield* decodeSettings({ source: "local", commandPath: "fake" }),
      environment: host,
      currentEnvironment: Effect.sync(() => host),
      selfInvocation: yield* resolveSelfInvocation(),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capturingSpawner),
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
        ...catalog,
        resolve: (_settings, cwd, env) =>
          Effect.sync(() => {
            resolutions.push(env?.PATH ?? "missing");
            return {
              distribution: "local" as const,
              spawn: {
                command: process.execPath,
                args: [
                  new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url)
                    .pathname,
                ],
                cwd,
                env: { ...env },
                shell: false,
              },
            };
          }),
      }),
    );
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const threadId = ThreadId.make("registry-session-environment");
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
    const providerThread = yield* first.ensureThread({ threadId, modelSelection, runtimePolicy });
    for (const ordinal of [1, 2]) {
      if (ordinal === 2) {
        host.PATH = "/new";
        host.GOAT_ISSUE_3079_LATE_HOST = "new";
        process.env.GOAT_ISSUE_3079_LATE_HOST = "new";
        yield* sessions.set(config("new"));
      }
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
    const second = yield* open("second");
    yield* second.ensureThread({ threadId, modelSelection, runtimePolicy });
    assert.deepEqual(resolutions, ["/old", "/new"]);
    assert.deepEqual(spawnedEnvironments, [undefined, undefined, "new"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected request")),
        ),
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
    Effect.scoped,
  ),
);
