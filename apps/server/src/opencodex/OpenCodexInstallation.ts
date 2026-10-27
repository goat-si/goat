// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or lstat.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@goat/shared/HostProcess";
import { cliArchiveTarCommand } from "@goat/shared/cliRelease";
import {
  OPEN_CODEX_PINNED_VERSION,
  OPEN_CODEX_RELEASES,
  openCodexCandidates,
  parseOpenCodexVersion,
  resolveOpenCodexRelease,
  supportedOpenCodexVersion,
  type OpenCodexRelease,
  type OpenCodexReleaseCatalog,
} from "@goat/shared/opencodexRelease";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import { makeInstallLock } from "./installLock.ts";

const MARKER = ".goat-install.json";
const MAX_MARKER_BYTES = 8192;
const MAX_MEMBERS = 20_000;
const Marker = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  root: Schema.String,
  target: Schema.String,
  version: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const decodeMarker = Schema.decodeUnknownEffect(Schema.fromJsonString(Marker), {
  onExcessProperty: "error",
});
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(Marker));

/** The reviewed pins; tests replace it at the acquisition boundary, users never can. */
export const ReleaseCatalog = Context.Reference<OpenCodexReleaseCatalog>(
  "goat/opencodex/ReleaseCatalog",
  { defaultValue: () => OPEN_CODEX_RELEASES },
);

const MESSAGES = {
  unsupported:
    "This GOAT build has no supported OpenCodex installation for this machine or release.",
  busy: "Another OpenCodex installation is in progress. Check it before retrying.",
  download: "The OpenCodex download failed its pinned size or SHA-256 check.",
  archive: "The OpenCodex archive has unsafe or incomplete contents.",
  verify: "The downloaded OpenCodex did not report the pinned version.",
  shadowed:
    "Another ocx is selected before the GOAT-managed install. Resolve that executable conflict and retry.",
  "not-managed": "GOAT cannot replace an OpenCodex installation it does not own.",
  activation:
    "OpenCodex activation could not be confirmed. Check the selected executable before retrying.",
  io: "OpenCodex installation could not finish. Check the selected executable before retrying.",
} as const;

