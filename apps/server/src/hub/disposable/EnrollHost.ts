import { ServerConfig } from "../../config.ts";
import { resolveSshCommand } from "@goat/ssh/command";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../processRunner.ts";
import * as Settings from "../../serverSettings.ts";
import { HubOcx, type OcxOutput, type PenExactRoute } from "../HubOcx.ts";
import type { PenNode } from "../penSshRoute.ts";
import { type DisposableRoute, disposableSshExecOptions } from "./routeContract.ts";

/** The machine's known_hosts holds another key (changed), or could not be written (unwritable). */
/** How a reach ended; ssh's own lines decide it, and none of them is kept. */
export type ReachAnswer = "ok" | "key_refused" | "host_key_changed" | "unreachable" | "unusable";
export const reachAnswerOf = (code: number | null, stderr: string): ReachAnswer =>
  code === 0
    ? "ok"
    : /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/u.test(stderr)
      ? "host_key_changed"
      : /Permission denied \(/u.test(stderr)
        ? "key_refused"
        : "unreachable";

export class KnownHostsError extends Data.TaggedError("KnownHostsError")<{
  readonly reason: "changed" | "unwritable";
}> {}

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
    /** Runs `true` on the machine over the route contract within 30 s. */
    readonly reach: (route: DisposableRoute) => Effect.Effect<ReachAnswer>;
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
    const directory = path.join((yield* ServerConfig).stateDir, "disposable", "known_hosts");
    return EnrollHost.of({
      route: Effect.fn("EnrollHost.route")(
        function* (node) {
          const pen = (yield* settings.getSettings).pen;
          if (pen === null) return undefined;
          return yield* ocx.penExactRoute(node, pen);
        },
        Effect.orElseSucceed(() => undefined),
      ),
      knownHosts: Effect.fn("EnrollHost.knownHosts")(
        function* (attachId, line) {
          const file = path.join(directory, attachId);
          const existing = yield* fs.readFileString(file).pipe(Effect.option);
          if (existing._tag === "Some")
            return existing.value === line
              ? file
              : yield* new KnownHostsError({ reason: "changed" });
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          yield* fs.writeFileString(file, line, { mode: 0o600 });
          return file;
        },
        Effect.catchTags({
          PlatformError: () => Effect.fail(new KnownHostsError({ reason: "unwritable" })),
        }),
      ),
      reach: Effect.fn("EnrollHost.reach")(
        function* (route) {
          const options = disposableSshExecOptions(route);
          if (options === undefined) return "unusable" as const;
          const ran = yield* runner.run({
            command: yield* resolveSshCommand,
            args: [...options, `pen-${route.nodeId}`, "true"],
            timeout: REACH_TIMEOUT,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: 64 * 1024,
          });
          return ran.timedOut ? ("unreachable" as const) : reachAnswerOf(ran.code, ran.stderr);
        },
        Effect.orElseSucceed(() => "unreachable" as const),
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
