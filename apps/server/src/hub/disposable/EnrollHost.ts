import { ServerConfig } from "../../config.ts";
import * as HostProcess from "@goat/shared/HostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a temporary name per write.
import * as NodeCrypto from "node:crypto";
import { resolveSshCommand } from "@goat/ssh/command";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as Inventory from "../../opencodex/OpenCodexInventory.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as Settings from "../../serverSettings.ts";
import { HubOcx, type OcxOutput, type PenExactRoute } from "../HubOcx.ts";
import type { PenNode } from "../penSshRoute.ts";
import { goatFolders, type KeyPathAnswer, keyPathFor } from "./keyPath.ts";
import { type DisposableRoute, disposableSshExecOptions } from "./routeContract.ts";

/** How a reach ended; ssh's own lines decide it, and none of them is kept. */
export type ReachAnswer =
  | "ok"
  | "key_refused"
  | "host_key_changed"
  | "host_key_unknown"
  | "unreachable"
  | "unusable";
const lineIs = (stderr: string, pattern: RegExp) =>
  stderr.split(/\r?\n/u).some((line) => pattern.test(line.trim()));
/** Whole lines only, so a machine's banner repeating ssh's words decides nothing. */
export const reachAnswerOf = (code: number | null, stderr: string): ReachAnswer => {
  if (code === 0) return "ok";
  // GOAT's own known_hosts for the machine is missing or unreadable: ssh then also says it failed.
  if (
    lineIs(stderr, /^No \S+ host key is known for \S+ and you have requested strict checking\.$/u)
  )
    return "host_key_unknown";
  if (lineIs(stderr, /^Host key verification failed\.$/u)) return "host_key_changed";
  if (lineIs(stderr, /^(?:\S+: )?Permission denied \([a-z,-]+\)\.$/u)) return "key_refused";
  return "unreachable";
};

/**
 * Whether the Home serves its link operation journal, from the exit code of the full listing alone.
 * The listing of a busy Home is far past HubOcx's output cap, so it is read with a small cap that
 * truncates instead of failing.
 */
export const journalServed = Effect.fn("EnrollHost.journalServed")(
  function* (binary: string, env: NodeJS.ProcessEnv) {
    const runner = yield* ProcessRunner.ProcessRunner;
    const ran = yield* runner.run({
      command: binary,
      args: ["link", "operations", "--json"],
      env,
      timeout: "30 seconds",
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 4096,
      outputMode: "truncate",
    });
    return !ran.timedOut && ran.code === 0;
  },
  Effect.orElseSucceed(() => false),
);

const IDENTITY_HINTS: ReadonlySet<string> = new Set([
  "identity_file_missing",
  "identity_file_not_regular",
  "identity_file_permissions",
  "identity_file_directory",
  "identity_file_ancestor",
  "identity_file_unreadable",
  "identity_file_unsupported_platform",
]);
/**
 * OpenCodex's refusal of the key file, from a failed ocx only; phaseOf reads it from the CLI's own
 * "(code invalid_identity_file, hint …)" line, never from a bare word.
 */
export const identityHintOf = (output: { readonly code: number; readonly phase?: string }) =>
  output.code !== 0 && output.phase !== undefined && IDENTITY_HINTS.has(output.phase)
    ? output.phase
    : undefined;

/** The machine's known_hosts holds another key (changed), or could not be written (unwritable). */
export class KnownHostsError extends Data.TaggedError("KnownHostsError")<{
  readonly reason: "changed" | "unwritable";
}> {}

/**
 * Writes a machine's one-line known_hosts once, through a temporary file linked into place, so a
 * failed write never leaves a partial file; a file holding anything else is "changed".
 */
export const writeKnownHostsOnce = Effect.fn("EnrollHost.writeKnownHostsOnce")(
  function* (directory: string, attachId: string, line: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, attachId);
    // One step per record runs at a time, so a temporary file of this record is a crash's leftover.
    for (const name of yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [])))
      if (name.startsWith(attachId + ".new-"))
        yield* Effect.ignore(fs.remove(path.join(directory, name)));
    const compare = (existing: string) =>
      existing === line
        ? Effect.succeed(file)
        : Effect.fail(new KnownHostsError({ reason: "changed" }));
    // Only a missing file is written; one GOAT cannot read is never replaced.
    const existing = yield* fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
    if (existing._tag === "Some") return yield* compare(existing.value);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const temporary = file + ".new-" + NodeCrypto.randomUUID();
    yield* fs.writeFileString(temporary, line, { mode: 0o600 });
    // link refuses an existing name, so a file that appeared meanwhile is compared, never replaced.
    const published = yield* fs.link(temporary, file).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      Effect.ensuring(Effect.ignore(fs.remove(temporary))),
    );
    if (!published) return yield* compare(yield* fs.readFileString(file));
    return file;
  },
  Effect.catchTags({
    PlatformError: () => Effect.fail(new KnownHostsError({ reason: "unwritable" })),
  }),
);

