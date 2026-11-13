import { ProjectId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { captureMemoryGrantCeiling } from "../memory/MemoryAccess.ts";
import {
  type DispatchModeRefusal,
  DispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { rejected } from "./channelBotSessionRecords.ts";
import { steersInto } from "./channelBotSessionRuns.ts";
import { refuseForward } from "./channelForwardRefusal.ts";
import { toolSteerIdsFor, turnSteerIdsFor } from "./channelIds.ts";
import { refuseSenderFollowUp, requesterForDelivery } from "./channelSenderAuthority.ts";
import { commitTransition } from "./channelTaskWrites.ts";

/** How long a follow-up may wait for the thread to show its run once its authority changed. */
export const ACCEPTED_RUN_WAIT_MS = 10 * 60_000;

const unconfirmedFollowUp = (sender: string | undefined) =>
  (sender === undefined
    ? "The requester’s permission changed, and GOAT could not confirm your follow-up"
    : sender + "'s access changed, and GOAT could not confirm their follow-up") +
  " started in the thread. Open the thread in GOAT to check it.";

export const makeForwardFollowUp = Effect.fn("channel.makeForwardFollowUp")(function* () {
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
    const idsFor = (attempt: "first" | "queued") =>
      event.payload.forwardKey === undefined
        ? turnSteerIdsFor(event.payload.inputId, attempt)
        : toolSteerIdsFor(event.payload.forwardKey, attempt);
    const own: ReadonlyArray<string> = [idsFor("first").messageId, idsFor("queued").messageId];
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
      if (
        latest.pendingAnswerMessageId !== undefined &&
        own.includes(latest.pendingAnswerMessageId)
      ) {
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
    // The requester and, for someone else's follow-up, its sender, as they stand now.
    const authority = yield* requesterForDelivery(stored.task, event.payload.sender).pipe(
      Effect.provideService(ChannelLedger.ChannelLedger, ledger),
      Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
    );
    const requester = authority._tag === "allowed" ? authority.requester : undefined;
    let acceptedRun = undefined;
    if (requester === undefined) {
      // The follow-up was recorded by this server's clock; a time that is unreadable or ahead
      // ends the wait rather than extending it.
      const age = DateTime.toEpochMillis(yield* DateTime.now) - Date.parse(event.occurredAt);
      const waiting = age >= 0 && age < ACCEPTED_RUN_WAIT_MS;
      const readRecords = Effect.suspend(() =>
        threads.getThreadRecords(worker.threadId, ["messages", "runs"]),
      ).pipe(
        Effect.map((records) => {
          const message = records.messages.find((candidate) => own.includes(candidate.id));
          const run = records.runs.find(
            (candidate) =>
              own.includes(candidate.userMessageId) ||
              (message !== undefined && candidate.id === message.runId),
          );
          return { message, run };
        }),
      );
      const readAccepted = readRecords.pipe(Effect.option);
      // Read again under the refusal's write lock: only a read that shows the run still absent
      // refuses. A run that appeared, or a read that failed, keeps the follow-up for the next pass.
      const giveUp = refuseForward(
        ledger,
        stored,
        unconfirmedFollowUp(authority._tag === "sender_changed" ? authority.name : undefined),
        owner,
        pending.sequence,
        own,
        () =>
          readRecords.pipe(
            Effect.map((again) => again.run === undefined),
            Effect.orElseSucceed(() => false),
          ),
      );
      const projection = yield* readAccepted;
      if (Option.isNone(projection)) return waiting ? undefined : yield* giveUp;
      const message = projection.value.message;
      acceptedRun = projection.value.run;
      if (message !== undefined && acceptedRun === undefined)
        return waiting ? undefined : yield* giveUp;
      if (acceptedRun === undefined && authority._tag === "sender_changed") {
        yield* refuseSenderFollowUp(ledger, stored, {
          eventId: event.eventId,
          name: authority.name,
          owner,
          sequence: pending.sequence,
          own,
        });
        return;
      }
      if (acceptedRun === undefined) {
        yield* refuseForward(
          ledger,
          stored,
          "The requester’s permission changed; your follow-up was not sent. Open the thread in GOAT.",
          owner,
          pending.sequence,
          own,
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
    // Steer only the run read above, and only while it holds no more memory than the requester
    // has now; a run that started since, or one that holds more, gets a queued turn instead.
    const steerInto =
      requester !== undefined &&
      steersInto(newest, false, captureMemoryGrantCeiling(requester.grantedScopes, false))
        ? newest
        : undefined;
    const send = (attempt: "first" | "queued") => {
      if (requester === undefined) return Effect.die("Cannot send without current authority");
      const ids = idsFor(attempt);
      return threads
        .sendToThread({
          projectId: ProjectId.make(target.projectId),
          commandId: ids.commandId,
          threadId: worker.threadId,
          messageId: ids.messageId,
          text: "Follow-up from " + event.payload.from + ": " + event.payload.text,
          attachments: [],
          // The second attempt only queues, which the thread accepts whatever its run is doing.
          ...(attempt === "first" && steerInto !== undefined
            ? { mode: "steer" as const, targetRunId: steerInto.id }
            : { mode: "queue" as const }),
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
        yield* refuseForward(
          ledger,
          stored,
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
          pending.sequence,
          own,
        );
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
