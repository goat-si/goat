import { expect, it } from "@effect/vitest";
import type { CuaHostStatus } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
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
