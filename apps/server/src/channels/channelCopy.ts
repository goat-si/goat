/**
 * Fixed words the channel layer sends without asking a model: link notices and failure notes.
 *
 * @module channelCopy
 */
export const CHANNEL_COPY = {
  linkHelp:
    'I don\'t know who you are yet. Open GOAT, go to Settings → Integrations → Slack, create a link code, and send it to me as "link <code>".',
  linkInvalid: "That link code is wrong or expired. Create a new one in GOAT and try again.",
  linked: "You're linked. Send me what you need.",
  unlinkedInput:
    'I can\'t take work from this account yet. Open GOAT, create a link code under Settings → Integrations → Slack, and send me "link <code>".',
  receptionFailed: "I couldn't read that just now. Please send it again.",
  agentCannotCreateWork:
    "Only people can start new work. I can tell you how existing work is going.",
  noReceptionModel:
    "No reception model is available. Pick a Codex or Claude model for text generation in GOAT settings.",
  answerForwarded: "Thanks. I passed your answer on.",
  answerNotAllowed:
    "I can't pass that on: answering this task's question needs the same access as the person who asked for it.",
} as const;
