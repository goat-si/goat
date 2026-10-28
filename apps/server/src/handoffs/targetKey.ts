/** Continuation arguments as one stable string, keys sorted, for a handoff's dedupe key. */
export const targetKey = (args: Readonly<Record<string, unknown>>) =>
  JSON.stringify(args, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
