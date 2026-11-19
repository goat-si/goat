import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2RuntimeInput,
} from "@goat/provider-acp/server/adapter";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { ACP_TEST_DRIVER, layerTest } from "./AcpAdapterV2.host.testkit.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { bundledMockAgentPath, makeMockRuntime } from "./AcpMockRuntime.testkit.ts";

it.effect("returns opaque native permission IDs verbatim after approval", () =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const selfInvocation = yield* resolveSelfInvocation();
    const mockAgentPath = yield* bundledMockAgentPath;
    type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
    let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
    let runtimeInput: AcpAdapterV2RuntimeInput | undefined;
    const makeRuntime = makeMockRuntime({
      childProcessSpawner,
      mockAgentPath,
      environment: { GOAT_ACP_HANG_PROMPT_FOREVER: "1" },
      wrapRuntime: (runtime) => ({
        ...runtime,
        handleRequestPermission: (handler) =>
          Effect.sync(() => {
            requestPermission = handler;
          }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
      }),
    });
    const instanceId = ProviderInstanceId.make("acp-test-opaque-permission-id");
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      flavor: {
        driver: ACP_TEST_DRIVER,
        capabilities: AcpProviderCapabilitiesV2,
        interruptPromptOnCancel: true,
        makeRuntime: (input) =>
          Effect.sync(() => {
            runtimeInput = input;
          }).pipe(Effect.andThen(makeRuntime(input))),
      },
      selfInvocation,
    });
    const threadId = ThreadId.make("thread-acp-opaque-permission-id");
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "approval-required",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-acp-opaque-permission-id"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy,
    });
    const turnFiber = yield* runtime
      .startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      )
      .pipe(Effect.forkScoped);
    if (requestPermission === undefined) {
      return yield* Effect.die("ACP runtime must register a permission handler");
    }

    const permissionFiber = yield* requestPermission(
      {
        sessionId: "mock-session-1",
        toolCall: {
          toolCallId: "unknown-permission-tool",
          title: "Unknown permission kind",
        },
        options: [{ optionId: " opaque-choice ", name: "Allow once", kind: "allow_once" }],
      },
      { requestId: "unknown-permission-request", method: "session/request_permission" },
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
    if (
      pending.type !== "runtime_request.updated" ||
      pending.runtimeRequest.providerTurnId === null
    ) {
      return yield* Effect.die("Expected an unknown ACP permission request");
    }
    const responseFiber = yield* runtime
      .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
      .pipe(Effect.forkScoped);
    const permission = yield* Fiber.join(permissionFiber);
    assert.equal(permission.outcome.outcome, "selected");
    if (runtimeInput?.onOutgoingResponse === undefined) {
      return yield* Effect.die("ACP runtime must expose native response acknowledgements");
    }
    yield* runtimeInput.onOutgoingResponse("unknown-permission-request");
    yield* Fiber.join(responseFiber);

    yield* runtime.interruptTurn({
      providerThread,
      providerTurnId: pending.runtimeRequest.providerTurnId,
    });
    yield* Fiber.join(turnFiber);
    assert.deepEqual(permission.outcome, { outcome: "selected", optionId: " opaque-choice " });
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
