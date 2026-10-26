import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
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
  readDiagnostic,
  readSendReceipt,
  trustDialog,
  trustOption,
  trustPrompt,
  trustRefusal,
  cleanOutput,
  SESSION_ID,
  validateLogin,
} from "./protocol.ts";
import { makeSessionRead, type SessionRead } from "./sessionRead.ts";

export interface ClaudeCloudLogin {
  readonly binary: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly binding: string;
}
/**
 * Present when GOAT may answer Claude Code's folder trust prompt for this folder. Each answer is
 * reported so the caller can record it.
 */
export interface ClaudeCloudTrust {
  readonly onAccepted: () => void;
  /**
   * Answers the trust prompt after a refusal in place of opening Claude here, so the caller can
   * keep one answer per folder in flight.
   */
  readonly accept?: Effect.Effect<void, ClaudeCloudError>;
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
      trust?: ClaudeCloudTrust,
    ) => Effect.Effect<
      {
        readonly receipt: { taskId: string; url: string; title: string };
        readonly exited: Effect.Effect<void, ClaudeCloudError>;
      },
      ClaudeCloudError,
      Scope.Scope
    >;
    /** Answers the folder trust prompt in interactive Claude without starting a session. */
    readonly acceptTrust: (
      login: ClaudeCloudLogin,
      cwd: string,
    ) => Effect.Effect<void, ClaudeCloudError>;
    readonly send: (
      login: ClaudeCloudLogin,
      cwd: string,
      taskId: string,
      message: string,
    ) => Effect.Effect<{ taskId: string; url: string }, ClaudeCloudError>;
    /**
     * Reads the session's transcript through a throwaway teleport under `root`. Each read runs
     * one small local model turn; GOAT removes the local copy afterwards.
     */
    readonly readSession: (
      login: ClaudeCloudLogin,
      root: string,
      sessionId: string,
    ) => Effect.Effect<SessionRead, ClaudeCloudError>;
  }
>()("@goat/provider-claude-cloud/server/cli/ClaudeCloudCli") {}

export type ClaudeCloudRun = (
  login: ClaudeCloudLogin,
  cwd: string,
  args: string[],
  options?: { readonly timeout?: Duration.Input },
) => Effect.Effect<{ code: number; stdout: string }, ClaudeCloudError>;

