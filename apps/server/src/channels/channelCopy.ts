/**
 * Fixed words the channel layer sends without asking a model: link notices and failure notes.
 *
 * @module channelCopy
 */
import type { TextGenerationFailureKind } from "@goat/provider-core/server/textGenerationUtils";

export const CHANNEL_COPY = {
  // oxlint-disable-next-line goat/no-em-dash-copy -- The approved receipt protocol fixes this exact text.
  sessionWorking: "Working on it — I'll reply here.",
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
    "I can't pass that on: answering this task's question needs the same access as the person who asked for it, GOAT memory included.",
  approvalNotAllowed:
    "I can't pass that on: answering this approval needs the same access as the person who asked for the work, GOAT memory included.",
  approvalAlreadyAnswered: "That approval was already answered.",
  approvalNotByNumber:
    "While an approval is waiting, a number doesn't answer anything. Reply with the words below, or with a question's choice.",
  approvalNeedsCode: "Which approval? Reply with its code, so I answer the one you mean.",
  approvalDetailUnreadable:
    "I can't show what it asks here, so open its thread in GOAT to answer it.",
  approvalDetailNotShown:
    "I can't show what this asks here. Check its thread in GOAT before answering.",
  approvalsMoreWaiting: " more waiting. They show here once these are answered, or open GOAT.",
  approvalFailed:
    "I couldn't pass that approval on. Open the work's thread in GOAT to answer it there.",
  approvalRemoteRefused:
    "I couldn't pass that approval on. That machine can't take approvals from here. Update GOAT there, or answer it in the thread.",
  noteCorrectionUnmatched:
    "I saved that, but couldn't find the earlier note it changes. If an older note says otherwise, ask me to forget it.",
  noteNotSaved: "I couldn't save that note, so it won't apply yet. Please ask me again.",
  noteChanged: "Changed that note.",
  noteForgotten: "Forgot that note.",
  noteNotFound: "I couldn't find that note in my notes, so nothing changed.",
  noteEditBusy:
    "Another change to my notes is still in progress, so nothing changed. Try again when it finishes.",
  noteEditFailed: "I couldn't change my notes just now, so nothing changed. Please try again.",
  noteFileTooLarge: "My notes file is too large to edit here, so nothing changed.",
  noteEditNotAllowed: "Only someone linked to GOAT Bot can change its notes.",
  noteEditTaskDone:
    "That notes change didn't start: the request it belonged to had already finished. Ask me again.",
  noteCameBack:
    "I removed that note, but it came back because something else wrote my notes at the same time. Please check the Memory tab.",
  noteUnverified:
    "I removed that note, but couldn't check my notes file afterwards. Please check the Memory tab.",
  noteForgetWouldRebind:
    "Forgetting that note would change which note another one replaces, so nothing changed.",
} as const;

/** Sent when GOAT put back a note it had refused to forget while another notes change ran. */
export const noteKeptNotice = (note: string) =>
  "I kept this note: " +
  JSON.stringify(note) +
  ". You asked me to forget it while another change to my notes was running, so that request changed nothing. Ask again if you still want it gone.";

const notesRead = (note: string, count: number) =>
  (count === 2 ? "Two notes read “" : count + " notes read “") + note + "”";

// A request in the person's own words reaches a turn that may edit the notes file by hand.
const TIDY_NOTES = " To clean them up, ask me in your own words which one to remove.";

/** The answer to a Memory tab change or forget whose words more than one current note reads. */
export const notesAlikeAnswer = (note: string, count: number) =>
  notesRead(note, count) +
  (count === 2 ? ", so I left them both." : ", so I left them all.") +
  TIDY_NOTES;

/** The reply to a correction whose words more than one current note reads: nothing was saved. */
export const notesAlikeNotSaved = (note: string, count: number) =>
  notesRead(note, count) +
  ", so I didn't save that change: I can't tell which one it replaces." +
  TIDY_NOTES;

/** What a model reads for a person's message: its text, then the names of the files sent with it. */
export const inboundTextWithFiles = (message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly name: string }>;
}) =>
  message.attachments.length === 0
    ? message.text
    : [message.text.trim(), "Attached: " + message.attachments.map((file) => file.name).join(", ")]
        .filter((part) => part !== "")
        .join("\n\n");
