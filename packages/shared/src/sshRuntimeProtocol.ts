import { ORCHESTRATION_PROTOCOL_MIN_SERVED, ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";

/** Bump when helper grammar, runner lifecycle, or auth-state semantics cease to interoperate.
 * GOAT 1001 <-> upstream 1. GOAT protocol numbers only increase. */
export const SSH_RUNTIME_PROTOCOL_VERSION = 1001;

export interface ProtocolRange {
  readonly min: number;
  readonly max: number;
}

/** The protocol versions one side can speak. A build speaks a range so two builds interoperate
 * without either replacing the other; `serverVersion` is informational. */
export interface RuntimeProtocolRanges {
  readonly ssh: ProtocolRange;
  readonly orchestration: ProtocolRange;
}

/** The single protocols this build speaks as a client. */
export const ownRuntimeProtocolRanges = (orchestrationProtocolVersion: number) =>
  ({
    ssh: { min: SSH_RUNTIME_PROTOCOL_VERSION, max: SSH_RUNTIME_PROTOCOL_VERSION },
    orchestration: { min: orchestrationProtocolVersion, max: orchestrationProtocolVersion },
  }) satisfies RuntimeProtocolRanges;

/** The ranges this build serves as a server, down to the oldest client protocol it still keeps. */
export const servedRuntimeProtocolRanges = () =>
  ({
    ssh: { min: SSH_RUNTIME_PROTOCOL_VERSION, max: SSH_RUNTIME_PROTOCOL_VERSION },
    orchestration: { min: ORCHESTRATION_PROTOCOL_MIN_SERVED, max: ORCHESTRATION_PROTOCOL_VERSION },
  }) satisfies RuntimeProtocolRanges;

export type RuntimeProtocolVerdict =
  | "compatible"
  | "update-required"
  | "client-too-old"
  | "unknown";

const validRange = (range: ProtocolRange | undefined): range is ProtocolRange =>
  range !== undefined &&
  Number.isSafeInteger(range.min) &&
  Number.isSafeInteger(range.max) &&
  range.min > 0 &&
  range.min <= range.max;

/**
 * The orchestration protocols a server serves. Servers that advertise only the integer serve
 * exactly that one, and servers shipped before negotiation speak the original protocol 1.
 * A malformed advertised range is `null`: compatibility cannot be established from it.
 */
export const orchestrationProtocolRangeOf = (server: {
  readonly protocol?: Partial<RuntimeProtocolRanges> | undefined;
  readonly orchestrationProtocolVersion?: number | undefined;
}): ProtocolRange | null => {
  const advertised = server.protocol?.orchestration;
  if (advertised !== undefined) return validRange(advertised) ? advertised : null;
  const version = server.orchestrationProtocolVersion ?? 1;
  return { min: version, max: version };
};

/**
 * The one SSH runtime compatibility comparator. A server compatible with the client on both the SSH
 * runner and orchestration ranges can be attached. `update-required` means the server is older than
 * every version the client speaks, `client-too-old` the reverse. A server that advertises no ranges
 * falls back to its single integers; a server with neither is `unknown`.
 */
export const compareRuntimeProtocols = (
  client: RuntimeProtocolRanges,
  server: {
    readonly protocol?: Partial<RuntimeProtocolRanges> | undefined;
    readonly sshRuntimeProtocolVersion?: number | undefined;
    readonly orchestrationProtocolVersion?: number | undefined;
  },
): RuntimeProtocolVerdict => {
  const point = (value: number | undefined) =>
    value === undefined ? undefined : { min: value, max: value };
  const serverRanges = [
    [client.ssh, server.protocol?.ssh ?? point(server.sshRuntimeProtocolVersion)],
    [
      client.orchestration,
      server.protocol?.orchestration ?? point(server.orchestrationProtocolVersion),
    ],
  ] as const;
  let verdict: RuntimeProtocolVerdict = "compatible";
  for (const [own, theirs] of serverRanges) {
    if (!validRange(own) || !validRange(theirs)) return "unknown";
    if (theirs.max < own.min) verdict = "update-required";
    else if (theirs.min > own.max && verdict === "compatible") verdict = "client-too-old";
  }
  return verdict;
};

export type HostCompatibility = "compatible" | "degraded" | "incompatible";

export interface HostCompatibilityVerdict {
  readonly compatibility: HostCompatibility;
  /** The side that has to update, or null when neither has to. */
  readonly update: "host" | "this-machine" | null;
}

/**
 * How a reachable host relates to the machine reading it, from the protocol ranges the host
 * serves. Release strings never enter: two builds of different channels that serve the same
 * protocols are compatible. A host that does not advertise both ranges, or advertises malformed
 * ones, answered but cannot show compatibility, so it is `degraded` and the host is the side to
 * update.
 */
export const hostCompatibilityOf = (
  client: RuntimeProtocolRanges,
  host: { readonly protocol?: Partial<RuntimeProtocolRanges> | undefined },
): HostCompatibilityVerdict => {
  if (host.protocol?.ssh === undefined || host.protocol.orchestration === undefined) {
    return { compatibility: "degraded", update: "host" };
  }
  switch (compareRuntimeProtocols(client, { protocol: host.protocol })) {
    case "compatible":
      return { compatibility: "compatible", update: null };
    case "update-required":
      return { compatibility: "incompatible", update: "host" };
    case "client-too-old":
      return { compatibility: "incompatible", update: "this-machine" };
    case "unknown":
      return { compatibility: "degraded", update: "host" };
  }
};
