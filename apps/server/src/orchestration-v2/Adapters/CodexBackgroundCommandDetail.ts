const BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH = 200;
const BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH = 1_000;

export function codexBackgroundCommandDetail(item: {
  readonly command: string;
  readonly exitCode?: number | null | undefined;
  readonly aggregatedOutput?: string | null | undefined;
}): string {
  // Codex rejects a turn/start with a lone surrogate and never answers it, so cut on code points.
  let commandEnd = BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH;
  const finalCommandUnit = item.command.charCodeAt(commandEnd - 1);
  if (finalCommandUnit >= 0xd800 && finalCommandUnit <= 0xdbff) commandEnd -= 1;
  const command =
    item.command.length > BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH
      ? `${item.command.slice(0, commandEnd)}...`
      : item.command;
  const exit =
    item.exitCode === null || item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`;
  const output = (item.aggregatedOutput ?? "").trimEnd();
  let outputStart = output.length - BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH;
  const firstOutputUnit = output.charCodeAt(outputStart);
  if (firstOutputUnit >= 0xdc00 && firstOutputUnit <= 0xdfff) outputStart += 1;
  const outputTail = outputStart > 0 ? `...${output.slice(outputStart)}` : output;
  const header = `Background command completed${exit}: ${command}`;
  return outputTail.length === 0 ? header : `${header}\n\nOutput tail:\n${outputTail}`;
}
