// @effect-diagnostics nodeBuiltinImport:off - runs the real generated probe script against a temporary home.
// Shared by the probe tests that run the generated first-probe script against stand-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { assert } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { buildRemoteRuntimeProbeScript } from "./runtimeProbe.ts";
import { OLD_HELPER_CAPS_STDERR } from "./runtimeFactsScripts.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export const version = "1.2.3";
export const MANIFEST = version + " 1 1 1700000000 has";
export const LIVE = "live " + version + " 1 1 4242 4343";
export const COMPAT = "compatible 1 inst-1";
export const SIGNALS = {
  serverVersion: version,
  sshRuntimeProtocolVersion: 1,
  orchestrationProtocolVersion: 1,
};
export const frame = (lines: ReadonlyArray<string>) =>
  ["begin v1 facts", ...lines, "end " + lines.length].join("\n") + "\n";
// A frame as `facts --with-caps` prints it: the capability line second, not counted at the end.
export const directFrame = (lines: ReadonlyArray<string>, caps = "caps v1 facts") =>
  ["begin v1 facts", caps, ...lines, "end " + lines.length].join("\n") + "\n";
export const GOOD = [
  "manifest ok " + MANIFEST,
  "commit ok 1700000000",
  "live ok " + LIVE,
  "compat ok " + COMPAT,
];
export const CAPS = "__ssh-helper capabilities";
export const FACTS =
  "__ssh-helper facts --runtime-file HOME/.goat/userdata/server-runtime.json" +
  " --port-file HOME/.goat/ssh-launch//port --pid-file HOME/.goat/ssh-launch//pid";
// The direct call the probe makes for the client's own runtime version.
export const DIRECT = FACTS.replace("facts ", "facts --with-caps ");
export const MANIFEST_ASK = "__ssh-helper runtime-manifest --shell";
export const COMMIT_ASK = "__ssh-helper commit-time";
export const LIVE_ASK =
  "__ssh-helper protocol --runtime-file HOME/.goat/userdata/server-runtime.json" +
  " --port-file HOME/.goat/ssh-launch//port --pid-file HOME/.goat/ssh-launch//pid --shell";
export const COMPAT_ASK = "__ssh-helper compat --port 4343";
export const SEPARATE = [MANIFEST_ASK, COMMIT_ASK, LIVE_ASK, COMPAT_ASK];

// Every answer comes from a file in HOME, so a test changes behaviour without changing the
// executable's bytes, which would change its key.
export const STAND_IN = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$HOME/calls"',
  'case "$*" in',
  "  '__ssh-helper capabilities') . \"$HOME/caps.sh\" ;;",
  "  '__ssh-helper facts '*) . \"$HOME/facts.sh\" ;;",
  "  '__ssh-helper runtime-manifest --shell') cat \"$HOME/manifest\" ;;",
  "  '__ssh-helper commit-time') printf '1700000000\\n' ;;",
  "  '__ssh-helper protocol --runtime-file '*) cat \"$HOME/live\" ;;",
  "  '__ssh-helper compat --port '*) cat \"$HOME/compat\" ;;",
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");
export const ANSWER_CAPS =
  'cat "$HOME/caps-out"; cat "$HOME/caps-err" >&2; exit "$(cat "$HOME/caps-status")"';
export const ANSWER_FRAME = 'cat "$HOME/frame"';
export const ANSWER_FRAMES =
  'case "$*" in *--with-caps*) cat "$HOME/frame-direct" ;; *) cat "$HOME/frame" ;; esac';
export const REPLACE_SELF = "printf '\\n# replaced\\n' >> \"$0\"; ";

// Git Bash stand-ins: uname, a clock past every age gate unless HOME/now names another time,
// a SHA-256 that logs each file it hashes and then runs a one-shot HOME/digest-hook, and ps -W
// listing the server.
export const PREFIX =
  "uname() { printf 'MINGW64_NT\\n'; }\n" +
  'date() { if [ -f "$HOME/now" ]; then cat "$HOME/now"; else printf \'4102444800\\n\'; fi; }\n' +
  "shasum() {\n" +
  '  printf \'%s\\n\' "$3" >> "$HOME/digests"\n' +
  '  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$3"; else command shasum -a 256 "$3"; fi\n' +
  '  if [ -f "$HOME/digest-hook" ]; then mv "$HOME/digest-hook" "$HOME/digest-hook.ran"; . "$HOME/digest-hook.ran" >/dev/null; fi\n' +
  "}\n" +
  "ps() { printf '%s\\n' '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND'" +
  " '     4242       1    4242       4242  ?         197609 10:00:00 /c/goat/goat'; }\n";
