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

// A tick left reading the never FIFO (a watchdog stopped between starting a tick and naming it)
// ends when the FIFO gains and loses a writer.
const releaseNever = (dir: string) => {
  try {
    NodeFS.closeSync(
      NodeFS.openSync(
        NodePath.join(dir, "never"),
        NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK,
      ),
    );
  } catch {
    // No reader is left.
  }
};

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
        if (NodeFS.existsSync(NodePath.join(dir, "never"))) releaseNever(dir);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(
    ["dash", "bash"].flatMap((shell) =>
      [true, false].map((trapsHangup) => ({ shell, trapsHangup })),
    ),
  )(
    "on Windows hangs up first and force-ends the tree only when the script outlives the grace ($shell, traps hang-up: $trapsHangup)",
    async ({ shell, trapsHangup }) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        const bin = NodePath.join(dir, "bin");
        NodeFS.mkdirSync(bin);
        for (const fifo of ["gate", "block", "never"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        const shims: Record<string, string> = {
          uname: "echo MINGW64_NT-10.0-26200",
          cat: 'case "$1" in /proc/*/winpid) echo 4242 ;; *) exec /bin/cat "$@" ;; esac',
          // Records the forced end and, standing in for it, releases the script.
          "taskkill.exe":
            'echo "$*" >> "$GOAT_TEST_DIR/taskkill"\nprintf x > "$GOAT_TEST_DIR/block"',
          // Tick 1 waits until the script is stuck; the deadline's other ticks pass at once. Grace
          // ticks never pass for a script that ends on hang-up, so only its exit can end them.
          sleep: [
            'n=$(($(/bin/cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
            'if [ "$n" = 1 ]; then exec /bin/cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
            'if [ "$n" -gt 3 ] && [ "$GOAT_TEST_GRACE" = hold ]; then exec /bin/cat "$GOAT_TEST_DIR/never"; fi',
          ].join("\n"),
        };
        for (const [name, body] of Object.entries(shims))
          NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        const body = [
          trapsHangup ? "trap 'exit 129' HUP" : "trap '' HUP",
          "trap 'echo cleaned > \"$1/cleaned\"' EXIT",
          'printf go > "$1/gate"',
          '/bin/cat "$1/block" >/dev/null',
        ].join("\n");
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = NodeChildProcess.spawn(shell, ["-s", "--", dir], {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              GOAT_TEST_DIR: dir,
              GOAT_TEST_GRACE: trapsHangup ? "hold" : "pass",
            },
            stdio: ["pipe", "ignore", "inherit"],
          });
          child.once("error", reject);
          child.once("close", (exit, signal) => resolve(exit ?? (signal === null ? null : 128)));
          child.stdin.end(withRemoteDeadline(body, 1_000, NodePath.join(bin, "sleep")));
        });
        expect(NodeFS.readFileSync(NodePath.join(dir, "cleaned"), "utf8")).toBe("cleaned\n");
        if (trapsHangup) {
          expect(code).toBe(129);
          // The script released its locks itself; nothing forced it.
          expect(NodeFS.existsSync(NodePath.join(dir, "taskkill"))).toBe(false);
        } else {
          expect(NodeFS.readFileSync(NodePath.join(dir, "taskkill"), "utf8")).toBe(
            "/PID 4242 /T /F\n",
          );
        }
      } finally {
        if (NodeFS.existsSync(NodePath.join(dir, "never"))) releaseNever(dir);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(["dash", "bash"])(
    "on Git Bash, without pgrep, finds the script's processes through ps and hangs them up (%s)",
    async (shell) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        const bin = NodePath.join(dir, "bin");
        NodeFS.mkdirSync(bin);
        for (const fifo of ["gate", "block", "never"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        // Git Bash: no pgrep at all, and a ps without -o that prints PID PPID PGID WINPID TTY UID
        // STIME COMMAND, with a status letter in front of some rows.
        const shims: Record<string, string> = {
          uname: "echo MINGW64_NT-10.0-26200",
          cat: 'case "$1" in /proc/*/winpid) echo 4242 ;; *) exec /bin/cat "$@" ;; esac',
          ps: [
            'if [ "$#" -gt 0 ]; then echo "ps: unknown option -- o" >&2; exit 1; fi',
            'echo "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND"',
            "/bin/ps -e -o pid=,ppid=,pgid= | while read -r pid ppid pgid; do",
            '  flag=" "; [ $((pid % 2)) = 1 ] && flag=I',
            '  printf "%s %7d %7d %7d %10d %5s %11d %8s %s\\n" "$flag" "$pid" "$ppid" "$pgid" 99 pty0 197609 12:00:00 /usr/bin/sh',
            "done",
          ].join("\n"),
          "taskkill.exe": 'echo "$*" >> "$GOAT_TEST_DIR/taskkill"',
          // Tick 1 waits until the script is stuck and the deadline's other ticks pass at once. The
          // first grace tick lets a script that never got the hang-up finish on its own.
          sleep: [
            'n=$(($(/bin/cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
            'if [ "$n" = 1 ]; then exec /bin/cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
            'if [ "$n" = 4 ]; then printf x > "$GOAT_TEST_DIR/block"; fi',
            'if [ "$n" -gt 3 ]; then exec /bin/cat "$GOAT_TEST_DIR/never"; fi',
          ].join("\n"),
        };
        for (const [name, body] of Object.entries(shims))
          NodeFS.writeFileSync(NodePath.join(bin, name), "#!/bin/sh\n" + body + "\n", {
            mode: 0o755,
          });
        for (const entry of (process.env.PATH ?? "").split(":")) {
          if (entry === "") continue;
          for (const name of NodeFS.existsSync(entry) ? NodeFS.readdirSync(entry) : []) {
            if (name === "pgrep" || NodeFS.existsSync(NodePath.join(bin, name))) continue;
            NodeFS.symlinkSync(NodePath.join(entry, name), NodePath.join(bin, name));
          }
        }
        const body = [
          "trap 'exit 129' HUP",
          "trap 'echo cleaned > \"$1/cleaned\"' EXIT",
          'printf go > "$1/gate"',
          '/bin/cat "$1/block" >/dev/null',
        ].join("\n");
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = NodeChildProcess.spawn(shell, ["-s", "--", dir], {
            env: { ...process.env, PATH: bin, GOAT_TEST_DIR: dir },
            stdio: ["pipe", "ignore", "inherit"],
          });
          child.once("error", reject);
          child.once("close", (exit, signal) => resolve(exit ?? (signal === null ? null : 128)));
          child.stdin.end(withRemoteDeadline(body, 1_000, NodePath.join(bin, "sleep")));
        });
        // Ended by the hang-up, after its own cleanup, without a forced end.
        expect(code).toBe(129);
        expect(NodeFS.readFileSync(NodePath.join(dir, "cleaned"), "utf8")).toBe("cleaned\n");
        expect(NodeFS.existsSync(NodePath.join(dir, "taskkill"))).toBe(false);
      } finally {
        if (NodeFS.existsSync(NodePath.join(dir, "never"))) releaseNever(dir);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
