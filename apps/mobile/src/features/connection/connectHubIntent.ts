import type { EnvironmentId } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";

export type ConnectHubIntent = "hub" | "change-hub" | "add-server" | "add-route";

export function resolveConnectHubIntent(input: {
  readonly intent?: string;
  readonly routeFor?: string;
  readonly savedEnvironmentCount: number;
}): ConnectHubIntent {
  if (input.routeFor) return "add-route";
  if (input.intent === "hub" || input.intent === "change-hub" || input.intent === "add-server") {
    return input.intent;
  }
  return input.savedEnvironmentCount === 0 ? "hub" : "change-hub";
}

const HUB_SCAN_HINT =
  "Scan the QR code from your hub: Settings → Connections → Show phone QR, or goat pair --tailscale.";

export const CONNECT_HUB_COPY = {
  hub: { title: "Connect hub", scanHint: HUB_SCAN_HINT },
  "change-hub": {
    title: "Change hub",
    scanHint: `${HUB_SCAN_HINT} Your current hub is removed from this phone after the new one connects.`,
  },
  "add-server": {
    title: "Add another server",
    scanHint: "Scan a pairing QR code from another GOAT server.",
  },
  "add-route": {
    title: "Add route",
    scanHint: "Scan the code from goat pair or desktop Connections settings",
  },
} satisfies Record<ConnectHubIntent, { title: string; scanHint: string }>;

export function selectHubEnvironmentId(
  localEnvironments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  storedHubId: EnvironmentId | null = null,
): EnvironmentId | null {
  return (
    localEnvironments.find((environment) => environment.environmentId === storedHubId)
      ?.environmentId ??
    localEnvironments[0]?.environmentId ??
    null
  );
}

export async function finishHubPairing(input: {
  readonly pairedEnvironmentId: EnvironmentId;
  readonly intent: ConnectHubIntent;
  readonly replaceEnvironmentId: EnvironmentId | null;
  readonly removeEnvironment: (
    id: EnvironmentId,
  ) => Promise<AsyncResult.AsyncResult<unknown, unknown>>;
}): Promise<{ readonly removed: boolean; readonly removalFailed: boolean }> {
  if (
    input.intent !== "change-hub" ||
    input.replaceEnvironmentId === null ||
    input.replaceEnvironmentId === input.pairedEnvironmentId
  ) {
    return { removed: false, removalFailed: false };
  }
  try {
    const result = await input.removeEnvironment(input.replaceEnvironmentId);
    const removed = AsyncResult.isSuccess(result);
    return { removed, removalFailed: !removed };
  } catch {
    return { removed: false, removalFailed: true };
  }
}
