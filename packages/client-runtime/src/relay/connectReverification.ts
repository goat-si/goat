import { RelayAuthenticationStrengthError } from "@goat/contracts/connectAssurance";
import * as Schema from "effect/Schema";

const isStrengthError = Schema.is(RelayAuthenticationStrengthError);

function requiresConnectReverification(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    if (isStrengthError(current))
      return current.reason === "reauthentication_required" || current.reason === "mfa_required";
    if ("relayError" in current && isStrengthError(current.relayError)) return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

export async function runConnectSensitiveAction<A>(input: {
  readonly action: () => Promise<A>;
  readonly reverify: () => Promise<void>;
  readonly invalidate: () => Promise<void>;
}): Promise<A> {
  try {
    return await input.action();
  } catch (error) {
    if (!requiresConnectReverification(error)) throw error;
    await input.reverify();
    await input.invalidate();
    return input.action();
  }
}
