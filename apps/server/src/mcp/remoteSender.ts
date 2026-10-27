import {
  OrchestratorMcpFailure,
  REMOTE_SENDER_LABEL_MAX_LENGTH,
  REMOTE_SENDER_TITLE_MAX_LENGTH,
  type OrchestrationMessageContext,
  type RemoteSenderAttribution,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

// Decorative metadata must never fail a send, so it is cut to fit instead of being rejected.
const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  let cut = "";
  for (const char of line) {
    if (cut.length + char.length > max - 1) break;
    cut += char;
  }
  return cut + "…";
};

/**
 * How this machine names the calling thread to another machine it sends to. Only a thread caller
 * has one; an outside caller or a server without an environment descriptor sends none.
 */
export const remoteSenderFor = Effect.fn("RemoteSender.forCaller")(function* (
  scope: McpInvocationScope,
  threads: ThreadManagement.ThreadManagementService["Service"],
) {
  if (scope.thread === undefined) return undefined;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  if (environment._tag === "None") return undefined;
  const shell = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null) return undefined;
  const descriptor = yield* environment.value.getDescriptor;
  return {
    environmentId: descriptor.environmentId,
    environmentLabel: clip(descriptor.label, REMOTE_SENDER_LABEL_MAX_LENGTH),
    threadId: shell.id,
    title: clip(shell.title.trim() || "Untitled thread", REMOTE_SENDER_TITLE_MAX_LENGTH),
  } satisfies RemoteSenderAttribution;
});

/**
 * A received remoteSender is kept only from an outside caller naming another environment, the same
 * rule launchedBy follows. It labels the message and never feeds senderThreadId or permissions.
 */
export const acceptRemoteSender = Effect.fn("RemoteSender.accept")(function* (
  scope: McpInvocationScope,
  remoteSender: RemoteSenderAttribution | undefined,
) {
  if (remoteSender === undefined) return undefined;
  if (scope.thread !== undefined || remoteSender.environmentId === scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "remoteSender is accepted only from an outside caller naming a foreign environment.",
    });
  return remoteSender;
});

/** Adds the sender to a message's context, after turn capabilities have rebuilt it. */
export function withRemoteSender<T extends { readonly context?: OrchestrationMessageContext }>(
  message: T,
  remoteSender: RemoteSenderAttribution | undefined,
): T {
  if (remoteSender === undefined) return message;
  const context = message.context ?? { version: 1 as const, records: [] };
  return { ...message, context: { ...context, remoteSender } };
}
