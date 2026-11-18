import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readPenConfig } from "./penConfigFile.ts";
import {
  PEN_EXACT_ALIAS,
  penConfigHosts,
  penExactAliasDecision,
  penGlobalFiles,
  sshSettings,
  type PenRouteRefusal,
} from "./penRoute.ts";
import { runPreflightProcess } from "./preflightProcess.ts";

export class PenAliasUnreadable extends Data.TaggedError("PenAliasUnreadable")<{
  readonly alias: string;
  readonly detail: string;
}> {}
export interface TrustedPenRoute {
  readonly alias: string;
  readonly nodeId: string;
  readonly noisePub: string;
  readonly revision: string;
  readonly target: DesktopSshEnvironmentTarget;
}

export const inspectPenExactAlias = Effect.fn("ssh/penAlias.inspectPenExactAlias")(
  function* (input: {
    readonly alias: string;
    readonly homeDirectory: string;
    readonly sshCommand?: string;
    readonly sshKeygenCommand?: string;
  }) {
    const { alias } = input;
    const error = (detail: string) => new PenAliasUnreadable({ alias, detail });
    if (!PEN_EXACT_ALIAS.test(alias)) return { refused: "not-in-pen-config" as const };
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(input.homeDirectory, ".ssh", "pen");
    const config = yield* readPenConfig(fs, path.join(dir, "config")).pipe(
      Effect.mapError(() => error("Pen config unreadable")),
    );
    const configHosts = penConfigHosts(config);
    if (!configHosts.includes(alias)) return { refused: "not-in-pen-config" as const };
    const run = (cmd: string, args: ReadonlyArray<string>) =>
      runPreflightProcess(cmd, args).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError(() => error(`${cmd} did not answer`)),
        Effect.filterOrFail(
          (result) => Buffer.byteLength(result.stdout) < 64 * 1024,
          () => error(`${cmd} printed more than GOAT reads`),
        ),
      );
    const resolved = yield* run(input.sshCommand ?? "ssh", ["-G", alias]);
    if (resolved.exitCode !== 0) return yield* error("ssh -G failed");
    const settings = sshSettings(resolved.stdout);
    const penKnownHosts = path.join(dir, "known_hosts");
    const preliminary = penExactAliasDecision({
      alias,
      configHosts,
      settings,
      penKnownHosts,
      globalKey: false,
      recorded: "key",
    });
    if (typeof preliminary === "string") return { refused: preliminary };
    const globals = penGlobalFiles(settings);
    const exists = (file: string) =>
      fs.exists(file).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError(() => error("Cannot inspect known hosts")),
      );
    let globalKey = globals === undefined;
    if (globals && globals.length > 1 && (yield* exists(globals.join(" ")))) globalKey = true;
    const keygen = (file: string) =>
      run(input.sshKeygenCommand ?? "ssh-keygen", ["-F", alias, "-f", file]).pipe(
        Effect.flatMap((out) =>
          out.exitCode === 0
            ? Effect.succeed(out.stdout)
            : out.exitCode === 1
              ? Effect.succeed("")
              : Effect.fail(error("ssh-keygen failed")),
        ),
      );
    for (const file of globals ?? []) {
      if ((yield* exists(file)) && (yield* keygen(file)).trim() !== "") globalKey = true;
    }
    if (globalKey) return { refused: "global-known-hosts" as const };
    const recorded = yield* keygen(penKnownHosts);
    const decision = penExactAliasDecision({
      alias,
      configHosts,
      settings,
      penKnownHosts,
      globalKey,
      recorded,
    });
    if (typeof decision === "string") return { refused: decision as PenRouteRefusal };
    return {
      alias,
      ...decision,
      target: { alias, hostname: alias, username: settings.get("user") ?? null, port: null },
    } satisfies TrustedPenRoute;
  },
);
