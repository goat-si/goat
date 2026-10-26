export const POWERSHELL_FLAGS = new Set([
  "-mta",
  "-nologo",
  "-noninteractive",
  "-noprofile",
  "-sta",
]);
export const POWERSHELL_OPTIONS_WITH_VALUE = new Set([
  "-configurationname",
  "-executionpolicy",
  "-inputformat",
  "-outputformat",
  "-version",
  "-windowstyle",
  "-workingdirectory",
]);

/** Index of the script after `-Command`/`-c`, or null when the call runs a file or anything else. */
export function powerShellCommandArgumentIndex(tokens: ReadonlyArray<string>): number | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index]?.toLowerCase() ?? "";
    if (!option.startsWith("-")) return null;
    if (option === "-c" || option === "-command") return index + 1;
    if (POWERSHELL_OPTIONS_WITH_VALUE.has(option)) index += 1;
    else if (!POWERSHELL_FLAGS.has(option)) return null;
  }
  return null;
}
