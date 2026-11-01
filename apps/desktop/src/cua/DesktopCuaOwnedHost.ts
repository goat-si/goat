import type { EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import type { NativeHost } from "./DesktopCuaNative.ts";
import type { refreshDesktopManifest } from "./DesktopCuaManifest.ts";

export interface OwnedHost {
  readonly manifestPath: string | undefined;
  readonly host: NativeHost;
  readonly abort: AbortController;
  readonly started: Promise<EmbeddedDriverConnection>;
  readonly helper: boolean;
  readonly direct: boolean;
  readonly refreshManifest: (
    apps: ReadonlyArray<string>,
  ) => ReturnType<typeof refreshDesktopManifest>;
  crashed?: boolean;
  monitor?: Promise<void>;
  cleanup?: Promise<void>;
}
