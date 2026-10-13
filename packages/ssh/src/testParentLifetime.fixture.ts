/**
 * JavaScript for a fixture server spawned directly by a test: exit once stdin
 * ends. The test worker holds the other end of that pipe, so this fires when
 * the worker dies or times out before its scope finalizers run, which
 * otherwise leaves the server running under PID 1. Servers that the launch
 * script starts get `</dev/null` and must not use this.
 */
export const exitWithTestParent = (condition: string) =>
  `if (${condition}) { process.stdin.once("end", () => process.exit(0)); process.stdin.once("error", () => process.exit(0)); process.stdin.resume(); }`;
