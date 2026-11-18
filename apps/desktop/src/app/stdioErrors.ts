import * as NodeOS from "node:os";

// libuv has no name for EDQUOT, so Node reports it as code "UNKNOWN" with the raw errno.
const EDQUOT_ERRNO = NodeOS.constants.errno.EDQUOT;

export function handleStdioError(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && ["EPIPE", "ENOSPC", "EDQUOT"].includes(String(error.code))) return;
    if (EDQUOT_ERRNO !== undefined && "errno" in error && error.errno === -EDQUOT_ERRNO) return;
  }
  throw error;
}
