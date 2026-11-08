// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import { isRemoteShellScript, withRemoteDeadline } from "./remoteDeadline.ts";

// The shell and everything it starts share fd 3 with the test. A clock tick that must never pass
// reads it and so blocks until the test closes its end once the shell exits. The run then settles
// only when every process holding fd 3 has exited, including a tick a stopped watchdog leaves.
const HOLD = "exec /bin/cat <&3 >/dev/null";

const spawnHeld = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly stdin?: string;
    // sshd starts a non-terminal session's shell as the leader of its own session.
    readonly sessionLeader?: boolean | undefined;
    // Runs once the shell has exited, before what it left behind is released.
    readonly onExit?: (() => void) | undefined;
  } = {},
) =>
  new Promise<{ readonly code: number | null; readonly stdout: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "inherit", "pipe"],
      detached: options.sessionLeader === true,
    });
    const hold = child.stdio[3];
    let stdout = "";
    let code: number | null = null;
    let failure: unknown;
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    if (hold instanceof NodeNet.Socket) hold.resume();
    child.once("error", reject);
    child.once("exit", (exit, signal) => {
      code = exit ?? (signal === null ? null : 128);
      try {
        options.onExit?.();
      } catch (error) {
        failure = error;
      }
      if (hold instanceof NodeNet.Socket) hold.end();
    });
    child.once("close", () =>
      failure === undefined ? resolve({ code, stdout }) : reject(failure),
    );
    child.stdin?.end(options.stdin ?? "");
  });

const runShell = (
  script: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
  options: {
    readonly shell?: string;
    readonly sessionLeader?: boolean;
    readonly onExit?: () => void;
  } = {},
) =>
  spawnHeld(options.shell ?? "sh", ["-s", "--", ...args], {
    env,
    stdin: script,
    sessionLeader: options.sessionLeader,
    onExit: options.onExit,
  });

