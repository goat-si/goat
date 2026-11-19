import * as M from "@goat/contracts";
import type * as Hub from "./MemoryHubService.ts";
import type * as Store from "./MemoryStore.ts";

type Error = Hub.MemoryHubServiceError;

export const failureCode = (e: Error): M.MemoryFailureCode =>
  e._tag === "MemoryHubUnauthorizedError" || e._tag === "MemoryHubForbiddenError"
    ? "route_unavailable"
    : e._tag === "MemoryStorageError"
      ? "storage_failed"
      : e._tag === "MemoryCapacityError"
        ? "capacity_exceeded"
        : e.code;
export const holdClass = (e: Error): Store.MemoryHoldClass =>
  e._tag === "MemoryHubUnauthorizedError" ||
  e._tag === "MemoryHubForbiddenError" ||
  failureCode(e) === "route_unavailable"
    ? "authorization"
    : ["identity_mismatch", "space_mismatch"].includes(failureCode(e))
      ? "identity"
      : [
            "unsupported_protocol",
            "unsupported_operation",
            "invalid_output",
            "invalid_cursor",
          ].includes(failureCode(e))
        ? "protocol"
        : "availability";
export const transient = (e: Error) =>
  e._tag === "MemoryStorageError" ||
  (e._tag === "MemoryHubError" &&
    ["unavailable", "storage_failed", "cursor_expired"].includes(e.code));

export const nextPullRetry = (
  error: Error,
  attempts: number,
  now: number,
  waitingForCheckpoint: boolean,
) => {
  const retrySoon = waitingForCheckpoint || transient(error);
  return {
    attempts: Math.min(2147483647, attempts + 1),
    nextAttemptAt: retrySoon
      ? now + Math.min(30000, 1000 * 2 ** Math.min(attempts, 5))
      : Number.MAX_SAFE_INTEGER,
    failureCode: failureCode(error),
    holdClass: retrySoon ? null : holdClass(error),
  };
};

export const refusedSync = (operation: M.MemoryOperation, code: M.MemoryFailureCode) =>
  (operation.kind === "move" && code === "source_invalidated") ||
  (M.requiresMemoryFloor2(operation) &&
    (code === "unsupported_protocol" || code === "hub_upgrade_required"));
