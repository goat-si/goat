// @effect-diagnostics nodeBuiltinImport:off -- Output errors are emitted outside the Effect runtime.
import * as NodeFS from "node:fs";
import { ignoreClosedPipe } from "@goat/shared/closedPipe";
import { guardErrors } from "@goat/shared/errorGuards";

let installed = false;

export function installServerOutputHandlers(): void {
  if (installed) return;
  installed = true;
  const route = (otherFd: number) => (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOSPC") return ignoreClosedPipe(error);
    try {
      NodeFS.writeSync(otherFd, "goat: ENOSPC writing server output; log output may be lost.\n");
    } catch {
      // Both output destinations can share the full filesystem.
    }
  };
  guardErrors(process.stdout, route(2));
  guardErrors(process.stderr, route(1));
}
