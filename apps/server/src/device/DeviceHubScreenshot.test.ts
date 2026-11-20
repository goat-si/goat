import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

it.effect.each([400, 500])(
  "retries a hub-rejected (%s) screenshot with simctl only on iOS 26 and older",
  (status) =>
    Effect.gen(function* () {
      const operations = makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: "http://device.test",
        http: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("private hub output", { status })),
          ),
        ),
        run: () => Effect.succeed({ code: 0, stdout: "iVBORw==", stderr: "" }),
        platformAvailable: (platform) => Effect.succeed(platform === "ios"),
      });
      const screenshot = (version: string) =>
        operations
          .screenshot({
            id: "phone",
            name: "Phone",
            version,
            platform: "ios",
            booted: true,
            physical: false,
          })
          .pipe(Effect.result);
      expect(yield* screenshot("iOS 27.0")).toMatchObject({
        failure: { _tag: "DeviceOperationError", reason: "hub_rejected" },
      });
      expect(yield* screenshot("iOS 26.3")).toMatchObject({
        success: new Uint8Array([137, 80, 78, 71]),
      });
    }),
);