// Each signal records whether its target is the sender's own group, the sender's live child,
// or anything else, which a PID read earlier could name by the time it is signalled.
const RECORD_KILLS = [
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

// The caller leads its group and runs the wrapped shell in it, beside a sibling that a hang-up of
// the whole group would end.
const runInCaller = async (
  dir: string,
  shell: string,
  wrapped: string,
  env: NodeJS.ProcessEnv = {},
) => {
  NodeFS.writeFileSync(NodePath.join(dir, "wrapped.sh"), wrapped);
  NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "keep")]);
  const caller = [
    'cat "$1/keep" >/dev/null & echo $! > "$1/sibling.pid"',
    '"$2" -s -- "$1" < "$1/wrapped.sh" > "$1/out"; echo "$?" > "$1/code"',
  ].join("\n");
  let siblingAlive = false;
  await spawnHeld("sh", ["-c", caller, "sh", dir, shell], {
    env: { GOAT_TEST_DIR: dir, ...env },
    sessionLeader: true,
    onExit: () => {
      const sibling = Number(NodeFS.readFileSync(NodePath.join(dir, "sibling.pid"), "utf8"));
      siblingAlive = process.kill(sibling, 0);
      // Release the surviving sibling so nothing outlives the test.
      NodeFS.writeFileSync(NodePath.join(dir, "keep"), "");
    },
  });
  const read = (name: string) => NodeFS.readFileSync(NodePath.join(dir, name), "utf8");
  return { siblingAlive, code: read("code").trim(), out: read("out") };
};
// Each line of a recorded signal log.
const signalled = (dir: string) =>
  NodeFS.existsSync(NodePath.join(dir, "signalled"))
    ? NodeFS.readFileSync(NodePath.join(dir, "signalled"), "utf8").trim().split("\n")
    : [];

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
        // The script records its shell's PID, its parent and its process group.
        const body = [
          '[ ! -r /proc/self/stat ] || { IFS= read -r st </proc/self/stat; echo "$$ $' +
            '{st##*) }" > "$1/ids"; }',
          'nohup cat "$1/keep" >/dev/null 2>&1 &',
          'echo $! > "$1/kept.pid"',
          'printf go > "$1/gate"',
          'cat "$1/block"',
          "echo unreachable",
        ].join("\n");
        const clock = NodePath.join(bin, "sleep");
        let keptAlive = false;
        const result = await runShell(
          withRemoteDeadline(body, 1_000, clock),
          [dir],
          { GOAT_TEST_GATE: NodePath.join(dir, "gate") },
          {
            shell,
            sessionLeader: true,
            onExit: () => {
              const kept = Number(NodeFS.readFileSync(NodePath.join(dir, "kept.pid"), "utf8"));
              keptAlive = process.kill(kept, 0);
              // Release the surviving reader so nothing outlives the test.
              NodeFS.writeFileSync(NodePath.join(dir, "keep"), "");
            },
          },
        );
        expect(result.stdout).toBe("");
        expect(result.code).not.toBe(0);
        expect(keptAlive).toBe(true);
        // The hang-up relied on a group of the run's own: dash's shell leads its session, and bash
        // gives the job a group led by the job's shell.
        if (NodeFS.existsSync(NodePath.join(dir, "ids"))) {
          const [outer, , parent, group] = NodeFS.readFileSync(
            NodePath.join(dir, "ids"),
            "utf8",
          ).split(" ");
          expect(group).toBe(shell === "dash" ? outer : parent);
        }
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
        for (const fifo of ["ticking"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        // The watchdog's clock records the watchdog's PID and then ticks far past the test.
        const clock = NodePath.join(dir, "sleep");
        NodeFS.writeFileSync(
          clock,
          '#!/bin/sh\necho $PPID > "$GOAT_TEST_DIR/watchdog.pid"\nprintf x > "$GOAT_TEST_DIR/ticking"\n' +
            HOLD +
            "\n",
          { mode: 0o755 },
        );
        const script = withRemoteDeadline('cat "$1/ticking" >/dev/null\nexit 3', 60_000, clock);
        expect(await runShell(script, [dir], { GOAT_TEST_DIR: dir }, { shell })).toEqual({
          code: 3,
          stdout: "",
        });
        // A watchdog left ticking would hold a Windows SSH channel open until its next tick.
        const watchdog = Number(NodeFS.readFileSync(NodePath.join(dir, "watchdog.pid"), "utf8"));
        expect(() => process.kill(watchdog, 0)).toThrow();
      } finally {
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
        const { code } = await runShell(
          withRemoteDeadline(body, 1_000, NodePath.join(bin, "sleep")),
          [dir],
          { GOAT_TEST_GATE: NodePath.join(dir, "gate") },
          { shell, sessionLeader: true },
        );
        expect(code).not.toBe(0);
        expect(NodeFS.readFileSync(NodePath.join(dir, "released"), "utf8")).toBe("owner-alive\n");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  // Git Bash's sh is bash.
  it("on Windows hangs up its own group once and never force-ends the tree", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
    try {
      const bin = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(bin);
      for (const fifo of ["gate", "block"])
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
      // Tick 1 waits until the script is stuck and the deadline's other ticks pass at once. Tick 4
      // releases the script, which ignored the hang-up as a native goat.exe child can.
      const shims: Record<string, string> = {
        uname: "echo MINGW64_NT-10.0-26200",
        "taskkill.exe": 'echo "$*" >> "$GOAT_TEST_DIR/taskkill"',
        sleep: [
          'n=$(($(/bin/cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
          'if [ "$n" = 1 ]; then exec /bin/cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
          'if [ "$n" = 4 ]; then printf x 1<>"$GOAT_TEST_DIR/block"; fi',
          'if [ "$n" -gt 3 ]; then ' + HOLD + "; fi",
        ].join("\n"),
      };
      for (const [name, body] of Object.entries(shims))
        NodeFS.writeFileSync(NodePath.join(bin, name), "#!/bin/sh\n" + body + "\n", {
          mode: 0o755,
        });
      const body = [
        "trap '' HUP",
        'printf go > "$1/gate"',
        '/bin/cat "$1/block" >/dev/null',
        "exit 3",
      ].join("\n");
      const result = await runInCaller(
        dir,
        "bash",
        RECORD_KILLS + withRemoteDeadline(body, 1_000, NodePath.join(bin, "sleep")),
        { PATH: bin + ":" + (process.env.PATH ?? "") },
      );
      // One hang-up of the job's own group; the script then ran to its own end.
      expect(signalled(dir)).toEqual(["group", "child"]);
      expect(result).toEqual({ siblingAlive: true, code: "3", out: "" });
      expect(NodeFS.existsSync(NodePath.join(dir, "taskkill"))).toBe(false);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("on Git Bash hangs up the script without reading a process list", async () => {
    const shell = "bash";
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
    try {
      const bin = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(bin);
      for (const fifo of ["gate", "block"])
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
          'if [ "$n" -gt 3 ]; then ' + HOLD + "; fi",
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
      const { code } = await runShell(
        withRemoteDeadline(body, 1_000, NodePath.join(bin, "sleep")),
        [dir],
        { PATH: bin, GOAT_TEST_DIR: dir },
        { shell },
      );
      // Ended by the hang-up, after its own cleanup, without a forced end.
      expect(code).toBe(129);
      expect(NodeFS.readFileSync(NodePath.join(dir, "cleaned"), "utf8")).toBe("cleaned\n");
      expect(NodeFS.existsSync(NodePath.join(dir, "taskkill"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(dir, "listed"))).toBe(false);
    } finally {
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
        for (const fifo of ["go"])
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
            'if [ "$n" -gt 3 ]; then ' + HOLD + "; fi",
          ].join("\n") + "\n",
          { mode: 0o755 },
        );
        const result = await runShell(
          RECORD_KILLS +
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
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(["dash", "bash"])(
    "never hangs up the caller's process group when the shell does not lead it (%s)",
    async (shell) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        for (const fifo of ["gate", "block"])
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
            'if [ "$n" -gt 4 ]; then ' + HOLD + "; fi",
          ].join("\n") + "\n",
          { mode: 0o755 },
        );
        const result = await runInCaller(
          dir,
          shell,
          withRemoteDeadline(
            'printf go > "$1/gate"\ncat "$1/block" >/dev/null && echo released',
            1_000,
            clock,
          ),
        );
        // bash gives the job a group of its own, which the watchdog hangs up. dash cannot, and
        // signals nothing it would have to name by number.
        expect(result).toEqual(
          shell === "bash"
            ? { siblingAlive: true, code: "129", out: "" }
            : { siblingAlive: true, code: "0", out: "released\n" },
        );
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(["dash", "bash"])(
    "starts no watchdog when a probe cannot read the job's process IDs (%s)",
    async (shell) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        const bin = NodePath.join(dir, "bin");
        NodeFS.mkdirSync(bin);
        // No /proc/self/stat (the wrapper reads a missing file instead) and no ps.
        for (const entry of (process.env.PATH ?? "").split(":")) {
          if (entry === "") continue;
          for (const name of NodeFS.existsSync(entry) ? NodeFS.readdirSync(entry) : []) {
            if (name === "ps" || NodeFS.existsSync(NodePath.join(bin, name))) continue;
            NodeFS.symlinkSync(NodePath.join(entry, name), NodePath.join(bin, name));
          }
        }
        const clock = NodePath.join(dir, "sleep");
        NodeFS.writeFileSync(clock, '#!/bin/sh\necho tick >> "$GOAT_TEST_DIR/ticks"\n', {
          mode: 0o755,
        });
        const result = await runInCaller(
          dir,
          shell,
          RECORD_KILLS + withRemoteDeadline("exit 6", 1_000, clock, NodePath.join(dir, "no-stat")),
          { PATH: bin },
        );
        expect(result).toEqual({ siblingAlive: true, code: "6", out: "" });
        // No watchdog ticked, and nothing was signalled.
        expect(NodeFS.existsSync(NodePath.join(dir, "ticks"))).toBe(false);
        expect(signalled(dir)).toEqual([]);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(!NodeFS.existsSync("/proc/self/stat")).each(["dash", "bash"])(
    "keeps a watchdog that loses sight of its parent until its shell stops it (%s)",
    async (shell) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        const bin = NodePath.join(dir, "bin");
        NodeFS.mkdirSync(bin);
        for (const entry of (process.env.PATH ?? "").split(":")) {
          if (entry === "") continue;
          for (const name of NodeFS.existsSync(entry) ? NodeFS.readdirSync(entry) : []) {
            if (name === "ps" || NodeFS.existsSync(NodePath.join(bin, name))) continue;
            NodeFS.symlinkSync(NodePath.join(entry, name), NodePath.join(bin, name));
          }
        }
        for (const fifo of ["gate", "block"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        // The probe reads /proc/self/stat through a link; tick 1 removes it, so every later look
        // fails. The deadline passes on ticks 2 and 3, and tick 4 releases the script, which
        // ignores the hang-up.
        const stat = NodePath.join(dir, "stat");
        NodeFS.symlinkSync("/proc/self/stat", stat);
        const clock = NodePath.join(dir, "sleep");
        NodeFS.writeFileSync(
          clock,
          [
            "#!/bin/sh",
            'n=$(($(cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
            'if [ "$n" = 1 ]; then rm -f "$GOAT_TEST_DIR/stat"; exec cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
            'if [ "$n" = 4 ]; then printf x 1<>"$GOAT_TEST_DIR/block"; fi',
            'if [ "$n" -gt 4 ]; then ' + HOLD + "; fi",
          ].join("\n") + "\n",
          { mode: 0o755 },
        );
        const body = [
          "trap '' HUP",
          'printf go > "$1/gate"',
          'cat "$1/block" >/dev/null',
          "exit 4",
        ].join("\n");
        const result = await runInCaller(
          dir,
          shell,
          RECORD_KILLS + withRemoteDeadline(body, 1_000, clock, stat),
          { PATH: bin },
        );
        expect(result).toEqual({ siblingAlive: true, code: "4", out: "" });
        // It was still a live child when its shell stopped it; only bash's job has a group of its
        // own to hang up.
        expect(signalled(dir)).toEqual(shell === "bash" ? ["group", "child"] : ["child"]);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it
    .skipIf(HostProcess.Platform.defaultValue() !== "linux")
    .each(
      ["dash", "bash"].flatMap((shell) =>
        ["foreground", "background"].map((mode) => ({ shell, mode })),
      ),
    )(
    "finishes under a controlling terminal, keeping its status ($shell, $mode)",
    async ({ shell, mode }) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(dir, "wrapped.sh"),
          withRemoteDeadline("echo yes\nexit 7", 60_000),
        );
        // script gives the run a terminal. In the background, job control would make dash and
        // bash wait forever to own it.
        const run =
          'timeout 30 "$2" -s < "$1/wrapped.sh" > "$1/out" 2>&1; echo "rc=$?" >> "$1/out"';
        NodeFS.writeFileSync(
          NodePath.join(dir, "driver.sh"),
          mode === "background" ? "set -m\n( " + run + " ) &\nwait\n" : run + "\n",
        );
        await spawnHeld("script", [
          "-qec",
          `bash ${NodePath.join(dir, "driver.sh")} ${dir} ${shell}`,
          "/dev/null",
        ]);
        expect(NodeFS.readFileSync(NodePath.join(dir, "out"), "utf8")).toBe("yes\nrc=7\n");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(["dash", "bash"])(
    "returns the script's status when a signal ended its watchdog before the script did (%s)",
    async (shell) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "ticked")]);
        // The first tick names the watchdog; the script ends it with a signal no trap can catch,
        // as a TERM that lands before the watchdog's trap would.
        const clock = NodePath.join(dir, "sleep");
        NodeFS.writeFileSync(
          clock,
          '#!/bin/sh\necho $PPID > "$GOAT_TEST_DIR/watchdog.pid"\nprintf x > "$GOAT_TEST_DIR/ticked"\n' +
            HOLD +
            "\n",
          { mode: 0o755 },
        );
        const body = 'cat "$1/ticked" >/dev/null\nkill -KILL "$(cat "$1/watchdog.pid")"\nexit 5';
        expect(
          await runShell(
            withRemoteDeadline(body, 60_000, clock),
            [dir],
            { GOAT_TEST_DIR: dir },
            { shell },
          ),
        ).toEqual({ code: 5, stdout: "" });
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each(["dash", "bash"].flatMap((shell) => ["file", "pipe"].map((stdin) => ({ shell, stdin }))))(
    "keeps the script's arguments, output and status with stdin from a $stdin ($shell)",
    ({ shell, stdin }) => {
      const script = withRemoteDeadline('printf "%s|" "$@"\nexit 7', 60_000);
      // Git Bash rereads a seekable script after forking; a last line without its newline then
      // joins the next read.
      expect(script.endsWith("\n")).toBe(true);
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        const file = NodePath.join(dir, "wrapped.sh");
        NodeFS.writeFileSync(file, script);
        const fd = stdin === "file" ? NodeFS.openSync(file, "r") : undefined;
        try {
          const run = NodeChildProcess.spawnSync(
            shell,
            ["-s", "--", "a b", "c"],
            fd === undefined ? { input: script } : { stdio: [fd, "pipe", "inherit"] },
          );
          expect([run.status, run.stdout.toString()]).toEqual([7, "a b|c|"]);
        } finally {
          if (fd !== undefined) NodeFS.closeSync(fd);
        }
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
