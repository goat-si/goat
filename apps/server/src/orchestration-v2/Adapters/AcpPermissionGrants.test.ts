import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2RuntimeInput,
} from "@goat/provider-acp/server/adapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DocumentText from "../../provider/DocumentText.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime, bundledMockAgentPath } from "./AcpMockRuntime.testkit.ts";

const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
);
const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");

describe("AcpAdapterV2", () => {
  it.effect.each([
    {
      label: "grants an ID-only execute approval its tracked command",
      kind: "execute",
      granted: true,
    },
    {
      label: "does not grant execution to an ID-only approval of another tool",
      kind: "other",
      granted: false,
    },
    {
      label: "grants an explicit execute approval",
      kind: "execute",
      requestKind: "execute",
      granted: true,
    },
    {
      label: "does not grant execution to an approved mode switch",
      kind: "execute",
      requestKind: "switch_mode",
      granted: false,
    },
    {
      label: "does not grant execution to an approved explicit other tool",
      kind: "other",
      requestKind: "other",
      granted: false,
    },
  ] as const)("$label", ({ kind, granted, ...testCase }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
      let createTerminal: Parameters<RuntimeService["handleCreateTerminal"]>[0] | undefined;
      let runtimeInput: AcpAdapterV2RuntimeInput | undefined;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: { GOAT_ACP_EMIT_TRACKED_TOOL_CALL_KIND_THEN_HANG: kind },
        wrapRuntime: (runtime) => ({
          ...runtime,
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
          handleCreateTerminal: (handler) =>
            Effect.sync(() => {
              createTerminal = handler;
            }).pipe(Effect.andThen(runtime.handleCreateTerminal(handler))),
        }),
      });
      const instanceId = ProviderInstanceId.make("acp-test-id-only-permission");
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
        clientTerminals: {},
      });
      const threadId = ThreadId.make("thread-acp-id-only-permission");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-id-only-permission"),
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
      if (requestPermission === undefined || createTerminal === undefined) {
        return yield* Effect.die("ACP runtime must register permission and terminal handlers");
      }
      yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "tracked-tool-call",
        ),
        Stream.runHead,
      );

      const permissionFiber = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: {
            toolCallId: "tracked-tool-call",
            ...("requestKind" in testCase ? { kind: testCase.requestKind } : {}),
          },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        },
        { requestId: "id-only-permission-request", method: "session/request_permission" },
      ).pipe(Effect.forkScoped);
      const approvalEvent = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
          ),
          Stream.runHead,
        ),
      );
      if (
        approvalEvent.type !== "turn_item.updated" ||
        approvalEvent.turnItem.type !== "approval_request" ||
        approvalEvent.turnItem.providerTurnId === null
      ) {
        return yield* Effect.die("Expected an ACP approval request");
      }
      const approval = approvalEvent.turnItem;
      const providerTurnId = approvalEvent.turnItem.providerTurnId;
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: approval.requestId, decision: "accept" })
        .pipe(Effect.forkScoped);
      assert.equal((yield* Fiber.join(permissionFiber)).outcome.outcome, "selected");
      if (runtimeInput?.onOutgoingResponse === undefined) {
        return yield* Effect.die("ACP runtime must expose native response acknowledgements");
      }
      yield* runtimeInput.onOutgoingResponse("id-only-permission-request");
      yield* Fiber.join(responseFiber);

      const terminalExit = yield* createTerminal(
        {
          sessionId: "mock-session-1",
          command: process.execPath,
          args: ["-e", ""],
        },
        { requestId: "id-only-permission-terminal", method: "terminal/create" },
      ).pipe(Effect.exit);
      assert.deepEqual(
        {
          prompt: approval.prompt,
          requestKind: approval.requestKind,
          terminalCreated: Exit.isSuccess(terminalExit),
        },
        { prompt: "git status", requestKind: "command", terminalCreated: granted },
      );

      yield* runtime.interruptTurn({ providerThread, providerTurnId });
      yield* Fiber.join(turnFiber);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
