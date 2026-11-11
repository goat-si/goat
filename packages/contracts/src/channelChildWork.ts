import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChannelTaskId } from "./channelCommon.ts";

/**
 * One piece of work a channel-owned thread launched: a delegated subagent or a bot-launched
 * GOAT thread, local or on another machine. The record makes child work durable: a retry of the
 * same request finds the same record instead of launching twice, capacity is counted from
 * records rather than memory, and stop traverses them. Rows live in channel_runtime_state, so
 * no migration competes with other work for an id.
 */

export const ChannelChildWorkId = TrimmedNonEmptyString.pipe(Schema.brand("ChannelChildWorkId"));
export type ChannelChildWorkId = typeof ChannelChildWorkId.Type;

export const ChannelChildWorkSurface = Schema.Literals([
  "delegate_local",
  "delegate_remote",
  "thread_launch",
  "ssh_thread_launch",
]);
export type ChannelChildWorkSurface = typeof ChannelChildWorkSurface.Type;

/**
 * What a thread GOAT Bot launched is for, judged by its workspace at admission: its own
 * worktree is coding, which stays in thread lists; a scratch folder or a project root is a
 * chore, which lists show only under the bot's task.
 */
export const GoatBotWorkKind = Schema.Literals(["coding", "chore"]);
export type GoatBotWorkKind = typeof GoatBotWorkKind.Type;

export const ChannelChildWorkState = Schema.Literals([
  /** Admission reserved capacity; the launch has not been attempted yet. */
  "reserved",
  /** The launch was attempted; the destination binding is not confirmed (crash window). */
  "launched",
  /** The destination is known and the child is active. */
  "bound",
  "completed",
  "failed",
  "cancelled",
  /** The launch never happened; capacity was returned. */
  "released",
  /** The outcome is uncertain (remote crash window); capacity stays reserved. */
  "unknown",
]);
export type ChannelChildWorkState = typeof ChannelChildWorkState.Type;

export const CHANNEL_CHILD_WORK_TERMINAL_STATES = [
  "completed",
  "failed",
  "cancelled",
  "released",
] as const satisfies ReadonlyArray<ChannelChildWorkState>;

export const isChannelChildWorkTerminal = (state: ChannelChildWorkState): boolean =>
  (CHANNEL_CHILD_WORK_TERMINAL_STATES as ReadonlyArray<ChannelChildWorkState>).includes(state);

/** States that hold descendant capacity. "unknown" keeps its slot until reconciliation resolves. */
export const CHANNEL_CHILD_WORK_ACTIVE_STATES = [
  "reserved",
  "launched",
  "bound",
  "unknown",
] as const satisfies ReadonlyArray<ChannelChildWorkState>;

export const isChannelChildWorkActive = (state: ChannelChildWorkState): boolean =>
  (CHANNEL_CHILD_WORK_ACTIVE_STATES as ReadonlyArray<ChannelChildWorkState>).includes(state);

/**
 * Where the child landed. Local children have a threadId; remote ones a correlation id and host,
 * and, once the destination acknowledged the launch, its thread and environment there.
 */
export const ChannelChildWorkDestination = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  correlationId: Schema.optional(TrimmedNonEmptyString),
  host: Schema.optional(TrimmedNonEmptyString),
  /** The destination GOAT's own environment id; absent when it could not be read. */
  environmentId: Schema.optional(EnvironmentId),
  /** What GOAT Bot launched it for, judged from the requested workspace at admission. */
  workKind: Schema.optional(GoatBotWorkKind),
});
export type ChannelChildWorkDestination = typeof ChannelChildWorkDestination.Type;

/** The child's thread on this machine; a remote child's thread lives on its host. */
export const localChildThreadId = (destination: ChannelChildWorkDestination | undefined) =>
  destination?.host === undefined ? destination?.threadId : undefined;

export const ChannelChildWork = Schema.Struct({
  childWorkId: ChannelChildWorkId,
  ownerId: TrimmedNonEmptyString,
  /** The channel task whose worker (or recorded child) launched this work. */
  taskId: ChannelTaskId,
  /** The owning task's generation at admission; retries of another run never match. */
  generation: NonNegativeInt,
  surface: ChannelChildWorkSurface,
  callerThreadId: ThreadId,
  /** The caller's run when its thread serves several tasks, as a GOAT Bot session does. */
  callerRunId: Schema.optional(RunId),
  /** The caller's clientRequestId, or a deterministic digest when none was passed. */
  requestKey: TrimmedNonEmptyString,
  promptDigest: TrimmedNonEmptyString,
  /** The launch-target parts hashed into keyless request keys, kept for operators. */
  destinationHint: Schema.optional(TrimmedNonEmptyString),
  state: ChannelChildWorkState,
  destination: Schema.optional(ChannelChildWorkDestination),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ChannelChildWork = typeof ChannelChildWork.Type;
