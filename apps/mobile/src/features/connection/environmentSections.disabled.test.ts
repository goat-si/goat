import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { isGoatConnectOnlyEnvironment, splitEnvironmentSections } from "./environmentSections";

const environmentId = EnvironmentId.make("retained");
const relay: ConnectionCatalogEntry = {
  target: new RelayConnectionTarget({ environmentId, label: "Saved" }),
  profile: Option.none(),
  enabled: true,
};
function bearer(authorization?: "t3-connect") {
  return {
    target: new BearerConnectionTarget({ environmentId, label: "Saved", connectionId: "direct" }),
    profile: Option.some(
      new BearerConnectionProfile({
        environmentId,
        label: "Saved",
        connectionId: "direct",
        httpBaseUrl: "https://desktop.tail.test",
        wsBaseUrl: "wss://desktop.tail.test/ws",
        ...(authorization ? { authorization } : {}),
      }),
    ),
  };
}

describe("default-off retained mobile environments", () => {
  it("keeps relay, direct and mixed saved records in local rows without mutating them", () => {
    const rows: ReadonlyArray<ConnectedEnvironmentSummary> = [true, false, true].map(
      (isRelayManaged, index) =>
        Object.freeze({
          environmentId: EnvironmentId.make(`saved-${index}`),
          environmentLabel: `Saved ${index}`,
          displayUrl: index === 0 ? "" : "https://desktop.tail.test",
          isRelayManaged,
          isEnabled: true,
          connectionState: "connected" as const,
          connectionError: null,
          connectionErrorTraceId: null,
        }),
    );
    Object.freeze(rows);
    expect(
      splitEnvironmentSections({ connectedEnvironments: rows, cloudEnvironments: null }),
    ).toEqual({
      localEnvironments: rows,
      connectedCloudEnvironments: [],
      availableCloudEnvironments: [],
    });
  });

  it("marks relay-only and legacy Connect-authorized bearer records unavailable", () => {
    expect(isGoatConnectOnlyEnvironment(relay)).toBe(true);
    expect(isGoatConnectOnlyEnvironment({ ...relay, ...bearer("t3-connect") })).toBe(true);
    expect(
      isGoatConnectOnlyEnvironment({ ...relay, alternateRoutes: [bearer("t3-connect")] }),
    ).toBe(true);
  });

  it("keeps ordinary bearer and mixed direct routes usable", () => {
    expect(isGoatConnectOnlyEnvironment({ ...relay, ...bearer() })).toBe(false);
    expect(isGoatConnectOnlyEnvironment({ ...relay, alternateRoutes: [bearer()] })).toBe(false);
    expect(isGoatConnectOnlyEnvironment(undefined)).toBe(false);
  });
});
