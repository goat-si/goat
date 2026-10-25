import { expect, it } from "@effect/vitest";
import type { CuaHostStatus } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import type { CuaDisplayProbe } from "./CuaDisplayCapability.ts";
import * as CuaDriver from "./CuaDriver.ts";

type HelperReadiness = Pick<CuaHostStatus, "readiness" | "signals">;

it.effect("host status carries the helper's last readiness only once the helper has reported", () =>
  Effect.gen(function* () {
    const reported = yield* Ref.make(Option.none<HelperReadiness>());
    const service = yield* CuaDriver.make(
      () => Effect.die("status never starts the driver"),
      Effect.succeed({
        capability: "available",
        reason: "Uses this Mac's screen.",
        environment: [],
      }),
      { helperReadiness: Ref.get(reported) },
    );
    const before = yield* service.status;
    expect(before.readiness).toBeUndefined();
    expect(before.signals).toBeUndefined();
    const helper = {
      readiness: {
        grants: { accessibility: "granted", screenCapture: "pending" },
        helper: "authenticated",
        capture: "pending",
        tree: "unavailable",
        input: "unavailable",
        blockers: [],
        reasons: ["Screen Recording is waiting for an answer."],
      },
      signals: { privateMode: "unsupported", humanInput: "unsupported" },
    } satisfies HelperReadiness;
    yield* Ref.set(reported, Option.some(helper));
    expect(yield* service.status).toMatchObject(helper);
  }).pipe(
    Effect.provide(ServerSettings.layerTest()),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.scoped,
  ),
);

it.effect("a grant block ends once the helper reports the missing grant granted (#1399)", () =>
  Effect.gen(function* () {
    const reported = yield* Ref.make(Option.none<HelperReadiness>());
    const block = {
      reason: "permissionsNotGranted",
      missing: ["screenRecording"],
      holder: "helper",
    } as const;
    const service = yield* CuaDriver.make(
      () =>
        Effect.succeed({
          start: Effect.fail(new CuaDriver.CuaDriverHostError({ operation: "desktop", block })),
          stop: Effect.void,
          waitForExit: Effect.never,
        }),
      Effect.succeed({
        capability: "available",
        reason: "Uses this Mac's screen.",
        environment: [],
      }),
      { helperReadiness: Ref.get(reported) },
    );
    expect(yield* service.acquire).toEqual(Option.none());
    expect((yield* service.status).block).toEqual(block);
    expect(yield* service.block).toEqual(block);
    const readiness = (screenCapture: "pending" | "granted") =>
      ({
        readiness: {
          grants: { accessibility: "granted", screenCapture },
          helper: "authenticated",
          capture: "pending",
          tree: "unavailable",
          input: "unavailable",
          blockers: [],
          reasons: [],
        },
      }) satisfies HelperReadiness;
    yield* Ref.set(reported, Option.some(readiness("pending")));
    expect((yield* service.status).block).toEqual(block);
    expect(yield* service.block).toEqual(block);
    yield* Ref.set(reported, Option.some(readiness("granted")));
    expect((yield* service.status).block).toBeUndefined();
    expect(yield* service.block).toBeUndefined();
  }).pipe(
    Effect.provide(ServerSettings.layerTest({ enableCua: true })),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.scoped,
  ),
);

it.effect(
  "a Windows desktop block holds while its blocker is reported, and ends once nothing blocks (#1516)",
  () =>
    Effect.gen(function* () {
      const reported = yield* Ref.make(Option.none<HelperReadiness>());
      const block = {
        reason: "desktopUnavailable",
        blocker: "screenLocked",
        detail:
          "The screen is locked or showing a Windows security prompt. Unlock it, then try again.",
      } as const;
      const service = yield* CuaDriver.make(
        () =>
          Effect.succeed({
            start: Effect.fail(new CuaDriver.CuaDriverHostError({ operation: "desktop", block })),
            stop: Effect.void,
            waitForExit: Effect.never,
          }),
        Effect.succeed({ capability: "available", reason: "Uses this screen.", environment: [] }),
        { helperReadiness: Ref.get(reported) },
      );
      expect(yield* service.acquire).toEqual(Option.none());
      const readiness = (blockers: ReadonlyArray<"screenLocked">) =>
        ({
          readiness: {
            grants: { accessibility: "granted", screenCapture: "granted" },
            helper: "authenticated",
            capture: "pending",
            tree: "unavailable",
            input: "background",
            blockers,
            reasons: [],
          },
        }) satisfies HelperReadiness;
      yield* Ref.set(reported, Option.some(readiness(["screenLocked"])));
      expect(yield* service.block).toEqual(block);
      yield* Ref.set(reported, Option.some(readiness([])));
      expect(yield* service.block).toBeUndefined();
      expect((yield* service.status).block).toBeUndefined();
    }).pipe(
      Effect.provide(ServerSettings.layerTest({ enableCua: true })),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.scoped,
    ),
);

