export function toolPriorityLaunch(
  platform: NodeJS.Platform,
  command: string,
  args: ReadonlyArray<string> = [],
  lower = true,
) {
  return lower && (platform === "darwin" || platform === "linux")
    ? { command: "nice", args: ["-n", "10", command, ...args] }
    : { command, args };
}

// Node runs `shell: true` as `/bin/sh -c <command>` on Unix, so this is the same launch, lowered.
export function toolPriorityShellLaunch(platform: NodeJS.Platform, commandLine: string) {
  return platform === "darwin" || platform === "linux"
    ? { command: "nice", args: ["-n", "10", "/bin/sh", "-c", commandLine], shell: false }
    : { command: commandLine, args: [], shell: true };
}
