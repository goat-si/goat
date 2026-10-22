import { extractFile, listPackage, statFile } from "@electron/asar";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";
import type { PlatformError } from "effect/PlatformError";
import { runtimeManifestAssetName } from "@goat/shared/runtimeManifest";
import { checkReleaseRuntimeManifest } from "./runtime-manifest.ts";
import { parseUpdateManifest, type UpdateManifest } from "./update-manifest.ts";

export class ReleaseVerificationError extends Schema.TaggedError<ReleaseVerificationError>()(
  "ReleaseVerificationError",
  { problems: Schema.Array(Schema.String) },
) {
  override get message() {
    return this.problems.join("\n");
  }
}

const ReleaseSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const ReleaseReportSchema = Schema.Struct({
  key: Schema.String,
  mode: Schema.Literals(["payload", "mac", "assemble"]),
  version: Schema.String,
  inputs: Schema.Array(Schema.Struct({ name: Schema.String, sha256: ReleaseSha256 })),
  transforms: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        from: ReleaseSha256,
        to: ReleaseSha256,
        step: Schema.Literal("dmg-finalize"),
      }),
    ),
  ),
  ok: Schema.Boolean,
  checks: Schema.Array(Schema.String),
  problems: Schema.Array(Schema.String),
});
export type ReleaseReport = typeof ReleaseReportSchema.Type;
export const decodeReleaseReport = Schema.decodeEffect(Schema.fromJsonString(ReleaseReportSchema));
const encodeReleaseReport = Schema.encodeEffect(Schema.fromJsonString(ReleaseReportSchema));
const isReleaseVerificationError = Schema.is(ReleaseVerificationError);
export interface ReleaseAsset {
  name: string;
  sha256: string;
  sha512: string;
  size: number;
}
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type ReleaseCommandRunner = (
  program: string,
  args: readonly string[],
) => Effect.Effect<
  CommandResult,
  ReleaseVerificationError | PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
>;
const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (a, b) => a + b,
    ),
  );
/** All tools, including archive extraction and Apple tooling, share this injectable boundary. */
export const runReleaseCommand: ReleaseCommandRunner = (program, args) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(program, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(Effect.scoped);
export const requireReleaseCommand = Effect.fn("requireReleaseCommand")(function* (
  runner: ReleaseCommandRunner,
  program: string,
  args: readonly string[],
) {
  const result = yield* runner(program, args);
  if (result.exitCode !== 0)
    return yield* new ReleaseVerificationError({
      problems: [`${program} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`],
    });
  return result;
});

export const isDistributable = (name: string) =>
  /\.(?:dmg|zip|exe|AppImage|deb|tar\.gz)$/.test(name);
export const hashBytes = Effect.fn("hashReleaseBytes")(function* (
  bytes: Uint8Array,
  algorithm: "SHA-256" | "SHA-512",
) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest(algorithm, Uint8Array.from(bytes)),
    catch: (error) =>
      new ReleaseVerificationError({ problems: [`${algorithm}: ${String(error)}`] }),
  });
  const data = new Uint8Array(digest);
  return algorithm === "SHA-256"
    ? Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("")
    : btoa(String.fromCharCode(...data));
});
export const readReleaseAsset = Effect.fn("readReleaseAsset")(function* (
  dir: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bytes = yield* fs.readFile(path.join(dir, name));
  return {
    name,
    size: bytes.length,
    sha256: yield* hashBytes(bytes, "SHA-256"),
    sha512: yield* hashBytes(bytes, "SHA-512"),
  };
});
export const releaseInputs = Effect.fn("releaseInputs")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inputs: ReleaseAsset[] = [];
  for (const name of (yield* fs.readDirectory(dir)).toSorted()) {
    if (isDistributable(name) && (yield* fs.stat(path.join(dir, name))).type === "File") {
      inputs.push(yield* readReleaseAsset(dir, name));
    }
  }
  return inputs;
});

