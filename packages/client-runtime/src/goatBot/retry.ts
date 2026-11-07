import type { ChannelTaskRetryRefusal, ChannelTaskStatus } from "@goat/contracts";

/** "Attempt 2" once a person has retried a task; nothing for the first attempt. */
export function taskAttemptLabel(generation: number | undefined): string | null {
  return generation === undefined || generation <= 1 ? null : `Attempt ${generation}`;
}

/** Failed and stopped work can run again; the server still decides whether it may. */
export function isRetryableTaskStatus(status: ChannelTaskStatus): boolean {
  return status === "failed" || status === "cancelled";
}

const REFUSAL_TEXT = {
  not_finished: "This task is still going.",
  completed: "This task already finished. Ask again in chat to run it anew.",
  elsewhere: "This ran on another computer. Check it there, then ask again in chat.",
  still_running: "The last attempt is still stopping. Try again in a moment.",
  not_retryable: "This task can't be retried. Ask again in chat.",
  bot_inactive: "This bot was deleted. Restore it to retry its work.",
} satisfies Record<ChannelTaskRetryRefusal, string>;

export function retryRefusalText(reason: ChannelTaskRetryRefusal): string {
  return REFUSAL_TEXT[reason];
}
