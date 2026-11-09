// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import { isRemoteShellScript, READ_TICK, withRemoteDeadline } from "./remoteDeadline.ts";

// The shell and everything it starts share fd 3 with the test. A clock tick that must never pass
// reads it and so blocks until the test closes its end once the shell exits. The run then settles
// only when every process holding fd 3 has exited, including a tick a stopped watchdog leaves.
const HOLD = "exec /bin/cat <&3 >/dev/null";
// The script's EXIT trap marks it done and wakes a tick already waiting on done.fifo; a tick that
// opened the FIFO before looking for the mark cannot miss it. It drops the test's fd 3 only to wait,
// so the test cannot finish and remove the mark between a stopped watchdog's last tick and its look.
const SCRIPT_DONE = 'trap \': >"$1/done"; printf "x\\\\n" 1<>"$1/done.fifo"\' EXIT';
const UNTIL_DONE =
  'exec 5<>"$GOAT_TEST_DIR/done.fifo"; [ -e "$GOAT_TEST_DIR/done" ] || { exec 3>&-; read -r line <&5; }';
const bashBefore4 =
  NodeChildProcess.spawnSync("bash", ["-c", "((BASH_VERSINFO < 4))"]).status === 0;

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

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
// Opening without a reader would block; ENXIO means no reader is left to release.
// The caller leads its group and runs the wrapped shell in it, beside a sibling that a hang-up of
// the whole group would end. The sibling reads fd 3, so it ends once the test closes it after the
// shell exits, however late it started.
const runInCaller = async (
  dir: string,
  shell: string,
  wrapped: string,
  env: NodeJS.ProcessEnv = {},
) => {
  NodeFS.writeFileSync(NodePath.join(dir, "wrapped.sh"), wrapped);
  const caller = [
    '/bin/cat <&3 >/dev/null & echo $! > "$1/sibling.pid"',
    '"$2" -s -- "$1" < "$1/wrapped.sh" > "$1/out"; echo "$?" > "$1/code"',
  ].join("\n");
  let siblingAlive = false;
  await spawnHeld("sh", ["-c", caller, "sh", dir, shell], {
    env: { GOAT_TEST_DIR: dir, ...env },
    sessionLeader: true,
    onExit: () => {
      const sibling = Number(NodeFS.readFileSync(NodePath.join(dir, "sibling.pid"), "utf8"));
      siblingAlive = isAlive(sibling);
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
  // TERM interrupts wait in dash and bash 4+, so the watchdog stops mid-tick: tick 1 blocks on a FIFO
  // only the test releases, and the shell must exit while it still blocks. bash before 4 traps during
  // wait only signals that came once wait began, so there tick 1 ends when the script exits.
  it.for(["dash", "bash"])(
    "returns as soon as the script exits, leaving no watchdog behind (%s)",
    async (shell, { onTestFinished }) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      const file = (name: string) => NodePath.join(dir, name);
      // After a pass, a failure or the project timeout: release the tick by ending it through the PID
      // it recorded before it signalled the script, then remove what the test made.
      onTestFinished(() => {
        const tick = NodeFS.existsSync(file("tick.pid"))
          ? Number(NodeFS.readFileSync(file("tick.pid"), "utf8"))
          : 0;
        if (tick > 0 && isAlive(tick)) process.kill(tick);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      });
      const midTick = shell === "dash" || !bashBefore4;
      for (const fifo of ["ticking", "done.fifo", "release"])
        NodeChildProcess.execFileSync("mkfifo", [file(fifo)]);
      const clock = file("sleep");
      NodeFS.writeFileSync(
        clock,
        [
          "#!/bin/sh",
          'n=$(($(cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
          '[ "$n" = 1 ] || exit 0',
          'echo $$ > "$GOAT_TEST_DIR/tick.pid"; echo $PPID > "$GOAT_TEST_DIR/watchdog.pid"',
          'printf x > "$GOAT_TEST_DIR/ticking"',
          midTick ? 'exec 3>&- /bin/cat "$GOAT_TEST_DIR/release" >/dev/null' : UNTIL_DONE,
        ].join("\n") + "\n",
        { mode: 0o755 },
      );
      const body = SCRIPT_DONE + '\ncat "$1/ticking" >/dev/null\nexit 3';
      const script = withRemoteDeadline(body, 60_000, clock);
      expect(await runShell(script, [dir], { GOAT_TEST_DIR: dir }, { shell })).toEqual({
        code: 3,
        stdout: "",
      });
      // A watchdog left ticking would hold a Windows SSH channel open until its next tick.
      expect(isAlive(Number(NodeFS.readFileSync(file("watchdog.pid"), "utf8")))).toBe(false);
      if (midTick) {
        // It stopped while its tick still blocked, and started no other.
        expect(isAlive(Number(NodeFS.readFileSync(file("tick.pid"), "utf8")))).toBe(true);
        expect(NodeFS.readFileSync(file("ticks"), "utf8").trim()).toBe("1");
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
  // Git Bash has /proc; without it the probe would read this test's Windows-shaped ps.
  it.skipIf(!NodeFS.existsSync("/proc/self/stat"))(
    "on Git Bash hangs up the script without reading a process list",
    async () => {
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
          ].join("\n"),
        };
        for (const [name, body] of Object.entries(shims))
          NodeFS.writeFileSync(NodePath.join(bin, name), "#!/bin/sh\n" + body + "\n", {
            mode: 0o755,
          });
        for (const entry of (process.env.PATH ?? "").split(":")) {
          if (entry === "") continue;
          for (const name of NodeFS.existsSync(entry) ? NodeFS.readdirSync(entry) : []) {
            if (
              name === "pgrep" ||
              NodeFS.lstatSync(NodePath.join(bin, name), { throwIfNoEntry: false })
            )
              continue;
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
    },
  );
  it
    .skipIf(!NodeFS.existsSync("/proc/self/stat"))
    .each(
      ["dash", "bash"].flatMap((shell) => [true, false].map((deadline) => ({ shell, deadline }))),
    )(
    "signals only its own process group or a live child, never a PID that may be reused ($shell, deadline: $deadline)",
    async ({ shell, deadline }) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        for (const fifo of ["go", "gate", "done.fifo"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        // Tick 1 waits until the script has set its traps, and ticks from 4 on until it has exited, so
        // no tick races its finish. Without a deadline tick 3 lets the script finish; with one, the
        // script waits to be hung up.
        const clock = NodePath.join(dir, "sleep");
        NodeFS.writeFileSync(
          clock,
          [
            "#!/bin/sh",
            'n=$(($(cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
            'if [ "$n" = 1 ]; then cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
            'if [ "$n" = 3 ] && [ "$GOAT_TEST_DEADLINE" = false ]; then printf x > "$GOAT_TEST_DIR/go"; fi',
            'if [ "$n" -gt 3 ]; then ' + UNTIL_DONE + "; fi",
          ].join("\n") + "\n",
          { mode: 0o755 },
        );
        const result = await runShell(
          RECORD_KILLS +
            withRemoteDeadline(
              [
                SCRIPT_DONE,
                "trap 'exit 129' HUP",
                'printf x > "$1/gate"',
                'cat "$1/go" >/dev/null',
              ].join("\n"),
              deadline ? 1_000 : 60_000,
              clock,
            ),
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
        // Tick 1 waits until the script is stuck and later ticks pass at once. Tick 4 comes only for a
        // script nothing hung up: it releases the script.
        const clock = NodePath.join(dir, "sleep");
        NodeFS.writeFileSync(
          clock,
          [
            "#!/bin/sh",
            'n=$(($(cat "$GOAT_TEST_DIR/ticks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/ticks"',
            'if [ "$n" = 1 ]; then exec cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
            'if [ "$n" = 4 ]; then printf x 1<>"$GOAT_TEST_DIR/block"; fi',
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
            if (
              name === "ps" ||
              NodeFS.lstatSync(NodePath.join(bin, name), { throwIfNoEntry: false })
            )
              continue;
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
            if (
              name === "ps" ||
              NodeFS.lstatSync(NodePath.join(bin, name), { throwIfNoEntry: false })
            )
              continue;
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

// Under bash the watchdog ticks in read on a private FIFO; ticks below replace that read and the
// clock so a test decides when time passes. The script blocks on $1/block until it is hung up.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "remote deadline read tick",
  () => {
    const inDir = async (run: (dir: string, bin: string) => Promise<void>) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-remote-deadline-"));
      try {
        const bin = NodePath.join(dir, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(NodePath.join(dir, "tmp"));
        for (const fifo of ["gate", "block"])
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, fifo)]);
        await run(dir, bin);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    };
    const shim = (bin: string, name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(bin, name), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
    // Runs the real tool: the one after this stand-in's directory on PATH.
    const real = (tool: string) => 'PATH="$' + '{PATH#*:}" ' + tool;
    const env = (dir: string, bin: string) => ({
      GOAT_TEST_DIR: dir,
      TMPDIR: NodePath.join(dir, "tmp"),
      PATH: bin + ":" + (process.env.PATH ?? ""),
    });
    // The first tick waits until the script is stuck; later ticks pass at once.
    const GATED_SLEEP =
      'if [ -p "$GOAT_TEST_DIR/gate" ]; then cat "$GOAT_TEST_DIR/gate" >/dev/null; rm -f "$GOAT_TEST_DIR/gate"; fi';
    const STUCK = ["trap 'exit 129' HUP", 'printf go > "$1/gate"', 'cat "$1/block"'].join("\n");
    // A clock any bash reads, for tests that need the read tick: EPOCHREALTIME came with bash 5, and
    // macOS still ships bash 3.2.
    const FIXED_NOW = "        goat_deadline_t=1000000000";
    const hasEpoch =
      NodeChildProcess.spawnSync("bash", [
        "-c",
        'case "$EPOCHREALTIME" in *[.,]*) ;; *) exit 1 ;; esac',
      ]).status === 0;
    const lines = (dir: string, name: string) =>
      NodeFS.existsSync(NodePath.join(dir, name))
        ? NodeFS.readFileSync(NodePath.join(dir, name), "utf8").trim().split("\n")
        : [];

    // Without EPOCHREALTIME the real clock fails and the watchdog ticks with sleep, which this rules out.
    it.skipIf(!NodeFS.existsSync("/proc/self/fd") || !hasEpoch)(
      "leaves no process of its own once a bash script ends",
      async () => {
        await inDir(async (dir) => {
          // fd 3 is the test's: a process still holding it at the shell's exit outlived the script.
          const script = withRemoteDeadline('readlink /proc/self/fd/3 > "$1/hold"\nexit 7', 60_000);
          let holders: string[] = [];
          const result = await runShell(
            script,
            [dir],
            {},
            {
              shell: "bash",
              onExit: () => {
                const hold = NodeFS.readFileSync(NodePath.join(dir, "hold"), "utf8").trim();
                const holds = (pid: string) => {
                  try {
                    return NodeFS.readdirSync("/proc/" + pid + "/fd").some((fd) => {
                      try {
                        return NodeFS.readlinkSync("/proc/" + pid + "/fd/" + fd) === hold;
                      } catch {
                        return false;
                      }
                    });
                  } catch {
                    return false;
                  }
                };
                holders = NodeFS.readdirSync("/proc").filter(
                  (pid) => /^\d+$/.test(pid) && holds(pid),
                );
              },
            },
          );
          expect(result).toEqual({ code: 7, stdout: "" });
          expect(holders).toEqual([]);
        });
      },
    );

    it("hangs up when the clock reaches the deadline, however its reads end", async () => {
      await inDir(async (dir, bin) => {
        NodeFS.writeFileSync(NodePath.join(dir, "clock"), "1000000000\n");
        // Every third read waits its whole step and the clock moves on by it; the others end at
        // once, one reporting a timeout and one an interrupting signal, with no time passed.
        const ticks = {
          now: '        read -r goat_deadline_t < "$GOAT_TEST_DIR/clock"',
          read: [
            'n=$(($(cat "$GOAT_TEST_DIR/reads" 2>/dev/null || echo 0) + 1)); echo "$n" > "$GOAT_TEST_DIR/reads"',
            'if [ "$n" = 1 ]; then cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
            "case $((n % 3)) in",
            '  1) echo "$(($(cat "$GOAT_TEST_DIR/clock") + $1 * 1000000))" > "$GOAT_TEST_DIR/clock"; (exit 142) ;;',
            "  2) (exit 142) ;;",
            "  *) (exit 138) ;;",
            "esac",
          ].join("\n"),
        };
        const body = [
          'trap \'cat "$1/clock" > "$1/fired"; exit 129\' HUP',
          'printf go > "$1/gate"',
          'cat "$1/block"',
        ].join("\n");
        const result = await runShell(
          withRemoteDeadline(body, 1_000, undefined, undefined, ticks),
          [dir],
          env(dir, bin),
          { shell: "bash", sessionLeader: true },
        );
        expect(result.code).toBe(129);
        // 1 s of client timeout and 5 s of grace on this clock: no earlier, no later.
        expect(lines(dir, "fired")).toEqual([String(1_000_000_000 + 6_000_000)]);
      });
    });

    it("hangs up at the clock's deadline when a read stalls past its tick", async () => {
      await inDir(async (dir, bin) => {
        NodeFS.writeFileSync(NodePath.join(dir, "clock"), "1000000000\n");
        // The first read is held up 5 s, longer than any tick; later reads take what they ask for.
        const ticks = {
          now: '        read -r goat_deadline_t < "$GOAT_TEST_DIR/clock"',
          read: [
            'echo "$(cat "$GOAT_TEST_DIR/clock") $1" >> "$GOAT_TEST_DIR/asked"',
            'if [ -p "$GOAT_TEST_DIR/gate" ]; then cat "$GOAT_TEST_DIR/gate" >/dev/null; rm -f "$GOAT_TEST_DIR/gate"; us=5000000',
            'else case "$1" in *.*) us=$((${1%.*} * 1000000 + 1${1#*.} - 1000000)) ;; *) us=$(($1 * 1000000)) ;; esac; fi',
            'echo "$(($(cat "$GOAT_TEST_DIR/clock") + us))" > "$GOAT_TEST_DIR/clock"; (exit 142)',
          ].join("\n"),
        };
        const result = await runShell(
          withRemoteDeadline(STUCK, 1_000, undefined, undefined, ticks),
          [dir],
          env(dir, bin),
          { shell: "bash", sessionLeader: true },
        );
        expect(result.code).toBe(129);
        // The stall counts in full and the next read asks only for the second left, so the clock
        // meets the 6 s deadline. A grace read may follow the hang-up before the script ends.
        expect(lines(dir, "asked").slice(0, 2)).toEqual(["1000000000 2", "1005000000 1.000000"]);
      });
    });

    it("ticks with sleep and hangs up on time when bash has no EPOCHREALTIME", async () => {
      await inDir(async (dir, bin) => {
        shim(bin, "mkdir", 'echo "$*" >> "$GOAT_TEST_DIR/mkdirs"; exit 1');
        // Tick 1 waits until the script is stuck and later ticks pass at once. Tick 5 comes only for
        // a script nothing hung up: it releases the script.
        shim(
          bin,
          "tick",
          [
            'echo "$1" >> "$GOAT_TEST_DIR/steps"; n=$(($(wc -l < "$GOAT_TEST_DIR/steps")))',
            'if [ "$n" = 1 ]; then exec cat "$GOAT_TEST_DIR/gate" >/dev/null; fi',
            'if [ "$n" = 5 ]; then printf x 1<>"$GOAT_TEST_DIR/block"; fi',
          ].join("\n"),
        );
        const result = await runShell(
          "unset EPOCHREALTIME\n" +
            withRemoteDeadline(STUCK, 2_000, NodePath.join(bin, "tick"), undefined, READ_TICK),
          [dir],
          env(dir, bin),
          { shell: "bash", sessionLeader: true },
        );
        expect(result.code).toBe(129);
        // 2 s of timeout and 5 s of grace count down in steps of 2, 2, 2 and 1; the hang-up follows.
        expect(lines(dir, "steps").slice(0, 4)).toEqual(["2", "2", "2", "1"]);
        expect(lines(dir, "mkdirs")).toEqual([]);
        expect(NodeFS.readdirSync(NodePath.join(dir, "tmp"))).toEqual([]);
      });
    });

    it("falls back to sleeping when a read fails, and still hangs up", async () => {
      await inDir(async (dir, bin) => {
        shim(bin, "tick", GATED_SLEEP);
        const ticks = { now: FIXED_NOW, read: 'echo read >> "$GOAT_TEST_DIR/reads"; (exit 1)' };
        const result = await runShell(
          withRemoteDeadline(STUCK, 1_000, NodePath.join(bin, "tick"), undefined, ticks),
          [dir],
          env(dir, bin),
          { shell: "bash", sessionLeader: true },
        );
        expect(result.code).toBe(129);
        expect(lines(dir, "reads")).toEqual(["read"]);
      });
    });

    it.each([
      ["its directory cannot be made", "mkdir", "exit 1"],
      ["chmod fails", "chmod", "exit 1"],
      ["mkfifo fails", "mkfifo", "exit 1"],
      ["the FIFO cannot be opened", "mkfifo", 'mkdir "$1"'],
    ])("sleeps and still hangs up when %s", async (_, tool, body) => {
      await inDir(async (dir, bin) => {
        shim(bin, tool, body);
        shim(bin, "tick", GATED_SLEEP);
        const ticks = {
          now: FIXED_NOW,
          read: 'echo read >> "$GOAT_TEST_DIR/reads"; (exit 142)',
        };
        const result = await runShell(
          withRemoteDeadline(STUCK, 1_000, NodePath.join(bin, "tick"), undefined, ticks),
          [dir],
          env(dir, bin),
          { shell: "bash", sessionLeader: true },
        );
        expect(result.code).toBe(129);
        expect(lines(dir, "reads")).toEqual([]);
        expect(NodeFS.readdirSync(NodePath.join(dir, "tmp"))).toEqual([]);
      });
    });

    it("ticks in read where mkdir -m makes the directory and then fails, as on Git Bash", async () => {
      await inDir(async (dir, bin) => {
        NodeFS.writeFileSync(NodePath.join(dir, "clock"), "1000000000\n");
        shim(
          bin,
          "mkdir",
          [
            'echo "$*" >> "$GOAT_TEST_DIR/mkdirs"',
            'case "$1" in -m) shift 2; ' + real("mkdir") + ' "$@"; exit 1 ;; esac',
            real("mkdir") + ' "$@"',
          ].join("\n"),
        );
        // The first read waits until the script is stuck; each read moves the clock by its step.
        const ticks = {
          now: '        read -r goat_deadline_t < "$GOAT_TEST_DIR/clock"',
          read: [
            'echo "$1" >> "$GOAT_TEST_DIR/reads"',
            'if [ -p "$GOAT_TEST_DIR/gate" ]; then cat "$GOAT_TEST_DIR/gate" >/dev/null; rm -f "$GOAT_TEST_DIR/gate"; fi',
            'echo "$(($(cat "$GOAT_TEST_DIR/clock") + $1 * 1000000))" > "$GOAT_TEST_DIR/clock"; (exit 142)',
          ].join("\n"),
        };
        const result = await runShell(
          withRemoteDeadline(STUCK, 1_000, undefined, undefined, ticks),
          [dir],
          env(dir, bin),
          { shell: "bash", sessionLeader: true },
        );
        expect(result.code).toBe(129);
        // 1 s of timeout and 5 s of grace in read steps of 2 s; a grace read may follow the hang-up.
        expect(lines(dir, "reads").slice(0, 3)).toEqual(["2", "2", "2"]);
        expect(lines(dir, "mkdirs").filter((line) => line.startsWith("-m"))).toEqual([]);
        expect(NodeFS.readdirSync(NodePath.join(dir, "tmp"))).toEqual([]);
      });
    });

    // "taken" makes the first name an existing directory with a file in it, so mkdir fails there.
    it.each(["directory", "chmod", "taken", "FIFO", "read"])(
      "cleans up only what it made when stopped during its %s step",
      async (stage) => {
        await inDir(async (dir, bin) => {
          NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "stopping")]);
          // The watchdog is stopped once the script knows it reached that stage.
          const stop = 'printf x > "$GOAT_TEST_DIR/stopping"; kill -TERM "$PPID"';
          const tool = { directory: "mkdir", chmod: "chmod", FIFO: "mkfifo" }[stage];
          if (tool !== undefined) shim(bin, tool, real(tool) + ' "$@" && ' + stop);
          if (stage === "taken")
            shim(
              bin,
              "mkdir",
              [
                'if [ ! -e "$GOAT_TEST_DIR/took" ]; then : > "$GOAT_TEST_DIR/took"',
                "  " + real("mkdir") + ' "$1" && echo keep > "$1/keep"; ' + stop + "; exit 1",
                "fi",
                real("mkdir") + ' "$@"',
              ].join("\n"),
            );
          const ticks = {
            now: FIXED_NOW,
            read:
              stage === "read"
                ? // $BASHPID came with bash 4; sh's parent is this watchdog.
                  'printf x > "$GOAT_TEST_DIR/stopping"; kill -TERM "$(exec sh -c \'echo $PPID\')"; (exit 142)'
                : READ_TICK.read,
          };
          const result = await runShell(
            withRemoteDeadline(
              'cat "$1/stopping" >/dev/null\nexit 3',
              60_000,
              undefined,
              undefined,
              ticks,
            ),
            [dir],
            env(dir, bin),
            { shell: "bash" },
          );
          expect(result).toEqual({ code: 3, stdout: "" });
          const left = NodeFS.readdirSync(NodePath.join(dir, "tmp"));
          const contents = (name: string) => NodeFS.readdirSync(NodePath.join(dir, "tmp", name));
          if (stage === "taken") {
            expect(left).toHaveLength(1);
            expect(contents(left[0] ?? "")).toEqual(["keep"]);
          } else expect(left).toEqual([]);
        });
      },
    );
  },
);