/** The fat header's small architecture count distinguishes it from a Java class version. */
export function isMachO(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = Array.from(bytes.subarray(0, 4), (v) => v.toString(16).padStart(2, "0")).join("");
  if (["feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(magic)) return true;
  if (!["cafebabe", "bebafeca"].includes(magic) || bytes.length < 8) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
  return count >= 1 && count <= 20;
}

// D-10 keeps GOAT's own sources private. Third-party code (node_modules, the Electron
// framework) legitimately ships its own TypeScript, source maps and its CI's paths, so
// source checks and generic path patterns apply to GOAT code only. Paths of this build
// machine (its home, workspace and checkout) fail anywhere they appear.
// On Windows and Linux, Electron's runtime (the renamed electron executable, its
// libraries, .pak files and locales) sits beside resources/ in the unpacked app;
// GOAT's own code lives under resources/. Cua Driver under resources/cua-driver is a
// vendored upstream release whose executables carry the paths of the CI that built them.
const thirdParty =
  /(?:^|\/)node_modules\/|\/Contents\/Frameworks\/|\/[Rr]esources\/cua-driver\/|(?:^|\/)(?:(?:win|linux)(?:-[a-z0-9]+)?-unpacked|__appImage-[a-z0-9]+)\/(?!resources\/)/;
// GOAT's own workspace packages stay GOAT code even when they land in node_modules.
const goatPackage = /(?:^|\/)node_modules\/@goat\//;
const buildPath =
  /\/Users\/[A-Za-z0-9._-]+\/|\/home\/runner\/|\/opt\/actions-runner\/|[DC]:\\+a\\+|\$GITHUB_WORKSPACE/g;

/** Absolute paths that identify the machine running the build. */
export function localBuildRoots(env: Readonly<Record<string, string | undefined>>, cwd: string) {
  const roots = [env.HOME, env.GITHUB_WORKSPACE, env.RUNNER_WORKSPACE, env.RUNNER_TEMP, cwd]
    .map((root) => root?.replace(/[\\/]+$/, ""))
    .filter((root): root is string => root !== undefined && root.length >= 5);
  return [...new Set(roots)];
}
const defaultBuildRoots = localBuildRoots(process.env, process.cwd());
// GitHub-hosted runners share one home directory per OS, so a dependency built on
// any hosted runner (the Cursor SDK's sandbox binary, for one) carries the same
// paths. Inside third-party files they do not identify this machine; workspace
// and temp roots still do.
const sharedHostedHomes = new Set(["/home/runner", "/Users/runner", "C:\\Users\\runneradmin"]);

export function exposureProblems(
  name: string,
  content = "",
  roots: readonly string[] = defaultBuildRoots,
  // Compiled binaries carry their toolchain's build paths (Node's own, Electron's);
  // only this machine's paths matter there.
  binary = false,
): string[] {
  const normalized = name.replace(/\\/g, "/");
  const problems: string[] = [];
  const ours = !thirdParty.test(normalized) || goatPackage.test(normalized);
  if (ours && /\.map$/i.test(normalized)) problems.push(`${name}: source map`);
  if (ours && /\.(?:ts|tsx|mts|cts)$/i.test(normalized)) problems.push(`${name}: original source`);
  if (/(?:^|\/)\.git(?:\/|$)/.test(normalized)) problems.push(`${name}: git metadata`);
  if (ours && /sourceMappingURL\s*=\s*data:/i.test(content))
    problems.push(`${name}: inline source map`);
  if (ours && /["']sourcesContent["']/.test(content))
    problems.push(`${name}: embedded sourcesContent`);
  if (/(?:github\.com[/:]|repos\/)goat-si\/goat(?!(?:-releases|_))/i.test(content))
    problems.push(`${name}: private repository URL`);
  // V8/Node's diagnostic code embeds this documented Windows example literally.
  const pathContent = content.replace(/C:\\(?:\\)?a\\(?:\\)?b\\(?:\\)?c(?=["'`\s)]|$)/g, "");
  const machineRoots = ours ? roots : roots.filter((root) => !sharedHostedHomes.has(root));
  const machinePath = machineRoots.some(
    (root) =>
      pathContent.includes(`${root}/`) || pathContent.includes(`${root}\\`) || name.includes(root),
  );
  if (machinePath || (ours && !binary && (buildPath.test(pathContent) || buildPath.test(name))))
    problems.push(`${name}: absolute build path`);
  buildPath.lastIndex = 0;
  return problems;
}

export const walkReleaseTree = Effect.fn("walkReleaseTree")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: Array<{
    absolute: string;
    relative: string;
    type: "file" | "directory" | "link";
  }> = [];
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const absolute = path.join(root, relative);
    const link = yield* fs.readLink(absolute).pipe(Effect.option);
    if (Option.isSome(link)) {
      entries.push({ absolute, relative, type: "link" });
      continue;
    }
    const info = yield* fs.stat(absolute);
    if (info.type === "Directory") {
      if (relative) entries.push({ absolute, relative, type: "directory" });
      for (const name of (yield* fs.readDirectory(absolute)).toSorted().toReversed())
        pending.push(path.join(relative, name));
    } else if (info.type === "File") entries.push({ absolute, relative, type: "file" });
  }
  return entries;
});
export function archiveMemberProblems(listing: string): string[] {
  return listing
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((name) => {
      const normalized = name.replace(/\\/g, "/");
      return /^(?:\/|[A-Za-z]:)/.test(normalized) || normalized.split("/").includes("..")
        ? [`${name}: unsafe archive member`]
        : exposureProblems(name);
    });
}
export const unpackReleaseArchive = Effect.fn("unpackReleaseArchive")(function* (
  archive: string,
  destination: string,
  runner: ReleaseCommandRunner = runReleaseCommand,
  macZip = false,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(destination, { recursive: true });
  // Windows' system tar is bsdtar and accepts ZIPs; Unix CLI ZIPs use unzip.
  const zip = archive.endsWith(".zip");
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const tar =
    platform === "win32" ? `${environment.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe` : "tar";
  const listing = yield* requireReleaseCommand(
    runner,
    zip && platform !== "win32" ? "unzip" : tar,
    zip && platform !== "win32" ? ["-Z1", archive] : ["-tf", archive],
  );
  const problems = archiveMemberProblems(listing.stdout);
  if (problems.length) return yield* new ReleaseVerificationError({ problems });
  if (zip && macZip)
    yield* requireReleaseCommand(runner, "ditto", ["-x", "-k", archive, destination]);
  else if (zip && platform !== "win32")
    yield* requireReleaseCommand(runner, "unzip", ["-q", archive, "-d", destination]);
  else yield* requireReleaseCommand(runner, tar, ["-xf", archive, "-C", destination]);
});

/** Scans unpacked payloads, all ASARs and embedded runtime tarballs, never installer container bytes. */
export const scanReleasePayload = Effect.fn("scanReleasePayload")(function* (
  root: string,
  runner: ReleaseCommandRunner = runReleaseCommand,
  visitMachO?: (
    file: string,
    name: string,
  ) => Effect.Effect<
    void,
    ReleaseVerificationError | PlatformError,
    ChildProcessSpawner.ChildProcessSpawner
  >,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "goat-payload-" });
  const problems: string[] = [];
  const pending = [{ dir: root, label: "" }];
  let counter = 0;
  let inspectedFiles = 0;
  while (pending.length) {
    const { dir, label } = pending.pop()!;
    for (const entry of yield* walkReleaseTree(dir)) {
      const name = label + entry.relative.replace(/\\/g, "/");
      // Builder output also contains manifests and installers. Scan its unpacked
      // directories; inputs below independently bind installer bytes to the report.
      if (
        !label &&
        !entry.relative.includes(path.sep) &&
        (isDistributable(entry.relative) || /\.(?:yml|yaml|blockmap)$/.test(entry.relative))
      )
        continue;
      problems.push(...exposureProblems(name));
      if (entry.type === "link") {
        const target = yield* fs.readLink(entry.absolute);
        const resolved = path.resolve(path.dirname(entry.absolute), target);
        // Electron DMGs expose the standard installation shortcut beside the app.
        if (!label && entry.relative === "Applications" && target === "/Applications") continue;
        if (
          path.isAbsolute(target) ||
          (!resolved.startsWith(path.resolve(dir) + path.sep) && resolved !== path.resolve(dir))
        ) {
          problems.push(`${name}: external payload symlink`);
        }
        continue;
      }
      if (entry.type !== "file") continue;
      inspectedFiles++;
      const inspect = Effect.fn("inspectReleasePayloadFile")(function* () {
        if (entry.absolute.endsWith(".asar")) {
          const members = yield* Effect.try({
            try: () => listPackage(entry.absolute, { isPack: false }),
            catch: (error) =>
              new ReleaseVerificationError({
                problems: [`${name}: invalid ASAR: ${String(error)}`],
              }),
          });
          for (const member of members) {
            const relative = member.replace(/^[/\\]+/, "");
            const memberName = `${name}!/${relative}`;
            problems.push(...exposureProblems(memberName));
            const data = yield* Effect.try({
              try: () => {
                const info = statFile(entry.absolute, relative, false);
                return "files" in info || "link" in info
                  ? undefined
                  : extractFile(entry.absolute, relative);
              },
              catch: (error) =>
                new ReleaseVerificationError({
                  problems: [`${memberName}: unreadable ASAR entry: ${String(error)}`],
                }),
            });
            if (!data) continue;
            if (visitMachO && isMachO(data)) {
              const binary = path.join(scratch, `mach-o-${counter++}`);
              yield* fs.writeFile(binary, data);
              yield* visitMachO(binary, memberName);
            }
            if (/\.(?:asar|tar\.gz)$/.test(relative)) {
              const nested = path.join(scratch, `nested-${counter++}`);
              yield* fs.makeDirectory(nested);
              yield* fs.writeFile(path.join(nested, path.basename(relative)), data);
              pending.push({ dir: nested, label: `${name}!/` });
            } else
              problems.push(
                ...exposureProblems(
                  memberName,
                  new TextDecoder().decode(data),
                  defaultBuildRoots,
                  isMachO(data),
                ),
              );
          }
        } else if (entry.absolute.endsWith(".tar.gz")) {
          const nested = path.join(scratch, `runtime-${counter++}`);
          yield* unpackReleaseArchive(entry.absolute, nested, runner);
          pending.push({ dir: nested, label: `${name}!/` });
        } else {
          const data = yield* fs.readFile(entry.absolute);
          if (visitMachO && isMachO(data)) yield* visitMachO(entry.absolute, name);
          problems.push(
            ...exposureProblems(
              name,
              new TextDecoder().decode(data),
              defaultBuildRoots,
              isMachO(data),
            ),
          );
        }
      });
      yield* inspect().pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            problems.push(
              isReleaseVerificationError(error) ? error.message : `${name}: ${String(error)}`,
            );
          }),
        ),
      );
    }
  }
  if (!inspectedFiles) problems.push("no unpacked payload files to scan");
  return [...new Set(problems)];
}, Effect.scoped);

