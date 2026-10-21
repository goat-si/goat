import type { ModelSelection, OpenCodexInventorySnapshot, ServerProvider } from "@goat/contracts";

import type { LocalOpenCodexRoute } from "./localRoutes.ts";

/**
 * GOAT's hub-down policy (design 261021_goatclaw_hub §1.6): what new goal work on this device does
 * while its Home is unreachable. OpenCodex never serves a Child from local providers; GOAT may hop
 * to the device's own sign-in only when both GOAT's switch and OpenCodex's per-device permission
 * allow it. Everything else pauses. Running turns are never touched.
 */
export type HubWork =
  | { readonly _tag: "Unaffected" }
  | { readonly _tag: "Hop"; readonly selection: ModelSelection; readonly notice: string }
  | { readonly _tag: "Paused"; readonly message: string };

export const UNAFFECTED: HubWork = { _tag: "Unaffected" };

/** Statuses a Child or Hub client answers when it cannot reach its Home (OCX-11 home_unreachable). */
const HOME_DOWN_STATUSES = new Set([502, 503, 504]);

/**
 * This device reaches models through a Home that is not answering. A Child waits for its tunnel
 * before answering 503, so the relayed request timing out with OpenCodex itself healthy counts too.
 * A local OpenCodex that is down is a different failure and stays with the provider errors.
 */
export function homeUnreachable(snapshot: OpenCodexInventorySnapshot): boolean {
  const linked = snapshot.link.role === "child" || snapshot.hubClient !== undefined;
  const evidence = snapshot.parityEvidence;
  if (!linked || !snapshot.runtime.healthy || evidence === undefined) return false;
  return evidence.modelsStatus === undefined || HOME_DOWN_STATUSES.has(evidence.modelsStatus);
}

export function decideHubWork(input: {
  readonly unreachable: boolean;
  readonly selection: ModelSelection;
  readonly routes: ReadonlyArray<LocalOpenCodexRoute>;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** hub.devices.local.localFallback */
  readonly goatAllows: boolean;
  /** OpenCodex's devices[].localFallback as last read from the Home; undefined when never read. */
  readonly openCodexAllows: boolean | undefined;
}): HubWork {
  if (!input.unreachable) return UNAFFECTED;
  const { selection } = input;
  const route = input.routes.find((entry) => entry.instanceId === selection.instanceId);
  // Work whose instance bypasses this device's OpenCodex never needed the Home. An unproven
  // route may still need it, so it pauses.
  if (route === undefined || route.status === "failed") return UNAFFECTED;
  const paused = (why: string): HubWork => ({
    _tag: "Paused",
    message: "The hub is unreachable and " + why + ".",
  });
  if (!input.goatAllows) return paused("local fallback is off for this device in hub settings");
  if (input.openCodexAllows !== true)
    return paused(
      input.openCodexAllows === false
        ? "OpenCodex does not allow local fallback for this device"
        : "OpenCodex's local fallback permission for this device is unknown",
    );
  const candidate = input.providers.find(
    (provider) =>
      provider.instanceId !== selection.instanceId &&
      provider.driver === route.driver &&
      provider.enabled &&
      provider.status === "ready" &&
      provider.auth.status === "authenticated" &&
      input.routes.some(
        (entry) => entry.instanceId === provider.instanceId && entry.status === "failed",
      ) &&
      provider.models.some((model) => model.slug === selection.model),
  );
  if (candidate === undefined)
    return paused(
      "no other " + route.driver + " instance here has its own sign-in for " + selection.model,
    );
  return {
    _tag: "Hop",
    selection: {
      instanceId: candidate.instanceId,
      model: selection.model,
      ...(selection.options === undefined ? {} : { options: selection.options }),
    },
    notice:
      "The hub is unreachable, so GOAT moved this goal work to " +
      (candidate.displayName ?? candidate.instanceId) +
      ", this device's own sign-in. It returns to the hub on the next attempt after the hub is back.",
  };
}
