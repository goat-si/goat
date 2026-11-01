import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import { GOAT_CONNECT_COMING_SOON } from "@goat/shared/goatConnect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";
import { isOnboardingEnvironmentAvailable } from "../../onboarding/targetEnvironment.logic";
import {
  environmentTransportLabel,
  isGoatConnectUnavailable,
  savedConnectionRouteLabel,
} from "./EnvironmentRow.logic";

const environmentId = EnvironmentId.make("saved");
const relay: ConnectionRoute = {
  target: new RelayConnectionTarget({ environmentId, label: "Saved machine" }),
  profile: Option.none(),
};
function direct(authorization?: "t3-connect"): ConnectionRoute {
  const connectionId = authorization ? "learned" : "paired";
  return {
    target: new BearerConnectionTarget({ environmentId, label: "Saved machine", connectionId }),
    profile: Option.some(
      new BearerConnectionProfile({
        environmentId,
        label: "Saved machine",
        connectionId,
        httpBaseUrl: "https://saved.ts.net",
        wsBaseUrl: "wss://saved.ts.net",
        ...(authorization ? { authorization, learned: true as const } : {}),
      }),
    ),
  };
}
function present(entry: ConnectionCatalogEntry): EnvironmentPresentation {
  return {
    entry,
    environmentId,
    label: "Saved machine",
    displayUrl: null,
    relayManaged: true,
    serverConfig: null,
    connection: { phase: "available", error: null, traceId: null },
  };
}
const comingSoon = `${GOAT_CONNECT_COMING_SOON.title} · ${GOAT_CONNECT_COMING_SOON.status}`;

describe("saved Connect routes while disabled", () => {
  it("retains relay-only entries with coming-soon labels and excludes them from onboarding", () => {
    const entry = { ...relay, enabled: true };
    const before = structuredClone(entry);
    expect(isGoatConnectUnavailable(entry)).toBe(true);
    expect(environmentTransportLabel(present(entry))).toBe(comingSoon);
    expect(savedConnectionRouteLabel(relay)).toBe(comingSoon);
    expect(isOnboardingEnvironmentAvailable({ entry })).toBe(false);
    expect(entry).toEqual(before);
  });

  it("also treats learned direct routes using Connect authorization as unavailable", () => {
    const learned = direct("t3-connect");
    const entry = { ...learned, enabled: true };
    expect(isGoatConnectUnavailable(entry)).toBe(true);
    expect(savedConnectionRouteLabel(learned)).toBe(comingSoon);
    expect(isOnboardingEnvironmentAvailable({ entry })).toBe(false);
  });

  it("keeps independently paired Tailscale routes usable in mixed environments", () => {
    const paired = direct();
    const entry = { ...relay, enabled: true, alternateRoutes: [paired] };
    const before = structuredClone(entry);
    expect(isGoatConnectUnavailable(entry)).toBe(false);
    expect(isOnboardingEnvironmentAvailable({ entry })).toBe(true);
    expect(environmentTransportLabel(present(entry))).toBe("Tailscale");
    expect(environmentTransportLabel(present(entry), paired.target)).toBe("via Tailscale");
    expect(environmentTransportLabel(present(entry), relay.target)).toBe("Tailscale");
    expect(entry).toEqual(before);
  });
});