it.effect("the agent block never waits on a readiness probe of the running driver", () =>
  Effect.gen(function* () {
    const service = yield* CuaDriver.make(
      () =>
        Effect.succeed({
          start: Effect.succeed({ command: "/driver", args: ["mcp"], environment: [] }),
          stop: Effect.void,
          waitForExit: Effect.never,
        }),
      Effect.succeed({ capability: "available", reason: "Uses this screen.", environment: [] }),
      { observeReadiness: () => Effect.never },
    );
    expect(Option.isSome(yield* service.acquire)).toBe(true);
    expect(yield* service.block).toBeUndefined();
  }).pipe(
    Effect.provide(ServerSettings.layerTest({ enableCua: true })),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.scoped,
  ),
);

it.effect("a grant block names only the grants still missing once some return", () =>
  Effect.gen(function* () {
    const reported = yield* Ref.make(Option.none<HelperReadiness>());
    const block = {
      reason: "permissionsNotGranted",
      missing: ["accessibility", "screenRecording"],
      holder: "helper",
    } as const;
    const service = yield* CuaDriver.make(
      () =>
        Effect.succeed({
          start: Effect.fail(new CuaDriver.CuaDriverHostError({ operation: "desktop", block })),
          stop: Effect.void,
          waitForExit: Effect.never,
        }),
      Effect.succeed({
        capability: "available",
        reason: "Uses this Mac's screen.",
        environment: [],
      }),
      { helperReadiness: Ref.get(reported) },
    );
    expect(yield* service.acquire).toEqual(Option.none());
    // The person grants Accessibility only.
    yield* Ref.set(
      reported,
      Option.some({
        readiness: {
          grants: { accessibility: "granted", screenCapture: "pending" },
          helper: "authenticated",
          capture: "pending",
          tree: "unavailable",
          input: "unavailable",
          blockers: [],
          reasons: [],
        },
      }),
    );
    const left = { ...block, missing: ["screenRecording"] };
    expect((yield* service.status).block).toEqual(left);
    expect(yield* service.block).toEqual(left);
  }).pipe(
    Effect.provide(ServerSettings.layerTest({ enableCua: true })),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.scoped,
  ),
);

it.effect(
  "before the first turn it offers the session a start would use, only while on, idle and with a usable screen (#1542)",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const probe = yield* Ref.make<CuaDisplayProbe>({
        capability: "available",
        reason: "Uses :7.",
        environment: [{ name: "DISPLAY", value: ":7" }],
      });
      let starts = 0;
      const service = yield* CuaDriver.make(
        () =>
          Effect.sync(() => {
            starts++;
            return { start: Effect.never, stop: Effect.void, waitForExit: Effect.never };
          }),
        Ref.get(probe),
        { binary: Effect.succeed("/opt/goat/cua-driver") },
      );
      const before = service.beforeTurn;
      if (before === undefined) return expect.unreachable("a binary offers a check");
      // Off: nothing to check.
      expect(yield* before.wanted).toBe(false);
      expect(yield* before.session).toEqual(Option.none());
      yield* settings.updateSettings({ enableCua: true });
      expect(yield* before.wanted).toBe(true);
      expect(yield* before.session).toEqual(
        Option.some({
          command: "/opt/goat/cua-driver",
          display: [{ name: "DISPLAY", value: ":7" }],
        }),
      );
      // A screen that went away is not checked.
      yield* Ref.set(probe, { capability: "unavailable", reason: "No display.", environment: [] });
      expect(yield* before.session).toEqual(Option.none());
      // Reading it never starts the driver; a start in progress ends the wish for a check.
      expect(starts).toBe(0);
      yield* Ref.set(probe, { capability: "available", reason: "Uses :7.", environment: [] });
      yield* service.acquire.pipe(Effect.forkScoped({ startImmediately: true }));
      expect(yield* before.wanted).toBe(false);
    }).pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.scoped,
    ),
);
