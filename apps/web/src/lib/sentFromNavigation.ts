import type { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Opened from a message this thread sent elsewhere; the timeline reveals the sending call. */
    sentFrom?: SentFromTarget;
  }
}

export interface SentFromTarget {
  /** The thread that sent it, whose timeline reveals the call. */
  readonly senderThreadId: ThreadId;
  /** Set when the sender is on another machine; absent means the same environment. */
  readonly senderEnvironmentId?: EnvironmentId;
  /** The thread and message the call delivered to. */
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** One per click, so opening the same message again reveals the call again. */
  readonly activation: string;
}

export interface OpenThreadOptions {
  readonly sentFrom?: SentFromTarget;
  /** Opens the thread on that connected environment instead of this timeline's. */
  readonly environmentId?: EnvironmentId;
}