export class OpenCodexInstallationError extends Schema.TaggedError<OpenCodexInstallationError>()(
  "OpenCodexInstallationError",
  {
    reason: Schema.Literals([
      "unsupported",
      "busy",
      "download",
      "archive",
      "verify",
      "shadowed",
      "not-managed",
      "activation",
      "io",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return MESSAGES[this.reason];
  }
}
const fail = (reason: OpenCodexInstallationError["reason"], cause?: unknown) =>
  new OpenCodexInstallationError({ reason, ...(cause === undefined ? {} : { cause }) });
const isInstallationError = Schema.is(OpenCodexInstallationError);

/** A directory entry as lstat sees it, so a replaced or recreated launcher never compares equal. */
interface EntryIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly file: boolean;
  readonly link: string | undefined;
}

export interface OpenCodexExecutable {
  /** The command OpenCodex's own resolution selects. */
  readonly path: string;
  readonly realPath: string;
  readonly version: string;
  /** Managed only when it is the executable a GOAT-completed release marker vouches for. */
  readonly ownership: "managed" | "adopted";
}

export class OpenCodexInstallation extends Context.Service<
  OpenCodexInstallation,
  {
    /** Whether `binary` is the executable of the release GOAT installed for `version`. */
    readonly inspect: (binary: string, version: string) => Effect.Effect<boolean>;
    /**
     * Keeps a supported selected ocx, or installs the pinned release and selects it. With
     * `managedVersion`, replaces only an install GOAT owns, with that pinned release.
     */
    readonly install: (input?: {
      readonly managedVersion?: string;
    }) => Effect.Effect<OpenCodexExecutable, OpenCodexInstallationError>;
  }
>()("goat/opencodex/OpenCodexInstallation") {}

/** Names from `tar -tf` and lines from `tar -tvf` describe only the standalone layout. */
const safeListing = (
  asset: OpenCodexRelease,
  names: ReadonlyArray<string>,
  lines: ReadonlyArray<string>,
) => {
  const clean = names.map((name) => name.replace(/^\.\//u, "").replace(/\/$/u, ""));
  const roots = [asset.layout.executable, "gui", "keyring"];
  return (
    names.length > 0 &&
    names.length <= MAX_MEMBERS &&
    names.length === lines.length &&
    new Set(clean).size === clean.length &&
    // Only plain files and directories: no symlink, hard link or device.
    lines.every((line) => ["-", "d"].includes(line[0] ?? "") && !/ (?:->|link to) /u.test(line)) &&
    clean.every(
      (name) =>
        name !== "" &&
        !name.startsWith("/") &&
        !name.includes("\\") &&
        !name.includes(":") &&
        !name.split("/").includes("..") &&
        roots.includes(name.split("/")[0] ?? ""),
    ) &&
    clean.includes(asset.layout.executable) &&
    clean.includes(asset.layout.gui) &&
    clean.some((name) => name.startsWith(`${asset.layout.keyring}/`) && name.endsWith(".node"))
  );
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const rawHome = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const cwd = yield* HostProcess.WorkingDirectory;
  const catalog = yield* ReleaseCatalog;
  const gate = yield* Semaphore.make(1);
  const installLock = yield* makeInstallLock;

  /** Resolved, so a symlinked home or ~/.local still yields one canonical install root. */
  const resolvedDirectory = Effect.fn("OpenCodexInstallation.resolvedDirectory")(function* (
    create: boolean,
    ...parts: Array<string>
  ) {
    const directory = path.join(yield* fs.realPath(rawHome), ...parts);
    if (create) yield* fs.makeDirectory(directory, { recursive: true });
    return yield* fs.realPath(directory);
  });
  const prefixOf = (create: boolean) =>
    resolvedDirectory(create, ".local", "share", "goat", "opencodex");
  /** A path with its directories resolved and its last component kept, to compare entries. */
  const entry = (file: string) =>
    fs
      .realPath(path.dirname(file))
      .pipe(Effect.map((directory) => path.join(directory, path.basename(file))));
  const command = Effect.fn("OpenCodexInstallation.command")(function* (
    binary: string,
    args: ReadonlyArray<string>,
  ) {
    const output = yield* runner
      .run({
        command: binary,
        args,
        env: environment,
        cwd,
        timeout: "60 seconds",
        maxOutputBytes: 4 * 1024 * 1024,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError((cause) => fail("verify", cause)));
    if (output.code !== 0 || output.timedOut || output.stdoutTruncated || output.stdoutInvalidUtf8)
      return yield* fail("verify");
    return output.stdout;
  });

  const inspect = Effect.fn("OpenCodexInstallation.inspect")(
    function* (binary: string, version: string) {
      const asset = resolveOpenCodexRelease(platform, arch, version, catalog);
      if (asset === undefined) return false;
      const prefix = yield* prefixOf(false);
      const root = path.join(prefix, `${version}-${asset.target}`);
      if ((yield* fs.realPath(root)) !== root) return false;
      if ((yield* fs.realPath(binary)) !== path.join(root, asset.layout.executable)) return false;
      const markerPath = path.join(root, MARKER);
      const stat = yield* fs.stat(markerPath);
      if (stat.type !== "File" || Number(stat.size) > MAX_MARKER_BYTES) return false;
      const marker = yield* decodeMarker(yield* fs.readFileString(markerPath));
      return (
        marker.root === root &&
        marker.target === asset.target &&
        marker.version === version &&
        marker.sha256 === asset.sha256
      );
    },
    // Ownership is conservative: unreadable or unknown provenance never grants replacement.
    Effect.orElseSucceed(() => false),
  );

  /** The ocx OpenCodex itself would run; a candidate that answers garbage blocks the choice. */
  const selected = Effect.fn("OpenCodexInstallation.selected")(function* () {
    for (const binary of openCodexCandidates(platform, rawHome, cwd, environment, path)) {
      if (!(yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false)))) continue;
      const output = yield* command(binary, ["--version"]).pipe(Effect.option);
      if (Option.isNone(output)) continue;
      const version = parseOpenCodexVersion(output.value);
      if (version === undefined) return yield* fail("shadowed");
      const managed = yield* inspect(binary, version);
      return {
        path: binary,
        realPath: yield* fs.realPath(binary),
        version,
        ownership: managed ? "managed" : "adopted",
      } satisfies OpenCodexExecutable;
    }
    return undefined;
  });

  /** The entry itself, never its target: a symlink is named by its inode and link text. */
  const identify = (file: string) =>
    Effect.tryPromise(() => NodeFSP.lstat(file, { bigint: true })).pipe(
      Effect.flatMap((stat) =>
        (stat.isSymbolicLink()
          ? fs.readLink(file).pipe(Effect.asSome)
          : Effect.succeed(Option.none<string>())
        ).pipe(
          Effect.map((link) => ({
            dev: String(stat.dev),
            ino: String(stat.ino),
            file: stat.isFile(),
            link: Option.getOrUndefined(link),
          })),
        ),
      ),
      Effect.option,
    );
  const same = (left: Option.Option<EntryIdentity>, right: Option.Option<EntryIdentity>) =>
    Option.isSome(left) &&
    Option.isSome(right) &&
    left.value.dev === right.value.dev &&
    left.value.ino === right.value.ino &&
    left.value.link === right.value.link;

  /** A complete release: its own executable answers its version beside its GUI and keyring. */
  const verifyRelease = Effect.fn("OpenCodexInstallation.verifyRelease")(
    function* (root: string, asset: OpenCodexRelease) {
      const executable = path.join(root, asset.layout.executable);
      const own = yield* identify(executable);
      const stat = yield* fs.stat(executable);
      const gui = yield* fs.stat(path.join(root, asset.layout.gui));
      const keyring = yield* fs.readDirectory(path.join(root, asset.layout.keyring));
      if (
        Option.isNone(own) ||
        !own.value.file ||
        Number(stat.size) === 0 ||
        (stat.mode & 0o111) === 0 ||
        gui.type !== "File" ||
        !keyring.some((name) => name.endsWith(".node")) ||
        parseOpenCodexVersion(yield* command(executable, ["--version"])) !== asset.version
      )
        return yield* fail("verify");
    },
    Effect.mapError((cause) => (isInstallationError(cause) ? cause : fail("verify", cause))),
  );

  /** Downloads, checks and unpacks a pinned release into its final, immutable directory. */
  const acquire = Effect.fn("OpenCodexInstallation.acquire")(function* (
    asset: OpenCodexRelease,
    prefix: string,
    destination: string,
  ) {
    const staging = yield* fs.makeTempDirectoryScoped({ directory: prefix, prefix: ".install-" });
    const archive = path.join(staging, "download");
    const runtime = path.join(staging, "runtime");
    yield* fs.makeDirectory(runtime);
    const hash = NodeCrypto.createHash("sha256");
    let bytes = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* http.execute(HttpClientRequest.get(asset.url));
        if (response.status !== 200) return yield* fail("download");
        yield* response.stream.pipe(
          Stream.tap((chunk) => {
            bytes += chunk.byteLength;
            hash.update(chunk);
            return bytes > asset.archiveBytes ? Effect.fail(fail("download")) : Effect.void;
          }),
          Stream.run(fs.sink(archive, { flag: "wx", mode: 0o600 })),
        );
      }),
    ).pipe(
      Effect.timeout("15 minutes"),
      Effect.mapError((cause) => (isInstallationError(cause) ? cause : fail("download", cause))),
    );
    if (bytes !== asset.archiveBytes || hash.digest("hex") !== asset.sha256)
      return yield* fail("download");
    const tar = cliArchiveTarCommand(platform, environment);
    const listing = (args: ReadonlyArray<string>) =>
      command(tar, args).pipe(
        Effect.map((text) => text.split(/\r?\n/u).filter((line) => line !== "")),
        Effect.mapError(() => fail("archive")),
      );
    const names = yield* listing(["-tf", archive]);
    const lines = yield* listing(["-tvf", archive]);
    if (!safeListing(asset, names, lines)) return yield* fail("archive");
    yield* command(tar, ["-xf", archive, "-C", runtime]).pipe(
      Effect.mapError(() => fail("archive")),
    );
    yield* verifyRelease(runtime, asset);
    yield* fs.writeFileString(
      path.join(runtime, MARKER),
      encodeMarker({
        schemaVersion: 1,
        root: destination,
        target: asset.target,
        version: asset.version,
        sha256: asset.sha256,
      }),
      { flag: "wx", mode: 0o600 },
    );
    yield* fs.rename(runtime, destination);
  });

  const created = (effect: Effect.Effect<void, PlatformError.PlatformError>) =>
    effect.pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
    );
  /** Puts a moved-aside entry back at `launcher` without ever replacing what is there now. */
  const restoreExclusively = (
    moved: string,
    identity: Option.Option<EntryIdentity>,
    launcher: string,
  ) =>
    created(
      Option.isSome(identity) && identity.value.link !== undefined
        ? fs.symlink(identity.value.link, launcher)
        : fs.link(moved, launcher),
    ).pipe(Effect.orElseSucceed(() => false));

  /**
   * Swaps the launcher only if it is still the entry selected under the lock, then confirms
   * OpenCodex's resolution selects this managed release. A displaced entry that is not ours is
   * kept aside under bin/.ocx-* when it cannot be put back.
   */
  const activate = Effect.fn("OpenCodexInstallation.activate")(function* (
    executable: string,
    version: string,
    bin: string,
    launcher: string,
    selectedLauncher: Option.Option<EntryIdentity>,
  ) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const activation = yield* fs.makeTempDirectory({ directory: bin, prefix: ".ocx-" });
        const done = fs.remove(activation, { recursive: true }).pipe(Effect.ignore);
        const backup = path.join(activation, "previous");
        let previous = Option.none<EntryIdentity>();
        if (Option.isSome(selectedLauncher)) {
          const moved = yield* fs.rename(launcher, backup).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!moved) {
            yield* done;
            return yield* fail("not-managed");
          }
          previous = yield* identify(backup);
          if (!same(previous, selectedLauncher)) {
            if (yield* restoreExclusively(backup, previous, launcher)) yield* done;
            return yield* fail("not-managed");
          }
        }
        // Exclusive: an entry someone created after the move stays theirs.
        if (!(yield* created(fs.symlink(executable, launcher)))) return yield* fail("not-managed");
        const published = yield* identify(launcher);
        const checked = yield* selected().pipe(Effect.option);
        const selection = Option.isSome(checked) ? checked.value : undefined;
        if (
          selection?.realPath === executable &&
          selection.version === version &&
          selection.ownership === "managed"
        ) {
          yield* done;
          return selection;
        }
        // Undo only this activation's own symlink, even when its target has disappeared.
        const current = yield* identify(launcher);
        if (same(current, published) && Option.getOrUndefined(current)?.link === executable) {
          yield* fs.rename(launcher, path.join(activation, "rejected"));
          if (Option.isNone(previous) || (yield* restoreExclusively(backup, previous, launcher)))
            yield* done;
        }
        return yield* fail(selection?.realPath === executable ? "verify" : "activation");
      }),
    );
  });

  const install = Effect.fn("OpenCodexInstallation.install")(
    function* (input: { readonly managedVersion?: string } = {}) {
      // Keeping a supported install changes nothing, so it needs no lock and creates no files.
      const current = yield* selected();
      if (
        input.managedVersion === undefined &&
        current !== undefined &&
        supportedOpenCodexVersion(current.version)
      )
        return current;
      if (platform === "win32") return yield* fail("unsupported");
      const version = input.managedVersion ?? OPEN_CODEX_PINNED_VERSION;
      const asset = resolveOpenCodexRelease(platform, arch, version, catalog);
      if (asset === undefined || !supportedOpenCodexVersion(version))
        return yield* fail("unsupported");
      return yield* gate.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const prefix = yield* prefixOf(true);
            const bin = yield* resolvedDirectory(true, ".local", "bin");
            const launcher = path.join(bin, "ocx");
            yield* installLock.acquire(prefix, () => fail("busy"));
            // Selected again under the lock: this identity is what activation may replace.
            const before = yield* selected();
            if (
              input.managedVersion === undefined &&
              before !== undefined &&
              supportedOpenCodexVersion(before.version)
            )
              return before;
            if (
              before !== undefined &&
              (before.ownership !== "managed" || (yield* entry(before.path)) !== launcher)
            )
              return yield* fail(input.managedVersion === undefined ? "shadowed" : "not-managed");
            const destination = path.join(prefix, `${version}-${asset.target}`);
            const executable = path.join(destination, asset.layout.executable);
            // A retained release is checked like a fresh one: the directory may have changed.
            if (!(yield* fs.exists(destination))) yield* acquire(asset, prefix, destination);
            else yield* verifyRelease(destination, asset);
            if (!(yield* inspect(executable, version))) return yield* fail("verify");
            const selectedLauncher = yield* identify(launcher);
            if (
              Option.isSome(selectedLauncher) &&
              (before === undefined ||
                (yield* fs.realPath(launcher).pipe(Effect.orElseSucceed(() => ""))) !==
                  before.realPath)
            )
              return yield* fail("not-managed");
            return yield* activate(executable, version, bin, launcher, selectedLauncher);
          }),
        ),
      );
    },
    Effect.mapError((cause) => (isInstallationError(cause) ? cause : fail("io", cause))),
  );

  return OpenCodexInstallation.of({ install, inspect });
});

export const layer = Layer.effect(OpenCodexInstallation, make);