const run = Effect.fn("ClaudeCloudCli.run")(function* (
  login: ClaudeCloudLogin,
  cwd: string,
  args: string[],
  options?: Parameters<ClaudeCloudRun>[3],
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
    Effect.timeout(options?.timeout ?? "30 seconds"),
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

const MAX_TRUST_ANSWERS = 3;
const trustFailure = (
  cwd: string,
  outcome: "rejected" | "uncertain",
  reason?: "folder_untrusted",
) =>
  new ClaudeCloudError({
    detail: `Claude Code hasn't trusted this folder yet. Open it once with \`claude\` in ${cwd}, accept the trust prompt, then try again.`,
    outcome,
    ...(reason === undefined ? {} : { reason }),
  });

const UP = "\u001b[A";
const DOWN = "\u001b[B";

/** Text a redraw leaves on screen, without cursor movement or erasing spaces. */
const visible = (raw: string) =>
  raw.replace(/\u001b\[[0-9;?>]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "").replace(/\s+/g, "");

/**
 * Walks Claude's trust dialog onto "Yes, I trust this folder" and confirms it. Claude drops keys
 * sent while it is still setting up its terminal, so a key goes out only on a settled screen.
 * Each key is judged on the whole settled redraw that followed it: a full repaint places the
 * marker, and a marker-only redraw (what Claude paints for an arrow key) moves it one option.
 * A key is never sent again on silence: if it did land but redrew late, a second key could move
 * past "Yes". Without a conclusive redraw nothing more is sent and the launch submits nothing. Enter goes out only while the marker is known to be on "Yes".
 * Returns true once it has.
 */
const makeTrustAnswer = () => {
  let dialog: { readonly yes: number; marked: number } | undefined;
  let sentAt = 0;
  let pending: 1 | -1 | undefined;
  let lost = false;
  return (raw: string, from: number, settled: boolean, write: (keys: string) => void) => {
    if (!settled || lost) return false;
    if (dialog === undefined) {
      const found = trustDialog(raw.slice(from));
      if (!found) return false;
      dialog = { ...found };
    } else if (pending !== undefined) {
      const redraw = raw.slice(sentAt);
      const repainted = trustDialog(redraw);
      if (repainted) dialog.marked = repainted.marked;
      else if (visible(redraw) === "❯") dialog.marked += pending;
      else if (redraw === "") return false;
      else {
        // The screen no longer tells where the marker is; never guess at Enter.
        lost = true;
        return false;
      }
      pending = undefined;
    }
    sentAt = raw.length;
    if (dialog.marked === dialog.yes) {
      dialog = undefined;
      write("\r");
      return true;
    }
    pending = dialog.yes > dialog.marked ? 1 : -1;
    write(pending === 1 ? DOWN : UP);
    return false;
  };
};

/** Output that stopped changing for one tick is a settled screen. */
const SETTLE = "250 millis";

/**
 * One owned PTY. Release kills it and waits for its real exit, escalating to SIGKILL, before
 * dropping listeners, so interruption and timeouts never orphan the process.
 */
const ownPty = Effect.fnUntraced(function* (
  pty: PtyAdapter.PtyAdapter["Service"],
  input: PtyAdapter.PtySpawnInput,
  handlers: {
    readonly data: (chunk: string, process: PtyAdapter.PtyProcess) => void;
    readonly exit: (event: PtyAdapter.PtyExitEvent) => void;
    readonly exited: () => boolean;
    readonly listeners: Set<() => void>;
  },
) {
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const process = yield* pty.spawn(input).pipe(
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
      const offExit = process.onExit(handlers.exit);
      const offData = process.onData((chunk) => handlers.data(chunk, process));
      return { process, offExit, offData };
    }),
    ({ process, offExit, offData }) =>
      Effect.gen(function* () {
        const waitForExit = Effect.callback<void>((resume) => {
          const finished = () => {
            if (handlers.exited()) resume(Effect.void);
          };
          handlers.listeners.add(finished);
          finished();
          return Effect.sync(() => {
            handlers.listeners.delete(finished);
          });
        });
        if (!handlers.exited()) {
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
                if (!handlers.exited()) {
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
            handlers.listeners.clear();
          }),
        ),
      ),
  );
});

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pty = yield* PtyAdapter.PtyAdapter;
  const provideSpawner = <A, E>(
    effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
  ) => Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner);
  const readSession = makeSessionRead({
    run: (login, cwd, args, options) => provideSpawner(run(login, cwd, args, options)),
    spawner,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
  });

  /** Opens interactive Claude in the folder only to answer its trust prompt, then closes it. */
  const acceptTrust = Effect.fn("ClaudeCloudCli.acceptTrust")(function* (
    login: ClaudeCloudLogin,
    cwd: string,
  ) {
    const environment = yield* checkLogin(login);
    let raw = "";
    let confirmed = false;
    let exit: PtyAdapter.PtyExitEvent | undefined;
    let pty_: PtyAdapter.PtyProcess | undefined;
    let seen = 0;
    const answer = makeTrustAnswer();
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const refused = (detail: string) =>
      new ClaudeCloudError({ detail, outcome: "rejected", reason: "folder_untrusted" });
    const until = (done: () => boolean) =>
      Effect.callback<void>((resume) => {
        const listener = () => {
          if (done()) resume(Effect.void);
        };
        listeners.add(listener);
        listener();
        return Effect.sync(() => {
          listeners.delete(listener);
        });
      });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ownPty(
          pty,
          { shell: login.binary, args: [], cwd, cols: 120, rows: 30, env: environment },
          {
            data: (chunk, process) => {
              if (raw.length <= LIMIT) raw = (raw + chunk).slice(0, LIMIT + 1);
              pty_ = process;
              notify();
            },
            exit: (event) => {
              exit = event;
              notify();
            },
            exited: () => exit !== undefined,
            listeners,
          },
        );
        yield* Effect.sync(() => {
          const settled = raw.length === seen;
          seen = raw.length;
          if (!confirmed && pty_ && !exit)
            confirmed = answer(raw, 0, settled, (keys) => pty_!.write(keys));
          notify();
        }).pipe(Effect.repeat(Schedule.spaced(SETTLE)), Effect.forkScoped);
        yield* until(() => confirmed || exit !== undefined).pipe(
          Effect.timeout("30 seconds"),
          Effect.catchTags({
            TimeoutError: () =>
              Effect.fail(
                refused(
                  "Claude Code did not show its folder trust prompt. Open the folder once with claude to finish its setup.",
                ),
              ),
          }),
        );
        if (!confirmed)
          return yield* refused(
            "Claude Code exited before showing its folder trust prompt. Open the folder once with claude to finish its setup.",
          );
        // Declining closes Claude at once; trusting keeps it open on its prompt.
        const closed = yield* until(() => exit !== undefined).pipe(
          Effect.timeout("3 seconds"),
          Effect.as(true),
          Effect.catchTags({ TimeoutError: () => Effect.succeed(false) }),
        );
        if (closed)
          return yield* refused(
            "Claude Code closed instead of trusting the folder. Open it once with claude and choose Yes, I trust this folder.",
          );
      }),
    );
  });

  const startOnce = Effect.fn("ClaudeCloudCli.startOnce")(function* (
    login: ClaudeCloudLogin,
    cwd: string,
    prompt: string,
    trust: ClaudeCloudTrust | undefined,
  ) {
    const environment = yield* checkLogin(login);
    // The supported optional --cloud value is bound with =, so leading flags remain prompt data.
    let raw = "";
    let receipt: ReturnType<typeof readStartReceipt>;
    let exit: PtyAdapter.PtyExitEvent | undefined;
    let failure: ClaudeCloudError | undefined;
    // Claude prints a long error over several wrapped lines, which can arrive in separate chunks.
    // The failure is set at its first line, so it keeps its precedence, re-read as more arrives,
    // and reported once the CLI exits (or the wait ends).
    let diagnosticFailure: ClaudeCloudError | undefined;
    // Output before this offset belongs to trust prompts GOAT already answered.
    let trustFrom = 0;
    let answers = 0;
    let answer = makeTrustAnswer();
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const listener of listeners) listener();
    };
    let seen = 0;
    let current: PtyAdapter.PtyProcess | undefined;
    const answerTrust = (bounded: string, settled: boolean) => {
      const process = current;
      if (!trust || receipt || failure || !process) return;
      if (answers >= MAX_TRUST_ANSWERS) {
        if (trustOption(bounded.slice(trustFrom)))
          failure = new ClaudeCloudError({
            detail: `Claude Code kept asking to trust ${cwd} after GOAT accepted it ${MAX_TRUST_ANSWERS} times. No prompt was sent.`,
            outcome: "rejected",
          });
        return;
      }
      if (!answer(bounded, trustFrom, settled, (keys) => process.write(keys))) return;
      answers += 1;
      trustFrom = bounded.length;
      answer = makeTrustAnswer();
      trust.onAccepted();
    };
    const inspect = (settled = false) => {
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
      answerTrust(bounded, settled);
      const pending = bounded.slice(trustFrom);
      if (!failure && trustRefusal(pending))
        failure = receipt
          ? trustFailure(cwd, "uncertain")
          : trustFailure(cwd, "rejected", "folder_untrusted");
      // A receipt after a refusal is no refusal: the session may exist, so nothing is retried.
      if (receipt && failure?.reason === "folder_untrusted")
        failure = trustFailure(cwd, "uncertain");
      // With a trust policy, a prompt still rendering its options is answered on a later chunk.
      if (!failure && trustPrompt(pending) && (!trust || receipt))
        failure = trustFailure(cwd, receipt ? "uncertain" : "rejected");
      const diagnostic =
        failure && failure !== diagnosticFailure
          ? undefined
          : readDiagnostic(bounded, login.environment);
      if (diagnostic !== undefined) {
        failure = diagnosticFailure = new ClaudeCloudError({
          detail: diagnostic || "Claude could not confirm cloud submission.",
          outcome: "uncertain",
        });
      }
      notify();
    };
    // The exit listener belongs to the process resource. Keep it until release sees real exit,
    // including interruption/timeout, before releasing its listeners and the caller's scope.
    yield* ownPty(
      pty,
      {
        shell: login.binary,
        args: [`--cloud=${prompt}`],
        cwd,
        cols: 120,
        rows: 30,
        env: environment,
      },
      {
        data: (chunk, process) => {
          if (raw.length <= LIMIT) raw = (raw + chunk).slice(0, LIMIT + 1);
          current = process;
          inspect();
        },
        exit: (event) => {
          exit = event;
          if (!raw.endsWith("\n")) raw += "\n";
          inspect();
        },
        exited: () => exit !== undefined,
        listeners,
      },
    );
    // Keys go out only on a settled screen; see makeTrustAnswer.
    if (trust)
      yield* Effect.sync(() => {
        const settled = raw.length === seen;
        seen = raw.length;
        if (!exit) inspect(settled);
      }).pipe(Effect.repeat(Schedule.spaced(SETTLE)), Effect.forkScoped);
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
          isClaudeCloudError(cause)
            ? cause
            : trust && failure?.reason === "folder_untrusted" && !exit
              ? // Still running after refusing: its outcome is unknown, so no retry.
                unknownSubmission(cause)
              : (failure ??
                // A trust dialog that never finished rendering sent nothing.
                (!receipt && trustPrompt(raw.slice(trustFrom))
                  ? trustFailure(cwd, "rejected")
                  : unknownSubmission(cause))),
        ),
      );
    const observed = yield* wait(() => {
      if (receipt) return Effect.succeed(receipt);
      // A refusal is final only once this process has really exited with nothing more to say.
      if (trust && failure?.reason === "folder_untrusted" && !exit) return undefined;
      if (failure !== undefined && failure === diagnosticFailure && !exit) return undefined;
      if (failure) return Effect.fail(failure);
      if (exit) return Effect.fail(unknownSubmission());
      return undefined;
    });
    return {
      receipt: observed,
      exited: wait(() => {
        if (failure !== undefined && failure === diagnosticFailure && !exit) return undefined;
        if (failure) return Effect.fail(failure);
        if (exit)
          // node-pty reports signal 0 for a normal Unix exit; other adapters omit it.
          return exit.exitCode === 0 && (exit.signal === null || exit.signal === 0)
            ? Effect.void
            : Effect.fail(unknownSubmission());
        return undefined;
      }),
    };
  });

  return ClaudeCloudCli.of({
    readiness: (login, cwd) => provideSpawner(probeReadiness(login, cwd)),
    acceptTrust,
    readSession,
    start: Effect.fn("ClaudeCloudCli.start")(function* (login, cwd, prompt, trust) {
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
      const first = yield* startOnce(login, cwd, prompt, trust).pipe(Effect.result);
      if (first._tag === "Success") return first.success;
      // A refusal starts nothing, so trusting the folder and starting once more is safe.
      if (
        !trust ||
        first.failure.reason !== "folder_untrusted" ||
        first.failure.outcome !== "rejected"
      )
        return yield* first.failure;
      yield* trust.accept ?? acceptTrust(login, cwd);
      trust.onAccepted();
      return yield* startOnce(login, cwd, prompt, trust).pipe(
        Effect.mapError((error) =>
          error.reason === "folder_untrusted"
            ? new ClaudeCloudError({
                detail: `Claude Code still refuses ${cwd} after GOAT accepted its trust prompt. No prompt was sent.`,
                outcome: "rejected",
                reason: "folder_untrusted",
              })
            : error,
        ),
      );
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
