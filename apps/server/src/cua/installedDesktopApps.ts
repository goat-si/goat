/**
 * Which GOAT desktop apps a Mac has installed, for the computer use reason a standalone server
 * reports. Reads Info.plist files only; anything it cannot read stays unknown, never "absent".
 *
 * @module installedDesktopApps
 */
import * as HostProcess from "@goat/shared/HostProcess";
import { compareSemverVersions } from "@goat/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const APPS = [
  { bundleId: "si.goat.desktop.nightly", bundle: "GOAT (Nightly).app", name: "GOAT (Nightly)" },
  { bundleId: "si.goat.desktop", bundle: "GOAT.app", name: "GOAT" },
] as const;

export interface InstalledDesktopApp {
  readonly name: string;
  readonly version: string;
}

/** `incomplete` when some location could not be read, so an empty list does not mean none. */
export interface InstalledDesktopApps {
  readonly apps: ReadonlyArray<InstalledDesktopApp>;
  readonly incomplete: boolean;
}

const UNKNOWN_DESKTOP_APPS: InstalledDesktopApps = { apps: [], incomplete: true };

const plistString = (plist: string, key: string): string | undefined =>
  plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1]?.trim() ||
  undefined;

const readApp = Effect.fnUntraced(function* (bundlePath: string, app: (typeof APPS)[number]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(bundlePath))) return "absent" as const;
  const plist = yield* fs.readFileString(path.join(bundlePath, "Contents", "Info.plist"));
  // A binary plist would need a parser; the shipped apps write XML.
  if (plist.startsWith("bplist")) return "unknown" as const;
  const version = plistString(plist, "CFBundleShortVersionString");
  return plistString(plist, "CFBundleIdentifier") === app.bundleId && version !== undefined
    ? { name: app.name, version }
    : ("unknown" as const);
});

/** Bounded so a slow disk cannot hold up host status; a timeout reads as unknown. */
export const readInstalledDesktopAppsIn = Effect.fn("installedDesktopApps.read")(
  function* (directories: ReadonlyArray<string>) {
    const path = yield* Path.Path;
    const found = yield* Effect.forEach(
      directories.flatMap((directory) =>
        APPS.map((app) => ({ app, bundlePath: path.join(directory, app.bundle) })),
      ),
      ({ app, bundlePath }) =>
        readApp(bundlePath, app).pipe(Effect.orElseSucceed(() => "unknown" as const)),
      { concurrency: "unbounded" },
    );
    return {
      apps: found.filter((entry) => typeof entry === "object"),
      incomplete: found.includes("unknown"),
    } satisfies InstalledDesktopApps;
  },
  Effect.timeoutOrElse({
    duration: "1 second",
    orElse: () => Effect.succeed(UNKNOWN_DESKTOP_APPS),
  }),
);

const readInstalledDesktopApps = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  return yield* readInstalledDesktopAppsIn(["/Applications", path.join(home, "Applications")]);
});

/**
 * Read only when a standalone Mac server probes its screen. Cached apart from the driver's 10 s
 * probe cache, so a host status read waits on the disk at most once a minute.
 */
export const cached = (fs: FileSystem.FileSystem, path: Path.Path) =>
  Effect.cachedWithTTL(
    readInstalledDesktopApps.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    ),
    "60 seconds",
  );

export type ConsoleOwner = "self" | "none" | "other" | "unknown";

/** What a person does so computer use can run, after the standalone reason itself. */
export function standaloneMacRemedy(input: {
  readonly installed: InstalledDesktopApps;
  readonly serverVersion: string;
  readonly console: ConsoleOwner;
}): string {
  const { apps, incomplete } = input.installed;
  const older = apps.filter((app) => compareSemverVersions(app.version, input.serverVersion) < 0);
  const installed =
    apps.length > 0
      ? apps
          .map(
            (app) =>
              `${app.name} ${app.version} is installed${
                older.includes(app) ? `, older than this server (${input.serverVersion})` : ""
              }.`,
          )
          .join(" ")
      : incomplete
        ? "GOAT could not check which GOAT desktop apps are installed here."
        : "No GOAT desktop app was found in Applications.";
  const signedIn =
    input.console === "none"
      ? " No one is signed in at this Mac's screen."
      : input.console === "other"
        ? " Another user is signed in at this Mac's screen."
        : "";
  const step =
    apps.length === 0 && !incomplete
      ? "installs GOAT, opens it"
      : older.length === apps.length && apps.length > 0
        ? "updates GOAT, opens it"
        : "opens GOAT";
  return `${installed}${signedIn} At this Mac or over Screen Sharing, a person ${step}, and starts new threads in that app's environment from a GOAT app connected directly to it; they turn computer use on there in Settings → Computer and approve its requests there.`;
}
