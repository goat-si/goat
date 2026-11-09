import { Timeouts } from "@goat/pen-protocol/wire";
import type { Room } from "./room.ts";

export interface Env {
  readonly ROOM: DurableObjectNamespace<Room>;
  // `wrangler dev --var` overrides for tests; the deployed Worker sets none.
  readonly PENDING_TIMEOUT_MS?: string;
  readonly IDLE_TIMEOUT_MS?: string;
  readonly AUTH_TIMEOUT_MS?: string;
}

export interface RelayLimits {
  readonly pendingTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly authTimeoutMs: number;
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
  };
}
