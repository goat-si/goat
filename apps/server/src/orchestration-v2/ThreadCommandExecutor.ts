import type { ThreadId } from "@goat/contracts";
import * as KeyedLock from "@goat/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId>
>()("goat/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(ThreadCommandExecutor, KeyedLock.make<ThreadId>());
