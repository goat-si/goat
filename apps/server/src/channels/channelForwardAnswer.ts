import { type ChannelTaskEvent, type ProjectId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { refuseForward } from "./channelForwardRefusal.ts";
import { answerForwardIdsFor } from "./channelIds.ts";
import { refuseAnswerForward, requesterForDelivery } from "./channelSenderAuthority.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";

export const forwardLocalWorkerAnswer = Effect.fn("channel.forwardLocalWorkerAnswer")(function* (
  {
    ledger,
    threads,
    slackSettings,
  }: {
    readonly ledger: ChannelLedger.ChannelLedger["Service"];
    readonly threads: ThreadManagement.ThreadManagementService["Service"];
    readonly slackSettings: SlackChannelSettings.SlackChannelSettings["Service"];
  },
  stored: ChannelLedger.ChannelStoredTask,
  threadId: ThreadId,
  projectId: ProjectId,
  event: Extract<ChannelTaskEvent, { readonly type: "task.question.answered" }>,
  sequence: number,
  owner: string,
) {
  const ids = answerForwardIdsFor(event.eventId);
  const brief = yield* ledger.latestTaskBrief(stored.task.taskId, stored.task.generation);
  const carriesNotes = brief?.context.notesPath !== undefined;
  const sender = event.payload.sender;
  const inputId = event.actor === "user" ? event.payload.inputId : undefined;
  const senderInputId = sender?.inputId ?? inputId;
  const live = requesterForDelivery(stored.task, sender, inputId, carriesNotes).pipe(
    Effect.provideService(ChannelLedger.ChannelLedger, ledger),
    Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
  );
  const authority = yield* live;
  if (authority._tag !== "allowed") {
    const projection = yield* threads
      .getThreadRecords(threadId, ["messages", "runs"])
      .pipe(Effect.option);
    if (Option.isNone(projection)) return;
    const accepted =
      projection.value.messages.some((message) => message.id === ids.messageId) ||
      projection.value.runs.some((run) => run.userMessageId === ids.messageId);
    if (accepted) {
      yield* ledger.completeForward({ owner, sequence });
      return;
    }
    yield* refuseAnswerForward(ledger, stored, authority, owner, sequence, ids);
    return;
  }
  // The worker's modes may have been raised since the task started. The orchestrator re-checks
  // them against the requester's ceiling inside the thread's command lock.
  const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
  const permissionRefused = yield* Ref.make<
    Exclude<Effect.Success<typeof live>, { readonly _tag: "allowed" }> | undefined
  >(undefined);
  const confirm = live.pipe(
    Effect.orElseSucceed(() => ({ _tag: "requester_changed" }) as const),
    Effect.flatMap((current) =>
      current._tag === "allowed"
        ? Effect.succeed(true)
        : Ref.set(permissionRefused, current).pipe(Effect.as(false)),
    ),
  );
  if (carriesNotes && senderInputId !== undefined)
    yield* ledger.bindWorkerFollowUpSender(threadId, ids.messageId, senderInputId);
  const sent = yield* threads
    .sendToThread({
      projectId,
      commandId: ids.commandId,
      threadId,
      messageId: ids.messageId,
      text: "Answer from " + stored.task.requester.displayName + ": " + event.payload.answer,
      attachments: [],
      mode: "queue",
      ...(carriesNotes ? { confirm } : {}),
      createdBy: "user",
      creationSource: "server",
    })
    .pipe(
      Effect.provideService(DispatchModeLimit, {
        runtimeMode: authority.requester.runtimeModeCeiling,
        interactionMode: "default",
        refused,
      }),
      Effect.result,
    );
  if (sent._tag === "Failure") {
    const denial = yield* Ref.get(permissionRefused);
    if (denial !== undefined)
      return yield* refuseAnswerForward(ledger, stored, denial, owner, sequence, ids);
    const refusal = yield* Ref.get(refused);
    if (refusal !== undefined) {
      // Keep the answer's intent: ask again, so the requester can lower the thread or answer there.
      yield* refuseForward(
        ledger,
        stored,
        "The coding thread now runs in " +
          refusal.runtimeMode +
          " mode, above what this task may use, so I didn't pass on your answer (\"" +
          event.payload.answer +
          "\"). Lower the thread's mode in GOAT and answer again, or answer in the thread.",
        owner,
        sequence,
        [ids.messageId],
      );
      return;
    }
    // Left pending; the next scan sends it again under the same command id.
    yield* Effect.logWarning("channel answer forward failed", {
      taskId: stored.task.taskId,
      cause: sent.failure,
    });
    return;
  }
  yield* ledger.completeForward({ owner, sequence });
});
