import { DeviceId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { fixture, minimalPng } from "./DeviceService.testkit.ts";

it.effect("extracts the complete PNG from a screenshot with surrounding warnings", () =>
  Effect.gen(function* () {
    const { service, settings, screenshotBody } = yield* fixture();
    yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
    yield* Ref.set(
      screenshotBody,
      Uint8Array.from([...new TextEncoder().encode("warning\n"), ...minimalPng, 10]),
    );
    const capture = yield* service.screenshot({ deviceId: DeviceId.make("Pixel_API_35") });
    expect(capture.png).toEqual(minimalPng);
  }).pipe(Effect.scoped),
);

it.effect("rejects an incomplete screenshot", () =>
  Effect.gen(function* () {
    const { service, settings, screenshotBody } = yield* fixture();
    yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
    yield* Ref.set(screenshotBody, minimalPng.subarray(0, 30));
    const error = yield* Effect.flip(
      service.screenshot({ deviceId: DeviceId.make("Pixel_API_35") }),
    );
    expect(error).toMatchObject({ _tag: "DeviceOperationError", reason: "hub_rejected" });
  }).pipe(Effect.scoped),
);
