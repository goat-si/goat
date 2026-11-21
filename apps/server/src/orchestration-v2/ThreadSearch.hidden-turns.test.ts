import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import { at, createProject, layerTest, message, thread } from "./ThreadSearch.testkit.ts";

it.layer(layerTest)("ThreadSearch hidden turns", (it) => {
  const providerInstanceId = ProviderInstanceId.make("codex");
  it.effect("leaves out answers in their question card and turns the thread hides", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:answers");
      const asked = ThreadId.make("thread:answers");
      const rewound = ThreadId.make("thread:rewound");
      const queued = ThreadId.make("thread:queued");
      const stopped = ThreadId.make("thread:stopped");
      const recovered = ThreadId.make("thread:recovered");
      const run = (owner: ThreadId, status: "rolled_back" | "cancelled") =>
        ({
          id: EventId.make(`run:${owner}`),
          type: "run.created",
          threadId: owner,
          runId: RunId.make(`run:${owner}`),
          nodeId: NodeId.make(`node:${owner}`),
          providerInstanceId,
          occurredAt: at(2),
          payload: {
            id: RunId.make(`run:${owner}`),
            threadId: owner,
            ordinal: 1,
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
            providerThreadId: null,
            userMessageId: MessageId.make(`${owner}:prompt`),
            rootNodeId: NodeId.make(`node:${owner}`),
            activeAttemptId: null,
            status,
            requestedAt: at(1),
            startedAt: at(1),
            completedAt: at(2),
            checkpointId: null,
            contextHandoffId: null,
          },
        }) satisfies OrchestrationV2DomainEvent;
      const shown = (owner: ThreadId, id: string, as: "turn_start" | "queued_turn" | "reply") =>
        ({
          id: EventId.make(`item:${id}`),
          type: "turn-item.updated",
          threadId: owner,
          occurredAt: at(2),
          payload: {
            id: TurnItemId.make(id),
            threadId: owner,
            runId: RunId.make(`run:${owner}`),
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: at(1),
            completedAt: at(1),
            updatedAt: at(1),
            messageId: MessageId.make(id),
            text: "",
            ...(as === "reply"
              ? { type: "assistant_message", streaming: false }
              : {
                  type: "user_message",
                  inputIntent: as,
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                }),
          },
        }) satisfies OrchestrationV2DomainEvent;
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(asked, project),
          message(asked, "async-answer:request-1", "user", "use the albatross drive"),
          thread(rewound, project),
          run(rewound, "rolled_back"),
          message(rewound, "rewound-reply", "assistant", "the albatross drive is ready", {
            runId: RunId.make(`run:${rewound}`),
          }),
          thread(queued, project),
          run(queued, "cancelled"),
          message(queued, "queued-prompt", "user", "then mount the albatross drive", {
            runId: RunId.make(`run:${queued}`),
          }),
          // A queued prompt usually has no item; an edited one has a queued item.
          message(queued, "requeued-prompt", "user", "then eject the albatross drive", {
            runId: RunId.make(`run:${queued}`),
          }),
          shown(queued, "requeued-prompt", "queued_turn"),
          // A stopped turn keeps its prompt and whatever the agent already said.
          thread(stopped, project),
          run(stopped, "cancelled"),
          message(stopped, "stopped-prompt", "user", "format the albatross drive", {
            runId: RunId.make(`run:${stopped}`),
          }),
          shown(stopped, "stopped-prompt", "turn_start"),
          thread(recovered, project),
          run(recovered, "cancelled"),
          message(recovered, "recovered-reply", "assistant", "the albatross drive is formatted", {
            runId: RunId.make(`run:${recovered}`),
          }),
          shown(recovered, "recovered-reply", "reply"),
        ],
        projections.apply,
        { discard: true },
      );
      assert.deepEqual(
        (yield* search.search({ query: "albatross" })).matches
          .map((match) => match.messageId)
          .sort(),
        [MessageId.make("recovered-reply"), MessageId.make("stopped-prompt")],
      );
    }),
  );
});
