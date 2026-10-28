/**
 * The driver's own tools, withheld from a turn that reaches the desktop through goat_screen_run.
 * The proxy still runs for that turn, because screen code drives the desktop through its channel.
 */
// JSON-RPC lines pass through unchanged apart from a tool listing and the initialize answer.
// @effect-diagnostics preferSchemaOverJson:off

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A tool listing with no tools, and an initialize answer without instructions about them. */
export function withoutDriverTools(line: string): string {
  if (!line.includes('"tools"') && !line.includes('"instructions"')) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  const result = record(record(message)?.result);
  if (result === undefined) return line;
  if (Array.isArray(result.tools))
    return JSON.stringify({ ...record(message), result: { ...result, tools: [] } });
  if ("protocolVersion" in result && "instructions" in result) {
    const { instructions: _instructions, ...rest } = result;
    return JSON.stringify({ ...record(message), result: rest });
  }
  return line;
}
