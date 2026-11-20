import { tokenizeCliArgs } from "@goat/shared/cliArgs";

export const claudeLaunchArgParseOptions = { valueFlags: ["append-system-prompt"] };

export function claudeLaunchArgPluginDirectories(launchArgs: string | undefined) {
  const tokens = tokenizeCliArgs(launchArgs ?? "");
  const directories: string[] = [];
  for (let index = 0; index < tokens.length && tokens[index] !== "--"; index++) {
    const token = tokens[index];
    if (token === undefined) break;
    if (!token.startsWith("--") || token.includes("=")) {
      if (token.startsWith("--plugin-dir=")) directories.push(token.slice("--plugin-dir=".length));
      continue;
    }
    const next = tokens[index + 1];
    if (
      next === undefined ||
      (next.startsWith("--") && !claudeLaunchArgParseOptions.valueFlags.includes(token.slice(2)))
    )
      continue;
    if (token === "--plugin-dir") directories.push(next);
    index++;
  }
  return directories;
}
