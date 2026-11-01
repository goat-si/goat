import type * as M from "@goat/contracts";
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
