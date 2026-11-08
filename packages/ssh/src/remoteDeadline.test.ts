// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";
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

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("remote deadline wrapper", () => {
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
  it("stops its watchdog as soon as the script exits", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
    try {
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "ticking")]);
      // The watchdog's clock records its PID and keeps ticking far past the test.
      const clock = NodePath.join(dir, "sleep");
      NodeFS.writeFileSync(
        clock,
        '#!/bin/sh\necho $$ > "$GOAT_TEST_DIR/clock.pid"\nprintf x > "$GOAT_TEST_DIR/ticking"\nexec sleep 30\n',
        { mode: 0o755 },
      );
      const script = withRemoteDeadline('cat "$1/ticking" >/dev/null\nexit 3', 60_000, clock);
      expect(await runShell(script, [dir], { GOAT_TEST_DIR: dir })).toEqual({
        code: 3,
        stdout: "",
      });
      // A watchdog left ticking would hold a Windows SSH channel open until its next tick.
      const clockPid = Number(NodeFS.readFileSync(NodePath.join(dir, "clock.pid"), "utf8"));
      expect(() => process.kill(clockPid, 0)).toThrow();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["dash", "bash"])(
    "keeps the lock owner's shell alive until the script's own hang-up cleanup ends (%s)",
    async (shell) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        const bin = NodePath.join(dir, "bin");
        NodeFS.mkdirSync(bin);
        for (const fifo of ["gate", "block"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        NodeFS.writeFileSync(
          NodePath.join(bin, "sleep"),
          '#!/bin/sh\nif [ -p "$GOAT_TEST_GATE" ]; then cat "$GOAT_TEST_GATE" >/dev/null; rm -f "$GOAT_TEST_GATE"; fi\n',
          { mode: 0o755 },
        );
        // Lock owners record $$; the cleanup must run while that shell still exists.
        const body = [
          "trap 'exit 129' HUP",
          "trap 'if kill -0 $$ 2>/dev/null; then echo owner-alive > \"$1/released\"; fi' EXIT",
          'printf go > "$1/gate"',
          'cat "$1/block"',
        ].join("\n");
        const result = await new Promise<number | null>((resolve, reject) => {
          const child = NodeChildProcess.spawn(shell, ["-s", "--", dir], {
            env: { ...process.env, GOAT_TEST_GATE: NodePath.join(dir, "gate") },
            stdio: ["pipe", "ignore", "inherit"],
          });
          child.once("error", reject);
          child.once("close", (code, signal) => resolve(code ?? (signal === null ? null : 128)));
          child.stdin.end(withRemoteDeadline(body, 1_000, NodePath.join(bin, "sleep")));
        });
        expect(result).not.toBe(0);
        expect(NodeFS.readFileSync(NodePath.join(dir, "released"), "utf8")).toBe("owner-alive\n");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
