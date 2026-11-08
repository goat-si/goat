import * as HostProcess from "@goat/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface ExcludedPortRange {
  readonly start: number;
  readonly end: number;
}

const EN_DASH = "\u2013";
const NETSH_EXCLUDED_PORT_TIMEOUT = Duration.millis(3_500);
const NETSH_KILL_GRACE = Duration.millis(500);
const PORT_LINE = /^\s*(\d+)\s+(\d+)\s*\*?\s*$/u;

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

export function parseExcludedPortRanges(output: string): ReadonlyArray<ExcludedPortRange> {
  const ranges: ExcludedPortRange[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = PORT_LINE.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end > 65535 ||
      start > end
    ) {
      continue;
    }
    ranges.push({ start, end });
  }
  return ranges;
}

export function findExcludedRange(
  port: number,
  ranges: ReadonlyArray<ExcludedPortRange>,
): ExcludedPortRange | null {
  return ranges.find((range) => port >= range.start && port <= range.end) ?? null;
}

export function suggestFreePort(
  port: number,
  ranges: ReadonlyArray<ExcludedPortRange>,
): number | null {
  let candidate = port + 1;
  while (candidate <= 65535) {
    const blocked = findExcludedRange(candidate, ranges);
    if (blocked === null) return candidate;
    candidate = blocked.end + 1;
  }
  return null;
}

export function reservedPortMessage(
  port: number,
  range: ExcludedPortRange,
  suggestion: number | null,
): string {
  const reserved =
    range.start === range.end
      ? `TCP port ${range.start}`
      : `TCP ports ${range.start}${EN_DASH}${range.end}`;
  const alternative =
    suggestion === null ? "Choose another port." : `Choose another port, such as ${suggestion}.`;
  return `Windows reserves ${reserved}, so Tailscale HTTPS cannot use port ${port}. ${alternative}`;
}

const readNetshExcludedPorts = Effect.fn("tailscale.readNetshExcludedPorts")(function* (
  family: "ipv4" | "ipv6",
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const empty: ReadonlyArray<ExcludedPortRange> = [];
  const recover = (cause: unknown) =>
    Effect.logDebug("Could not read Windows excluded TCP ports", { family, cause }).pipe(
      Effect.as(empty),
    );
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make("netsh.exe", ["int", family, "show", "excludedportrange", "protocol=tcp"], {
        forceKillAfter: NETSH_KILL_GRACE,
      }),
    );
    const [stdout, , exitCode] = yield* Effect.all(
      [
        collectText(child.stdout),
        collectText(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      yield* Effect.logDebug("Could not read Windows excluded TCP ports", { family, exitCode });
      return [];
    }
    return parseExcludedPortRanges(stdout);
  }).pipe(
    Effect.scoped,
    Effect.timeout(NETSH_EXCLUDED_PORT_TIMEOUT),
    Effect.catch(recover),
    Effect.catchDefect(recover),
  );
});

export const readWindowsExcludedTcpPortRanges = Effect.fn(
  "tailscale.readWindowsExcludedTcpPortRanges",
)(function* () {
  if ((yield* HostProcess.Platform) !== "win32") {
    return [];
  }
  const [ipv4, ipv6] = yield* Effect.all(
    [readNetshExcludedPorts("ipv4"), readNetshExcludedPorts("ipv6")],
    { concurrency: "unbounded" },
  );
  return [...ipv4, ...ipv6];
});
