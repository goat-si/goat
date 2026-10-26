import { RelayConnectionTarget } from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import { isOnboardingEnvironmentAvailable } from "../../onboarding/targetEnvironment.logic";
import {
  environmentTransportLabel,
  isGoatConnectUnavailable,
  savedConnectionRouteLabel,
} from "./EnvironmentRow.logic";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

describe("saved Connect presentation when enabled", () => {
  it("preserves relay labels and onboarding availability", () => {
    const environmentId = EnvironmentId.make("saved");
    const entry = {
      target: new RelayConnectionTarget({ environmentId, label: "Saved machine" }),
      profile: Option.none(),
      enabled: true,
    };
    expect(isGoatConnectUnavailable(entry)).toBe(false);
    expect(isOnboardingEnvironmentAvailable({ entry })).toBe(true);
    expect(savedConnectionRouteLabel(entry)).toBe("GOAT Connect");
    expect(
      environmentTransportLabel({
        entry,
        environmentId,
        label: "Saved machine",
        displayUrl: null,
        relayManaged: true,
        serverConfig: null,
        connection: { phase: "available", error: null, traceId: null },
      }),
    ).toBe("GOAT Connect");
  });
});
