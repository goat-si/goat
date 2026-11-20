import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { ClaudeAgentSdkQueryOptions } from "./ClaudeAgentSdkQueryRunner.ts";

const decodeHistory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        uuid: Schema.String,
        message: Schema.Struct({ content: Schema.Unknown }),
      }),
    ),
  ),
);

export const interruptedResumeOptions = Effect.fn("ClaudeAgentSdkQueryRunner.interruptedResume")(
  function* <E, R>(
    options: ClaudeAgentSdkQueryOptions,
    readHistory: (sessionId: string) => Effect.Effect<string, E, R>,
  ) {
    if (options.resume === undefined) return options;
    const messages = yield* readHistory(options.resume).pipe(Effect.flatMap(decodeHistory));
    const savedBoundary = options.resumeSessionAt;
    let end =
      savedBoundary === undefined
        ? messages.length
        : messages.findIndex((message) => message.uuid === savedBoundary) + 1;
    const boundary = end;
    let toolInterrupted = false;
    // Native reply-on-resume starts before the CLI's synthetic abort and tool-refusal rows.
    while (end > 0) {
      const message = messages[end - 1];
      if (message?.type !== "user") break;
      const content = message.message.content;
      const blocks: unknown =
        typeof content === "string" ? [{ type: "text", text: content }] : content;
      if (!Array.isArray(blocks) || blocks.length === 0) break;
      const stop = blocks.every(
        (block: unknown) =>
          Predicate.isObject(block) &&
          block.type === "text" &&
          (block.text === "[Request interrupted by user]" ||
            block.text === "[Request interrupted by user for tool use]"),
      );
      if (stop) {
        toolInterrupted ||= blocks.some(
          (block: unknown) =>
            Predicate.isObject(block) &&
            block.text === "[Request interrupted by user for tool use]",
        );
      } else if (
        !toolInterrupted ||
        !blocks.every(
          (block: unknown) =>
            Predicate.isObject(block) &&
            block.type === "tool_result" &&
            block.is_error === true &&
            typeof block.content === "string" &&
            block.content.startsWith("The user doesn't want to proceed with this tool use."),
        )
      ) {
        break;
      }
      end--;
    }
    const resumeSessionAt = (end < boundary ? messages[end - 1]?.uuid : undefined) ?? savedBoundary;
    return {
      ...options,
      ...(resumeSessionAt === undefined ? {} : { resumeSessionAt }),
      env: {
        ...options.env,
        CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
        CLAUDE_CODE_RESUME_REASON: "user_resume",
      },
    };
  },
);
