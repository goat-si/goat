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
