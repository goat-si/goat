import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChannelLedgerError } from "./channelLedgerError.ts";
import type { ChannelTask, ThreadId } from "@goat/contracts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export const readRecords = (
  threads: ThreadManagement.ThreadManagementService["Service"],
  threadId: ThreadId,
) =>
  threads.getThreadRecords(threadId, [
    "runs",
    "messages",
    "providerTurns",
    "runtimeRequests",
    "subagents",
  ]);

export const rejected = (failure: unknown) => {
  const tag = (failure as { readonly _tag?: string } | undefined)?._tag;
  return (
    tag === "OrchestratorCommandRejectedError" ||
    tag === "OrchestratorCommandPreviouslyRejectedError" ||
    tag === "ThreadManagementNoSteerableRunError"
  );
};

const isLedgerError = Schema.is(ChannelLedgerError);

export const requireTarget = (task: ChannelTask) =>
  task.target === undefined
    ? Effect.fail(
        new ChannelLedgerError({
          reason: "version_conflict",
          detail: "A GOAT Bot turn needs its dispatch target.",
        }),
      )
    : Effect.succeed(task.target);

export const asLedgerError = (operation: string) => (cause: unknown) =>
  isLedgerError(cause)
    ? cause
    : new ChannelLedgerError({
        reason: "persistence",
        detail: "GOAT Bot session " + operation + " failed.",
        cause,
      });
