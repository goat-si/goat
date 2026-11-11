import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as SshTunnel from "./tunnel.ts";
import { ARCHIVE, uploadTarget } from "./tunnel.fixture.ts";
import { fixture, stopped } from "./tunnel.runtime-status.fixture.ts";

// A probe asks the client's own runtime version for its facts directly (see facts_frame_ask).
describe("the client's own runtime version reaches every first-probe path", () => {
  it.effect.each([
    { name: "names", own: "1.2.2", expected: "facts_own_version='1.2.2'" },
    { name: "omits", own: undefined, expected: "facts_own_version=''" },
  ])(
    "status and preparation probes carry the version the runner $name as its own",
    ({ own, expected }) => {
      // The own version is the client's configuration, never the version a host is asked for.
      const f = fixture(stopped, own === undefined ? {} : { ownRuntimeVersion: own });
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.status(uploadTarget);
        yield* manager.ensureEnvironment(uploadTarget).pipe(Effect.exit);
        assert.isAtLeast(f.probeScripts.length, 2);
        for (const script of f.probeScripts) assert.include(script, "\n" + expected + "\n");
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );

  it.each([
    { name: "names", own: "1.2.2", expected: "facts_own_version='1.2.2'" },
    { name: "omits", own: undefined, expected: "facts_own_version=''" },
  ])(
    "a launch's reconnect probe carries the version the runner $name as its own",
    ({ own, expected }) => {
      const runner = { ...ARCHIVE, ...(own === undefined ? {} : { ownRuntimeVersion: own }) };
      const launch = SshTunnel.buildRemoteLaunchScript(runner, undefined, false, true);
      assert.include(launch, "reconnect_probe() {");
      assert.include(launch, "\n" + expected + "\n");
    },
  );
});
