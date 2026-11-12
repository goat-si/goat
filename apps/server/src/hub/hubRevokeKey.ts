import type { HubDeviceStep } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { HubOcx } from "./HubOcx.ts";

/** The hub's half of a Hub client leaving: revoke its data key once the device is standalone. */
export const revokeHubClientKey = Effect.fn("HubMembership.revokeKey")(function* (
  ocx: HubOcx["Service"],
  id: string,
  steps: HubDeviceStep[],
  timeoutMs: number,
) {
  const revoked = yield* ocx.home(["access", "key", "remove", id, "--yes", "--json"], timeoutMs);
  steps.push(
    revoked.code === 0
      ? { step: "revoke", outcome: "ok", detail: id }
      : {
          step: "revoke",
          outcome: "failed",
          detail: `ocx access key remove exited ${revoked.code}.`,
        },
  );
  return revoked.code === 0;
});
