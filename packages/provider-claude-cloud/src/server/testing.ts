import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PtyAdapter from "@goat/shared/PtyAdapter";
import * as Cli from "./cli.ts";

export class FakePty implements PtyAdapter.PtyProcess {
  readonly pid = 90001;
  writes: string[] = [];
  kills = 0;
  killSignals: Array<string | undefined> = [];
  exitOnForceKill = false;
  private data = new Set<(data: string) => void>();
  private exits = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private exit: PtyAdapter.PtyExitEvent | undefined;
  private readyLatch = Deferred.makeUnsafe<void>();
  private killedLatch = Deferred.makeUnsafe<void>();
  private forceKilledLatch = Deferred.makeUnsafe<void>();
  readonly ready = Deferred.await(this.readyLatch);
  readonly killed = Deferred.await(this.killedLatch);
  readonly forceKilled = Deferred.await(this.forceKilledLatch);
  exitOnKill = true;
  private checkReady() {
    if (this.data.size && this.exits.size) Deferred.doneUnsafe(this.readyLatch, Effect.void);
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize() {}
  kill(signal?: string) {
    this.kills += 1;
    this.killSignals.push(signal);
    Deferred.doneUnsafe(this.killedLatch, Effect.void);
    if (signal === "SIGKILL") Deferred.doneUnsafe(this.forceKilledLatch, Effect.void);
    if (this.exitOnKill || (signal === "SIGKILL" && this.exitOnForceKill)) this.finish(130);
  }
  onData(callback: (data: string) => void) {
    this.data.add(callback);
    this.checkReady();
    return () => {
      this.data.delete(callback);
    };
  }
  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void) {
    if (this.exit) {
      callback(this.exit);
      return () => {};
    }
    this.exits.add(callback);
    this.checkReady();
    return () => {
      this.exits.delete(callback);
    };
  }
  emit(data: string) {
    for (const listener of this.data) listener(data);
  }
  finish(code = 0, signal: number | null = null) {
    this.exit = { exitCode: code, signal };
    for (const listener of this.exits) listener(this.exit);
  }
  get listeners() {
    return this.data.size + this.exits.size;
  }
}

export const LOGIN: Cli.ClaudeCloudLogin = {
  binary: "/fixture/Claude native",
  environment: {
    HOME: "/fixture/home",
    CLAUDE_CONFIG_DIR: "/fixture/claude",
    TOKEN: "fixture-secret",
  },
  binding: "claudeCloud:claudeAgent:/fixture/claude:/fixture/Claude native",
};
export const RECEIPT =
  "Created cloud session: Test task\r\nView: https://claude.ai/code/session_ABC123?from=cli&m=0\r\nResume with: claude --teleport session_ABC123\r\n";
// Native folder prompt observed in the Claude 2.1.296 probe; no trust input was sent by GOAT.
export const FOLDER_TRUST_PROMPT = "Do you trust the files in this folder?\r\n";
// Claude 2.1.306's dialog, captured natively: "No, exit" is highlighted first, so Enter declines.
export const NATIVE_TRUST_DIALOG =
  "\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou\u001b[63Gtrust?\r\r\n\r\r\n" +
  "\u001b[2G❯\u001b[4GNo,\u001b[8Gexit\r\r\n\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n\r\r\n" +
  "\u001b[2GEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G·\u001b[21GEsc\u001b[25Gto\u001b[28Gcancel\r\r\n";
// Claude's redraw after one Down arrow: it moves only the marker.
export const NATIVE_TRUST_MOVED =
  "\u001b[1D\u001b[4B\r\u001b[1C\u001b[4A \r\u001b[1C\u001b[1B❯\r\r\n\r\n\r\n\u001b[1C\u001b[3A";
export const DOWN = "\u001b[B";
// Representative synthetic refusals, not captured native output or exhaustive vendor wording.
export const SYNTHETIC_FOLDER_TRUST_REFUSALS = [
  "Error: This folder is not trusted.\r\n",
  "This directory is not trusted.\r\n",
  "Error: Workspace trust is required for this folder.\r\n",
  "Error: Claude Code cannot run in an untrusted directory.\r\n",
] as const;
export const defaultReply = (args: readonly string[]) => {
  if (args[0] === "--version") return { code: 0, stdout: "2.1.296 (Claude Code)\n" };
  if (args[0] === "--help") return { code: 0, stdout: "--cloud [description|session_id|url]\n" };
  if (args[0] === "auth")
    return { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n' };
  return {
    code: 0,
    stdout:
      '{"ok":true,"session_id":"session_ABC123","url":"https://claude.ai/code/session_ABC123?from=cli"}\n',
  };
};

export const makeCliHarness = Effect.fnUntraced(function* (
  reply: (args: readonly string[]) => {
    code: number;
    stdout: string;
    bytes?: Uint8Array;
    stderr?: string;
  } = defaultReply,
  rejectSpawn = false,
  options: {
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly rejectPtySpawn?: boolean;
  } = {},
) {
  const fake = new FakePty();
  // Later spawns: the trust retry opens interactive Claude, then starts the cloud session again.
  const fakes = [fake, new FakePty(), new FakePty()];
  const commandSpawned = yield* Deferred.make<void>();
  const commands: ChildProcess.StandardCommand[] = [];
  const starts: PtyAdapter.PtySpawnInput[] = [];
  const encoder = new TextEncoder();
  const spawner = ChildProcessSpawner.make((command) =>
    rejectSpawn
      ? Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcessSpawner",
            method: "spawn",
          }),
        )
      : Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline.");
          commands.push(command);
          Deferred.doneUnsafe(commandSpawned, Effect.void);
          const response = reply(command.args);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(90002),
            exitCode:
              options.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(response.code)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(response.bytes ?? encoder.encode(response.stdout)),
            stderr: response.stderr ? Stream.make(encoder.encode(response.stderr)) : Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
  );
  const service = yield* Cli.ClaudeCloudCli.pipe(
    Effect.provide(
      Cli.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(
              PtyAdapter.PtyAdapter,
              PtyAdapter.PtyAdapter.of({
                spawn: (input) =>
                  options.rejectPtySpawn
                    ? Effect.fail(
                        new PtyAdapter.PtySpawnError({
                          adapter: "fake",
                          cause: "fixture missing PTY",
                        }),
                      )
                    : Effect.sync(() => {
                        starts.push(input);
                        const next = fakes[starts.length - 1];
                        if (!next) throw new Error("Unexpected extra PTY spawn.");
                        return next;
                      }),
              }),
            ),
          ),
        ),
      ),
    ),
  );
  return { service, fake, fakes, commands, starts, commandSpawned };
});
