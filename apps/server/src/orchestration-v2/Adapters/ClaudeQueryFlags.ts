const CLAUDE_CODE_MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

export function claudeQueryFlagEnvironment(input: {
  readonly environment: Readonly<Record<string, string>> | undefined;
  readonly model: string;
  readonly autoCompactWindow: string | undefined;
  readonly toolSearchOverride: "true" | undefined;
}) {
  return {
    ...input.environment,
    ...(input.autoCompactWindow === undefined
      ? {}
      : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: input.autoCompactWindow }),
    ...(CLAUDE_CODE_MODEL_ALIASES.has(input.model)
      ? { [`ANTHROPIC_DEFAULT_${input.model.toUpperCase()}_MODEL`]: input.model }
      : {}),
    ...(input.toolSearchOverride === undefined
      ? {}
      : { ENABLE_TOOL_SEARCH: input.toolSearchOverride }),
  };
}
