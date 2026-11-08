// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import { isRemoteShellScript, withRemoteDeadline } from "./remoteDeadline.ts";

const runShell = (
  script: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
  // sshd starts a non-terminal session's shell as the leader of its own session.
  options: { readonly shell?: string; readonly sessionLeader?: boolean } = {},
) =>
  new Promise<{ readonly code: number | null; readonly stdout: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(options.shell ?? "sh", ["-s", "--", ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
      detached: options.sessionLeader === true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
    child.stdin.end(script);
  });

// A stopped watchdog leaves its tick to end by itself; one reading the never FIFO ends when the
// FIFO gains and loses a writer.
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

  it.each(["dash", "bash"])(
    "hangs up a script still running after the client's deadline, sparing nohup children (%s)",
    async (shell) => {
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
        const result = await runShell(
          withRemoteDeadline(body, 1_000, clock),
          [dir],
          { GOAT_TEST_GATE: NodePath.join(dir, "gate") },
          { shell, sessionLeader: true },
        );
        expect(result.stdout).toBe("");
        expect(result.code).not.toBe(0);
        const kept = Number(NodeFS.readFileSync(NodePath.join(dir, "kept.pid"), "utf8"));
        expect(() => process.kill(kept, 0)).not.toThrow();
        // Release the surviving reader so nothing outlives the test.
        NodeFS.writeFileSync(NodePath.join(dir, "keep"), "");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(["dash", "bash"])(
    "returns as soon as the script exits, leaving no watchdog behind (%s)",
    async (shell) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        for (const fifo of ["ticking", "never"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        // The watchdog's clock records the watchdog's PID and then ticks far past the test.
        const clock = NodePath.join(dir, "sleep");
        NodeFS.writeFileSync(
          clock,
          '#!/bin/sh\necho $PPID > "$GOAT_TEST_DIR/watchdog.pid"\nprintf x > "$GOAT_TEST_DIR/ticking"\nexec cat "$GOAT_TEST_DIR/never"\n',
          { mode: 0o755 },
        );
        const script = withRemoteDeadline('cat "$1/ticking" >/dev/null\nexit 3', 60_000, clock);
        // The shell's output closes although the tick still runs: the tick holds only /dev/null.
        expect(await runShell(script, [dir], { GOAT_TEST_DIR: dir }, { shell })).toEqual({
          code: 3,
          stdout: "",
        });
        // A watchdog left ticking would hold a Windows SSH channel open until its next tick.
        const watchdog = Number(NodeFS.readFileSync(NodePath.join(dir, "watchdog.pid"), "utf8"));
        expect(() => process.kill(watchdog, 0)).toThrow();
      } finally {
        releaseNever(dir);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
            // As under sshd, the shell leads its session, so a hang-up reaches the script's command.
            detached: true,
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
  // Git Bash's sh is bash.
  it.each([true, false].map((trapsHangup) => ({ shell: "bash", trapsHangup })))(
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
          "taskkill.exe": 'echo "$*" >> "$GOAT_TEST_DIR/taskkill"',
          // Tick 1 waits until the script is stuck; the deadline's other ticks pass at once. Grace
          // ticks never pass for a script that ends on hang-up, so only its exit can end them.
          // Tick 9, the first after the forced end, stands in for it: it releases the script, then
          // waits like every later tick.
          sleep: [
            'n=$(($(/bin/cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
            'if [ "$n" = 1 ]; then exec /bin/cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
            'if [ "$n" = 9 ]; then printf x > "$GOAT_TEST_DIR/block"; fi',
            'if [ "$n" -gt 8 ] || { [ "$n" -gt 3 ] && [ "$GOAT_TEST_GRACE" = hold ]; }; then exec /bin/cat "$GOAT_TEST_DIR/never"; fi',
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
  it("on Git Bash hangs up the script without reading a process list", async () => {
    const shell = "bash";
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
    try {
      const bin = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(bin);
      for (const fifo of ["gate", "block", "never"])
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
      // Git Bash has no pgrep and a ps without -o. A PID read from a process list can be reused
      // before it is signalled, so neither may be asked.
      const shims: Record<string, string> = {
        uname: "echo MINGW64_NT-10.0-26200",
        cat: 'case "$1" in /proc/*/winpid) echo 4242 ;; *) exec /bin/cat "$@" ;; esac',
        pgrep: 'echo "pgrep $*" >> "$GOAT_TEST_DIR/listed"; exit 1',
        ps: [
          'echo "ps $*" >> "$GOAT_TEST_DIR/listed"',
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
          'if [ "$n" = 4 ]; then printf x 1<>"$GOAT_TEST_DIR/block"; fi',
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
      expect(NodeFS.existsSync(NodePath.join(dir, "listed"))).toBe(false);
    } finally {
      if (NodeFS.existsSync(NodePath.join(dir, "never"))) releaseNever(dir);
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it
    .skipIf(!NodeFS.existsSync("/proc/self/stat"))
    .each(
      ["dash", "bash"].flatMap((shell) => [true, false].map((deadline) => ({ shell, deadline }))),
    )(
    "signals only its own process group or a live child, never a PID that may be reused ($shell, deadline: $deadline)",
    async ({ shell, deadline }) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        for (const fifo of ["go", "never"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        // Ticks start and end around the script. Without a deadline tick 3 lets the script finish,
        // so the watchdog is stopped mid-tick; with one, the script waits to be hung up.
        const clock = NodePath.join(dir, "sleep");
        NodeFS.writeFileSync(
          clock,
          [
            "#!/bin/sh",
            'n=$(($(cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
            'if [ "$n" = 3 ] && [ "$GOAT_TEST_DEADLINE" = false ]; then printf x > "$GOAT_TEST_DIR/go"; fi',
            'if [ "$n" -gt 3 ]; then exec cat "$GOAT_TEST_DIR/never"; fi',
          ].join("\n") + "\n",
          { mode: 0o755 },
        );
        // Each signal records whether its target is the sender's own group, the sender's live child,
        // or anything else, which a PID read earlier could name by the time it is signalled.
        const recordKills = [
          "kill() {",
          "  for target; do :; done",
          '  case "$1" in -0) ;; *)',
          '    IFS= read -r me </proc/self/stat; me="$' + '{me%% *}"',
          "    parent=",
          '    if IFS= read -r st <"/proc/$target/stat" 2>/dev/null; then st="$' +
            '{st##*) }"; st="$' +
            '{st#* }"; parent="$' +
            '{st%% *}"; fi',
          '    case "$target:$parent" in 0:*) echo group ;; *:"$me") echo child ;; *) echo "other $target" ;; esac >> "$GOAT_TEST_DIR/signalled"',
          "  esac",
          '  command kill "$@"',
          "}",
          "",
        ].join("\n");
        const result = await runShell(
          recordKills +
            withRemoteDeadline('cat "$1/go" >/dev/null', deadline ? 1_000 : 60_000, clock),
          [dir],
          { GOAT_TEST_DIR: dir, GOAT_TEST_DEADLINE: String(deadline) },
          { shell, sessionLeader: true },
        );
        expect(result.code).toBe(deadline ? 129 : 0);
        const signalled = NodeFS.readFileSync(NodePath.join(dir, "signalled"), "utf8")
          .trim()
          .split("\n");
        // The watchdog is stopped by the shell that started it, after the hang-up if there was one.
        expect(signalled).toEqual(deadline ? ["group", "child"] : ["child"]);
      } finally {
        releaseNever(dir);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(["dash", "bash"])(
    "never hangs up the caller's process group when the shell does not lead it (%s)",
    async (shell) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        for (const fifo of ["gate", "block", "keep", "never"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        // Tick 1 waits until the script is stuck and later deadline ticks pass at once. Tick 4 comes
        // only for a script nothing hung up: it releases the script, and later ticks wait.
        const clock = NodePath.join(dir, "sleep");
        NodeFS.writeFileSync(
          clock,
          [
            "#!/bin/sh",
            'n=$(($(cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
            'if [ "$n" = 1 ]; then exec cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
            'if [ "$n" = 4 ]; then printf x 1<>"$GOAT_TEST_DIR/block"; fi',
            'if [ "$n" -gt 4 ]; then exec cat "$GOAT_TEST_DIR/never"; fi',
          ].join("\n") + "\n",
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          NodePath.join(dir, "wrapped.sh"),
          withRemoteDeadline(
            'printf go > "$1/gate"\ncat "$1/block" >/dev/null && echo released',
            1_000,
            clock,
          ),
        );
        // The caller leads its group and runs the wrapped shell in it, beside a sibling that a
        // hang-up of the whole group would end.
        const caller = [
          'cat "$1/keep" >/dev/null & echo $! > "$1/sibling.pid"',
          '"$2" -s -- "$1" < "$1/wrapped.sh" > "$1/out"; echo "$?" > "$1/code"',
        ].join("\n");
        await new Promise<void>((resolve, reject) => {
          const child = NodeChildProcess.spawn("sh", ["-c", caller, "sh", dir, shell], {
            env: { ...process.env, GOAT_TEST_DIR: dir },
            stdio: ["ignore", "ignore", "inherit"],
            detached: true,
          });
          child.once("error", reject);
          child.once("close", () => resolve());
        });
        const sibling = Number(NodeFS.readFileSync(NodePath.join(dir, "sibling.pid"), "utf8"));
        expect(() => process.kill(sibling, 0)).not.toThrow();
        const code = NodeFS.readFileSync(NodePath.join(dir, "code"), "utf8").trim();
        const out = NodeFS.readFileSync(NodePath.join(dir, "out"), "utf8");
        if (shell === "bash") {
          // bash gives the job a group of its own, which the watchdog hangs up.
          expect(code).toBe("129");
          expect(out).toBe("");
        } else {
          // dash cannot, and signals nothing it would have to name by number.
          expect(code).toBe("0");
          expect(out).toBe("released\n");
        }
        // Release the surviving sibling so nothing outlives the test.
        NodeFS.writeFileSync(NodePath.join(dir, "keep"), "");
      } finally {
        releaseNever(dir);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
