import * as Effect from "effect/Effect";
import * as Invocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Lifecycle from "../../ThreadLifecycleMcpService.ts";
import { ThreadLifecycleToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ThreadLifecycleToolkit, {
  goat_queue_resume: McpToolAccess.destructive(
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const service = yield* Lifecycle.ThreadLifecycleMcpService;
          return yield* service.resume(yield* Invocation.McpInvocationContext, input);
        }),
      { admission: "handler" },
    ),
  ),
  goat_queued_run_start: McpToolAccess.destructive(
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const service = yield* Lifecycle.ThreadLifecycleMcpService;
          return yield* service.start(yield* Invocation.McpInvocationContext, input);
        }),
      { admission: "handler" },
    ),
  ),
  goat_thread_delete: McpToolAccess.destructive(
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const service = yield* Lifecycle.ThreadLifecycleMcpService;
          return yield* service.delete(yield* Invocation.McpInvocationContext, input);
        }),
      { admission: "handler" },
    ),
  ),
  goat_provider_session_detach: McpToolAccess.destructive(
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const service = yield* Lifecycle.ThreadLifecycleMcpService;
          return yield* service.detach(yield* Invocation.McpInvocationContext, input);
        }),
      { admission: "handler" },
    ),
  ),
  goat_queue_receipt: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Lifecycle.ThreadLifecycleMcpService;
      return yield* service.receipt(yield* Invocation.McpInvocationContext, "queue.resume", input);
    }),
  ),
  goat_queued_run_receipt: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Lifecycle.ThreadLifecycleMcpService;
      return yield* service.receipt(
        yield* Invocation.McpInvocationContext,
        "queued_run.start",
        input,
      );
    }),
  ),
  goat_thread_lifecycle_receipt: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Lifecycle.ThreadLifecycleMcpService;
      return yield* service.receipt(yield* Invocation.McpInvocationContext, "thread.delete", input);
    }),
  ),
  goat_provider_session_receipt: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Lifecycle.ThreadLifecycleMcpService;
      return yield* service.receipt(
        yield* Invocation.McpInvocationContext,
        "provider_session.detach",
        input,
      );
    }),
  ),
});
