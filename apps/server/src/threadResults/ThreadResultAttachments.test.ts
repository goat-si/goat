import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ThreadResultService, layer } from "./ThreadResultService.ts";

it.effect("reopens both attempts' evidence by run ID and rejects foreign references", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const worker = ThreadId.make("worker");
    const runId = RunId.make("release-check");
    const messageId = MessageId.make("worker-message");
    const ids = ["first-attachment", "second-attachment"] as const;
    const attachments = ids.map((id) => ({
      id,
      name: "junit.xml",
      type: "file" as const,
      mimeType: "application/xml",
      sizeBytes: 42,
    }));
    const open = (attemptId: RunAttemptId) =>
      layer.pipe(
        Layer.provide(
          Layer.mock(Threads.ThreadManagementService)({
            getThreadRecords: () =>
              Effect.succeed({
                thread: { id: worker, branch: null, pullRequests: [] },
                runs: [{ id: runId, status: "running", activeAttemptId: attemptId }],
              } as never),
            getMessagesById: (id, messages) =>
              Effect.succeed(
                new Map(
                  id === worker && messages.includes(messageId)
                    ? [
                        [
                          messageId,
                          {
                            id: messageId,
                            threadId: worker,
                            runId,
                            nodeId: null,
                            createdBy: "user",
                            creationSource: "web",
                            role: "user",
                            text: "",
                            streaming: false,
                            createdAt: DateTime.makeUnsafe(0),
                            updatedAt: DateTime.makeUnsafe(0),
                            attachments,
                          } satisfies OrchestrationV2ConversationMessage,
                        ],
                      ]
                    : [],
                ),
              ),
          }),
        ),
        Layer.provide(Sqlite.layerFromPath(directory + "/results.sqlite")),
      );
    const first = RunAttemptId.make("first");
    const second = RunAttemptId.make("retry");
    const record = (attemptId: RunAttemptId, attachmentId: string) =>
      Effect.flatMap(ThreadResultService, (service) =>
        service.report(worker, {
          runId,
          expectedAttemptId: attemptId,
          outcome: "succeeded",
          attachmentRefs: [{ messageId, attachmentId }],
        }),
      );
    yield* record(first, ids[0]).pipe(Effect.provide(open(first)));
    yield* Effect.gen(function* () {
      assert.equal((yield* Effect.flip(record(first, ids[0]))).reason, "attachment_invalid");
      assert.equal(
        (yield* Effect.flip(record(second, "other-threads-file"))).reason,
        "attachment_invalid",
      );
      yield* record(second, ids[1]);
      yield* record(second, ids[1]);
      const service = yield* ThreadResultService;
      yield* service.report(worker, { runId, outcome: "succeeded", summary: "Done" });
    }).pipe(Effect.provide(open(second)));
    const result = yield* Effect.flatMap(ThreadResultService, (s) => s.forRun(worker, runId)).pipe(
      Effect.provide(open(second)),
    );
    assert.deepStrictEqual(result?.attachments, [
      { messageId, attachmentId: ids[0], attemptId: first, name: "junit.xml" },
      { messageId, attachmentId: ids[1], attemptId: second, name: "junit.xml" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
