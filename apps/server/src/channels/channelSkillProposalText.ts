/**
 * The words and bytes of a GOAT Bot skill proposal. A worker's finished task may offer a procedure
 * as a skill; the requester sees the whole text in the GOAT app and only their Save writes it.
 *
 * @module channelSkillProposalText
 */
import {
  type ChannelOpenQuestion,
  type ChannelRequester,
  type ChannelSkillProposal,
  type ChannelTask,
  type ChannelTaskSkillProposal,
  SKILL_PROPOSAL_OPTIONS,
} from "@goat/contracts";

import { redactGoatCredentials } from "../mcp/goatCredentialRedaction.ts";
import { scanMemoryValue } from "../memory/MemorySecretScanner.ts";
import { mayDirect } from "./ChannelGateway.ts";

const HEADER_VALUE_CHARS = 120;

export const skillProposalQuestion = (proposal: ChannelSkillProposal) =>
  "Save this as a skill? " + proposal.name + ": " + proposal.summary + "\n\n" + proposal.text;

/** What a model may read of a question: a proposal's body is worker text, so only its first line. */
export const questionTextForModel = (task: ChannelTask, question: ChannelOpenQuestion) =>
  task.skillProposal === undefined ? question.text : (question.text.split("\n", 1)[0] ?? "");

/**
 * The saved file names its approver, so only that person may answer a proposal.
 * The answer resumes no run: it saves text they already see, so memory and runtime
 * ceilings are not compared. Every other question still is.
 */
export const mayAnswerTask = (
  answerer: ChannelRequester,
  task: ChannelTask,
  connectionId?: string,
) =>
  task.skillProposal === undefined
    ? mayDirect(answerer, connectionId, task)
    : answerer.ownerId === task.requester.ownerId &&
      answerer.principalId === task.requester.principalId &&
      answerer.grantedScopes.includes("orchestration:operate");

export const isSkillProposalAnswer = (answer: string) =>
  (SKILL_PROPOSAL_OPTIONS as ReadonlyArray<string>).includes(answer.trim());

/** Why a completed task's proposal is not offered, or undefined to offer it. */
export const skillProposalDropReason = (task: ChannelTask, proposal: ChannelSkillProposal) => {
  // Only the GOAT app shows the whole proposal next to Save; Slack cuts long messages.
  if (task.originAddress.kind !== "goat" || task.requester.originKind !== "goat")
    return "not_goat_app";
  if (task.skillProposal !== undefined) return "proposal_task";
  for (const value of [proposal.name, proposal.summary, proposal.text]) {
    if (scanMemoryValue(value).kind === "blocked" || redactGoatCredentials(value) !== value)
      return "secret";
  }
  return undefined;
};

const headerValue = (value: string) =>
  value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, HEADER_VALUE_CHARS);

/**
 * The exact file a Save writes. Every input is stored on the task or its answer, so any attempt,
 * including one resumed after a restart, writes the same bytes.
 */
export const skillFileText = (input: {
  readonly taskId: string;
  readonly proposal: ChannelTaskSkillProposal;
  readonly approvedAt: string;
}) =>
  input.proposal.text +
  "\n\n---\nProposed by GOAT Bot after " +
  headerValue(input.proposal.sourceTitle) +
  " on " +
  input.approvedAt.slice(0, 10) +
  "; approved by " +
  headerValue(input.proposal.requesterName) +
  ".\n<!-- goat-skill-proposal " +
  input.taskId +
  " -->\n";
