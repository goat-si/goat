import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";
import { BUILD_COMMIT_TIME } from "../buildCommitTime.ts";
import {
  instanceToken,
  protocolShellLine,
  readLiveSshRuntimeProtocol,
  readSshRuntimeCompatibility,
  runtimeManifestShellLine,
} from "./sshRuntimeProbes.ts";

// A host script asks `capabilities` once per executable before it uses a combined call, and an
// old runtime's unknown-subcommand answer is cached as "none". The call takes no flags so that
// answer is one exact error. The names a script may see are fixed there (fact_valid caps).
const CAPABILITIES = ["facts", "wait-ready-report"] as const;

export const capabilities = Command.make("capabilities").pipe(
  Command.withHandler(() =>
    Effect.sync(() => {
      process.stdout.write(["caps v1", ...CAPABILITIES].join(" ") + "\n");
    }),
  ),
);

const compatLine = async (port: number, liveInstance: unknown) => {
  try {
    const value = await readSshRuntimeCompatibility(port);
    // Both reads must carry an id: only then is the server that answered compat the live one.
    if (!instanceToken(liveInstance) || value.instanceId === undefined)
      return "compat fail unavailable";
    if (value.instanceId !== liveInstance) return "compat fail changed";
    return `compat ok ${value.verdict} ${value.drainRestart ? 1 : 0} ${value.instanceId}`;
  } catch {
    return "compat fail unavailable";
  }
};

type RuntimeFiles = {
  readonly runtimeFile: string;
  readonly portFile: string;
  readonly pidFile: string;
};

// The live answer, then compat on the port that answer named, asked only when the descriptor read
// for live and the one read for compat carry the same instance id.
const liveAndCompatLines = async (input: RuntimeFiles) => {
  const lines: string[] = [];
  let liveInstance: unknown;
  let livePort: number | undefined;
  try {
    const live = await readLiveSshRuntimeProtocol(
      input.runtimeFile,
      input.portFile,
      input.pidFile,
      (instanceId) => {
        liveInstance = instanceId;
      },
    );
    lines.push(`live ok ${protocolShellLine(live)}`);
    if (live.status === "live" && live.port >= 1 && live.port <= 65535) livePort = live.port;
  } catch {
    lines.push("live fail error");
  }
  if (livePort !== undefined) lines.push(await compatLine(livePort, liveInstance));
  return lines;
};

const frame = (call: string, lines: ReadonlyArray<string>) =>
  [`begin v1 ${call}`, ...lines, `end ${lines.length}`].join("\n") + "\n";

/**
 * The first probe's four questions in one start, each answered by the function its separate
 * subcommand uses, in the probe's order: `runtime-manifest --shell`, `commit-time`,
 * `protocol --shell` for the live server, then `compat` on the port that live answer named.
 * The host script validates the whole frame before it uses or records any line.
 */
const readSshRuntimeFactsFrame = async (input: RuntimeFiles) =>
  frame("facts", [
    `manifest ok ${runtimeManifestShellLine()}`,
    BUILD_COMMIT_TIME === undefined ? "commit fail unavailable" : `commit ok ${BUILD_COMMIT_TIME}`,
    ...(await liveAndCompatLines(input)),
  ]);

/**
 * What a launch's `wait-ready --report` prints once its wait ends: whether the server on `port`
 * answered, then, for a ready server, the live and compat answers the first pairing asks, so the
 * launch can record them. A server that never answered is asked nothing more.
 */
export const waitReadyReportFrame = async (port: number, ready: boolean, input: RuntimeFiles) =>
  frame(
    "wait-ready",
    ready
      ? [`ready ok ${port}`, ...(await liveAndCompatLines(input))]
      : ["ready fail timeout", "live fail unavailable"],
  );

export const waitReadyReportFlags = {
  report: Flag.Boolean("report").pipe(Flag.withDefault(false)),
  runtimeFile: Flag.String("runtime-file").pipe(Flag.optional),
  portFile: Flag.String("port-file").pipe(Flag.optional),
  pidFile: Flag.String("pid-file").pipe(Flag.optional),
};

export const facts = Command.make("facts", {
  runtimeFile: Flag.String("runtime-file"),
  portFile: Flag.String("port-file"),
  pidFile: Flag.String("pid-file"),
}).pipe(
  Command.withHandler((input) =>
    Effect.promise(async () => {
      process.stdout.write(await readSshRuntimeFactsFrame(input));
    }),
  ),
);
