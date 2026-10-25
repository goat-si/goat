import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** The two launch identities are exclusive; ignored flags could silently select the wrong one. */
export const parseLeaseProxyArguments = (args: ReadonlyArray<string>) => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      !["--thread", "--control", "--expires", "--driver-fingerprint"].includes(key) ||
      values.has(key) ||
      value === undefined ||
      value.trim().length === 0 ||
      value.startsWith("--")
    )
      return undefined;
    values.set(key, value);
  }
  const threadId = values.get("--thread");
  if (threadId !== undefined) {
    // Identity for provider reloads only; control admission comes from the authenticated stream.
    const expectedSize = values.has("--driver-fingerprint") ? 2 : 1;
    return values.size === expectedSize ? { mode: "thread" as const, threadId } : undefined;
  }
  const controlId = values.get("--control");
  const expiresAt = DateTime.make(values.get("--expires") ?? "");
  return values.size === 2 && controlId !== undefined && Option.isSome(expiresAt)
    ? { mode: "control" as const, controlId, expiresAt: expiresAt.value }
    : undefined;
};
