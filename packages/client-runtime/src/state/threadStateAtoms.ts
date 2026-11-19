import type { EnvironmentId as EnvironmentIdType, ThreadId as ThreadIdType } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { followStreamInEnvironment } from "./runtime.ts";
import type { ThreadResumeCache } from "./threadResumeCache.ts";

export function threadStateChanges(
  makeEnvironmentThreadState: typeof import("./threads.ts").makeEnvironmentThreadState,
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
  onThreadDeleted?: (environmentId: EnvironmentIdType, threadId: ThreadIdType) => void,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, resumeCache, onThreadDeleted).pipe(
        Effect.map(SubscriptionRef.changes),
      ),
    ),
  );
}

export function notifyThreadDeleted(
  observer: ((environmentId: EnvironmentIdType, threadId: ThreadIdType) => void) | undefined,
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
) {
  return observer === undefined
    ? Effect.void
    : Effect.sync(() => observer(environmentId, threadId)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread deletion observer failed.", { cause }),
        ),
      );
}
