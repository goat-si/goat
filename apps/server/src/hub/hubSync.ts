import type { HubDeviceStep } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { deviceExit } from "./hubDeviceResult.ts";
import { type HubOcx, SYNC_EXIT } from "./HubOcx.ts";

const SYNC_TIMEOUT_MS = 120_000;

/**
 * A join's one sync over its new link, so the Child routes through the Home before parity reads
 * it. Like the Child sync of OpenCodexSync, it runs only on an idle device and never restarts
 * Codex; the guarded script refuses unless the device is connected over exactly this link.
 */
export const makeLinkSync = (ocx: HubOcx["Service"]) =>
  Effect.fn("HubMembership.syncOverLink")(function* (
    alias: string,
    linkId: string,
    scope: McpInvocationScope,
  ) {
    // moved: the device left this link during the sync, so the join cannot report it linked.
    const failed = (detail: string, moved = false) => ({
      step: { step: "sync", outcome: "failed", detail } satisfies HubDeviceStep,
      moved,
    });
    if ((yield* ocx.runningTurns(alias, scope)) !== 0)
      return {
        step: {
          step: "sync",
          outcome: "deferred",
          detail: "A turn is running there, or its activity is unknown, so GOAT did not sync.",
        } satisfies HubDeviceStep,
        moved: false,
      };
    return yield* ocx.syncDevice(alias, { linkId, restartCodex: false }, SYNC_TIMEOUT_MS).pipe(
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
          : output.code === SYNC_EXIT.notConnected
            ? failed(`${alias} is not connected over ${linkId} yet.`)
            : output.code === SYNC_EXIT.connectionChanged
              ? failed(
                  "The connection changed during ocx sync, so it is not reported synced.",
                  true,
                )
              : failed(deviceExit("sync", output)),
      ),
      Effect.catch((error) => Effect.succeed(failed(error.message))),
    );
  });
