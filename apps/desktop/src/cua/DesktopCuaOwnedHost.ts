import type { EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";
import type { NativeHost } from "./DesktopCuaNative.ts";
import type { refreshDesktopManifest } from "./DesktopCuaManifest.ts";

export interface OwnedHost {
  readonly manifestPath: string | undefined;
  readonly host: NativeHost;
  readonly abort: AbortController;
  readonly started: Promise<EmbeddedDriverConnection>;
  /** Run by GOAT Computer Use; only such a host makes the helper's readiness "running". */
  readonly helper: boolean;
  readonly direct: boolean;
  readonly refreshManifest: (
    apps: ReadonlyArray<string>,
  ) => ReturnType<typeof refreshDesktopManifest>;
  /** It exited before GOAT stopped it; retire aborts before stopping, so its own stop never is. */
  crashed?: boolean;
  monitor?: Promise<void>;
  cleanup?: Promise<void>;
}
