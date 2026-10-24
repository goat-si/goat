import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, type OrchestrationV2ServerCommand, ThreadId } from "@goat/contracts";
import { withTurnCapabilities } from "@goat/shared/turnCapabilities";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:send-context");
const shell = liveThreadShell(threadId);

it.effect(
  "a send hands its capability chips to message.dispatch, and a plain send hands none",
  () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const layer = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            restartContinuationPending: () => Effect.succeed(false),
            awaitRestartContinuation: () => Effect.never,
            getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
            getThreadShell: () => Effect.succeed(shell),
            getThreadEventSequence: () => Effect.succeed(0),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 1, storedEvents: [] };
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        const send = (index: number, message: ReturnType<typeof withTurnCapabilities>) =>
          service
            .sendToThread({
              projectId: shell.projectId,
              commandId: CommandId.make(`send-context:${index}`),
              threadId,
              messageId: MessageId.make(`send-context:${index}`),
              ...message,
              attachments: [],
              mode: "queue",
              createdBy: "agent",
              creationSource: "mcp",
            })
            // Only what reached the orchestrator matters; delivery reads need a real projection.
            .pipe(Effect.ignore);
        yield* send(1, withTurnCapabilities({ text: "Check the page" }, ["browser"]));
        yield* send(2, withTurnCapabilities({ text: "Plain" }, []));
      }).pipe(Effect.provide(layer));
      const messages = dispatched.flatMap((command) =>
        command.type === "message.dispatch" ? [command] : [],
      );
      assert.equal(messages.length, 2);
      assert.deepEqual(
        messages[0]?.context?.records.map((record) => record.kind),
        ["capability"],
      );
      assert.isUndefined(messages[1]?.context);
    }),
);
