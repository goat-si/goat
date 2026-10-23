import { goatCallText } from "@goat/contracts/agentSurface/callText";
/**
 * Plain sentences for a remote GOAT that did not answer. Node's fetch reports every transport
 * failure as "fetch failed" and keeps the reason in its cause chain, so the cause decides the
 * sentence. Each one names what happened and what to do; the failure keeps its reason code.
 */

export type RemoteTransportFailure = "refused" | "timeout" | "dropped" | "unreachable";

const CODES: ReadonlyArray<readonly [RemoteTransportFailure, ReadonlySet<string>]> = [
  ["refused", new Set(["ECONNREFUSED"])],
  [
    "timeout",
    new Set([
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "TimeoutError",
      "AbortError",
    ]),
  ],
  ["dropped", new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"])],
  [
    "unreachable",
    new Set(["ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ENETDOWN"]),
  ],
];

function* causes(error: unknown): Generator<Record<string, unknown>> {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const record = current as Record<string, unknown>;
    yield record;
    current = record.cause;
  }
}

export function classifyRemoteTransportFailure(error: unknown): RemoteTransportFailure | null {
  for (const cause of causes(error)) {
    for (const key of [cause.code, cause.name]) {
      if (typeof key !== "string") continue;
      for (const [kind, codes] of CODES) if (codes.has(key)) return kind;
    }
  }
  return null;
}

/** The sentence for a remote GOAT whose call failed in transport, before any reply. */
export function remoteUnavailableMessage(alias: string, error: unknown): string {
  switch (classifyRemoteTransportFailure(error)) {
    case "refused":
      return `GOAT on ${alias} is not accepting connections; it may be stopped or restarting. ${goatCallText("ssh.host_status")} shows whether its runtime is up.`;
    case "timeout":
      return `GOAT on ${alias} is too busy to answer: the request timed out. A stalled server is usually overloaded or has a large database; Fleet shows its load and storage.`;
    case "dropped":
      return `The connection to GOAT on ${alias} dropped mid-request. Retrying usually works; if it keeps happening, GOAT there may be restarting.`;
    case "unreachable":
      return `${alias} cannot be reached on the network. Check that it is awake and online.`;
    case null: {
      const detail = error instanceof Error ? error.message.trim() : "";
      return detail.length === 0 || detail === "fetch failed"
        ? `GOAT on ${alias} did not answer; the connection failed before a reply.`
        : `GOAT on ${alias} did not answer: ${detail}`;
    }
  }
}

/** A call that got no reply within its deadline: the server is up but not keeping up. */
export function remoteDeadlineMessage(alias: string, tool: string, timeoutMs: number): string {
  return `GOAT on ${alias} did not answer ${tool} within ${Math.round(timeoutMs / 1000)}s. It is reachable but busy, usually from load or a large database; Fleet shows its load and storage.`;
}
