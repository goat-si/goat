import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as SshTunnel from "./tunnel.ts";
import { uploadTarget } from "./tunnel.fixture.ts";
import { fixture, stopped, successfulStatus } from "./tunnel.runtime-status.fixture.ts";

describe("SSH runtime status after a preparation dies", () => {
  it.effect("a preparation that died without publishing does not pin the host at preparing", () => {
    const f = fixture({ ...stopped, ready: true });
    f.dieOnLaunch();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const ended = yield* Effect.exit(manager.ensureEnvironment(uploadTarget, { keyOnly: true }));
      assert.isTrue(Exit.isFailure(ended));
      const probesBefore = f.calls.probes;
      const status = successfulStatus(yield* manager.status(uploadTarget));
      // The host answers its probe again, so the page shows what runs there now.
      assert.notEqual(status.state, "preparing");
      assert.equal(status.state, "stopped");
      assert.equal(f.calls.probes, probesBefore + 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });
});
