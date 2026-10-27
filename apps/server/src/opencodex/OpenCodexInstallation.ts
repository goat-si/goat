// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or random token.
import * as NodeCrypto from "node:crypto";

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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";

const MARKER = ".goat-install.json";
const LOCK = ".install-lock";
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
  const lockToken = `${process.pid}\n${NodeCrypto.randomUUID()}\n`;

  /** Under the resolved home, so a symlinked home still yields one canonical install root. */
  const places = Effect.gen(function* () {
    const home = yield* fs.realPath(rawHome);
    const bin = path.join(home, ".local", "bin");
    return {
      prefix: path.join(home, ".local", "share", "goat", "opencodex"),
      bin,
      launcher: path.join(bin, "ocx"),
    };
  });
  /** A path with its directories resolved and its last component kept, to compare entries. */
  const entry = (file: string) =>
    fs
      .realPath(path.dirname(file))
      .pipe(Effect.map((directory) => path.join(directory, path.basename(file))));
  const present = (file: string) =>
    fs.exists(file).pipe(
      Effect.flatMap((exists) =>
        exists ? Effect.succeed(true) : fs.readLink(file).pipe(Effect.as(true)),
      ),
      Effect.orElseSucceed(() => false),
    );

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
      const { prefix } = yield* places;
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

  /**
   * One installer per machine: the lock directory names its owner process. A lock whose owner
   * is gone is reclaimed under a second, exclusive directory; any other lock is `busy`.
   */
  const lock = Effect.fn("OpenCodexInstallation.lock")(function* (prefix: string) {
    const lockPath = path.join(prefix, LOCK);
    const owner = path.join(lockPath, "owner");
    const claim = Effect.gen(function* () {
      const staged = yield* fs.makeTempDirectory({ directory: prefix, prefix: ".lock-" });
      yield* fs.writeFileString(path.join(staged, "owner"), lockToken);
      return yield* fs.rename(staged, lockPath).pipe(
        Effect.as(true),
        Effect.catch(() => fs.remove(staged, { recursive: true }).pipe(Effect.as(false))),
      );
    });
    const release = fs.readFileString(owner).pipe(
      Effect.flatMap((text) =>
        text === lockToken ? fs.remove(lockPath, { recursive: true }) : Effect.void,
      ),
      Effect.ignore,
    );
    const take = Effect.gen(function* () {
      if (yield* claim) return;
      const holder = Number(
        (yield* fs.readFileString(owner).pipe(Effect.orElseSucceed(() => ""))).split("\n")[0],
      );
      if (
        !Number.isInteger(holder) ||
        holder <= 0 ||
        holder === process.pid ||
        isProcessAlive(holder)
      )
        return yield* fail("busy");
      const reclaim = `${lockPath}.reclaim`;
      const reclaiming = yield* fs.makeDirectory(reclaim).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!reclaiming) return yield* fail("busy");
      const still = yield* fs.readFileString(owner).pipe(Effect.orElseSucceed(() => ""));
      const reclaimed =
        Number(still.split("\n")[0]) === holder
          ? yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.andThen(claim))
          : false;
      yield* fs.remove(reclaim, { recursive: true });
      if (!reclaimed) return yield* fail("busy");
    });
    yield* Effect.acquireRelease(take, () => release);
  });

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
    const staged = path.join(runtime, asset.layout.executable);
    const stat = yield* fs.stat(staged);
    if (
      stat.type !== "File" ||
      Number(stat.size) === 0 ||
      (stat.mode & 0o111) === 0 ||
      parseOpenCodexVersion(yield* command(staged, ["--version"])) !== asset.version
    )
      return yield* fail("verify");
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

  /** Points the launcher at `executable`, then confirms OpenCodex's resolution selects it. */
  const activate = Effect.fn("OpenCodexInstallation.activate")(function* (
    executable: string,
    bin: string,
    launcher: string,
    before: OpenCodexExecutable | undefined,
  ) {
    yield* fs.makeDirectory(bin, { recursive: true });
    const activation = yield* fs.makeTempDirectoryScoped({ directory: bin, prefix: ".ocx-" });
    const next = path.join(activation, "ocx");
    yield* fs.symlink(executable, next);
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* fs.rename(next, launcher);
        const checked = yield* selected().pipe(Effect.option);
        if (Option.isSome(checked) && checked.value?.realPath === executable) return checked.value;
        // Undo only what this activation did: a launcher someone changed since stays theirs.
        const stillOurs = yield* fs.realPath(launcher).pipe(
          Effect.map((value) => value === executable),
          Effect.orElseSucceed(() => false),
        );
        if (stillOurs && before !== undefined) {
          const restore = path.join(activation, "restore");
          yield* fs.symlink(before.realPath, restore);
          yield* fs.rename(restore, launcher);
        } else if (stillOurs) {
          yield* fs.remove(launcher);
        }
        return yield* fail("activation");
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
            const { prefix, bin, launcher } = yield* places;
            yield* fs.makeDirectory(prefix, { recursive: true });
            yield* lock(prefix);
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
            if (!(yield* fs.exists(destination))) yield* acquire(asset, prefix, destination);
            if (!(yield* inspect(executable, version))) return yield* fail("verify");
            if (
              (yield* present(launcher)) &&
              (before === undefined ||
                (yield* fs.realPath(launcher).pipe(Effect.orElseSucceed(() => ""))) !==
                  before.realPath)
            )
              return yield* fail("not-managed");
            return yield* activate(executable, bin, launcher, before);
          }),
        ),
      );
    },
    Effect.mapError((cause) => (isInstallationError(cause) ? cause : fail("io", cause))),
  );

  return OpenCodexInstallation.of({ install, inspect });
});

export const layer = Layer.effect(OpenCodexInstallation, make);
