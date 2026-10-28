// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or lstat.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

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
import { acquireInstallLock, INSTALL_LOCK_FILE } from "./installLock.ts";

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

/**
 * The Windows `current` junction swap in flight. Recovery restores the previous junction until
 * the record says committed, then only removes this operation's leftover entries.
 */
const WindowsActivation = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operationId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  previous: Schema.NullOr(Schema.String),
  next: Schema.String,
  phase: Schema.Literals(["pending", "committed"]),
});
type WindowsActivation = typeof WindowsActivation.Type;
const decodeActivation = Schema.decodeUnknownEffect(Schema.fromJsonString(WindowsActivation), {
  onExcessProperty: "error",
});
const encodeActivation = Schema.encodeSync(Schema.fromJsonString(WindowsActivation));
const ACTIVATION = ".activation.json";
/** Windows paths compare without case and with one separator form. */
const windowsIdentity = (value: string) => NodePath.win32.resolve(value).toLowerCase();
const sameWindowsPath = (left: string | undefined, right: string | undefined) =>
  left === undefined || right === undefined
    ? left === right
    : windowsIdentity(left) === windowsIdentity(right);

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

/**
 * A member name as a forward-slash path. Windows release zips name members with backslashes, so
 * those are normalized only after refusing drive, UNC and absolute names; elsewhere a backslash
 * is refused outright.
 */
const memberName = (name: string, windows: boolean) =>
  windows
    ? /^(?:[\\/]|[A-Za-z]:)/u.test(name)
      ? undefined
      : name.replaceAll("\\", "/")
    : name.includes("\\")
      ? undefined
      : name;

