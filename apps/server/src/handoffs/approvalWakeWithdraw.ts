import { CommandId, type HandoffReadInput, MessageId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a fresh id for each withdrawal attempt.
import * as NodeCrypto from "node:crypto";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/** The run that delivers a handoff's "approved" wake, while it exists. */
const approvedWakeRun = (
  threads: ThreadManagement.ThreadManagementService["Service"],
  input: HandoffReadInput,
) =>
  threads.getThreadRecords(input.threadId, ["runs"], { turnItemTypes: [], messageRoles: [] }).pipe(
    Effect.map((records) => {
      const wake = MessageId.make(`message:handoff-wake:${input.handoffId}:completed`);
      return records.runs.find((candidate) => candidate.userMessageId === wake);
    }),
  );

const commandId = (input: HandoffReadInput, status: string) =>
  CommandId.make(`handoff:${input.handoffId}:withdraw-wake:${status}:${NodeCrypto.randomUUID()}`);

/**
 * Withdraws an approval's "approved" wake before the agent reads it: the approval was used, so
 * its "call again" would only meet "already used". A queued wake is cancelled; one whose turn is
 * still preparing or starting, because the asking turn ended meanwhile, is interrupted.
 */
export const withdrawApprovalWake = Effect.fn("Handoffs.withdrawApprovalWake")(function* (
  threads: ThreadManagement.ThreadManagementService["Service"],
  input: HandoffReadInput,
) {
  const run = yield* approvedWakeRun(threads, input);
  if (run?.status === "queued")
    yield* threads.dispatch({
      type: "queued-run.cancel",
      commandId: commandId(input, run.status),
      threadId: input.threadId,
      runId: run.id,
    });
  else if (run?.status === "preparing" || run?.status === "starting")
    yield* threads.dispatch({
      type: "run.interrupt",
      commandId: commandId(input, run.status),
      threadId: input.threadId,
      runId: run.id,
      reason: "The approval this turn was woken for was already used.",
    });
});

/**
 * A person ending an approved computer use grant (a card's Stop, Stop all, End computer use)
 * stops that agent. The wake reactor withdraws the grant's approval wake while it has
 * not taken the screen yet: queued behind the thread's running turn, or still starting. A turn
 * already running keeps the control the Stop ended.
 */
export const withdrawComputerUseWake = Effect.fn("Handoffs.withdrawComputerUseWake")(function* (
  threads: ThreadManagement.ThreadManagementService["Service"],
  input: HandoffReadInput,
  ended: DateTime.Utc | undefined,
) {
  const run = yield* approvedWakeRun(threads, input);
  if (run === undefined) return;
  // A wake run that started only after the grant ended is a turn the Stop should have kept from
  // starting. One already working before the Stop keeps going, like every other turn then.
  const startedAfterEnd =
    (run.status === "running" || run.status === "waiting") &&
    run.startedAt !== null &&
    ended !== undefined &&
    DateTime.toEpochMillis(run.startedAt) >= DateTime.toEpochMillis(ended);
  // A retry after a rejection needs a fresh id; the run's state decides whether one is due.
  if (run.status === "queued")
    yield* threads.dispatch({
      type: "queued-run.cancel",
      commandId: commandId(input, run.status),
      threadId: input.threadId,
      runId: run.id,
    });
  else if (run.status === "preparing" || run.status === "starting" || startedAfterEnd)
    yield* threads.dispatch({
      type: "run.interrupt",
      commandId: commandId(input, run.status),
      threadId: input.threadId,
      runId: run.id,
      reason: "A person ended this thread's computer use before this turn started.",
    });
});
