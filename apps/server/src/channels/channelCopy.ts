/**
 * Fixed words the channel layer sends without asking a model: link notices and failure notes.
 *
 * @module channelCopy
 */
import type { TextGenerationFailureKind } from "@goat/provider-core/server/textGenerationUtils";

export const CHANNEL_COPY = {
  linkHelp:
    'I don\'t know who you are yet. Open GOAT, go to Settings → GOAT Bot → Slack, create a link code, and send it to me as "link <code>".',
  linkInvalid: "That link code is wrong or expired. Create a new one in GOAT and try again.",
  linked: "You're linked. Send me what you need.",
  unlinkedInput:
    'I can\'t take work from this account yet. Open GOAT, create a link code under Settings → GOAT Bot → Slack, and send me "link <code>".',
  botMoved: "GOAT Bot moved to another machine. Please resend your message there.",
  /** Fixed wording per failure kind: provider output stays in the server log. */
  receptionFailedBecause: {
    schema_rejected:
      "I couldn't read that: the model provider rejected GOAT's request format. Check for a GOAT update.",
    auth: "I couldn't read that: the model provider on GOAT Bot's computer needs you to sign in again.",
    rate_limited:
      "I couldn't read that: the model provider's usage limit was reached. Please try again later.",
    timeout: "I couldn't read that: the model took too long to answer. Please send it again.",
    unavailable:
      "I couldn't read that: GOAT Bot's computer can't run its text generation model right now. Check the text generation model and its provider in GOAT settings there.",
    invalid_output:
      "I couldn't read that: the model's answer didn't fit what GOAT expects. Please send it again.",
    failed: "I couldn't read that: the model provider returned an error. Please send it again.",
  } satisfies Record<TextGenerationFailureKind, string>,
  readFoundNothing:
    "I looked through what I can see and couldn't find that. Can you tell me more about it?",
  agentCannotCreateWork:
    "Only people can start new work. I can tell you how existing work is going.",
  agentCannotMoveWork: "Only people with access to run work can move it to another machine.",
  agentCannotStopWork: "Only the people who may run this work can stop it.",
  answerForwarded: "Thanks. I passed your answer on.",
  questionAlreadyAnswered:
    "That question was already answered, so I didn't pass this on. Send it as a new message if it still matters.",
  answerNotAllowed:
    "I can't pass that on: answering this task's question needs the same access as the person who asked for it.",
  approvalNotAllowed:
    "I can't pass that on: answering this approval needs the same access as the person who asked for the work.",
  approvalAlreadyAnswered: "That approval was already answered.",
  approvalFailed:
    "I couldn't pass that approval on. Open the work's thread in GOAT to answer it there.",
  approvalRemoteRefused:
    "I couldn't pass that approval on. That machine can't take approvals from here. Update GOAT there, or answer it in the thread.",
} as const;
