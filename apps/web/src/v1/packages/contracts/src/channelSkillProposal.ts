import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChannelTaskId } from "./channelCommon.ts";

/** The skill file is <name>.md, so the name is one safe lowercase file name. */
export const SKILL_PROPOSAL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/u;
export const SKILL_PROPOSAL_SUMMARY_MAX = 200;
export const SKILL_PROPOSAL_TEXT_MAX = 8192;
export const SKILL_PROPOSAL_SAVE = "Save";
export const SKILL_PROPOSAL_DECLINE = "Not now";
export const SKILL_PROPOSAL_OPTIONS = [SKILL_PROPOSAL_SAVE, SKILL_PROPOSAL_DECLINE] as const;

/** A procedure a worker offers to keep as a GOAT Bot skill; nothing is saved unless the requester agrees. */
export const ChannelSkillProposal = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(SKILL_PROPOSAL_NAME_PATTERN)),
  summary: TrimmedNonEmptyString.check(
    Schema.isMaxLength(SKILL_PROPOSAL_SUMMARY_MAX),
    Schema.isPattern(/^[^\r\n]*$/u),
  ),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_PROPOSAL_TEXT_MAX)),
});
export type ChannelSkillProposal = typeof ChannelSkillProposal.Type;

/** Marks a server-owned task that only asks whether to save a proposal; it never gets a worker. */
export const ChannelTaskSkillProposal = Schema.Struct({
  ...ChannelSkillProposal.fields,
  sourceTaskId: ChannelTaskId,
  sourceTitle: TrimmedNonEmptyString,
  /** Frozen when the proposal was made, so every save attempt writes the same bytes. */
  requesterName: Schema.String,
});
export type ChannelTaskSkillProposal = typeof ChannelTaskSkillProposal.Type;
