import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseGoalCommand } from "@goat/contracts";
import {
  planClaudeSkillDispatch,
  type ClaudeSkillTarget,
} from "../../provider/Drivers/ClaudeSkillDispatch.ts";

export function makeClaudeUserMessage(input: {
  readonly text: string;
  readonly priority?: SDKUserMessage["priority"];
  readonly skills?: ReadonlyMap<string, ClaudeSkillTarget>;
  readonly skillMentionsFrom?: number;
  readonly uuid?: SDKUserMessage["uuid"];
}): SDKUserMessage {
  // Claude expands a skill only when `/name` starts the last text block.
  // Keep the whole request before that block; see ClaudeSkillDispatch.
  const dispatch =
    input.skills === undefined
      ? undefined
      : planClaudeSkillDispatch(input.text, input.skills, input.skillMentionsFrom);
  // Claude runs `/goal` only when it opens the prompt, so a goal stays one block.
  const isGoalCommand = parseGoalCommand({ text: input.text }) !== null;
  return {
    type: "user",
    message: {
      role: "user",
      content: isGoalCommand
        ? (dispatch?.leadingText ?? input.text)
        : dispatch
          ? [
              ...(dispatch.leadingText === undefined
                ? []
                : [{ type: "text" as const, text: dispatch.leadingText }]),
              { type: "text" as const, text: dispatch.commandText },
            ]
          : input.text,
    },
    parent_tool_use_id: null,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.uuid === undefined ? {} : { uuid: input.uuid }),
  };
}

export function handoffSkillOffset(
  promptText: string,
  userText: string,
  inlineContextLength: number | undefined,
) {
  return inlineContextLength === undefined
    ? {}
    : {
        skillMentionsFrom: promptText.length - userText.slice(inlineContextLength).trimEnd().length,
      };
}
