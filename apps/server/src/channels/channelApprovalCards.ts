/**
 * Approve/deny cards for the approvals a GOAT Bot task's worker or its subagents wait on. A card is
 * sent once per runtime request; a reply is read without a model, so an approval never depends on
 * how a model understood the message. Which approvals are open comes from the task's observation,
 * which already drops a request once anyone answers it. Each card goes by a code the ledger issues
 * once per conversation ("A1", "A2", …), so a code, and an old card's button, names one request
 * for good.
 *
 * @module channelApprovalCards
 */
import type {
  ChannelRequester,
  ChannelTask,
  ChannelTaskApprovalRef,
  OrchestrationV2RuntimeRequest,
  ProviderApprovalDecision,
} from "@goat/contracts";

import { CHANNEL_COPY } from "./channelCopy.ts";

export interface OpenApprovalCard {
  readonly task: ChannelTask;
  readonly approval: ChannelTaskApprovalRef;
}

export const openApprovalCards = (
  tasks: ReadonlyArray<ChannelTask>,
): ReadonlyArray<OpenApprovalCard> =>
  tasks.flatMap((task) =>
    (task.observed?.needsYou ?? []).flatMap((need) =>
      need.approval === undefined ? [] : [{ task, approval: need.approval }],
    ),
  );

const ACCEPT = new Set(["approve", "approved", "allow", "accept", "승인", "허용"]);
const DECLINE = new Set(["deny", "denied", "decline", "reject", "거절", "거부"]);

/** Longer messages are conversation, not a card answer, and go to the model as usual. */
const MAX_REPLY_LENGTH = 80;
const CODE = /^a[1-9][0-9]{0,5}$/i;

export interface ApprovalReply {
  readonly decision: Extract<ProviderApprovalDecision, "accept" | "decline">;
  /** The card code that followed the verb, upper-cased; absent for a bare verb. */
  readonly code?: string;
}

/**
 * Reads "approve", "deny A3", "승인 A3" and the like. A verb followed by anything but a card code
 * ("approve the PR") is conversation, never an approval of whatever happens to be waiting.
 */
export const parseApprovalReply = (text: string): ApprovalReply | undefined => {
  // Hangul typed on a Mac can arrive decomposed.
  const trimmed = text.normalize("NFC").trim();
  if (trimmed === "" || trimmed.length > MAX_REPLY_LENGTH) return undefined;
  const [first = "", ...rest] = trimmed.split(/\s+/);
  const verb = first.toLowerCase().replace(/[.!,:]+$/, "");
  const decision = ACCEPT.has(verb) ? "accept" : DECLINE.has(verb) ? "decline" : undefined;
  if (decision === undefined) return undefined;
  const target = rest
    .join(" ")
    .replace(/^[#:\-–—\s]+/, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (target === "") return { decision };
  return CODE.test(target) ? { decision, code: target.toUpperCase() } : undefined;
};

const actionPhrase = (kind: OrchestrationV2RuntimeRequest["kind"] | undefined): string => {
  switch (kind) {
    case "command":
      return "run a command";
    case "file-change":
      return "change files";
    case "file-read":
      return "read files";
    case "permission":
      return "use more permissions";
    default:
      return "go ahead";
  }
};

const MAX_PROMPT_CHARS = 400;
/** Bounds a card so three in one Slack section (3,000 characters) keep every prompt visible. */
const MAX_TITLE_CHARS = 120;

const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1) + "…" : text;

/** The work's title as an approval card shows it. */
export const approvalTitle = (task: ChannelTask) => clip(task.title, MAX_TITLE_CHARS);

/**
 * The two buttons on an approval card, Deny first so a quick first pick never approves. A Slack
 * button or a GOAT app choice sends one of these labels; typed, they are the only approval reply.
 */
const approvalChoiceLabels = (code: string): readonly [string, string] => [
  "Deny " + code,
  "Approve " + code,
];

/** Same words a local answer records, and the provenance a remote respond requires. */
export const approvalReason = (
  decision: ApprovalReply["decision"],
  answerer: ChannelRequester,
  via: ChannelRequester["originKind"],
) =>
  (decision === "accept" ? "Approved" : "Denied") +
  " by " +
  answerer.displayName +
  " from GOAT Bot (" +
  via +
  ").";

export const approvalSent = (decision: ApprovalReply["decision"], title: string) =>
  decision === "accept"
    ? "Approved. " + title + " continues."
    : "Denied. I told the agent on " + title + " not to.";

/**
 * The card's words and buttons; the buttons carry the card's code. A request it can't show (no
 * prompt, or held on another machine) keeps its buttons and says to check the thread first.
 */
export const approvalCard = (input: {
  readonly card: OpenApprovalCard;
  readonly code: string;
  readonly bySubagent: boolean;
  readonly kind: OrchestrationV2RuntimeRequest["kind"] | undefined;
  readonly prompt: string | undefined;
}): { readonly text: string; readonly options: ReadonlyArray<string> } => {
  const prompt = input.prompt?.trim();
  const detail =
    prompt === undefined || prompt === ""
      ? "\n" + CHANNEL_COPY.approvalDetailNotShown
      : "\n" + clip(prompt, MAX_PROMPT_CHARS);
  return {
    text:
      approvalTitle(input.card.task) +
      ": " +
      (input.bySubagent ? "a subagent" : "the agent") +
      " wants to " +
      actionPhrase(input.kind) +
      "." +
      detail,
    options: approvalChoiceLabels(input.code),
  };
};
