import { type DeviceHostId, DevicePlatformUnavailableError } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as DeviceHost from "./DeviceHost.ts";

const RETRY_HINT =
  "After changing PATH or SERVE_EMU_FFMPEG, turn device support off and on for SSH hosts, or restart the local environment server.";

/** Android emulator video needs ffmpeg with libx264 on the device host, resolved the way its hub does. */
export const ensureAndroidVideoEncoder = Effect.fn("DeviceService.ensureAndroidVideoEncoder")(
  function* (ready: Pick<DeviceHost.DeviceHostReady, "run" | "nodePath">, hostId: DeviceHostId) {
    const encoders = yield* ready.run(ready.nodePath, [
      "-e",
      `const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg", ["-hide_banner", "-encoders"], {
    stdio: "inherit", timeout: 10000, killSignal: "SIGKILL",
  });
  process.exitCode = result.error ? 1 : (result.status ?? 1);`,
    ]);
    if (encoders.code !== 0) {
      return yield* new DevicePlatformUnavailableError({
        hostId,
        platform: "android",
        reason: `Android emulator video needs working ffmpeg with the libx264 encoder. Install it on the device host's PATH or set SERVE_EMU_FFMPEG there, then retry opening the emulator. ${RETRY_HINT}`,
      });
    }
    if (!/^\s*V\S*[ \t]+libx264(?:[ \t]|$)/m.test(`${encoders.stdout}\n${encoders.stderr}`)) {
      return yield* new DevicePlatformUnavailableError({
        hostId,
        platform: "android",
        reason: `Android emulator video needs the libx264 encoder. Install an ffmpeg build that includes libx264 on the device host, then retry opening the emulator. ${RETRY_HINT}`,
      });
    }
  },
);
