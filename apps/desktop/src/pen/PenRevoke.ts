// @effect-diagnostics nodeBuiltinImport:off -- Desktop owns the local Pen subprocess.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@goat/shared/HostProcess";
import { guardChild } from "@goat/shared/errorGuards";
import type { DesktopPenPin, DesktopPenRevokeResult } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as DesktopPenMembers from "./DesktopPenMembers.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { resolvePenBinary } from "./penPipe.ts";

interface Dependencies {
  readonly member: (pin: DesktopPenPin) => Effect.Effect<string | undefined>;
  readonly confirm: (name: string) => Effect.Effect<"cancel" | "remove" | "remove-compromised">;
  readonly resolveBinary: () => Effect.Effect<string | undefined>;
  readonly spawn: (
    binary: string,
    args: readonly string[],
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
  readonly deadline: Duration.Input;
  readonly onSpawn?: Effect.Effect<void>;
}
const failed = (message: string): DesktopPenRevokeResult => ({ status: "failed", message });
const unknown = failed("The outcome is unknown; check pen ls before trying again.");

export function makePenRevoke(deps: Dependencies) {
  let busy = false;
  const revoke = Effect.fn("PenRevoke.revoke")(function* (pin: DesktopPenPin) {
    if (busy) return failed("Another Pen removal is already in progress.");
    busy = true;
    let activeChild: NodeChildProcess.ChildProcess | undefined;
    return yield* Effect.gen(function* () {
      const name = yield* deps.member(pin);
      if (name === undefined) return failed("This machine is no longer a confirmed Pen member.");
      const choice = yield* deps.confirm(name);
      if (choice === "cancel") return { status: "cancelled" } as const;
      const binary = yield* deps.resolveBinary();
      if (!binary)
        return failed("Pen was not found. Install or update Pen, or run pen revoke in a terminal.");
      if ((yield* deps.member(pin)) === undefined)
        return failed("This machine is no longer a confirmed Pen member.");
      const args = ["revoke", "--node", pin.nodeId, "--noise", pin.noisePub];
      if (choice === "remove-compromised") args.push("--compromised");
      let proc: NodeChildProcess.ChildProcess | undefined;
      let output = Buffer.alloc(0);
      const createCompletion = () =>
        new Promise<DesktopPenRevokeResult>((resolve) => {
          try {
            proc = deps.spawn(binary, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
            activeChild = proc;
            let settled = false;
            const finish = (result: DesktopPenRevokeResult) => {
              if (!settled) {
                settled = true;
                resolve(result);
              }
            };
            guardChild(proc, (error) => finish(failed(`Could not run Pen: ${error.message}`)));
            const collect = (chunk: Buffer | string) => {
              const data = Buffer.from(chunk);
              if (output.length < 65536)
                output = Buffer.concat([output, data.subarray(0, 65536 - output.length)]);
            };
            proc.stdout?.on("data", collect);
            proc.stderr?.on("data", collect);
            // A killed child that never closes its pipes must not latch removals off.
            proc.once("exit", () => {
              activeChild = undefined;
              busy = false;
            });
            proc.once("close", (code, signal) => {
              activeChild = undefined;
              busy = false;
              if (signal || code === null) return finish(unknown);
              const text = output.toString("utf8").trim().slice(0, 600);
              if (code === 0) return finish({ status: "revoked", output: text });
              if (code === 2) return finish(failed("Update Pen, or run pen revoke in a terminal."));
              finish(failed(`Pen could not remove the machine: ${text || `exit ${code}`}`));
            });
          } catch (error) {
            resolve(failed(`Could not run Pen: ${String(error)}`));
          }
        });
      const running = Effect.gen(function* () {
        const { promise } = yield* Effect.sync(() => ({ promise: createCompletion() }));
        yield* deps.onSpawn ?? Effect.void;
        return yield* Effect.promise(() => promise);
      });
      return yield* Effect.race(running, Effect.sleep(deps.deadline).pipe(Effect.as(unknown)));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (activeChild) activeChild.kill("SIGKILL");
          else busy = false;
        }),
      ),
    );
  });
  return { revoke };
}

export class PenRevoke extends Context.Reference<ReturnType<typeof makePenRevoke>>(
  "@goat/desktop/pen/PenRevoke",
  { defaultValue: () => ({ revoke: () => Effect.succeed(failed("Pen removal is unavailable.")) }) },
) {}
export const layer = Layer.effect(
  PenRevoke,
  Effect.gen(function* () {
    const members = yield* DesktopPenMembers.DesktopPenMembers;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const windows = yield* ElectronWindow.ElectronWindow;
    const platform = yield* HostProcess.Platform;
    const env = yield* HostProcess.Environment;
    return makePenRevoke({
      member: (pin) => members.member?.(pin) ?? Effect.sync((): string | undefined => undefined),
      confirm: Effect.fn("PenRevoke.confirm")(function* (name) {
        const owner = yield* windows.main;
        if (Option.isNone(owner)) return "cancel" as const;
        const result = yield* dialog
          .showMessageBox(
            {
              type: "warning",
              message: `Remove ${name} from Pen?`,
              detail:
                "It loses access to every machine in this Pen mesh and GOAT stops showing it. To let it back in, invite it again.",
              buttons: ["Cancel", "Remove"],
              defaultId: 0,
              cancelId: 0,
              checkboxLabel: "This machine was lost or stolen: also revoke every key it admitted",
              checkboxChecked: false,
            },
            owner.value,
          )
          .pipe(Effect.orElseSucceed(() => ({ response: 0, checkboxChecked: false })));
        return result.response !== 1
          ? ("cancel" as const)
          : result.checkboxChecked
            ? ("remove-compromised" as const)
            : ("remove" as const);
      }),
      resolveBinary: () => Effect.promise(() => resolvePenBinary({ platform, path: env.PATH })),
      spawn: (binary, args, options) => NodeChildProcess.spawn(binary, [...args], options),
      deadline: "60 seconds",
    });
  }),
);
