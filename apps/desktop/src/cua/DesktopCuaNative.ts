import type { ComputerUseReadiness } from "@goat/contracts";
import { cuaDriverHostOptions } from "@goat/shared/cuaDriverRelease";
import { listCuaDriverApplications, type CuaDriverListedApp } from "@goat/shared/cuaDriverManifest";
import { fromLenientJson } from "@goat/shared/schemaJson";
import * as Schema from "effect/Schema";
import type { CuaDriverLike, ToolResult } from "@trycua/cua-driver";
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";

import {
  makeHelperHost,
  listHelperApplications,
  probeHelperGrants,
  spawnHelperProcess,
  type DaemonMetadata,
  type HelperBundle,
  type HelperFeatures,
  type HelperHostOptions,
  type HelperSession,
} from "./ComputerUseHelper.ts";
import { probeWindowsReadiness, windowsDriverPipe } from "./ComputerUseHelperWindows.ts";
import { resolveHelperBundle } from "./ComputerUseHelperInstall.ts";
import { prepareDesktopManifest } from "./DesktopCuaManifest.ts";
import { makeMcpHelperHost } from "./McpHelperHost.ts";

/**
 * Who runs the driver. "helper": GOAT Computer Use.app owns the TCC identity and spawns the
 * driver (D1). "embedded": the SDK spawns it from this Electron process, for builds that do not
 * ship the helper yet.
 */
export type Engine =
  | { readonly kind: "helper"; readonly bundle: HelperBundle }
  | { readonly kind: "embedded"; readonly driverPath: string };

/**
 * Agents get the general manifest, which leaves GOAT's own windows out. The grant check is the
 * one process no agent ever holds, so its manifest admits only GOAT, the window it reads.
 */
export type CuaManifestScope = "agents" | "verify";

/** The daemon lifecycle both engines share: the SDK's in-process host and the helper app. */
export interface NativeHost {
  readonly start: () => Promise<EmbeddedDriverConnection>;
  readonly stop: () => Promise<void>;
  readonly waitForExit: (
    generation: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<unknown>;
  readonly uniffiDestroy: () => void;
  /** The helper's service pid, the driver's parent; absent for the in-process host. */
  readonly servicePid?: () => number | undefined;
  /** The readiness MCP peer owned by this helper generation (macOS only). */
  readonly readinessPeer?: () => DriverClient | undefined;
  /** The running generation's helper session: its private-mode watch (#1235) and captures (#1370). */
  readonly session?: () =>
    | Pick<
        HelperSession,
        | "watch"
        | "unwatch"
        | "onEvent"
        | "canWatch"
        | "reportsInput"
        | "canFrame"
        | "frames"
        | "onFrame"
      >
    | undefined;
}
type DriverClient = Pick<CuaDriverLike, "callTool"> & { readonly uniffiDestroy?: () => void };
type DriverImage = ToolResult["images"][number];
/** detail: why a Windows desktop is not ready, in onboarding's words; Windows has no grant to give. */
export type Grants = {
  accessibility: boolean;
  screenRecording: boolean;
  readonly detail?: string;
  readonly blocker?: ComputerUseReadiness["blockers"][number];
  /** What the probed helper said in its hello it can do (#1532); absent for GOAT's own grants. */
  readonly features?: HelperFeatures;
};

export interface DesktopCuaDriverDependencies {
  readonly loadEmbedded: () => Promise<{
    readonly EmbeddedCuaDriverHost: {
      readonly withOptions: (options: ReturnType<typeof cuaDriverHostOptions>) => NativeHost;
    };
  }>;
  readonly loadElectron: () => Promise<
    Pick<
      typeof import("@trycua/cua-driver/electron"),
      "requestMacOSPermissions" | "hasRequiredMacOSPermissions"
    >
  >;
  /** SDK client bound to one daemon generation's socket. */
  readonly connect: (socketPath: string) => Promise<DriverClient>;
  /** Electron's view of the grants, read without prompting. */
  readonly checkGrants: () => Promise<Grants>;
  /** The helper's own grants, from a fresh helper process; prompts as the helper when asked. */
  readonly helperGrants: (
    bundle: HelperBundle,
    prompt: boolean,
    platform: NodeJS.Platform,
  ) => Promise<Grants>;
  /**
   * The helper bundle this build ships. absent: the build has none, and GOAT itself runs the
   * driver as releases did before the helper. unusable: it should be there and cannot be used,
   * so computer use stays off rather than run under another principal. note: something to log.
   */
  readonly helperBundlePath: typeof resolveHelperBundle;
  readonly helperHost: (
    options: Omit<HelperHostOptions, "spawn" | "readMetadata"> & {
      readonly platform: NodeJS.Platform;
      readonly verify?: boolean;
    },
  ) => NativeHost;
  readonly imageHasContent: (image: DriverImage) => Promise<boolean>;
  /** Writes the capability manifest for one daemon start and returns its path. */
  readonly prepareManifest: (input: {
    readonly binaryPath: string;
    readonly scope: CuaManifestScope;
    readonly hostBundleIds: ReadonlyArray<string>;
    readonly directory: string;
    readonly platform: NodeJS.Platform;
    /** Lists apps through the helper, so the driver never runs outside its seal check. */
    readonly listApplications?: () => Promise<ReadonlyArray<CuaDriverListedApp>>;
  }) => Promise<string>;
  readonly listApps: typeof listCuaDriverApplications;
  /** Read the local server's persisted opt-in, not whether an agent driver happens to run. */
  readonly computerUseEnabled: (settingsPath: string) => Promise<boolean>;
  readonly readManifest: (path: string) => Promise<string>;
  /** The apps the helper's driver lists, after the helper verifies it (#1241, macOS and Windows). */
  readonly helperApps: (
    bundle: HelperBundle,
    platform: NodeJS.Platform,
  ) => Promise<ReadonlyArray<CuaDriverListedApp>>;
  readonly processId: number;
  /** Windows manifests name apps by executable path, so GOAT's own is how they name GOAT. */
  readonly executablePath: string;
}

/** A capture of a locked or unauthorized screen is all black; real content varies. */
export function bitmapHasContent(bitmap: Uint8Array): boolean {
  const pixels = Math.floor(bitmap.length / 4);
  if (pixels === 0) return false;
  const stride = Math.max(1, Math.floor(pixels / 4096));
  let lit = 0;
  let sampled = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4;
    sampled++;
    if (Math.max(bitmap[offset] ?? 0, bitmap[offset + 1] ?? 0, bitmap[offset + 2] ?? 0) > 16) lit++;
  }
  return lit / sampled >= 0.01;
}

