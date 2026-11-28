import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime, bundledMockAgentPath } from "./AcpMockRuntime.testkit.ts";
import { layerTest, ACP_TEST_DRIVER } from "./AcpAdapterV2.host.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2RuntimeInput,
} from "@goat/provider-acp/server/adapter";

describe("ACP auto accept edits", () => {
  const startAutoAcceptEditsTurn = Effect.fn(function* (
    name: string,
    agentEnvironment?: (folders: {
      readonly workspace: string;
      readonly elsewhere: string;
    }) => Readonly<Record<string, string>>,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-acp-edit-cwd-" });
    const elsewhere = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-acp-edit-out-" });
    type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
    let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
    let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
    let runtimeInput: AcpAdapterV2RuntimeInput | undefined;
    const makeRuntime = makeMockRuntime({
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      mockAgentPath: yield* bundledMockAgentPath,
      environment: {
        GOAT_ACP_HANG_PROMPT_FOREVER: "1",
        ...agentEnvironment?.({ workspace, elsewhere }),
      },
      wrapRuntime: (runtime) => ({
        ...runtime,
        handleRequestPermission: (handler) =>
          Effect.sync(() => {
            requestPermission = handler;
          }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
        handleSessionUpdate: (handler) =>
          Effect.sync(() => {
            sessionUpdate = handler;
          }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
      }),
    });
    const instanceId = ProviderInstanceId.make(`acp-test-${name}`);
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
      selfInvocation: yield* resolveSelfInvocation(),
      clientTerminals: {},
    });
    const threadId = ThreadId.make(`thread-acp-${name}`);
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      cwd: workspace,
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-acp-${name}`),
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
    const acknowledge = runtimeInput?.onOutgoingResponse;
    if (
      requestPermission === undefined ||
      sessionUpdate === undefined ||
      acknowledge === undefined
    ) {
      return yield* Effect.die("ACP runtime must register its handlers");
    }
    const handleRequestPermission = requestPermission;
    const options = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ] as const;
    /** Sends an edit permission request and returns the fiber waiting on its answer. */
    const requestEdit = (
      toolCallId: string,
      request: { readonly sessionId?: string; readonly target?: string } = {},
    ) =>
      handleRequestPermission(
        {
          sessionId: request.sessionId ?? "mock-session-1",
          toolCall: {
            toolCallId,
            title: "Edit file",
            kind: "edit",
            ...(request.target === undefined ? {} : { locations: [{ path: request.target }] }),
          },
          options,
        },
        { requestId: `${toolCallId}-request`, method: "session/request_permission" },
      ).pipe(Effect.forkScoped);
    /** Declines the approval the adapter raised and ends the turn. */
    const declinePendingAndStop = Effect.fn(function* (
      requestId: string,
      fiber: Effect.Success<ReturnType<typeof requestEdit>>,
    ) {
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
        return yield* Effect.die("Expected an ACP approval request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "decline" })
        .pipe(Effect.forkScoped);
      const response = yield* Fiber.join(fiber);
      yield* acknowledge(requestId);
      yield* Fiber.join(responseFiber);
      assert.deepEqual(response.outcome, { outcome: "selected", optionId: "reject-once" });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: pending.runtimeRequest.providerTurnId,
      });
      yield* Fiber.join(turnFiber);
    });
    return {
      path,
      workspace,
      elsewhere,
      sessionUpdate,
      acknowledge,
      requestEdit,
      declinePendingAndStop,
      runtime,
      providerThread,
      turnFiber,
    };
  });

  it.effect("auto-accepts an edit inside the thread's folder and asks about one outside it", () =>
    Effect.gen(function* () {
      const turn = yield* startAutoAcceptEditsTurn("edit-folder");
      const inside = yield* turn
        .requestEdit("edit-inside", { target: turn.path.join(turn.workspace, "src", "a.ts") })
        .pipe(Effect.flatMap(Fiber.join));
      yield* turn.acknowledge("edit-inside-request");
      assert.deepEqual(inside.outcome, { outcome: "selected", optionId: "allow-once" });

      const outsideFiber = yield* turn.requestEdit("edit-outside", {
        target: turn.path.join(turn.elsewhere, "b.ts"),
      });
      yield* turn.declinePendingAndStop("edit-outside-request", outsideFiber);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "asks about an edit without a path from a session that did not start its tool call",
    () =>
      Effect.gen(function* () {
        const turn = yield* startAutoAcceptEditsTurn("edit-other-session");
        // The first request waits for the turn, so the tool call below lands in it.
        const first = yield* turn
          .requestEdit("edit-first", { target: turn.path.join(turn.workspace, "src", "a.ts") })
          .pipe(Effect.flatMap(Fiber.join));
        yield* turn.acknowledge("edit-first-request");
        assert.deepEqual(first.outcome, { outcome: "selected", optionId: "allow-once" });
        yield* turn.sessionUpdate({
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "edit-shared",
            title: "Edit file",
            kind: "edit",
            status: "pending",
            locations: [{ path: turn.path.join(turn.workspace, "src", "b.ts") }],
          },
        });

        // The session that started the tool call may name it by id alone.
        const own = yield* turn.requestEdit("edit-shared").pipe(Effect.flatMap(Fiber.join));
        yield* turn.acknowledge("edit-shared-request");
        assert.deepEqual(own.outcome, { outcome: "selected", optionId: "allow-once" });

        const otherFiber = yield* turn.requestEdit("edit-shared", { sessionId: "mock-session-2" });
        yield* turn.declinePendingAndStop("edit-shared-request", otherFiber);
      }).pipe(Effect.provide(layerTest)),
  );

  const editNamedByIdAsks = (
    name: string,
    updates: (turn: {
      readonly inside: string;
      readonly outside: string;
    }) => ReadonlyArray<Record<string, unknown>>,
  ) =>
    Effect.gen(function* () {
      const turn = yield* startAutoAcceptEditsTurn(name);
      const inside = turn.path.join(turn.workspace, "src", "a.ts");
      // The first request waits for the turn, so the tool call below lands in it.
      const first = yield* turn
        .requestEdit("edit-first", { target: inside })
        .pipe(Effect.flatMap(Fiber.join));
      yield* turn.acknowledge("edit-first-request");
      assert.deepEqual(first.outcome, { outcome: "selected", optionId: "allow-once" });
      for (const update of updates({ inside, outside: turn.path.join(turn.elsewhere, "b.ts") })) {
        yield* turn.sessionUpdate({
          sessionId: "mock-session-1",
          update: { toolCallId: "edit-tracked", ...update },
        } as EffectAcpSchema.SessionNotification);
      }
      const fiber = yield* turn.requestEdit("edit-tracked");
      yield* turn.declinePendingAndStop("edit-tracked-request", fiber);
    }).pipe(Effect.provide(layerTest));

  it.effect(
    "asks about an edit named by id whose tool call named another folder before an update",
    () =>
      editNamedByIdAsks("edit-replaced-path", ({ inside, outside }) => [
        {
          sessionUpdate: "tool_call",
          title: "Edit file",
          kind: "edit",
          status: "pending",
          locations: [{ path: outside }],
        },
        { sessionUpdate: "tool_call_update", locations: [{ path: inside }] },
      ]),
  );

  it.effect("asks about an edit named by id whose tool call left one location blank", () =>
    editNamedByIdAsks("edit-blank-path", ({ inside }) => [
      {
        sessionUpdate: "tool_call",
        title: "Edit file",
        kind: "edit",
        status: "pending",
        locations: [{ path: inside }, { path: " " }],
      },
    ]),
  );

  it.effect("asks about an edit named by id whose content chunk changes another folder", () =>
    editNamedByIdAsks("edit-chunk-path", ({ inside, outside }) => [
      {
        sessionUpdate: "tool_call",
        title: "Edit file",
        kind: "edit",
        status: "pending",
        locations: [{ path: inside }],
      },
      {
        sessionUpdate: "tool_call_content_chunk",
        content: { type: "diff", changes: [{ operation: "modify", path: outside }] },
      },
    ]),
  );

  it.effect("auto-accepts an edit named by id whose updates from the agent were all read", () =>
    Effect.gen(function* () {
      const turn = yield* startAutoAcceptEditsTurn("edit-read-updates", ({ workspace }) => ({
        GOAT_ACP_EMIT_EDIT_UPDATES_THEN_REQUEST: JSON.stringify([
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "edit-tracked",
            title: "Edit file",
            kind: "edit",
            status: "pending",
            locations: [{ path: `${workspace}/src/a.ts` }],
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "edit-tracked",
            locations: [{ path: `${workspace}/src/a.ts`, line: 3 }],
          },
        ]),
      }));
      const answerOrRequest = Option.getOrThrow(
        yield* turn.runtime.events.pipe(
          Stream.filter(
            (event) =>
              (event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending") ||
              (event.type === "turn_item.updated" &&
                event.turnItem.nativeItemRef?.nativeId?.includes("edit-answered:") === true),
          ),
          Stream.runHead,
        ),
      );
      if (
        answerOrRequest.type !== "turn_item.updated" ||
        answerOrRequest.turnItem.providerTurnId === null
      ) {
        return assert.fail("The edit became an approval request");
      }
      assert.include(answerOrRequest.turnItem.nativeItemRef?.nativeId, "edit-answered:allow");
      yield* turn.runtime.interruptTurn({
        providerThread: turn.providerThread,
        providerTurnId: answerOrRequest.turnItem.providerTurnId,
      });
      yield* Fiber.join(turn.turnFiber);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    {
      update: "one location is not a path",
      later: (inside: string) => ({
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-tracked",
        locations: [{ path: inside }, { path: 7 }],
      }),
    },
    {
      update: "a line number is not a whole number",
      later: (inside: string) => ({
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-tracked",
        locations: [{ path: inside, line: -1 }],
      }),
    },
    {
      update: "tool call id cannot be read",
      later: (inside: string) => ({
        sessionUpdate: "tool_call_update",
        toolCallId: 7,
        locations: [{ path: inside }],
      }),
    },
  ])(
    "asks about an edit named by id after an update the agent sent could not be read: $update",
    ({ later }) =>
      Effect.gen(function* () {
        // The agent process writes these to its output, so they pass through protocol decoding.
        const turn = yield* startAutoAcceptEditsTurn("edit-unread-update", ({ workspace }) => {
          const inside = `${workspace}/src/a.ts`;
          return {
            GOAT_ACP_EMIT_EDIT_UPDATES_THEN_REQUEST: JSON.stringify([
              {
                sessionUpdate: "tool_call_update",
                toolCallId: "edit-tracked",
                title: "Edit file",
                kind: "edit",
                status: "pending",
                locations: [{ path: inside }],
              },
              later(inside),
            ]),
          };
        });
        const answerOrRequest = Option.getOrThrow(
          yield* turn.runtime.events.pipe(
            Stream.filter(
              (event) =>
                (event.type === "runtime_request.updated" &&
                  event.runtimeRequest.status === "pending") ||
                (event.type === "turn_item.updated" &&
                  event.turnItem.nativeItemRef?.nativeId?.includes("edit-answered:") === true),
            ),
            Stream.runHead,
          ),
        );
        if (
          answerOrRequest.type !== "runtime_request.updated" ||
          answerOrRequest.runtimeRequest.providerTurnId === null
        ) {
          return assert.fail("The edit was answered without an approval request");
        }
        yield* turn.runtime.respondToRuntimeRequest({
          requestId: answerOrRequest.runtimeRequest.id,
          decision: "decline",
        });
        yield* turn.runtime.interruptTurn({
          providerThread: turn.providerThread,
          providerTurnId: answerOrRequest.runtimeRequest.providerTurnId,
        });
        yield* Fiber.join(turn.turnFiber);
      }).pipe(Effect.provide(layerTest)),
  );
});