/**
 * What enrollment does outside GOAT's own records: read Pen's route for a node, keep the machine's
 * private known_hosts, run ssh under the route contract, and run ocx on this Home. Tests replace it
 * with fakes of those contracts.
 */
export class EnrollHost extends Context.Service<
  EnrollHost,
  {
    /** Pen's route for the node through the confirmed Pen; undefined when there is none to read. */
    readonly route: (node: PenNode) => Effect.Effect<PenExactRoute | undefined>;
    /** Writes the machine's one-line known_hosts once; a different line later fails. */
    readonly knownHosts: (attachId: string, line: string) => Effect.Effect<string, KnownHostsError>;
    /** Removes the machine's known_hosts once its link is gone; a missing file is already gone. */
    readonly forgetKnownHosts: (attachId: string) => Effect.Effect<boolean>;
    /** Runs `true` on the machine over the route contract within 30 s. */
    readonly reach: (route: DisposableRoute) => Effect.Effect<ReachAnswer>;
    /** Whether this Home's OpenCodex serves its link operation journal. */
    readonly journalServed: Effect.Effect<boolean>;
    /** Whether OpenCodex can use the machine key at this path, GOAT's own folders tightened. */
    readonly keyPath: (keyFile: string) => Effect.Effect<KeyPathAnswer>;
    /** ocx on this Home; undefined when it could not be run. */
    readonly ocx: (
      args: ReadonlyArray<string>,
      timeoutMs: number,
    ) => Effect.Effect<OcxOutput | undefined>;
  }
>()("goat/hub/disposable/EnrollHost") {}

const REACH_TIMEOUT = "30 seconds";

export const layer = Layer.effect(
  EnrollHost,
  Effect.gen(function* () {
    const ocx = yield* HubOcx;
    const settings = yield* Settings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const inventory = yield* Inventory.OpenCodexInventory;
    const environment = yield* HostProcess.Environment;
    const config = yield* ServerConfig;
    const directory = path.join(config.stateDir, "disposable", "known_hosts");
    const own = goatFolders(config);
    return EnrollHost.of({
      route: Effect.fn("EnrollHost.route")(
        function* (node) {
          const pen = (yield* settings.getSettings).pen;
          if (pen === null) return undefined;
          return yield* ocx.penExactRoute(node, pen);
        },
        Effect.orElseSucceed(() => undefined),
      ),
      keyPath: Effect.fn("EnrollHost.keyPath")(function* (keyFile) {
        return yield* keyPathFor(keyFile, own).pipe(
          Effect.orElseSucceed((): KeyPathAnswer => ({ kind: "unreadable" })),
        );
      }),
      knownHosts: Effect.fn("EnrollHost.knownHosts")(function* (attachId, line) {
        return yield* writeKnownHostsOnce(directory, attachId, line).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }),
      forgetKnownHosts: Effect.fn("EnrollHost.forgetKnownHosts")(
        function* (attachId) {
          yield* fs
            .remove(path.join(directory, attachId))
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
          return true;
        },
        Effect.orElseSucceed(() => false),
      ),
      reach: Effect.fn("EnrollHost.reach")(
        function* (route) {
          const options = disposableSshExecOptions(route);
          if (options === undefined) return "unusable" as const;
          const ran = yield* runner.run({
            command: yield* resolveSshCommand,
            // ERROR keeps a machine's banner and ssh's own notices out of what decides the answer.
            args: [...options, "-o", "LogLevel=ERROR", `pen-${route.nodeId}`, "true"],
            timeout: REACH_TIMEOUT,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: 64 * 1024,
          });
          return ran.timedOut ? ("unreachable" as const) : reachAnswerOf(ran.code, ran.stderr);
        },
        Effect.orElseSucceed(() => "unreachable" as const),
      ),
      journalServed: Effect.gen(function* () {
        const binary = (yield* inventory.read).binaries[0]?.path;
        return binary !== undefined && (yield* journalServed(binary, environment));
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.orElseSucceed(() => false),
      ),
      ocx: Effect.fn("EnrollHost.ocx")(
        function* (args, timeoutMs) {
          return yield* ocx.home(args, timeoutMs);
        },
        Effect.orElseSucceed(() => undefined),
      ),
    });
  }),
);
