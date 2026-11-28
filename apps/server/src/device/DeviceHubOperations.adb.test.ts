import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

// regression: #30629 hosts with only Platform-Tools listed no connected phones
it.effect.each([
  { emulatorTooling: true, adbFails: false },
  { emulatorTooling: false, adbFails: false },
  { emulatorTooling: false, adbFails: true },
])(
  "lists adb-attached physical devices when the hub cannot run avdmanager (emulator tooling: $emulatorTooling, adb fails: $adbFails)",
  ({ emulatorTooling, adbFails }) =>
    Effect.gen(function* () {
      // expo-device-hub returns no Android devices at all once `avdmanager list avd` fails.
      const commands: Array<string> = [];
      const operations = makeDeviceHubOperations({
        hostId: LOCAL_DEVICE_HOST_ID,
        origin: "http://device.test",
        http: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                simulators: [],
                emulators: [],
                errors: [
                  {
                    id: "avd",
                    message: "[android-utils] Failed to run `avdmanager list avd`:",
                    error:
                      "Error: Command failed: avdmanager list avd\nThe operation couldn’t be completed. Unable to locate a Java Runtime.",
                  },
                ],
              }),
            ),
          ),
        ),
        run: (command, args) =>
          Effect.sync(() => {
            commands.push(command);
            return command === "adb" && args.includes("devices")
              ? {
                  code: adbFails ? 1 : 0,
                  stdout:
                    "List of devices attached\nR52T10ABCDE            device usb:1-1 product:gts9wifi model:SM_X710 device:gts9wifi transport_id:1\n\n",
                  stderr: "",
                }
              : command === "adb" && args.includes("getprop")
                ? {
                    code: 0,
                    stdout:
                      "[ro.product.manufacturer]: [samsung]\n[ro.product.model]: [SM-X710]\n[ro.build.version.release]: [15]\n",
                    stderr: "",
                  }
                : { code: 0, stdout: "", stderr: "" };
          }),
        platformAvailable: (platform) => Effect.succeed(platform === "android"),
        avdsAvailable: Effect.succeed(emulatorTooling),
      });
      const listed = yield* operations.list;
      expect(commands.includes("emulator")).toBe(emulatorTooling);
      if (adbFails) {
        expect(listed.devices).toEqual([]);
        expect(listed.androidDiscoveryIncomplete).toBe(true);
        expect(listed.detail).toBe("Could not list Android devices (adb devices -l).");
        return;
      }
      expect(listed.devices).toContainEqual(
        expect.objectContaining({
          id: "R52T10ABCDE",
          platform: "android",
          booted: true,
          physical: true,
        }),
      );
      // Without emulator tooling, the failed avdmanager probe is noise.
      if (!emulatorTooling) expect(listed.detail).toBeUndefined();
    }),
);
