import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { dispatchFailure } from "../mcp/threadAccess.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { WorktreeSendCheck } from "./goat/WorktreeSendCheck.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

const threadId = ThreadId.make("thread:worktree-send");
const projectId = ProjectId.make("project:worktree-send");
const REFUSAL =
  "The worktree of thread thread:worktree-send at /elsewhere/feature is missing, and GOAT can't recreate it: it is outside GOAT's worktrees folder. Put the folder back at that path, or move the thread to another worktree.";

const layerFor = (refusal: string | undefined, dispatched: Array<string>) =>
  ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        restartContinuationPending: () => Effect.succeed(false),
        awaitRestartContinuation: () => Effect.never,
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              id: threadId,
              projectId,
              deletedAt: null,
              worktreePath: "/elsewhere/feature",
              branch: "feature",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
            },
          } as unknown as OrchestrationV2ThreadProjection),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command.commandId);
            return { sequence: 1, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        WorktreeSendCheck,
        WorktreeSendCheck.of({ refusal: () => Effect.succeed(refusal) }),
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(
      CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
    ),
  );

const send = (
  commandId: string,
  mode: "queue_after_active" | "steer_active" = "queue_after_active",
) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(commandId),
      threadId,
      messageId: MessageId.make(`message:${commandId}`),
      text: "Continue",
      attachments: [],
      dispatchMode:
        mode === "steer_active"
          ? { type: mode, targetRunId: RunId.make("run:worktree-send") }
          : { type: mode },
      createdBy: "agent",
      creationSource: "mcp",
    });
  });

it.effect(
  "a send to a thread whose missing worktree GOAT cannot restore is refused before it is stored",
  () => {
    const dispatched: Array<string> = [];
    return Effect.gen(function* () {
      const error = yield* Effect.flip(send("send:unrestorable"));
      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementWorktreeUnrestorableError,
      );
      expect(dispatched).toEqual([]);
      const message = `${REFUSAL} The message was not sent.`;
      // An agent's MCP send fails with this code and text.
      expect(dispatchFailure(error as never)).toMatchObject({
        code: "thread_not_sendable",
        message,
      });
      // Clients, older ones included, show the text the dispatch error carries.
      expect(userFacingDispatchErrorMessage(error)).toBe(message);
    }).pipe(Effect.provide(layerFor(REFUSAL, dispatched)));
  },
);

it.effect("a live steer starts no turn and is not refused", () => {
  const dispatched: Array<string> = [];
  return Effect.gen(function* () {
    yield* send("send:steer", "steer_active");
    expect(dispatched).toEqual(["send:steer"]);
  }).pipe(Effect.provide(layerFor(REFUSAL, dispatched)));
});

it.effect(
  "a send the check passes (present, or restorable at turn start) is dispatched as before",
  () => {
    const dispatched: Array<string> = [];
    return Effect.gen(function* () {
      yield* send("send:restorable");
      expect(dispatched).toEqual(["send:restorable"]);
    }).pipe(Effect.provide(layerFor(undefined, dispatched)));
  },
);