export const TAIL = [
  "binary_json \"$V\" || printf 'binary-failed'; printf '\\n'",
  "build_commit_time \"$exe\" || printf 'no-commit'; printf '\\n'",
  'live_fact "$exe" "$runtime_file" "$state/port" "$state/pid" || printf \'live-failed\\n\'',
  'compat_fact "$exe" 4343 "$runtime_file" "$state/port" "$state/pid" 4242 || printf \'compat-failed\\n\'',
].join("\n");
export const ANSWERED = [JSON.stringify(SIGNALS), "1700000000", LIVE, COMPAT];

export const fixture = Effect.fn("runtimeProbe.factsFrame.fixture")(function* (
  options: { readonly own?: string } = {},
) {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-probe-frame-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const dir = NodePath.join(home, ".goat/runtime/goat/versions", version);
  const exe = NodePath.join(dir, "goat");
  const facts = NodePath.join(home, ".goat/ssh-launch/facts");
  const record = NodePath.join(home, ".goat/userdata/server-runtime.json");
  const write = (name: string, value: string) =>
    NodeFSP.writeFile(NodePath.join(home, name), value);
  const hash = NodeCrypto.createHash("sha256").update(STAND_IN).digest("hex");
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(record), { recursive: true });
    await NodeFSP.writeFile(exe, STAND_IN, { mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(dir, ".install-complete"), version + "\n");
    await NodeFSP.writeFile(
      NodePath.join(dir, "goat-manifest-shell-v1.sha256"),
      version + " " + hash + "\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, ".install-record"),
      version + " " + "a".repeat(64) + " " + hash + " cache\n",
    );
    await NodeFSP.writeFile(
      record,
      JSON.stringify({ pid: 4242, port: 4343, startedAt: "2026-11-10T00:00:00.000Z" }),
    );
    await write("calls", "");
    await write("manifest", MANIFEST + "\n");
    await write("live", LIVE + "\n");
    await write("compat", COMPAT + "\n");
    await write("caps-out", "usage\n");
    await write("caps-err", OLD_HELPER_CAPS_STDERR);
    await write("caps-status", "1");
    await write("caps.sh", ANSWER_CAPS);
    await write("facts.sh", ANSWER_FRAMES);
    await write("frame", frame(GOOD));
    await write("frame-direct", directFrame(GOOD));
  });
  const generated = buildRemoteRuntimeProbeScript(version, undefined, false, false, options.own);
  const boundary = generated.indexOf("\nretained_version=");
  assert.isAbove(boundary, 0);
  const script = PREFIX + generated.slice(0, boundary) + "\n";
  const run = (tail = TAIL) =>
    Effect.promise(async () => {
      const out = await exec("sh", ["-c", script + tail], { env: { ...process.env, HOME: home } });
      return out.stdout.split("\n").filter(Boolean);
    });
  return {
    home,
    dir,
    exe,
    record,
    run,
    write: (name: string, value: string) => Effect.promise(() => write(name, value)),
    supporting: () =>
      Effect.promise(async () => {
        await write("caps-out", "caps v1 facts\n");
        await write("caps-err", "");
        await write("caps-status", "0");
      }),
    asks: () =>
      Effect.promise(async () =>
        (await NodeFSP.readFile(NodePath.join(home, "calls"), "utf8"))
          .replaceAll(home, "HOME")
          .split("\n")
          .filter(Boolean),
      ),
    digests: () =>
      Effect.promise(async () =>
        (await NodeFSP.readFile(NodePath.join(home, "digests"), "utf8").catch(() => ""))
          .replaceAll(home, "HOME")
          .split("\n")
          .filter(Boolean),
      ),
    facts: () =>
      Effect.promise(async () =>
        (await NodeFSP.readdir(facts).catch(() => [] as string[]))
          .filter((name) => !name.startsWith("."))
          .sort(),
      ),
    fact: (name: string) =>
      Effect.promise(() => NodeFSP.readFile(NodePath.join(facts, name), "utf8")),
    forgetManifest: () =>
      Effect.promise(async () => {
        for (const name of ["version", "own"])
          await NodeFSP.rm(NodePath.join(facts, name + "." + version + ".exe"), { force: true });
      }),
  };
});
