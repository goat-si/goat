// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveCommandPath } from "@goat/shared/shell";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
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

it.live("runtime launches retain the environment captured at session open", () =>
  Effect.gen(function* () {
    const key = "GOAT_ACP_SNAPSHOT_LATE_VARIABLE";
    const original = process.env[key];
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }),
    );
    delete process.env[key];
    const first = { ...process.env };
    process.env[key] = "new-host-value";
    const second = { ...process.env };
    const observed: Array<string | null> = [];
    const path = yield* Path.Path;
    const agent = yield* path.fromFileUrl(
      new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
    );
    for (const environment of [first, first, second]) {
      const received = yield* Deferred.make<string>();
      yield* AcpSessionRuntime.make({
        spawn: {
          command: process.execPath,
          args: [
            "-e",
            `console.error(JSON.stringify(process.env.${key} ?? null)); import(process.argv[1])`,
            agent,
          ],
          env: environment,
          shell: false,
        },
        sessionEnvironment: environment,
        cwd: process.cwd(),
        clientInfo: { name: "test", version: "1" },
        onStderr: (text) => Deferred.succeed(received, text).pipe(Effect.asVoid),
      });
      observed.push(JSON.parse((yield* Deferred.await(received)).trim()));
    }
    assert.deepEqual(observed, [null, null, "new-host-value"]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.live("new launches read host changes made after adapter creation", () =>
  Effect.gen(function* () {
    const key = "GOAT_ACP_LEGACY_LATE_VARIABLE";
    const original = process.env[key];
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }),
    );
    const path = yield* Path.Path;
    const agent = yield* path.fromFileUrl(
      new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
    );
    const observed: Array<string> = [];
    for (const optedIn of [false, true]) {
      delete process.env[key];
      const received = yield* Deferred.make<string>();
      const instanceId = ProviderInstanceId.make(`acp-late-${optedIn}`);
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        ...(optedIn
          ? {
              currentEnvironment: Effect.sync(() => ({
                ...process.env,
                INSTANCE_VALUE: "instance",
              })),
            }
          : {}),
        clientTerminals: { environment: { INSTANCE_VALUE: "instance" }, shellCommands: true },
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ProviderDriverKind.make(`acp-late-${optedIn}`),
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (input) =>
            AcpSessionRuntime.make({
              ...input,
              spawn: {
                command: process.execPath,
                args: [
                  "-e",
                  `console.error(JSON.stringify([process.env.${key} ?? null, process.env.INSTANCE_VALUE])); import(process.argv[1])`,
                  agent,
                ],
                cwd: input.cwd,
                env: {
                  ...(input.sessionEnvironment ?? { INSTANCE_VALUE: "instance" }),
                  GOAT_ACP_SESSION_LIFECYCLE: "1",
                },
                shell: false,
              },
              onStderr: (text) => Deferred.succeed(received, text).pipe(Effect.asVoid),
            }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const threadId = ThreadId.make(`thread-late-${optedIn}`);
      process.env[key] = "late";
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`session-${optedIn}`),
        modelSelection,
        runtimePolicy,
      });
      process.env[key] = "late";
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      observed.push((yield* Deferred.await(received)).trim());
    }
    assert.deepEqual(
      observed.map((value) => JSON.parse(value)),
      [
        ["late", "instance"],
        ["late", "instance"],
      ],
    );
  }).pipe(Effect.provide(layer), Effect.scoped),
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

