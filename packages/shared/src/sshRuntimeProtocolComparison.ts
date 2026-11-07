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

export type RuntimeProtocolVerdict =
  | "compatible"
  | "update-required"
  | "client-too-old"
  | "unknown";

export const validRange = (range: ProtocolRange | undefined): range is ProtocolRange =>
  range !== undefined &&
  Number.isSafeInteger(range.min) &&
  Number.isSafeInteger(range.max) &&
  range.min > 0 &&
  range.min <= range.max;

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
