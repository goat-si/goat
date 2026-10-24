import * as NodeOS from "node:os";
import type { DesktopWindowMaterialCapability } from "@goat/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as MacosObjcRuntime from "../../electron/MacosObjcRuntime.ts";
import * as Adapters from "./adapters.ts";
import { probeMacosGlass } from "./macosGlassAdapter.ts";
import { probeCapability } from "./materialPolicy.ts";

const MACOS_GLASS_PRODUCTION_ELIGIBLE = false;

export class MacosVersion extends Context.Service<
  MacosVersion,
  { readonly get: Effect.Effect<string | null> }
>()("@goat/desktop/window/material/materialPlatform/MacosVersion") {}

export const layerMacosVersion = Layer.succeed(MacosVersion, {
  get: Effect.sync(() => {
    try {
      return process.getSystemVersion();
    } catch {
      return null;
    }
  }),
});

export class DesktopMaterialPlatform extends Context.Service<
  DesktopMaterialPlatform,
  {
    readonly capability: DesktopWindowMaterialCapability;
    readonly adapter: Adapters.MaterialAdapter | null;
  }
>()("@goat/desktop/window/material/materialPlatform/DesktopMaterialPlatform") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const unavailable = (reason: "api-unavailable" | "os-version" = "api-unavailable") => ({
    capability: { supported: false, reason } as const,
    adapter: null,
  });
  if (environment.platform !== "darwin") {
    const capability = probeCapability({
      platform: environment.platform,
      macOSMajor: null,
      windowsBuild: Number(NodeOS.release().split(".")[2]) || null,
      hasBackgroundMaterialApi:
        typeof Electron.BrowserWindow?.prototype?.setBackgroundMaterial === "function",
    });
    const adapter = yield* Adapters.WindowMaterialAdapter;
    return { capability, adapter: capability.supported ? adapter : null };
  }
  // Shipping eligibility is independent of the explicit development experiment below.
  if (environment.isPackaged && !MACOS_GLASS_PRODUCTION_ELIGIBLE) return unavailable();
  const flag = yield* Config.String("GOAT_DESKTOP_MAC_GLASS_CANDIDATE").pipe(
    Config.withDefault(""),
  );
  if (!environment.isDevelopment || flag !== "1" || environment.processArch !== "arm64")
    return unavailable();
  const version = yield* (yield* MacosVersion).get;
  if (version === null || !/^\d+(?:\.\d+)*$/.test(version)) return unavailable();
  const major = Number(version.split(".")[0]);
  if (!Number.isSafeInteger(major)) return unavailable();
  if (major < 26) return unavailable("os-version");
  const loader = yield* MacosObjcRuntime.MacosObjcRuntime;
  const result = yield* loader.load.pipe(
    Effect.flatMap((runtime) =>
      Effect.try({
        try: () => probeMacosGlass(runtime),
        catch: (cause) => new Adapters.NativeMaterialError({ cause }),
      }),
    ),
    Effect.result,
  );
  if (result._tag === "Failure") return unavailable();
  return {
    capability: { supported: true, material: "macos-glass" } as const,
    adapter: result.success,
  };
});

export const layer = Layer.effect(DesktopMaterialPlatform, make);
