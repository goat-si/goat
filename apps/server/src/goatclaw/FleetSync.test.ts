import { describe, expect, it } from "@effect/vitest";
import { GoatclawFleetPolicy, type GoatclawSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ServerSettingsService } from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as FleetSync from "./FleetSync.ts";

type Machine = Effect.Success<ReturnType<typeof machine>>;
const decodePolicy = Schema.decodeUnknownEffect(GoatclawFleetPolicy);

/** One GOAT's settings and fleet sync; `reach` answers its calls to connected hosts. */
const machine = (
  goatclaw: Partial<GoatclawSettings>,
  reach?: (
    call: SshRemoteDispatch.SshHostToolCall,
  ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>,
) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const sync = yield* FleetSync.make;
    return { settings, sync, goatclaw: settings.getSettings.pipe(Effect.map((s) => s.goatclaw)) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettingsService.layerTest({ goatclaw }),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)(
          reach === undefined
            ? { connectedHosts: Effect.succeed([]) }
            : { connectedHosts: Effect.succeed(["box"]), callHostTool: (call) => reach(call) },
        ),
      ),
    ),
  );

/** A connected host running a current GOAT: the call reaches its own fleet sync. */
const connectedTo = (remote: Machine) => (call: SshRemoteDispatch.SshHostToolCall) =>
  Effect.gen(function* () {
    expect(call.tool).toBe(FleetSync.SYNC_TOOL);
    expect(call.settingsWrite).toBe(true);
    const policy = yield* decodePolicy(call.arguments.policy).pipe(Effect.orDie);
    return { policy: yield* remote.sync.receive(policy).pipe(Effect.orDie) };
  });

describe("GoatclawFleetSync", () => {
  it.effect("applies goatclaw switched on here to a connected host", () =>
    Effect.gen(function* () {
      const remote = yield* machine({});
      const local = yield* machine({}, connectedTo(remote));
      yield* TestClock.adjust("1 minute");
      yield* local.settings.updateSettings({
        goatclaw: { enabled: true, defaultProfile: "owner" },
      });

      const reach = yield* local.sync.ensure("box");

      expect(reach).toEqual({ sync: { state: "applied" }, enforcesCeilings: true });
      const applied = yield* remote.goatclaw;
      expect(applied.enabled).toBe(true);
      expect(applied.defaultProfile).toBe("owner");
      expect(applied.updatedAt).toBe((yield* local.goatclaw).updatedAt);
      expect(yield* local.sync.hostState("box")).toEqual({ state: "applied" });
    }),
  );

  it.effect("pushes a later change here on the next reconcile and adopts one made there", () =>
    Effect.gen(function* () {
      const remote = yield* machine({});
      const local = yield* machine({}, connectedTo(remote));
      yield* local.settings.updateSettings({ goatclaw: { enabled: true } });
      yield* local.sync.reconcile;
      expect((yield* remote.goatclaw).enabled).toBe(true);

      yield* TestClock.adjust("1 minute");
      yield* local.settings.updateSettings({ goatclaw: { defaultProfile: "manager" } });
      yield* local.sync.reconcile;
      expect((yield* remote.goatclaw).defaultProfile).toBe("manager");

      // Switching it off on the host is the newest change, so it turns off here as well.
      yield* TestClock.adjust("1 minute");
      yield* remote.settings.updateSettings({ goatclaw: { enabled: false } });
      yield* local.sync.reconcile;
      expect((yield* local.goatclaw).enabled).toBe(true);
      yield* TestClock.adjust(FleetSync.REFRESH_MS);
      yield* local.sync.reconcile;
      expect((yield* local.goatclaw).enabled).toBe(false);
    }),
  );

  it.effect("never lets a policy nobody set override one somebody did", () =>
    Effect.gen(function* () {
      // Switched on by hand before fleet sync existed: no stamp, but still a person's choice.
      const remote = yield* machine({});
      const local = yield* machine({ enabled: true }, connectedTo(remote));
      expect((yield* local.goatclaw).updatedAt).toBeUndefined();

      expect((yield* local.sync.ensure("box")).sync.state).toBe("applied");
      expect((yield* remote.goatclaw).enabled).toBe(true);
      expect((yield* local.goatclaw).updatedAt).toBeDefined();

      const untouched = yield* machine({});
      const kept = yield* local.sync.receive(yield* untouched.goatclaw);
      expect(kept.enabled).toBe(true);
    }),
  );

  it.effect("tells an outdated host from one that cannot take the policy yet", () =>
    Effect.gen(function* () {
      const cases = [
        {
          error: new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            message: `GOAT on box does not have ${FleetSync.SYNC_TOOL}; it runs 0.1.1 and this machine runs 0.1.2.`,
          }),
          state: "outdated",
          enforcesCeilings: false,
        },
        {
          // A linked host whose token lacks settings:write: its GOAT answered, so it is current.
          error: new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "remote_refused",
            message:
              "Only a connected GOAT allowed to change this machine's settings syncs goatclaw policy.",
            remoteCode: "capability_denied",
          }),
          state: "pending",
          enforcesCeilings: true,
        },
        {
          error: new SshRemoteDispatch.SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "box did not answer.",
          }),
          state: "pending",
          enforcesCeilings: false,
        },
      ] as const;
      for (const { error, state, enforcesCeilings } of cases) {
        const local = yield* machine({ enabled: true }, () => Effect.fail(error));
        const reach = yield* local.sync.ensure("box");
        expect(reach.sync.state).toBe(state);
        expect(reach.enforcesCeilings).toBe(enforcesCeilings);
      }
    }),
  );
});
