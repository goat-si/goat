import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PtyAdapter from "@goat/shared/PtyAdapter";
import { collectUint8StreamText } from "@goat/provider-core/server/collectStreamText";
import { parseGenericCliVersion } from "@goat/provider-core/server/snapshotProbe";
import {
  ClaudeCloudError,
  isClaudeCloudError,
  parseAuthEffect,
  readStartReceipt,
  readSendReceipt,
  trustRequired,
  cleanOutput,
  redact,
  SESSION_ID,
  validateLogin,
} from "./protocol.ts";

export interface ClaudeCloudLogin {
  readonly binary: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly binding: string;
}
const LIMIT = 64 * 1024;
const unknownSubmission = (cause?: unknown) =>
  new ClaudeCloudError({
    detail:
      "Claude Cloud submission outcome is unknown. Check claude.ai/code before starting another task; GOAT will not retry automatically.",
    outcome: "uncertain",
    ...(cause === undefined ? {} : { cause }),
  });
const checkLogin = (login: ClaudeCloudLogin) =>
  Effect.try({
    try: () => validateLogin(login),
    catch: (cause) =>
      isClaudeCloudError(cause)
        ? cause
        : new ClaudeCloudError({
            detail: "Could not validate the selected sibling Claude configuration.",
            outcome: "rejected",
            cause,
          }),
  });

export class ClaudeCloudCli extends Context.Service<
  ClaudeCloudCli,
  {
    readonly readiness: (
      login: ClaudeCloudLogin,
      cwd: string,
    ) => Effect.Effect<{ version: string | null }, ClaudeCloudError>;
    readonly start: (
      login: ClaudeCloudLogin,
      cwd: string,
      prompt: string,
    ) => Effect.Effect<
      {
        readonly receipt: { taskId: string; url: string; title: string };
        readonly exited: Effect.Effect<void, ClaudeCloudError>;
      },
      ClaudeCloudError,
      Scope.Scope
    >;
    readonly send: (
      login: ClaudeCloudLogin,
      cwd: string,
      taskId: string,
      message: string,
    ) => Effect.Effect<{ taskId: string; url: string }, ClaudeCloudError>;
  }
>()("@goat/provider-claude-cloud/server/cli/ClaudeCloudCli") {}

const run = Effect.fn("ClaudeCloudCli.run")(function* (
  login: ClaudeCloudLogin,
  cwd: string,
  args: string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* checkLogin(login);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(login.binary, args, {
            cwd,
            env: environment,
            shell: false,
            stdin: "ignore",
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ClaudeCloudError({
                detail:
                  "Could not spawn the sibling Claude CLI. No follow-up was delivered; check its binary and the environment-owned control directory.",
                outcome: "rejected",
                cause,
              }),
          ),
        );
      const [code, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          collectUint8StreamText({ stream: child.stdout, maxBytes: LIMIT }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: LIMIT }),
        ],
        { concurrency: "unbounded" },
      );
      if (stdout.truncated || stderr.truncated || stdout.invalidUtf8 || stderr.invalidUtf8) {
        return yield* new ClaudeCloudError({
          detail:
            "Claude returned an incomplete response. Delivery is uncertain; check the cloud session.",
          outcome: "uncertain",
        });
      }
      return { code: Number(code), stdout: stdout.text };
    }),
  ).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) =>
      isClaudeCloudError(cause)
        ? cause
        : new ClaudeCloudError({
            detail:
              "Claude CLI did not return a readable response. Check the sibling login and cloud session before retrying.",
            outcome: "uncertain",
            cause,
          }),
    ),
  );
});

/**
 * Read-only readiness: `auth status` first, then `--version` and `--help`. Never starts a session.
 * Failures carry a `reason` so provider diagnosis can name the next step.
 */
