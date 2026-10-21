/**
 * JavaScript for a fixture server spawned directly by a test: exit once stdin
 * ends. The test worker holds the other end of that pipe, so this fires when
 * the worker dies or times out before its scope finalizers run, which
 * otherwise leaves the server running under PID 1. Servers that the launch
 * script starts get `</dev/null` and must not use this.
 */
export const exitWithTestParent = (condition: string) =>
  `if (${condition}) { process.stdin.once("end", () => process.exit(0)); process.stdin.once("error", () => process.exit(0)); process.stdin.resume(); }`;

/** Where a fixture records the test worker that owns the servers it starts. */
export const TEST_OWNER_FILE = "owner-pid";

/**
 * JavaScript for a fixture server the launch script starts. Its stdin is `/dev/null` and it
 * outlives the shell on purpose, so it watches instead: it exits once the test worker named in
 * `<fixtureDir>/owner-pid` is gone or the fixture directory was removed. Without this, a worker
 * killed before its scope finalizers leaves the server running under PID 1.
 */
export const exitWithTestOwner = (fixtureDir: string) =>
  `{ const ownerFs = require("node:fs"); const ownerDir = ${fixtureDir};
  const ownerFile = require("node:path").join(ownerDir, ${JSON.stringify(TEST_OWNER_FILE)});
  const owner = ownerFs.existsSync(ownerFile) ? Number(ownerFs.readFileSync(ownerFile, "utf8")) : 0;
  setInterval(() => {
    let alive = ownerFs.existsSync(ownerDir);
    if (alive && owner > 0) { try { process.kill(owner, 0); } catch (error) { alive = error.code === "EPERM"; } }
    if (!alive) process.exit(0);
  }, 500).unref(); }`;
