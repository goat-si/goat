import { isNodeId } from "@goat/pen-protocol/identity";
import { Timeouts } from "@goat/pen-protocol/wire";
import type { Room } from "./room.ts";
import { TOTALS_WRITE_EVERY_MS } from "./traffic.ts";

export interface Env {
  readonly ROOM: DurableObjectNamespace<Room>;
  // `wrangler dev --var` overrides for tests; the deployed Worker sets none.
  readonly PENDING_TIMEOUT_MS?: string;
  readonly IDLE_TIMEOUT_MS?: string;
  readonly AUTH_TIMEOUT_MS?: string;
  // Where a node's first session id counts from (tests of the u32 wrap); unset starts at 0.
  readonly SID_START?: string;
  // How often a Room may write its traffic totals (tests use 0: at every session end).
  readonly TOTALS_EVERY_MS?: string;
  // Node ids, comma-separated, whose Rooms keep a traffic row; set as a secret (wrangler secret put
  // TRAFFIC_NODES) so the ids stay out of the repository. Unset keeps no rows.
  readonly TRAFFIC_NODES?: string;
}

export interface RelayLimits {
  readonly pendingTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly authTimeoutMs: number;
  readonly totalsEveryMs: number;
}

function clamp(raw: string | undefined, max: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0 && value <= max ? value : max;
}

/** Each override clamps to its contract default as a maximum. */
export function readLimits(env: Env): RelayLimits {
  return {
    pendingTimeoutMs: clamp(env.PENDING_TIMEOUT_MS, Timeouts.PENDING_TIMEOUT_MS),
    idleTimeoutMs: clamp(env.IDLE_TIMEOUT_MS, Timeouts.IDLE_TIMEOUT_MS),
    authTimeoutMs: clamp(env.AUTH_TIMEOUT_MS, Timeouts.AUTH_TIMEOUT_MS),
    totalsEveryMs:
      env.TOTALS_EVERY_MS === "0" ? 0 : clamp(env.TOTALS_EVERY_MS, TOTALS_WRITE_EVERY_MS),
  };
}

/** Whether nodeId's Room keeps a traffic row: anyone can mint node ids, so only listed ones do. */
export function tracksTraffic(env: Env, nodeId: string): boolean {
  return (
    isNodeId(nodeId) && (env.TRAFFIC_NODES ?? "").split(",").some((id) => id.trim() === nodeId)
  );
}
