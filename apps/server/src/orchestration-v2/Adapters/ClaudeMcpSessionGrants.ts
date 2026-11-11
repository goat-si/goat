import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import { stableStringify } from "@goat/shared/relaySigning";

const MAX_GRANTS = 64;
const MAX_KEY_BYTES = 8 * 1024;

function keyFor(request: ElicitationRequest): string | undefined {
  try {
    const key = stableStringify([
      request.serverName,
      request.displayName ?? null,
      request.title ?? null,
      request.message,
      request.requestedSchema ?? null,
    ]);
    return Buffer.byteLength(key, "utf8") <= MAX_KEY_BYTES ? key : undefined;
  } catch {
    return undefined;
  }
}

export function makeClaudeMcpSessionGrants() {
  const grants = new Map<string, ElicitationResult>();
  return {
    get(request: ElicitationRequest): ElicitationResult | undefined {
      const key = keyFor(request);
      const result = key === undefined ? undefined : grants.get(key);
      return result === undefined ? undefined : structuredClone(result);
    },
    remember(request: ElicitationRequest, result: ElicitationResult): void {
      const key = keyFor(request);
      if (key !== undefined && (grants.has(key) || grants.size < MAX_GRANTS)) {
        grants.set(key, structuredClone(result));
      }
    },
  };
}
