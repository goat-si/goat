// Lifted from provider-opencode/src/server/openCodeConfigContent.ts:1-10 at 916b5ccc1b2.
export function resolveOpenCodeConfigContent(
  inputEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return inputEnvironment?.OPENCODE_CONFIG_CONTENT ?? inheritedEnvironment.OPENCODE_CONFIG_CONTENT ?? "{}";
}
