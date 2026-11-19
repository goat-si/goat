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
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, resumeCache).pipe(Effect.map(SubscriptionRef.changes)),
    ),
  );
}