const decodeComputerUseSetting = Schema.decodeUnknownSync(
  fromLenientJson(Schema.Struct({ enableCua: Schema.optionalKey(Schema.Boolean) })),
);

export const dependencies: DesktopCuaDriverDependencies = {
  loadEmbedded: async () => {
    const sdk = await import("@trycua/cua-driver/embedded");
    return {
      EmbeddedCuaDriverHost: {
        // A UniFFI constructor: it returns the concrete host, typed as its interface.
        withOptions: (options) =>
          sdk.EmbeddedCuaDriverHost.withOptions(options) as EmbeddedCuaDriverHost,
      },
    };
  },
  loadElectron: () => import("@trycua/cua-driver/electron"),
  connect: async (socketPath) => (await import("@trycua/cua-driver")).CuaDriver.connect(socketPath),
  checkGrants: async () => {
    const { systemPreferences } = await import("electron");
    return {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
    };
  },
  helperGrants: (bundle, prompt, platform) =>
    platform === "win32"
      ? probeWindowsReadiness(spawnHelperProcess(bundle.executable, platform), bundle.bundleId)
      : probeHelperGrants(spawnHelperProcess(bundle.executable, platform), bundle.bundleId, prompt),
  helperBundlePath: resolveHelperBundle,
  helperHost: ({ platform, verify, ...options }) =>
    platform === "darwin" && verify
      ? makeMcpHelperHost(options)
      : makeHelperHost({
          ...options,
          spawn: (executable) => spawnHelperProcess(executable, platform),
          ...(platform === "win32" ? { socket: windowsDriverPipe, mcpThroughHelper: true } : {}),
          readMetadata: async (socketPath): Promise<DaemonMetadata> => {
            const driver: DriverClient & Pick<CuaDriverLike, "metadata"> = (
              await import("@trycua/cua-driver")
            ).CuaDriver.connect(socketPath);
            try {
              return await driver.metadata();
            } finally {
              driver.uniffiDestroy?.();
            }
          },
        }),
  imageHasContent: async (image) => {
    const { nativeImage } = await import("electron");
    const decoded = nativeImage.createFromBuffer(Buffer.from(image.dataBase64, "base64"));
    return !decoded.isEmpty() && bitmapHasContent(decoded.toBitmap());
  },
  prepareManifest: prepareDesktopManifest,
  listApps: listCuaDriverApplications,
  computerUseEnabled: async (settingsPath) => {
    const raw = await (await import("node:fs/promises")).readFile(settingsPath, "utf8");
    const settings = decodeComputerUseSetting(raw);
    return settings.enableCua === true;
  },
  readManifest: async (path) => (await import("node:fs/promises")).readFile(path, "utf8"),
  helperApps: (bundle, platform) =>
    listHelperApplications(spawnHelperProcess(bundle.executable, platform), bundle.bundleId),
  processId: process.pid,
  executablePath: process.execPath,
};
