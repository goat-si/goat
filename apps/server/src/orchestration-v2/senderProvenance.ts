/**
 * Who sent a message or launched a thread, recorded once when it happens so a later restart or
 * reordered queue cannot change it (computer use authority follows it; see ComputerUseOrigin).
 *
 * @module senderProvenance
 */
import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadLauncher,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

interface RunReads<E> {
  readonly getThreadRecords: (
    threadId: ThreadId,
    fields: ReadonlyArray<"runs">,
  ) => Effect.Effect<
    { readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">> },
    E
  >;
}

const EXECUTING: ReadonlyArray<OrchestrationV2Run["status"]> = ["starting", "running", "waiting"];

/** The run executing in a thread now, if any; a failed read records none. */
const executingRun = <E>(store: RunReads<E>, threadId: ThreadId) =>
  store.getThreadRecords(threadId, ["runs"]).pipe(
    Effect.map((records) => records.runs.find((run) => EXECUTING.includes(run.status))?.id),
    Effect.orElseSucceed(() => undefined),
  );

/** A message command with its sender's executing run recorded in place of any value it came with. */
export const withSenderRun = Effect.fn("senderProvenance.withSenderRun")(function* <
  E,
  C extends {
    readonly senderThreadId?: ThreadId | undefined;
    readonly senderRunId?: RunId | undefined;
  },
>(store: RunReads<E>, command: C) {
  const { senderRunId: _sent, ...rest } = command;
  const runId =
    command.senderThreadId === undefined
      ? undefined
      : yield* executingRun(store, command.senderThreadId);
  return (runId === undefined ? rest : { ...rest, senderRunId: runId }) as C;
});

/** A local launcher with its executing run recorded in place of any value it came with. */
export const withLauncherRun = Effect.fn("senderProvenance.withLauncherRun")(function* <E>(
  store: RunReads<E>,
  launcher: OrchestrationV2ThreadLauncher,
) {
  const { runId: _sent, ...rest } = launcher;
  if (launcher.kind !== "launch" || launcher.environmentId !== null) return rest;
  const runId = yield* executingRun(store, launcher.threadId);
  return runId === undefined ? rest : { ...rest, runId };
});

/** The sender fields a message copies from the record it comes from. */
export const senderOf = (from: {
  readonly senderThreadId?: ThreadId | undefined;
  readonly senderRunId?: RunId | undefined;
}) => ({
  ...(from.senderThreadId === undefined ? {} : { senderThreadId: from.senderThreadId }),
  ...(from.senderRunId === undefined ? {} : { senderRunId: from.senderRunId }),
});
