import type {
  NodeId,
  RemoteReportDeliveryMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import type * as Effect from "effect/Effect";
import type * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import type { DismissSelector } from "./remoteDispatchDismiss.ts";
import type { RemoteDispatchError, RemoteDispatchRecord } from "./remoteDispatchModel.ts";
import type { RemoteFollowUp } from "./remoteTaskFollowUp.ts";

export interface RemoteLaunchInput {
  readonly kind: "thread" | "task";
  readonly originThreadId: ThreadId;
  readonly delivery: typeof RemoteReportDeliveryMode.Type;
  readonly launch: SshRemoteDispatch.SshLaunchInput;
  readonly task?: { readonly taskId: NodeId; readonly parentRunId: RunId };
  /** A durable caller identity (a channel child-work record) keys the row for launch retries. */
  readonly correlationId?: string | undefined;
}
export interface RemoteDispatchCoordinatorShape {
  readonly launch: <E, R>(
    input: RemoteLaunchInput,
    beforeLaunch: Effect.Effect<void, E, R>,
  ) => Effect.Effect<
    {
      correlationId: string;
      launch: SshRemoteDispatch.SshLaunchResult;
      reportsSupported: boolean;
    },
    RemoteDispatchError | SshRemoteDispatch.SshRemoteDispatchError | E,
    R
  >;
  readonly cancel: <E, R>(
    id: string,
    authorize: Effect.Effect<RuntimeMode, E, R>,
  ) => Effect.Effect<
    "cancel_requested" | "cancelled" | "already_settled",
    RemoteDispatchError | SshRemoteDispatch.SshRemoteDispatchError | E,
    R
  >;
  readonly get: (id: string) => Effect.Effect<RemoteDispatchRecord | null, RemoteDispatchError>;
  readonly listForOrigin: (
    id: ThreadId,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<RemoteDispatchRecord>, RemoteDispatchError>;
  /** Every dispatch of these remoteThreadKey values, newest first. */
  readonly listForRemoteThreads: (
    keys: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<RemoteDispatchRecord>, RemoteDispatchError>;
  /** Every origin's dispatches, most recently updated first. */
  readonly listRecent: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<RemoteDispatchRecord>, RemoteDispatchError>;
  /** The task owner remains available after completion, including for sends from other threads. */
  readonly taskOrigin: (
    host: string,
    threadId: string,
  ) => Effect.Effect<ThreadId | null, RemoteDispatchError>;
  readonly isTaskThread: (
    host: string,
    threadId: string,
  ) => Effect.Effect<boolean, RemoteDispatchError>;
  readonly resume: (host: string, threadId: string) => Effect.Effect<void, RemoteDispatchError>;
  /** A send that starts a run on the thread of one of the caller's finished remote tasks. */
  readonly followUp: RemoteFollowUp;
  /** Stops following dismissable thread dispatches without contacting their host. */
  readonly dismiss: (
    selector: DismissSelector,
  ) => Effect.Effect<ReadonlyArray<RemoteDispatchRecord>, RemoteDispatchError>;
  readonly claimDelete: (input: {
    readonly originThreadId: ThreadId;
    readonly host: string;
    readonly remoteThreadId: string;
    readonly requestKey: string;
  }) => Effect.Effect<
    | { readonly _tag: "missing" }
    | { readonly _tag: "reports" }
    | { readonly _tag: "state"; readonly state: string }
    | { readonly _tag: "other_key" }
    | { readonly _tag: "claimed"; readonly correlationId: string; readonly readKey: string },
    RemoteDispatchError
  >;
  readonly clearDelete: (
    correlationId: string,
    requestKey: string,
  ) => Effect.Effect<void, RemoteDispatchError>;
  /**
   * One pass settling lost thread launches with their destinations (rebound or fenced), then
   * asking hosts of threads lost to an outage whether they answer again. The coordinator runs it
   * on its own schedule; an inconclusive row is asked again after a backoff.
   */
  readonly resolveLostLaunches: Effect.Effect<void>;
}
