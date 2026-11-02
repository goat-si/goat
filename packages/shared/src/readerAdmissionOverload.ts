export class ReaderAdmissionOverloadError extends Error {
  constructor() {
    super("Reader admission limit reached");
    this.name = "ReaderAdmissionOverloadError";
  }
}

export const isReaderAdmissionOverload = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value instanceof ReaderAdmissionOverloadError) return true;
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if ("cause" in value) pending.push(value.cause);
    if ("reason" in value) pending.push(value.reason);
  }
  return false;
};
