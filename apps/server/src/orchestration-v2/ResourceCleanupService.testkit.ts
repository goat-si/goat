import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DeviceService from "../device/DeviceService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

/** The real cleanup with terminals, previews and devices stubbed, for tests about files or tasks. */
export const layerWithStubbedHosts = ResourceCleanupService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
      Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
      Layer.mock(DeviceService.DeviceService)({ releaseThread: () => Effect.void }),
    ),
  ),
);
