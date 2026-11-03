import { type ChannelTask, ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  type DispatchModeRefusal,
  DispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { requesterForDispatch } from "./channelDispatchAuthority.ts";
import { refuseForward } from "./channelForwardRefusal.ts";
import { turnSteerIdsFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";

type AskRequester = (
  stored: ChannelLedger.ChannelStoredTask,
  text: string,
  owner: string,
  options?: { readonly clearPendingAnswer?: boolean; readonly choices?: ReadonlyArray<string> },
) => Effect.Effect<ChannelTask | undefined, ChannelLedger.ChannelLedgerError>;

export const makeForwardFollowUp = Effect.fn("channel.makeForwardFollowUp")(function* (
  askRequester: AskRequester,
) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const slackSettings = yield* SlackChannelSettings.SlackChannelSettings;
  const forwardFollowUp = Effect.fn("channel.forwardFollowUp")(function* (
    pending: ChannelLedger.ChannelPendingEvent,
    event: Extract<ChannelLedger.ChannelPendingEvent["event"], { type: "task.followup.received" }>,
    owner: string,
  ) {
    const stored = yield* ledger.getTask(event.taskId);
    const worker = stored?.task.worker;
    const target = stored?.task.target;
    // Work that was stopped, finished, or restarted as a new generation never gets an old
    // follow-up: sending it would start a run nothing reports on.
    if (
      stored === undefined ||
      worker === undefined ||
      target === undefined ||
      (stored.task.status !== "running" && stored.task.status !== "waiting_input") ||
      stored.task.generation !== event.payload.generation
    ) {
      yield* ledger.completeForward({ owner, sequence: pending.sequence });
      return;
    }
    // In order per task: a later follow-up never overtakes an earlier one still waiting.
    if (
      yield* ledger.hasEarlierPendingForward({
        taskId: event.taskId,
        sequence: pending.sequence,
      })
    ) {
      return;
    }
    // A person stopped the worker's run in GOAT after this follow-up was recorded. Sending it
    // would start the worker again; instead the follow-up is dropped and the fence lifted, so
    // reconciliation records the stop as it does for any stopped run.
    const records = yield* threads.getThreadRecords(worker.threadId, ["runs"]).pipe(Effect.option);
    const newest = Option.match(records, {
      onNone: () => undefined,
      onSome: (value) => value.runs.toSorted((left, right) => left.ordinal - right.ordinal).at(-1),
    });
    if (newest?.status === "cancelled") {
      const latest = (yield* ledger.getTask(event.taskId)) ?? stored;
      if (latest.pendingAnswerMessageId !== undefined) {
        const lifted = yield* commitTransition(
          ledger,
          latest,
          { type: "task.worker.bound", payload: { worker: { ...worker, runId: newest.id } } },
          { owner, pendingAnswerMessageId: null },
        );
        if (lifted === undefined) return;
      }
      yield* ledger.completeForward({ owner, sequence: pending.sequence });
      return;
    }
    const requester = yield* requesterForDispatch(stored.task).pipe(
      Effect.provideService(ChannelLedger.ChannelLedger, ledger),
      Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
    );
    let acceptedRun = undefined;
    if (requester === undefined) {
      const projection = yield* threads
        .getThreadRecords(worker.threadId, ["messages", "runs"])
        .pipe(Effect.option);
      if (Option.isNone(projection)) return;
      const ids = [
        turnSteerIdsFor(event.payload.inputId, "first").messageId,
        turnSteerIdsFor(event.payload.inputId, "queued").messageId,
      ];
      const message = projection.value.messages.find((candidate) => ids.includes(candidate.id));
      acceptedRun = projection.value.runs.find(
        (run) =>
          ids.includes(run.userMessageId) || (message !== undefined && run.id === message.runId),
      );
      if (message !== undefined && acceptedRun === undefined) return;
      if (acceptedRun === undefined) {
        yield* refuseForward(
          ledger,
          stored,
          "The requester’s permission changed; your follow-up was not sent. Open the thread in GOAT.",
          owner,
          pending.sequence,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ChannelLedger.ChannelLedgerError({
                reason: "persistence",
                detail: "Could not record forward refusal.",
                cause,
              }),
          ),
        );
        return;
      }
    }
    const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
    const send = (attempt: "first" | "queued") => {
      if (requester === undefined) return Effect.die("Cannot send without current authority");
      const ids = turnSteerIdsFor(event.payload.inputId, attempt);
      return threads
        .sendToThread({
          projectId: ProjectId.make(target.projectId),
          commandId: ids.commandId,
          threadId: worker.threadId,
          messageId: ids.messageId,
          text: "Follow-up from " + event.payload.from + ": " + event.payload.text,
          attachments: [],
          // First into the running run when it can take steering; the second attempt only
          // queues, which the thread accepts whatever its run is doing.
          mode: attempt === "first" ? "auto" : "queue",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: requester.runtimeModeCeiling,
            interactionMode: "default",
            refused,
          }),
          Effect.result,
        );
    };
    const rejected = (failure: { readonly _tag: string }) =>
      failure._tag === "OrchestratorCommandRejectedError" ||
      failure._tag === "OrchestratorCommandPreviouslyRejectedError";
    let sent =
      acceptedRun === undefined
        ? yield* send("first")
        : { _tag: "Success" as const, success: { run: acceptedRun } };
    // A rejected command id is refused for good, so a definite rejection gets one more attempt
    // under its own ids rather than retrying the same ones forever.
    if (
      sent._tag === "Failure" &&
      rejected(sent.failure) &&
      (yield* Ref.get(refused)) === undefined
    ) {
      sent = yield* send("queued");
    }
    if (sent._tag === "Failure") {
      const refusal = yield* Ref.get(refused);
      if (refusal !== undefined || rejected(sent.failure)) {
        // Read again: an earlier follow-up's question may have moved the task since.
        const asked = yield* askRequester(
          (yield* ledger.getTask(event.taskId)) ?? stored,
          refusal !== undefined
            ? "The thread doing this now runs in " +
                refusal.runtimeMode +
                " mode, above what this work may use, so I didn't pass on your follow-up (\"" +
                event.payload.text +
                "\"). Lower the thread's mode in GOAT, or say it again there."
            : "The thread doing this didn't take your follow-up (\"" +
                event.payload.text +
                '"). Say it again, or open the thread in GOAT.',
          owner,
          { clearPendingAnswer: true },
        );
        // Done only once the person has been told; otherwise the next pass tells them.
        if (asked === undefined) return;
        yield* ledger.completeForward({ owner, sequence: pending.sequence });
        return;
      }
      // Not known to be refused; the next pass sends it again under the same ids.
      yield* Effect.logWarning("channel follow-up forward failed", {
        taskId: stored.task.taskId,
        cause: sent.failure,
      });
      return;
    }
    const latest = yield* ledger.getTask(event.taskId);
    if (
      latest === undefined ||
      latest.task.worker === undefined ||
      (latest.task.status !== "running" && latest.task.status !== "waiting_input")
    ) {
      // Settling waits for pending forwards, so this means the task was stopped meanwhile.
      yield* ledger.completeForward({ owner, sequence: pending.sequence });
      return;
    }
    // Bind the task to the run that took the follow-up. Only the follow-up that set the fence
    // lifts it; an earlier one leaves a later one's fence in place.
    const own = [
      turnSteerIdsFor(event.payload.inputId, "first").messageId,
      turnSteerIdsFor(event.payload.inputId, "queued").messageId,
    ] as ReadonlyArray<string>;
    const ownsFence =
      latest.pendingAnswerMessageId !== undefined && own.includes(latest.pendingAnswerMessageId);
    if (ownsFence || latest.task.worker.runId !== sent.success.run.id) {
      const bound = yield* commitTransition(
        ledger,
        latest,
        {
          type: "task.worker.bound",
          payload: { worker: { ...latest.task.worker, runId: sent.success.run.id } },
        },
        { owner, ...(ownsFence ? { pendingAnswerMessageId: null } : {}) },
      );
      // A concurrent write moved the task; the next pass sends again under the same ids,
      // which lands on the same run, and binds then.
      if (bound === undefined) return;
    }
    yield* ledger.completeForward({ owner, sequence: pending.sequence });
  });

  return forwardFollowUp;
});