/** Names from `tar -tf` and lines from `tar -tvf` describe only the standalone layout. */
export const safeListing = (
  asset: OpenCodexRelease,
  names: ReadonlyArray<string>,
  lines: ReadonlyArray<string>,
  windows = false,
) => {
  const normalized = names.map((name) => memberName(name, windows));
  if (normalized.some((name) => name === undefined)) return false;
  const clean = normalized.map((name = "") => name.replace(/^\.\//u, "").replace(/\/$/u, ""));
  const roots = [asset.layout.executable, "gui", "keyring"];
  // NTFS folds case, so two names that differ only in case would land on one file there.
  const keys = clean.map((name) => (windows ? name.toLowerCase() : name));
  return (
    names.length > 0 &&
    names.length <= MAX_MEMBERS &&
    names.length === lines.length &&
    new Set(keys).size === keys.length &&
    // Only plain files and directories: no symlink, hard link or device.
    lines.every((line) => ["-", "d"].includes(line[0] ?? "") && !/ (?:->|link to) /u.test(line)) &&
    clean.every(
      (name) =>
        name !== "" &&
        !name.startsWith("/") &&
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
  /** Windows' launcher is the `current` junction in the prefix, the path Remote Link selects. */
  const windowsLauncher = path.join(
    rawHome,
    ".local",
    "share",
    "goat",
    "opencodex",
    "current",
    "ocx.exe",
  );
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
        // Windows has no execute bit: a nonempty file whose --version answers is the test.
        (platform !== "win32" && (stat.mode & 0o111) === 0) ||
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
    if (!safeListing(asset, names, lines, platform === "win32")) return yield* fail("archive");
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

  /** Where a junction points; undefined when absent. Anything but a link is never treated as one. */
  const junctionTarget = Effect.fn("OpenCodexInstallation.junctionTarget")(function* (
    file: string,
  ) {
    const found = yield* identify(file);
    if (Option.isNone(found)) return undefined;
    if (found.value.link === undefined) return yield* fail("activation");
    return yield* fs.realPath(file);
  });
  /** Removes only the junction entry, and only while it still points at `target`. */
  const removeJunction = Effect.fn("OpenCodexInstallation.removeJunction")(function* (
    file: string,
    target: string,
  ) {
    const actual = yield* junctionTarget(file);
    if (actual === undefined) return;
    if (!sameWindowsPath(actual, target)) return yield* fail("activation");
    yield* Effect.tryPromise(() => NodeFSP.unlink(file));
  });
  /** A marked release in the prefix that the trusted pins vouch for; never a path alone. */
  const checkWindowsRelease = Effect.fn("OpenCodexInstallation.checkWindowsRelease")(function* (
    prefix: string,
    root: string,
  ) {
    if (!sameWindowsPath(path.dirname(root), prefix)) return yield* fail("activation");
    const markerPath = path.join(root, MARKER);
    const stat = yield* fs.stat(markerPath);
    if (stat.type !== "File" || Number(stat.size) > MAX_MARKER_BYTES)
      return yield* fail("activation");
    const marker = yield* decodeMarker(yield* fs.readFileString(markerPath));
    const asset = resolveOpenCodexRelease(platform, arch, marker.version, catalog);
    if (
      asset === undefined ||
      !(yield* inspect(path.join(root, asset.layout.executable), marker.version))
    )
      return yield* fail("activation");
  });
  const activationPaths = (prefix: string, id: string) => ({
    current: path.join(prefix, "current"),
    next: path.join(prefix, `.current-${id}.next`),
    backup: path.join(prefix, `.current-${id}.previous`),
  });
  const writeActivation = Effect.fn("OpenCodexInstallation.writeActivation")(function* (
    prefix: string,
    record: WindowsActivation,
  ) {
    const file = path.join(prefix, ACTIVATION);
    const temporary = `${file}.${record.operationId}.${record.phase}.tmp`;
    yield* Effect.tryPromise(async () => {
      const handle = await NodeFSP.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(encodeActivation(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    yield* fs.rename(temporary, file);
  });
  const readActivation = Effect.fn("OpenCodexInstallation.readActivation")(function* (
    prefix: string,
  ) {
    const file = path.join(prefix, ACTIVATION);
    const found = yield* identify(file);
    if (Option.isNone(found)) return undefined;
    if (!found.value.file || Number((yield* fs.stat(file)).size) > MAX_MARKER_BYTES)
      return yield* fail("activation");
    const record = yield* decodeActivation(yield* fs.readFileString(file));
    yield* checkWindowsRelease(prefix, record.next);
    if (record.previous !== null) yield* checkWindowsRelease(prefix, record.previous);
    return record;
  });

  /**
   * Finishes or undoes an interrupted Windows activation under the install lock: before commit
   * the previous junction comes back (or this operation's first junction goes), after it only
   * leftovers go. A foreign or ambiguous state is refused untouched; no version directory is
   * ever removed.
   */
  const recoverWindows = Effect.fn("OpenCodexInstallation.recoverWindows")(
    function* (prefix: string) {
      const record = yield* readActivation(prefix);
      if (record === undefined) return;
      const names = activationPaths(prefix, record.operationId);
      const previous = record.previous ?? undefined;
      const current = yield* junctionTarget(names.current);
      const backup = yield* junctionTarget(names.backup);
      if (record.phase === "committed") {
        if (!sameWindowsPath(current, record.next)) return yield* fail("activation");
        if (backup !== undefined) {
          if (!sameWindowsPath(backup, previous)) return yield* fail("activation");
          yield* removeJunction(names.backup, backup);
        }
      } else {
        if (
          current !== undefined &&
          !sameWindowsPath(current, record.next) &&
          !sameWindowsPath(current, previous)
        )
          return yield* fail("activation");
        if (current !== undefined && sameWindowsPath(current, record.next))
          yield* removeJunction(names.current, record.next);
        const now = yield* junctionTarget(names.current);
        if (previous !== undefined && now === undefined) {
          if (!sameWindowsPath(backup, previous)) return yield* fail("activation");
          yield* fs.rename(names.backup, names.current);
        } else if (!sameWindowsPath(now, previous) || backup !== undefined)
          return yield* fail("activation");
        if (!sameWindowsPath(yield* junctionTarget(names.current), previous))
          return yield* fail("activation");
      }
      yield* removeJunction(names.next, record.next);
      yield* fs.remove(path.join(prefix, ACTIVATION));
    },
    Effect.mapError((cause) => (isInstallationError(cause) ? cause : fail("activation", cause))),
  );

  /**
   * Points the `current` junction at a verified release: journal, swap, confirm OpenCodex's
   * resolution selects it, then commit. Any failure before the commit restores the previous
   * junction; a crash leaves the journal for the next install to recover. Junctions need no
   * administrator or Developer Mode, unlike file symlinks.
   */
  const activateWindows = Effect.fn("OpenCodexInstallation.activateWindows")(
    function* (
      prefix: string,
      destination: string,
      executable: string,
      before: OpenCodexExecutable | undefined,
    ) {
      if (before?.ownership === "managed" && sameWindowsPath(before.realPath, executable))
        return before;
      const previous = before?.ownership === "managed" ? path.dirname(before.realPath) : undefined;
      yield* checkWindowsRelease(prefix, destination);
      if (previous !== undefined) yield* checkWindowsRelease(prefix, previous);
      if ((yield* readActivation(prefix)) !== undefined) return yield* fail("activation");
      const record: WindowsActivation = {
        schemaVersion: 1,
        operationId: NodeCrypto.randomUUID().replaceAll("-", ""),
        previous: previous ?? null,
        next: destination,
        phase: "pending",
      };
      const names = activationPaths(prefix, record.operationId);
      if (!sameWindowsPath(yield* junctionTarget(names.current), previous))
        return yield* fail("not-managed");
      yield* Effect.tryPromise(() => NodeFSP.symlink(destination, names.next, "junction"));
      if (!sameWindowsPath(yield* junctionTarget(names.next), destination))
        return yield* fail("activation");
      yield* writeActivation(prefix, record);
      const published = yield* Effect.gen(function* () {
        if (previous !== undefined) yield* fs.rename(names.current, names.backup);
        yield* fs.rename(names.next, names.current);
        const checked = yield* selected();
        if (
          checked?.ownership !== "managed" ||
          !sameWindowsPath(checked.realPath, executable) ||
          !sameWindowsPath(checked.path, windowsLauncher)
        )
          return yield* fail("activation");
        return checked;
      }).pipe(Effect.result);
      if (published._tag === "Failure") {
        yield* recoverWindows(prefix);
        return yield* isInstallationError(published.failure)
          ? published.failure
          : fail("activation", published.failure);
      }
      yield* writeActivation(prefix, { ...record, phase: "committed" });
      yield* recoverWindows(prefix);
      return published.success;
    },
    Effect.uninterruptible,
    Effect.mapError((cause) => (isInstallationError(cause) ? cause : fail("activation", cause))),
  );

  /**
   * Whether `before` keeps GOAT from activating its release. On Windows only an ocx Remote Link
   * would select ahead of the `current` junction shadows it; a managed one must be that junction.
   */
  const blocksActivation = Effect.fn("OpenCodexInstallation.blocksActivation")(function* (
    before: OpenCodexExecutable,
    launcher: string,
    managedOnly: boolean,
  ) {
    if (platform !== "win32")
      return before.ownership !== "managed" || (yield* entry(before.path)) !== launcher;
    const order = openCodexCandidates(platform, rawHome, cwd, environment, path).map(
      windowsIdentity,
    );
    const at = order.indexOf(windowsIdentity(before.path));
    const managed = order.indexOf(windowsIdentity(windowsLauncher));
    return before.ownership === "managed" ? at !== managed : managedOnly || at <= managed;
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

  /** Removes one entry this activation owns, then its directory once nothing else is in it. */
  const discard = (file: string) => fs.remove(file).pipe(Effect.ignore);
  const removeIfEmpty = (directory: string) =>
    Effect.tryPromise(() => NodeFSP.rmdir(directory)).pipe(Effect.ignore);

  /**
   * Swaps the launcher only if it is still the entry selected under the lock, then confirms
   * OpenCodex's resolution selects this managed release. Any failure after the swap puts the
   * previous launcher back; an entry that is not ours is never removed, only kept aside.
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
        const backup = path.join(activation, "previous");
        let previous = Option.none<EntryIdentity>();
        if (Option.isSome(selectedLauncher)) {
          const moved = yield* fs.rename(launcher, backup).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!moved) {
            yield* removeIfEmpty(activation);
            return yield* fail("not-managed");
          }
          previous = yield* identify(backup);
          if (!same(previous, selectedLauncher)) {
            if (yield* restoreExclusively(backup, previous, launcher)) {
              yield* discard(backup);
              yield* removeIfEmpty(activation);
            }
            return yield* fail("not-managed");
          }
        }
        let published = Option.none<EntryIdentity>();
        const attempt = Effect.gen(function* () {
          // Exclusive: an entry someone created after the move stays theirs.
          if (!(yield* created(fs.symlink(executable, launcher))))
            return yield* fail("not-managed");
          published = yield* identify(launcher);
          const checked = yield* selected().pipe(Effect.option);
          const selection = Option.isSome(checked) ? checked.value : undefined;
          if (
            selection?.realPath === executable &&
            selection.version === version &&
            selection.ownership === "managed"
          )
            return selection;
          return yield* fail(selection?.realPath === executable ? "verify" : "activation");
        });
        const outcome = yield* Effect.result(attempt);
        if (outcome._tag === "Success") {
          yield* discard(backup);
          yield* removeIfEmpty(activation);
          return outcome.success;
        }
        // Undo only this activation's own symlink, judged after moving it, so a launcher someone
        // put there meanwhile is put back instead of removed.
        let restorePrevious = true;
        if (Option.isSome(published)) {
          const rejected = path.join(activation, "rejected");
          const moved = yield* fs.rename(launcher, rejected).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (moved) {
            const found = yield* identify(rejected);
            if (same(found, published) && Option.getOrUndefined(found)?.link === executable)
              yield* discard(rejected);
            else {
              restorePrevious = false;
              if (yield* restoreExclusively(rejected, found, launcher)) yield* discard(rejected);
            }
          }
        }
        if (
          restorePrevious &&
          Option.isSome(previous) &&
          (yield* restoreExclusively(backup, previous, launcher))
        )
          yield* discard(backup);
        // Removed only when empty: anything left is an entry kept aside for a person to resolve.
        yield* removeIfEmpty(activation);
        return yield* outcome.failure;
      }),
    );
  });

  const install = Effect.fn("OpenCodexInstallation.install")(
    function* (input: { readonly managedVersion?: string } = {}) {
      // Keeping a supported install changes nothing, so it needs no lock and creates no files.
      const current = yield* selected();
      // An uncommitted Windows swap may still be undone, so it is recovered under the lock first.
      const pendingActivation =
        platform === "win32" &&
        (yield* prefixOf(false).pipe(
          Effect.flatMap((prefix) => identify(path.join(prefix, ACTIVATION))),
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => false),
        ));
      if (
        input.managedVersion === undefined &&
        current !== undefined &&
        supportedOpenCodexVersion(current.version) &&
        !pendingActivation
      )
        return current;
      const version = input.managedVersion ?? OPEN_CODEX_PINNED_VERSION;
      const asset = resolveOpenCodexRelease(platform, arch, version, catalog);
      // Windows installs only a pinned x64 release whose Remote Link accepts a Windows Child.
      if (
        asset === undefined ||
        !supportedOpenCodexVersion(version) ||
        (platform === "win32" && (arch !== "x64" || !asset.remoteLinkWindows))
      )
        return yield* fail("unsupported");
      return yield* gate.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const prefix = yield* prefixOf(true);
            const bin =
              platform === "win32" ? prefix : yield* resolvedDirectory(true, ".local", "bin");
            const launcher = path.join(bin, "ocx");
            yield* acquireInstallLock(
              path.join(prefix, INSTALL_LOCK_FILE),
              () => fail("busy"),
              (cause) => fail("io", cause),
            );
            if (platform === "win32") yield* recoverWindows(prefix);
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
              (yield* blocksActivation(before, launcher, input.managedVersion !== undefined))
            )
              return yield* fail(input.managedVersion === undefined ? "shadowed" : "not-managed");
            const destination = path.join(prefix, `${version}-${asset.target}`);
            const executable = path.join(destination, asset.layout.executable);
            // A retained release is checked like a fresh one: the directory may have changed.
            if (!(yield* fs.exists(destination))) yield* acquire(asset, prefix, destination);
            else yield* verifyRelease(destination, asset);
            if (!(yield* inspect(executable, version))) return yield* fail("verify");
            if (platform === "win32")
              return yield* activateWindows(
                prefix,
                destination,
                executable,
                before?.ownership === "managed" ? before : undefined,
              );
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
