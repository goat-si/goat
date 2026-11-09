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
const CAPABILITIES = ["facts"] as const;
const capabilitiesLine = () => ["caps v1", ...CAPABILITIES].join(" ");

export const capabilities = Command.make("capabilities").pipe(
  Command.withHandler(() =>
    Effect.sync(() => {
      process.stdout.write(capabilitiesLine() + "\n");
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

/**
 * The first probe's four questions in one start, each answered by the function its separate
 * subcommand uses, in the probe's order: `runtime-manifest --shell`, `commit-time`,
 * `protocol --shell` for the live server, then `compat` on the port that live answer named.
 * With `withCaps` the `capabilities` line follows the begin line, outside the count.
 */
const readSshRuntimeFactsFrame = async (input: {
  readonly runtimeFile: string;
  readonly portFile: string;
  readonly pidFile: string;
  readonly withCaps: boolean;
}) => {
  const lines = [
    `manifest ok ${runtimeManifestShellLine()}`,
    BUILD_COMMIT_TIME === undefined ? "commit fail unavailable" : `commit ok ${BUILD_COMMIT_TIME}`,
  ];
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
  const head = input.withCaps ? ["begin v1 facts", capabilitiesLine()] : ["begin v1 facts"];
  return [...head, ...lines, `end ${lines.length}`].join("\n") + "\n";
};

export const facts = Command.make("facts", {
  runtimeFile: Flag.String("runtime-file"),
  portFile: Flag.String("port-file"),
  pidFile: Flag.String("pid-file"),
  withCaps: Flag.Boolean("with-caps").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler((input) =>
    Effect.promise(async () => {
      process.stdout.write(await readSshRuntimeFactsFrame(input));
    }),
  ),
);