export const probeReadiness = Effect.fn("ClaudeCloudCli.readiness")(
  function* (login: ClaudeCloudLogin, cwd: string) {
    const auth = yield* run(login, cwd, ["auth", "status"]);
    const account = yield* parseAuthEffect(auth.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeCloudError({
            detail:
              "Claude auth status did not return valid JSON. Update the sibling Claude CLI and sign in on this environment.",
            outcome: "rejected",
            cause,
          }),
      ),
    );
    if (auth.code !== 0 || !account.loggedIn || account.authMethod !== "claude.ai") {
      const signedIn = auth.code === 0 && account.loggedIn;
      return yield* new ClaudeCloudError({
        detail:
          "Claude Cloud needs a claude.ai login in the selected sibling's configuration. Run claude auth login --claudeai on this environment's machine.",
        outcome: "rejected",
        reason: signedIn ? "wrong_sign_in" : "not_signed_in",
        ...(signedIn ? { authMethod: account.authMethod } : {}),
      });
    }
    const version = yield* run(login, cwd, ["--version"]);
    const help = yield* run(login, cwd, ["--help"]);
    if (version.code !== 0 || help.code !== 0 || !/--cloud(?:\s|\[)/.test(help.stdout)) {
      return yield* new ClaudeCloudError({
        detail: "The sibling Claude CLI does not advertise cloud sessions. Update that CLI.",
        outcome: "rejected",
        reason: "cloud_unsupported",
      });
    }
    return { version: parseGenericCliVersion(version.stdout) };
  },
  Effect.mapError((cause) =>
    cause.outcome === "rejected"
      ? cause
      : new ClaudeCloudError({
          detail:
            "Could not read the sibling Claude CLI readiness. No cloud prompt was sent; check its configuration.",
          outcome: "rejected",
          cause,
        }),
  ),
);

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pty = yield* PtyAdapter.PtyAdapter;
  const provideSpawner = <A, E>(
    effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
  ) => Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner);

  return ClaudeCloudCli.of({
    readiness: (login, cwd) => provideSpawner(probeReadiness(login, cwd)),
    start: Effect.fn("ClaudeCloudCli.start")(function* (login, cwd, prompt) {
      const environment = yield* checkLogin(login);
      // --cloud accepts IDs and URLs as well as descriptions. Never reinterpret a create as attach.
      if (
        !prompt.trim() ||
        SESSION_ID.test(prompt.trim()) ||
        prompt.trim().startsWith("https://claude.ai/code/")
      ) {
        return yield* new ClaudeCloudError({
          detail:
            "Claude Cloud needs a task description. Send follow-ups from the existing GOAT thread.",
          outcome: "rejected",
        });
      }
      // The supported optional --cloud value is bound with =, so leading flags remain prompt data.
      let raw = "";
      let receipt: ReturnType<typeof readStartReceipt>;
      let exit: PtyAdapter.PtyExitEvent | undefined;
      let failure: ClaudeCloudError | undefined;
      const listeners = new Set<() => void>();
      const notify = () => {
        for (const listener of listeners) listener();
      };
      const inspect = () => {
        const bounded = raw.slice(0, LIMIT);
        const normalized = cleanOutput(bounded);
        // Preserve the first independently validated receipt even if the same chunk contains
        // overflow, trust, conflicting identities, or a later diagnostic. Admission is durable
        // before exited reports those failures; malformed/unaccepted output is never admission.
        if (!receipt) {
          const firstEnd = /^\s*Resume with:\s*claude --teleport session_[A-Za-z0-9]+\s*\n/m.exec(
            normalized,
          );
          if (firstEnd) {
            try {
              receipt = readStartReceipt(normalized.slice(0, firstEnd.index + firstEnd[0].length));
            } catch (cause) {
              failure = unknownSubmission(cause);
            }
          }
        }
        try {
          const complete = readStartReceipt(bounded);
          if (complete && receipt && complete.taskId !== receipt.taskId)
            failure = unknownSubmission();
          receipt ??= complete;
        } catch (cause) {
          failure = unknownSubmission(cause);
        }
        if (raw.length > LIMIT || raw.includes("\uFFFD")) failure = unknownSubmission();
        if (trustRequired(bounded) && !failure)
          failure = new ClaudeCloudError({
            detail: `Claude Code hasn't trusted this folder yet. Open it once with \`claude\` in ${cwd}, accept the trust prompt, then try again.`,
            outcome: receipt ? "uncertain" : "rejected",
          });
        const diagnostic = /^\s*Error:\s*(.+)\n/m.exec(normalized)?.[1];
        if (diagnostic && !failure)
          failure = new ClaudeCloudError({
            detail:
              redact(diagnostic, login.environment) || "Claude could not confirm cloud submission.",
            outcome: "uncertain",
          });
        notify();
      };
      // The exit listener belongs to the process resource. Keep it until release sees real exit,
      // including interruption/timeout, before releasing its listeners and the caller's scope.
      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const process = yield* pty
            .spawn({
              shell: login.binary,
              args: [`--cloud=${prompt}`],
              cwd,
              cols: 120,
              rows: 30,
              env: environment,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ClaudeCloudError({
                    detail:
                      "Could not start the sibling Claude CLI in a PTY. Check its binary path and this environment's PTY support.",
                    outcome: "rejected",
                    cause,
                  }),
              ),
            );
          const offExit = process.onExit((event) => {
            exit = event;
            if (!raw.endsWith("\n")) raw += "\n";
            inspect();
          });
          const offData = process.onData((chunk) => {
            if (raw.length <= LIMIT) raw = (raw + chunk).slice(0, LIMIT + 1);
            inspect();
          });
          return { process, offExit, offData };
        }),
        ({ process, offExit, offData }) =>
          Effect.gen(function* () {
            const waitForExit = Effect.callback<void>((resume) => {
              const finished = () => {
                if (exit) resume(Effect.void);
              };
              listeners.add(finished);
              finished();
              return Effect.sync(() => {
                listeners.delete(finished);
              });
            });
            if (!exit) {
              try {
                process.kill();
              } catch {
                /* Escalate after the grace period; retain ownership until actual exit. */
              }
            }
            yield* waitForExit.pipe(
              Effect.timeout("2 seconds"),
              Effect.catchTags({
                TimeoutError: () =>
                  Effect.sync(() => {
                    if (!exit) {
                      try {
                        process.kill("SIGKILL");
                      } catch {
                        /* Retain ownership until this process reports actual exit. */
                      }
                    }
                  }).pipe(Effect.andThen(waitForExit)),
              }),
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                offData();
                offExit();
                listeners.clear();
              }),
            ),
          ),
      );
      const wait = <A>(decide: () => Effect.Effect<A, ClaudeCloudError> | undefined) =>
        Effect.callback<A, ClaudeCloudError>((resume) => {
          const listener = () => {
            const value = decide();
            if (value) resume(value);
          };
          listeners.add(listener);
          listener();
          return Effect.sync(() => {
            listeners.delete(listener);
          });
        }).pipe(
          Effect.timeout("60 seconds"),
          Effect.mapError((cause) =>
            isClaudeCloudError(cause) ? cause : (failure ?? unknownSubmission(cause)),
          ),
        );
      const observed = yield* wait(() => {
        if (receipt) return Effect.succeed(receipt);
        if (failure) return Effect.fail(failure);
        if (exit) return Effect.fail(unknownSubmission());
        return undefined;
      });
      return {
        receipt: observed,
        exited: wait(() => {
          if (failure) return Effect.fail(failure);
          if (exit)
            // node-pty reports signal 0 for a normal Unix exit; other adapters omit it.
            return exit.exitCode === 0 && (exit.signal === null || exit.signal === 0)
              ? Effect.void
              : Effect.fail(unknownSubmission());
          return undefined;
        }),
      };
    }),
    send: Effect.fn("ClaudeCloudCli.send")(function* (login, cwd, taskId, message) {
      if (!SESSION_ID.test(taskId) || !message.trim())
        return yield* new ClaudeCloudError({
          detail:
            "A follow-up needs the saved Claude session ID and a nonempty message. No prompt was sent.",
          outcome: "rejected",
        });
      // --print is a flag; its prompt is positional after the parser's end-of-options marker.
      const response = yield* provideSpawner(
        run(login, cwd, ["--print", `--cloud=${taskId}`, "--output-format", "json", "--", message]),
      );
      const receipt = yield* Effect.try({
        try: () => readSendReceipt(response.stdout, taskId, login.environment),
        catch: (cause) =>
          isClaudeCloudError(cause)
            ? cause
            : new ClaudeCloudError({
                detail:
                  "Claude did not return a valid follow-up receipt. Delivery is uncertain; open the existing cloud session before sending again.",
                outcome: "uncertain",
                cause,
              }),
      });
      if (response.code !== 0)
        return yield* new ClaudeCloudError({
          detail:
            "Claude returned a receipt with a failed exit. Delivery is uncertain; check the existing cloud session.",
          outcome: "uncertain",
        });
      return receipt;
    }),
  });
});
export const layer = Layer.effect(ClaudeCloudCli, make);
