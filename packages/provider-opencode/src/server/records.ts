export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function recordValue(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && key in input
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

export function recordString(input: unknown, ...keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(recordValue(input, key));
    if (value !== undefined) return value;
  }
  return undefined;
}
