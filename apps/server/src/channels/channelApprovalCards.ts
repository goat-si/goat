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
  ChannelTask,
  ChannelTaskApprovalRef,
  OrchestrationV2RuntimeRequest,
  ProviderApprovalDecision,
} from "@goat/contracts";

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
  const trimmed = text.trim();
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

/** The two buttons on an approval card. A number or a Slack button sends one of these labels. */
export const approvalChoiceLabels = (code: string): readonly [string, string] => [
  "Approve " + code,
  "Deny " + code,
];

/** The card's words and buttons; the buttons carry the card's code. */
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
      ? ""
      : "\n" +
        (prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS - 1) + "…" : prompt);
  return {
    text:
      input.card.task.title +
      ": " +
      (input.bySubagent ? "a subagent" : "the agent") +
      " wants to " +
      actionPhrase(input.kind) +
      "." +
      detail,
    options: approvalChoiceLabels(input.code),
  };
};

/** The question asked when a bare "approve" could mean more than one card. */
export const whichApproval = (
  cards: ReadonlyArray<{ readonly card: OpenApprovalCard; readonly code: string }>,
  decision: ApprovalReply["decision"],
): { readonly text: string; readonly options: ReadonlyArray<string> } => {
  const verb = decision === "accept" ? "Approve" : "Deny";
  const shown = cards.slice(0, 4);
  return {
    text:
      "More than one approval is waiting. Which one?\n" +
      shown.map((entry) => "- " + entry.code + ": " + entry.card.task.title).join("\n"),
    options: shown.map((entry) => verb + " " + entry.code),
  };
};
