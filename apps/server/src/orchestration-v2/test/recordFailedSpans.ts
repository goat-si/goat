import { ProviderDriverKind, type OrchestrationV2AppThread } from "@goat/contracts";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";

export function recordFailedSpans() {
  const failedSpans: string[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        if (Exit.isFailure(exit)) failedSpans.push(span.name);
      };
      return span;
    },
  });
  return { failedSpans, tracer };
}

export const childCreatedEvent = (appThread: OrchestrationV2AppThread) => ({
  type: "app_thread.created" as const,
  driver: ProviderDriverKind.make("codex"),
  appThread,
});
