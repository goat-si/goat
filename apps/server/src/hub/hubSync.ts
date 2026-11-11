import type { HubDeviceStep } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { deviceExit } from "./hubDeviceResult.ts";
import type { HubChildConnectionAdmission, HubOcx } from "./HubOcx.ts";

const SYNC_TIMEOUT_MS = 120_000;
/** OpenCodex's exit when --expect-link finds another or no connection; it changed nothing. */
const LINK_MISMATCH = 5;
const LATER = "Run hub.device_repair, or ocx sync on the device, once it is idle.";

/**
 * A join's one sync over its new link, so the Child routes through the Home before parity reads
 * it. It runs inside the Child's own goat_hub_child_connection: under its admission fence, only
 * while no turn runs, as ocx sync --expect-link, so a sync never lands on another connection and a
 * runtime restart it causes never cuts a running turn. Anything less defers it; nothing runs unbound.
 */
export const makeLinkSync = (ocx: HubOcx["Service"]) =>
  Effect.fn("HubMembership.syncOverLink")(function* (
    alias: string,
    linkId: string,
    admission: HubChildConnectionAdmission,
  ) {
    const deferred = (detail: string, moved = false) => ({
      step: { step: "sync", outcome: "deferred", detail } satisfies HubDeviceStep,
      moved,
    });
    // A standing consent can be withdrawn while link add runs; the sync is a separate change.
    const allowed = yield* admission.authorize.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!allowed)
      return deferred(`Permission for this membership change ended before the sync. ${LATER}`);
    return yield* ocx
      .connection(alias, { kind: "sync", expectedLinkId: linkId }, SYNC_TIMEOUT_MS, admission)
      .pipe(
        Effect.map((output) =>
          output.code === 0
            ? {
                step: {
                  step: "sync",
                  outcome: "ok",
                  detail: `ocx sync ran over ${linkId}.`,
                } satisfies HubDeviceStep,
                moved: false,
              }
            : output.code === LINK_MISMATCH
              ? deferred(
                  `${output.message ?? `${alias} is not connected over ${linkId}; nothing was changed.`} ${LATER}`,
                  true,
                )
              : {
                  step: {
                    step: "sync",
                    outcome: "failed",
                    detail: deviceExit("sync", output),
                  } satisfies HubDeviceStep,
                  moved: false,
                },
        ),
        // Busy, an older GOAT or OpenCodex there, or a changed membership: nothing ran.
        Effect.catch((error) => Effect.succeed(deferred(`${error.message} ${LATER}`))),
      );
  });
