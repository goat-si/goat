import { CommandId, type OrchestrationV2Run, type ProjectId, type ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import type * as Orchestrator from "./Orchestrator.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";

export const settleAfterRun = Effect.fn("orchestrationV2.threadManagement.settleAfterFollowUps")(
  function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly run: OrchestrationV2Run;
    readonly timeoutMs: number;
    readonly requestedAt?: DateTime.Utc;
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly records: ThreadManagementServiceShape["getProjectThreadRecords"];
    readonly dispatch: ThreadManagementServiceShape["dispatch"];
  }) {
    const { run, orchestrator } = input;
    const requestedAt = input.requestedAt ?? (yield* DateTime.now);
    const afterSequence = yield* orchestrator.getThreadEventSequence(input.threadId);
    const trySettle = Effect.gen(function* () {
      const sequence = yield* orchestrator.getThreadEventSequence(input.threadId);
      const records = yield* input.records(input, ["runs"]);
      if (
        threadPullRequestsOf(records.thread).some(
          (link) =>
            link.watch !== undefined &&
            !DateTime.isLessThan(DateTime.makeUnsafe(link.watch.startedAt), requestedAt),
        )
      )
        return true;
      const following = records.runs.filter((candidate) => candidate.ordinal > run.ordinal);
      if (following.length > 0) {
        const { messages } = yield* input.records(input, ["messages"], {
          messageRunIds: following.map((candidate) => candidate.id),
          messageRoles: ["user"],
        });
        const automatic = new Set(
          messages
            .filter(
              (message) =>
                message.role === "user" &&
                (message.notification !== undefined || message.delegatedCompletion !== undefined),
            )
            .map((message) => message.id),
        );
        if (
          messages.some((message) => !automatic.has(message.id)) ||
          following.some((candidate) => !automatic.has(candidate.userMessageId))
        )
          return true;
        if (
          following.some((candidate) =>
            candidate.status === "queued"
              ? candidate.queueHeld !== true
              : !["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
                  candidate.status,
                ),
          )
        )
          return false;
        if (
          following.some(
            (candidate) => candidate.status !== "queued" && candidate.status !== "completed",
          )
        )
          return true;
      }
      const latest = records.runs.reduce<OrchestrationV2Run | undefined>(
        (current, candidate) =>
          current === undefined || candidate.ordinal > current.ordinal ? candidate : current,
        undefined,
      );
      if (latest === undefined) return true;
      return yield* input
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`server:settle-after-run:${run.id}:${sequence}`),
          threadId: input.threadId,
          expectedLatestRunId: latest.id,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            OrchestratorDispatchError: () => Effect.succeed(false),
            OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed(false),
          }),
        );
    });
    yield* Stream.fromEffect(trySettle).pipe(
      Stream.concat(
        orchestrator
          .streamStoredEventsFrom({
            threadId: input.threadId,
            afterSequence,
            eventType: "run.updated",
          })
          .pipe(Stream.mapEffect(() => trySettle)),
      ),
      Stream.filter((done) => done),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(input.timeoutMs)),
    );
  },
);

export const make = (services: {
  readonly timeoutMs: number;
  readonly waitForThread: ThreadManagementServiceShape["waitForThread"];
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly records: ThreadManagementServiceShape["getProjectThreadRecords"];
  readonly dispatch: ThreadManagementServiceShape["dispatch"];
}): ThreadManagementServiceShape["settleAfterRun"] =>
  Effect.fn("orchestrationV2.threadManagement.settleAfterRun")(function* (input) {
    const requestedAt = yield* DateTime.now;
    const { run } = yield* services.waitForThread({
      ...input,
      timeoutMs: services.timeoutMs,
      releaseOnPendingQuestion: false,
    });
    if (run?.status !== "completed") return;
    yield* settleAfterRun({ ...services, ...input, run, requestedAt });
  });
