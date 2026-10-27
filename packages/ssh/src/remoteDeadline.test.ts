// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { isRemoteShellScript, withRemoteDeadline } from "./remoteDeadline.ts";

const runShell = (script: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  new Promise<{ readonly code: number | null; readonly stdout: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn("sh", ["-s", "--", ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
    child.stdin.end(script);
  });

describe.skipIf(process.platform === "win32")("remote deadline wrapper", () => {
  it("wraps only scripts that sh reads from stdin", () => {
    expect(isRemoteShellScript(["sh", "-l", "-s", "--", "runtime"])).toBe(true);
    expect(isRemoteShellScript(["sh", "-s"])).toBe(true);
    expect(isRemoteShellScript(["sh", "-c", "cat > archive"])).toBe(false);
    expect(isRemoteShellScript(["goat", "-s"])).toBe(false);
  });

  it("keeps the script's arguments, output and exit status", async () => {
    const script = withRemoteDeadline('printf "%s|" "$@"\nexit 7', 60_000);
    expect(await runShell(script, ["a b", "c"])).toEqual({ code: 7, stdout: "a b|c|" });
  });

  it("hangs up a script still running after the client's deadline, sparing nohup children", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
    try {
      const bin = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(bin);
      for (const fifo of ["gate", "block", "keep"])
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
      // The watchdog's clock: the first tick waits until the script is stuck, later ticks are instant.
      NodeFS.writeFileSync(
        NodePath.join(bin, "sleep"),
        '#!/bin/sh\nif [ -p "$GOAT_TEST_GATE" ]; then cat "$GOAT_TEST_GATE" >/dev/null; rm -f "$GOAT_TEST_GATE"; fi\n',
        { mode: 0o755 },
      );
      const body = [
        'nohup cat "$1/keep" >/dev/null 2>&1 &',
        'echo $! > "$1/kept.pid"',
        'printf go > "$1/gate"',
        'cat "$1/block"',
        "echo unreachable",
      ].join("\n");
      const clock = NodePath.join(bin, "sleep");
      const result = await runShell(withRemoteDeadline(body, 1_000, clock), [dir], {
        GOAT_TEST_GATE: NodePath.join(dir, "gate"),
      });
      expect(result.stdout).toBe("");
      expect(result.code).not.toBe(0);
      const kept = Number(NodeFS.readFileSync(NodePath.join(dir, "kept.pid"), "utf8"));
      expect(() => process.kill(kept, 0)).not.toThrow();
      // Release the surviving reader so nothing outlives the test.
      NodeFS.writeFileSync(NodePath.join(dir, "keep"), "");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
