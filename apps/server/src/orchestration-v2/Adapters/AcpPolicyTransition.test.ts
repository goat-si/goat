import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ACP_TEST_DRIVER, layerTest } from "./AcpAdapterV2.host.testkit.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { bundledMockAgentPath, makeMockRuntime } from "./AcpMockRuntime.testkit.ts";

it.effect.each(["runtime-mode", "approval-policy"] as const)(
  "tightens the session mode before the first tool permission after a %s change",
  (scenario) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const firstPrompt = yield* Deferred.make<string>();
      let currentMode = "auto";
      let promptCount = 0;
      let requestPermission:
        | Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["handleRequestPermission"]>[0]
        | undefined;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner: spawner,
        mockAgentPath: yield* bundledMockAgentPath,
        wrapRuntime: (runtime) => ({
          ...runtime,
          getModeState: Effect.sync(() => ({
            currentModeId: currentMode,
            availableModes: [
              { id: "auto", name: "auto" },
              { id: "ask", name: "ask" },
            ],
          })),
          setMode: (mode) =>
            Effect.sync(() => {
              currentMode = mode;
              return {};
            }),
          prompt: (payload, options) =>
            Effect.suspend(() => {
              promptCount++;
              return promptCount === 1
                ? runtime.prompt(payload, options)
                : Deferred.succeed(firstPrompt, currentMode).pipe(Effect.andThen(Effect.never));
            }),
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
        }),
      });
      const instanceId = ProviderInstanceId.make("acp-transition");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        currentEnvironment: Effect.succeed({ PATH: "", HOME: "/synthetic-home" }),
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          makeRuntime,
          lockSessionModeToPolicy: true,
          sessionModeForPolicy: (policy) =>
            policy.runtimeMode === "full-access" ||
            (policy.runtimeMode === "auto" && policy.approvalPolicy === undefined)
              ? "auto"
              : "ask",
        },
      });
      const threadId = ThreadId.make("acp-transition");
      const full = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: scenario === "runtime-mode" ? "full-access" : "auto",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const supervised = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        ...full,
        ...(scenario === "runtime-mode"
          ? { runtimeMode: "approval-required" as const }
          : { approvalPolicy: "on-request" }),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("acp-transition"),
        modelSelection,
        runtimePolicy: full,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: full,
      });
      const firstTerminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy: full,
          now: yield* DateTime.now,
        }),
      );
      yield* Fiber.join(firstTerminal);
      const turn = yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy: supervised,
            ordinal: 2,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkScoped);
      assert.equal(yield* Deferred.await(firstPrompt), "ask");
      if (requestPermission === undefined)
        return yield* Effect.die("permission handler was not registered");
      const permission = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: { toolCallId: "first-tool", title: "Run tool" },
          options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
        },
        { requestId: "first-tool-request", method: "session/request_permission" },
      ).pipe(Effect.forkScoped);
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      assert.equal(pending.type, "runtime_request.updated");
      yield* Fiber.interrupt(permission);
      yield* Fiber.interrupt(turn);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);
