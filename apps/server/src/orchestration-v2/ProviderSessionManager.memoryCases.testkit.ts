// Turn-start memory admission cases: launch kind, task ceiling, and the grant the turn receives.
export const turnStartMemoryCases = [
  { name: "ordinary", kind: "ordinary", ceiling: undefined, expected: "read_write" },
  { name: "channel reply", kind: "channel", ceiling: undefined, expected: "none" },
  {
    name: "usage-limit ordinary",
    kind: "ordinary",
    ceiling: undefined,
    expected: "read_write",
    continuation: true,
  },
  {
    name: "usage-limit delegated read",
    kind: "delegated",
    ceiling: "read",
    expected: "read",
    continuation: true,
  },
  ...(["scheduled", "delegated"] as const).flatMap((kind) =>
    (["none", "read", "read_write"] as const).map(
      (ceiling) =>
        ({
          name: `${kind} ${ceiling}`,
          kind,
          ceiling,
          expected: ceiling,
        }) as const,
    ),
  ),
  { name: "legacy task", kind: "delegated", ceiling: undefined, expected: "none" },
  {
    name: "read-only sandbox",
    kind: "ordinary",
    ceiling: undefined,
    expected: "read",
    readOnly: true,
  },
  {
    name: "pending admission",
    kind: "delegated",
    ceiling: "none",
    expected: "read",
    pending: true,
  },
  {
    name: "pending admission plus read-only sandbox",
    kind: "delegated",
    ceiling: "none",
    expected: "read",
    pending: true,
    readOnly: true,
  },
  {
    name: "missing message",
    kind: "ordinary",
    ceiling: undefined,
    expected: "none",
    missingMessage: true,
  },
] as const;

export type TurnStartMemoryCase = (typeof turnStartMemoryCases)[number];
