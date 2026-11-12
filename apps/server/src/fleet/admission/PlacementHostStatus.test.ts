import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";

import { run } from "../../mcp/HostStatusMcpService.testkit.ts";
import { PlacementAdmissionEnabled } from "./PlacementKey.ts";

it.effect.each([false, true])(
  "host.status advertises placementAdmission only while admission is on (on: %s)",
  (enabled) =>
    Effect.gen(function* () {
      const { value } = yield* run(
        { hosts: [], hostCall: () => Effect.die("no host is read") },
        (service) =>
          service
            .readForClient({
              environmentId: EnvironmentId.make("host-status-test"),
              sessionId: "web-session",
              reachHosts: false,
            })
            .pipe(
              Effect.provideService(HostProcess.Platform, "darwin"),
              Effect.provideService(PlacementAdmissionEnabled, enabled),
            ),
      );
      expect(value._tag).toBe("Success");
      if (value._tag !== "Success") return;
      expect(value.success.hosts[0]?.placementAdmission).toBe(enabled ? 1 : undefined);
    }),
);