export const writeReleaseReport = Effect.fn("writeReleaseReport")(function* (
  file: string,
  report: ReleaseReport,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(path.resolve(file)), { recursive: true });
  yield* fs.writeFileString(file, (yield* encodeReleaseReport(report)) + "\n");
});
export const writePayloadReport = Effect.fn("writePayloadReport")(function* (
  dir: string,
  file: string,
  key: string,
  version: string,
  problems: readonly string[],
) {
  const inputs = yield* releaseInputs(dir);
  const allProblems = [...problems, ...(inputs.length ? [] : ["no distributable artifacts"])];
  yield* writeReleaseReport(file, {
    key,
    mode: "payload",
    version,
    inputs: inputs.map(({ name, sha256 }) => ({ name, sha256 })),
    ok: allProblems.length === 0,
    checks: ["exposure-scan", "payload-hashes"],
    problems: allProblems,
  });
  if (allProblems.length) return yield* new ReleaseVerificationError({ problems: allProblems });
});

export function requiredReleaseAssets(version: string): string[] {
  const names = [
    runtimeManifestAssetName(version),
    "nightly-mac.yml",
    "nightly.yml",
    "nightly-linux.yml",
    "nightly-linux-arm64.yml",
    "install.sh",
    "install.ps1",
    "install-goat-server.sh",
    "THIRD_PARTY_NOTICES.md",
    "LICENSE-T3CODE.txt",
  ];
  for (const arch of ["arm64", "x64"]) {
    for (const ext of ["dmg", "zip", "exe"]) names.push(`GOAT-${version}-${arch}.${ext}`);
    for (const ext of ["zip", "exe"]) names.push(`GOAT-${version}-${arch}.${ext}.blockmap`);
  }
  // electron-builder names Linux x64 packages by distro convention.
  names.push(`GOAT-${version}-arm64.AppImage`, `GOAT-${version}-arm64.deb`);
  names.push(`GOAT-${version}-x86_64.AppImage`, `GOAT-${version}-amd64.deb`);
  for (const key of ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]) {
    names.push(`goat-${version}-${key}.${key.startsWith("win32") ? "zip" : "tar.gz"}`);
  }
  return names.toSorted();
}
export function matchesReleaseGlob(name: string, glob: string): boolean {
  return new RegExp(
    "^" +
      glob
        .split("")
        .map((char) =>
          char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$+.[\]{}()|]/g, "\\$&"),
        )
        .join("") +
      "$",
  ).test(name);
}
export function releaseAssetKey(name: string): string | undefined {
  const cli = /^goat-.+-(darwin|linux|win32)-(arm64|x64)\.(tar\.gz|zip)$/.exec(name);
  if (cli)
    return `cli-${cli[1] === "darwin" ? "mac" : cli[1] === "win32" ? "win" : "linux"}-${cli[2]}`;
  const desktop = /^GOAT-.+-(arm64|x64|x86_64|amd64)\.(dmg|zip|exe|AppImage|deb)$/.exec(name);
  if (desktop) {
    const arch = desktop[1] === "arm64" ? "arm64" : "x64";
    const platform = ["dmg", "zip"].includes(desktop[2]!)
      ? "mac"
      : desktop[2] === "exe"
        ? "win"
        : "linux";
    return `desktop-${platform}-${arch}`;
  }
  return undefined;
}
export function releaseAssetVersion(name: string): string | undefined {
  return (/^goat-(.+)-(?:darwin|linux|win32)-(?:arm64|x64)\.(?:tar\.gz|zip)$/.exec(name) ??
    /^GOAT-(.+)-(?:arm64|x64|x86_64|amd64)\.(?:dmg|zip|exe|AppImage|deb)$/.exec(name))?.[1];
}
export function checkReleaseAssetSet(
  names: readonly string[],
  version: string,
  allowMissing: readonly string[] = [],
): string[] {
  const required = requiredReleaseAssets(version);
  const problems = required
    .filter(
      (name) =>
        !names.includes(name) && !allowMissing.some((glob) => matchesReleaseGlob(name, glob)),
    )
    .map((name) => `missing asset: ${name}`);
  for (const name of names) {
    if (required.includes(name) || name === "SHA256SUMS") continue;
    // Some Linux builders emit optional AppImage blockmaps. They must belong to an actual asset.
    if (
      name.endsWith(".AppImage.blockmap") &&
      required.includes(name.slice(0, -9)) &&
      names.includes(name.slice(0, -9))
    )
      continue;
    problems.push(`unexpected asset: ${name}`);
  }
  return problems;
}
export function checkReleaseManifest(
  manifest: UpdateManifest,
  assets: readonly ReleaseAsset[],
  version: string,
): string[] {
  const problems: string[] = [];
  if (manifest.version !== version)
    problems.push(`manifest version ${manifest.version} != ${version}`);
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.url)) problems.push(`duplicate manifest URL: ${file.url}`);
    seen.add(file.url);
    const asset = assets.find((candidate) => candidate.name === file.url);
    if (!asset) problems.push(`manifest asset missing or nonlocal URL: ${file.url}`);
    else if (file.sha512 !== asset.sha512 || file.size !== asset.size)
      problems.push(`manifest hash/size mismatch: ${file.url}`);
  }
  return problems;
}
/** A payload report must cover every distributable from its build, including both Mac containers. */
export function checkReleaseReports(
  reports: readonly ReleaseReport[],
  assets: readonly ReleaseAsset[],
  version: string,
): string[] {
  const problems: string[] = [];
  const payloads = assets.filter((asset) => isDistributable(asset.name));
  const keys = [...new Set(payloads.map((asset) => releaseAssetKey(asset.name)))];
  if (keys.includes(undefined)) problems.push("unrecognized distributable asset");
  for (const report of reports) {
    if (
      !keys.includes(report.key) ||
      report.version !== version ||
      !report.ok ||
      report.problems.length ||
      report.inputs.length === 0 ||
      !["payload", "mac"].includes(report.mode) ||
      // A mac report only counts when it was produced with --require-signing.
      (report.mode === "mac" &&
        (!report.checks.includes("require-signing") ||
          report.checks.some((check) => check.includes("unsigned/unverified")))) ||
      (report.mode === "mac" &&
        !report.key.startsWith("desktop-mac-") &&
        report.key !== "cli-mac-arm64")
    ) {
      problems.push(`invalid report: ${report.key}/${report.mode}`);
      continue;
    }
    if (new Set(report.inputs.map((input) => input.name)).size !== report.inputs.length)
      problems.push(`duplicate report inputs: ${report.key}`);
    for (const transform of report.transforms ?? []) {
      if (
        report.mode !== "payload" ||
        transform.step !== "dmg-finalize" ||
        !transform.name.endsWith(".dmg") ||
        !report.inputs.some(
          (input) => input.name === transform.name && input.sha256 === transform.from,
        ) ||
        transform.from === transform.to
      )
        problems.push(`invalid transform: ${transform.name}`);
    }
    for (const input of report.inputs) {
      const asset = payloads.find((candidate) => candidate.name === input.name);
      if (!asset || releaseAssetKey(input.name) !== report.key) {
        problems.push(`unrelated report input: ${input.name}`);
        continue;
      }
      const transforms = (report.transforms ?? []).filter(
        (transform) => transform.name === input.name,
      );
      if (transforms.length > 1) problems.push(`multiple transforms: ${input.name}`);
      if (
        report.mode === "payload" &&
        report.key.startsWith("desktop-mac-") &&
        input.name.endsWith(".dmg") &&
        transforms.length !== 1
      )
        problems.push(`missing DMG finalization transform: ${input.name}`);
      if (input.sha256 === asset.sha256) {
        if (transforms.length) problems.push(`unnecessary transform: ${input.name}`);
        continue;
      }
      const transform = transforms[0];
      const macCovers = reports.some(
        (mac) =>
          mac.mode === "mac" &&
          mac.key === report.key &&
          mac.version === version &&
          mac.ok &&
          mac.problems.length === 0 &&
          mac.inputs.some((entry) => entry.name === input.name && entry.sha256 === asset.sha256),
      );
      if (
        report.mode !== "payload" ||
        !input.name.endsWith(".dmg") ||
        transforms.length !== 1 ||
        transform?.from !== input.sha256 ||
        transform.to !== asset.sha256 ||
        !macCovers
      )
        problems.push(`report hash mismatch: ${input.name}`);
    }
  }
  for (const key of keys) {
    if (!key) continue;
    for (const mode of key.startsWith("desktop-mac-") ? ["payload", "mac"] : ["payload"]) {
      const matching = reports.filter((report) => report.key === key && report.mode === mode);
      if (matching.length !== 1) {
        problems.push(`expected one ${mode} report: ${key}`);
        continue;
      }
      for (const asset of payloads.filter((asset) => releaseAssetKey(asset.name) === key)) {
        if (!matching[0]!.inputs.some((input) => input.name === asset.name))
          problems.push(`report omits ${asset.name}: ${key}/${mode}`);
      }
    }
  }
  return problems;
}
export function renderSha256Sums(assets: readonly Pick<ReleaseAsset, "name" | "sha256">[]): string {
  return assets
    .filter((asset) => asset.name !== "SHA256SUMS")
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join("");
}
export const assembleRelease = Effect.fn("assembleRelease")(function* (
  dir: string,
  reportsDir: string,
  version: string,
  allowMissing: readonly string[] = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = (yield* fs.readDirectory(dir)).toSorted();
  const problems = checkReleaseAssetSet(names, version, allowMissing);
  const assets: ReleaseAsset[] = [];
  for (const name of names.filter((name) => name !== "SHA256SUMS")) {
    if ((yield* fs.stat(path.join(dir, name))).type !== "File") {
      problems.push(`not an asset file: ${name}`);
      continue;
    }
    assets.push(yield* readReleaseAsset(dir, name));
  }
  const runtimeName = runtimeManifestAssetName(version);
  if (names.includes(runtimeName)) {
    problems.push(
      ...checkReleaseRuntimeManifest(
        yield* fs.readFileString(path.join(dir, runtimeName)),
        version,
        new Map(assets.map(({ name, sha256 }) => [name, sha256])),
      ),
    );
  }
  for (const name of names.filter((name) => name.endsWith(".yml"))) {
    // Read before parsing so parser errors become a failed report instead of a defect.
    const source = yield* fs.readFileString(path.join(dir, name));
    const parsed = yield* Effect.try({
      try: () => parseUpdateManifest(source, name, "release"),
      catch: (error) => new ReleaseVerificationError({ problems: [`${name}: ${String(error)}`] }),
    }).pipe(Effect.result);
    if (parsed._tag === "Failure") problems.push(parsed.failure.message);
    else {
      problems.push(
        ...checkReleaseManifest(parsed.success, assets, version).map(
          (problem) => `${name}: ${problem}`,
        ),
      );
      // Electron-updater must retain every updateable container for each architecture.
      const expected = assets.filter((asset) =>
        name === "nightly-mac.yml"
          ? /^GOAT-.*\.(?:zip|dmg)$/.test(asset.name)
          : name === "nightly.yml"
            ? /^GOAT-.*\.exe$/.test(asset.name)
            : name === "nightly-linux-arm64.yml"
              ? /^GOAT-.*-arm64\.AppImage$/.test(asset.name)
              : name === "nightly-linux.yml"
                ? /^GOAT-.*-x86_64\.AppImage$/.test(asset.name)
                : false,
      );
      for (const asset of expected)
        if (!parsed.success.files.some((file) => file.url === asset.name))
          problems.push(`${name}: missing manifest entry ${asset.name}`);
    }
  }
  const reports: ReleaseReport[] = [];
  for (const entry of yield* walkReleaseTree(reportsDir)) {
    if (entry.type !== "file" || !entry.absolute.endsWith(".json")) continue;
    const decoded = yield* decodeReleaseReport(yield* fs.readFileString(entry.absolute)).pipe(
      Effect.result,
    );
    if (decoded._tag === "Failure") problems.push(`${entry.relative}: invalid report JSON`);
    else reports.push(decoded.success);
  }
  problems.push(...checkReleaseReports(reports, assets, version));
  if (problems.length) return yield* new ReleaseVerificationError({ problems });
  const sums = renderSha256Sums(assets);
  yield* fs.writeFileString(path.join(dir, "SHA256SUMS"), sums);
  if ((yield* fs.readFileString(path.join(dir, "SHA256SUMS"))) !== sums)
    return yield* new ReleaseVerificationError({ problems: ["SHA256SUMS read-back mismatch"] });
  return {
    key: "assemble",
    mode: "assemble" as const,
    version,
    inputs: assets
      .filter((asset) => isDistributable(asset.name))
      .map(({ name, sha256 }) => ({ name, sha256 })),
    ok: true,
    checks: ["asset-set", "manifests", "reports", "SHA256SUMS"],
    problems: [],
  };
});