it.live("plan extraction receives the environment and launch captured by its session", () =>
  Effect.gen(function* () {
    const host = { ...process.env, GOAT_PLAN_TEST_VALUE: "old" };
    const seen = yield* Deferred.make<unknown>();
    const instanceId = ProviderInstanceId.make("acp-plan-environment");
    const path = yield* Path.Path;
    const makeRuntime = makeMockRuntime({
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      mockAgentPath: yield* path.fromFileUrl(
        new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
      ),
      environment: { GOAT_ACP_EMIT_POST_SETTLE_MONITOR_FLOW: "1" },
    });
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      continuationRequests: { offer: () => Effect.void },
      currentEnvironment: Effect.sync(() => host),
      selfInvocation: yield* resolveSelfInvocation(),
      flavor: {
        driver: ProviderDriverKind.make("acp-plan-environment"),
        capabilities: AcpProviderCapabilitiesV2,
        enablePostSettleContinuation: true,
        resolveSessionLaunch: (environment) => Effect.succeed(environment.GOAT_PLAN_TEST_VALUE),
        makeRuntime,
        extractProposedPlanMarkdown: (...args) => {
          Deferred.doneUnsafe(seen, Effect.succeed(Reflect.get(args, "1")));
          return undefined;
        },
      },
    });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const threadId = ThreadId.make("thread-plan-environment");
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("plan"),
      modelSelection,
      runtimePolicy,
    });
    host.GOAT_PLAN_TEST_VALUE = "new";
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* session.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now: yield* DateTime.now,
        ordinal: 1,
      }),
    );
    yield* session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const context = (yield* Deferred.await(seen)) as
      | { environment?: NodeJS.ProcessEnv; launch?: unknown }
      | undefined;
    assert.deepEqual([context?.environment?.GOAT_PLAN_TEST_VALUE, context?.launch], ["old", "old"]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.live("resolves relative PATH from the workspace and launches with the session PATH", () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-acp-path-"))),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const bin = NodePath.join(workspace, "bin");
    const executable = NodePath.join(bin, "goat-acp-test-command");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const instanceId = ProviderInstanceId.make("acp-relative-path");
    const path = yield* Path.Path;
    const makeRuntime = makeMockRuntime({
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      mockAgentPath: yield* path.fromFileUrl(
        new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
      ),
    });
    const resolved: Array<unknown> = [];
    const launchPaths: Array<string | undefined> = [];
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      currentEnvironment: Effect.succeed({ ...process.env, PATH: "bin" }),
      selfInvocation: yield* resolveSelfInvocation(),
      flavor: {
        driver: ProviderDriverKind.make("acp-relative-path"),
        capabilities: AcpProviderCapabilitiesV2,
        resolveSessionLaunch: (environment, sessionEnvironment) => {
          launchPaths.push(sessionEnvironment?.PATH);
          return resolveCommandPath("goat-acp-test-command", { env: environment }).pipe(
            Effect.provide(NodeServices.layer),
          );
        },
        makeRuntime: (input) => {
          resolved.push(input.sessionLaunch);
          return makeRuntime(input);
        },
      },
    });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: workspace,
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const threadId = ThreadId.make("thread-relative-path");
    yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("relative-path"),
      modelSelection,
      runtimePolicy,
    });
    assert.deepEqual({ resolved, launchPaths }, { resolved: [executable], launchPaths: ["bin"] });
  }).pipe(Effect.provide(layer), Effect.scoped),
);

// Windows ignores empty PATH entries; on POSIX an empty entry names the current directory.
it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "an empty PATH entry finds the session's own executable before a later directory",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-acp-empty-"))),
        (directory) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const workspace = NodePath.join(root, "workspace");
      const bin = NodePath.join(root, "bin");
      for (const directory of [workspace, bin]) {
        NodeFS.mkdirSync(directory);
        NodeFS.writeFileSync(NodePath.join(directory, "goat-acp-test-command"), "#!/bin/sh\n", {
          mode: 0o755,
        });
      }
      const instanceId = ProviderInstanceId.make("acp-empty-path");
      const path = yield* Path.Path;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        mockAgentPath: yield* path.fromFileUrl(
          new URL("../../../../apps/server/scripts/acp-mock-agent.ts", import.meta.url),
        ),
      });
      const resolved: Array<unknown> = [];
      const launchPaths: Array<string | undefined> = [];
      for (const sessionPath of [`:${bin}`, `${bin}:`, `/nonexistent::${bin}`]) {
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          currentEnvironment: Effect.succeed({ ...process.env, PATH: sessionPath }),
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ProviderDriverKind.make("acp-empty-path"),
            capabilities: AcpProviderCapabilitiesV2,
            resolveSessionLaunch: (environment, sessionEnvironment) => {
              launchPaths.push(sessionEnvironment?.PATH);
              return resolveCommandPath("goat-acp-test-command", { env: environment }).pipe(
                Effect.provide(NodeServices.layer),
              );
            },
            makeRuntime: (input) => {
              resolved.push(input.sessionLaunch);
              return makeRuntime(input);
            },
          },
        });
        yield* adapter.openSession({
          threadId: ThreadId.make("thread-empty-path"),
          providerSessionId: ProviderSessionId.make("empty-path"),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: workspace,
          }),
        });
      }
      const own = NodePath.join(workspace, "goat-acp-test-command");
      assert.deepEqual(
        { resolved, launchPaths },
        {
          resolved: [own, NodePath.join(bin, "goat-acp-test-command"), own],
          launchPaths: [`:${bin}`, `${bin}:`, `/nonexistent::${bin}`],
        },
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
);
