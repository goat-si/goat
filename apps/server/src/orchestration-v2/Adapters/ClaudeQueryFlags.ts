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

const CLAUDE_SCIENTIFIC_INTEGER = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/;
const CLAUDE_GROUPED_INTEGER = /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/;
export function parseClaudeInteger(text: string): number {
  const value = text.trim();
  if (value.length <= 32 && CLAUDE_SCIENTIFIC_INTEGER.test(value)) {
    const number = Number(value);
    return Number.isInteger(number) ? number : Number.NaN;
  }
  if (value.length <= 32 && CLAUDE_GROUPED_INTEGER.test(value)) {
    return Number.parseInt(value.replace(/[_,\u00A0\u202F ]/g, ""), 10);
  }
  return Number.parseInt(value, 10);
}
