// @effect-diagnostics nodeBuiltinImport:off -- the register child is a plain argv spawn, never a shell.
import * as NodeChildProcess from "node:child_process";

import { encodeKey32 } from "@goat/pen-protocol/service";
import { guardChild } from "@goat/shared/errorGuards";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { PEN_SERVICE_NAME } from "./penHandshake.ts";

/** How long the child may take to answer; Pen bounds its own control writes at 5 s. */
export const PEN_REGISTER_DEADLINE = Duration.seconds(10);
const READY_CAP = 128;
const STDERR_TAIL = 2048;
const REGISTERED = new RegExp(
  `^pen-service v1 registered ${PEN_SERVICE_NAME} ([a-z2-7]{1,64})$`,
  "u",
);

export class PenRegistrationError extends Data.TaggedError("PenRegistrationError")<{
  readonly reason: string;
}> {}

export interface PenRegistration {
  readonly id: string;
  /** Completes when Pen no longer holds this registration (released, replaced or the daemon gone). */
  readonly lost: Deferred.Deferred<void>;
}

/**
 * Holds this GOAT's registration as Pen's "goat" service for as long as the scope lives
 * (pen-protocol CONTRACT "Registration"). K goes to the child's stdin only; the child's whole
 * environment is PEN_HOME, the pinned state folder, because `pen service register` takes no --home.
 */
export class PenRegistrar extends Context.Service<
  PenRegistrar,
  {
    readonly register: (input: {
      readonly executablePath: string;
      readonly stateDir: string;
      readonly port: number;
      readonly key: Uint8Array;
    }) => Effect.Effect<PenRegistration, PenRegistrationError, Scope.Scope>;
  }
>()("goat/pen/PenRegistrar") {}

export const register: PenRegistrar["Service"]["register"] = Effect.fn("PenRegistrar.register")(
  function* (input) {
    const registered = yield* Deferred.make<string, PenRegistrationError>();
    const lost = yield* Deferred.make<void>();
    let stderr = "";
    const fail = (reason: string) => {
      Deferred.doneUnsafe(
        registered,
        Effect.fail(new PenRegistrationError({ reason: stderr.trim() || reason })),
      );
      Deferred.doneUnsafe(lost, Effect.void);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = guardChild(
          NodeChildProcess.spawn(
            input.executablePath,
            ["service", "register", PEN_SERVICE_NAME, "--port", String(input.port)],
            {
              shell: false,
              stdio: ["pipe", "pipe", "pipe"],
              env: { PEN_HOME: input.stateDir },
              windowsHide: true,
            },
          ),
          (error) => fail(`pen did not start: ${error.message}`),
          () => {},
        );
        let head = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          head += chunk.toString("latin1");
          const lf = head.indexOf("\n");
          if (lf === -1 && head.length < READY_CAP) return;
          const match = lf === -1 ? null : REGISTERED.exec(head.slice(0, lf));
          if (match?.[1] === undefined)
            fail("pen answered something other than its registered line");
          else Deferred.doneUnsafe(registered, Effect.succeed(match[1]));
          child.stdout?.removeAllListeners("data");
          child.stdout?.resume();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
        });
        child.once("exit", (code) => fail(`pen service register exited with code ${code}`));
        child.stdin?.write(`${encodeKey32(input.key)}\n`);
        return child;
      }),
      (child) =>
        Effect.sync(() => {
          child.stdin?.end();
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }),
    );
    const id = yield* Deferred.await(registered).pipe(
      Effect.timeoutOrElse({
        duration: PEN_REGISTER_DEADLINE,
        orElse: () =>
          Effect.fail(new PenRegistrationError({ reason: "pen did not register GOAT in time" })),
      }),
    );
    return { id, lost };
  },
);

export const layer = Layer.succeed(PenRegistrar, { register });
