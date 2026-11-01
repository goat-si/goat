#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - streams tar archives through the host tar binary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import {
  makeGitHubReleasesClient,
  type GitHubRelease,
  type GitHubReleaseAsset,
  type GitHubReleasesClient,
} from "./lib/github-releases.ts";

// goat-nightly hands build outputs between jobs through draft releases in goat-si/goat
// instead of Actions artifacts: release assets do not count toward the Actions and
// Packages storage quota. Each hand-off is its own draft, tagged
// goat-nightly-staging-<run id>--<name>, so parallel jobs never upload into the same
// release. A hand-off is one tar stream split into parts below GitHub's 2 GiB
// per-asset limit, plus a manifest uploaded last that records every part's size and
// SHA-256. A consumer only trusts a hand-off whose manifest exists and whose parts
// match it.

export class NightlyStagingError extends Schema.TaggedError<NightlyStagingError>()(
  "NightlyStagingError",
  { message: Schema.String },
) {}

export const STAGING_TAG_PREFIX = "goat-nightly-staging-";
/** GitHub refuses release assets of 2 GiB or more. */
export const MAX_ASSET_BYTES = 2 * 1024 ** 3 - 1;
/** Each part is buffered in memory once on upload and once on download. */
export const DEFAULT_PART_BYTES = 256 * 1024 ** 2;
const MANIFEST_SUFFIX = ".manifest.json";

export const StagingManifest = Schema.Struct({
  name: Schema.String,
  size: Schema.Int,
  parts: Schema.Array(
    Schema.Struct({ asset: Schema.String, size: Schema.Int, sha256: Schema.String }),
  ),
});
export type StagingManifest = typeof StagingManifest.Type;
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(StagingManifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(StagingManifest));

const fail = (message: string) => Effect.fail(new NightlyStagingError({ message }));

/** A run's staging tag, goat-nightly-staging-<run id>. */
export function isStagingTag(tag: string) {
  return /^goat-nightly-staging-\d+$/.test(tag);
}

export function handoffTag(tag: string, name: string) {
  return `${tag}--${name}`;
}

/** The run tag and hand-off name of a hand-off draft's tag. */
export function parseHandoffTag(tag: string) {
  const match = /^(goat-nightly-staging-\d+)--([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(tag);
  return match ? { run: match[1]!, name: match[2]! } : undefined;
}

export function partAssetName(name: string, index: number) {
  return `${name}.tar.${String(index).padStart(3, "0")}`;
}

/** The hand-off a staging asset belongs to: "cli-linux-x64.tar.001" -> "cli-linux-x64". */
export function handoffOfAsset(asset: string) {
  if (asset.endsWith(MANIFEST_SUFFIX)) return asset.slice(0, -MANIFEST_SUFFIX.length);
  return /^(.+)\.tar\.\d{3}$/.exec(asset)?.[1];
}

/** Shell-style glob with only "*"; anchored at both ends. */
export function globMatcher(glob: string) {
  const source = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const pattern = new RegExp(`^${source}$`);
  return (value: string) => pattern.test(value);
}

export function splitList(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
const validPath = (path: string) =>
  path.length > 0 &&
  !path.startsWith("-") &&
  !NodePath.isAbsolute(path) &&
  !path.split(/[\\/]/).includes("..");

/** The draft with this tag; the lowest id wins if a retry ever created two. */
export function findStagingRelease(releases: ReadonlyArray<GitHubRelease>, tag: string) {
  return releases
    .filter((release) => release.draft && release.tag_name === tag)
    .toSorted((left, right) => left.id - right.id)[0];
}

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

let tarFlavor: "bsd" | "gnu" | undefined;
/** bsdtar (macOS, Windows System32) and GNU tar (Linux, Git Bash) take different flags. */
function tarFlags(platform: NodeJS.Platform) {
  tarFlavor ??= /bsdtar/.test(
    NodeChildProcess.spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "",
  )
    ? "bsd"
    : "gnu";
  if (tarFlavor === "bsd") return platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : [];
  return platform === "win32" ? ["--force-local"] : [];
}

/**
 * Runs tar with relative paths only, so GNU tar on Windows never reads a drive
 * letter as a remote host. COPYFILE_DISABLE and the bsdtar flags keep macOS
 * AppleDouble files and extended attributes out of the archive.
 */
const runTar = (
  args: ReadonlyArray<string>,
  cwd: string,
  io: { stdin?: string; stdout?: string },
) =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    runTarWith([...tarFlags(platform), ...args], cwd, io),
  );

const runTarWith = (
  args: ReadonlyArray<string>,
  cwd: string,
  io: { stdin?: string; stdout?: string },
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const input = io.stdin === undefined ? "ignore" : NodeFS.openSync(io.stdin, "r");
        const output = io.stdout === undefined ? "inherit" : NodeFS.openSync(io.stdout, "w");
        const child = NodeChildProcess.spawn("tar", args, {
          cwd,
          env: { ...process.env, COPYFILE_DISABLE: "1" },
          stdio: [input, output, "inherit"],
        });
        const close = () => {
          if (typeof input === "number") NodeFS.closeSync(input);
          if (typeof output === "number") NodeFS.closeSync(output);
        };
        child.on("error", (error) => {
          close();
          reject(error);
        });
        child.on("close", (code) => {
          close();
          if (code === 0) resolve();
          else reject(new Error(`tar exited with ${code}`));
        });
      }),
    catch: (error) => new NightlyStagingError({ message: `tar failed: ${String(error)}` }),
  });

/**
 * Extracts a tar stream fed part by part, so a consumer needs disk for the files
 * only and never for a second, concatenated copy of the archive.
 */
const tarExtractor = (cwd: string) =>
  Effect.acquireRelease(
    Effect.flatMap(HostProcess.Platform, (platform) =>
      Effect.sync(() => {
        NodeFS.mkdirSync(cwd, { recursive: true });
        const child = NodeChildProcess.spawn("tar", [...tarFlags(platform), "-xf", "-"], {
          cwd,
          env: { ...process.env, COPYFILE_DISABLE: "1" },
          stdio: ["pipe", "inherit", "inherit"],
        });
        const done = new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)),
          );
        });
        done.catch(() => undefined);
        return { child, done };
      }),
    ),
    ({ child }) =>
      Effect.sync(() => {
        if (child.exitCode === null) child.kill();
      }),
  ).pipe(
    Effect.map(({ child, done }) => ({
      write: (bytes: Uint8Array) =>
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) =>
              child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())),
            ),
          catch: (error) => new NightlyStagingError({ message: `tar failed: ${String(error)}` }),
        }),
      finish: Effect.tryPromise({
        try: () => {
          child.stdin.end();
          return done;
        },
        catch: (error) => new NightlyStagingError({ message: `tar failed: ${String(error)}` }),
      }),
    })),
  );

const readRange = (file: string, offset: number, length: number) =>
  Effect.try({
    try: () => {
      const bytes = Buffer.alloc(length);
      const fd = NodeFS.openSync(file, "r");
      try {
        let read = 0;
        while (read < length) {
          const count = NodeFS.readSync(fd, bytes, read, length - read, offset + read);
          if (count === 0) throw new Error("unexpected end of archive");
          read += count;
        }
      } finally {
        NodeFS.closeSync(fd);
      }
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
    catch: (error) => new NightlyStagingError({ message: `Cannot read archive: ${String(error)}` }),
  });

const temporaryFile = (label: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(
        NodePath.join(process.env.RUNNER_TEMP ?? NodeOS.tmpdir(), `goat-staging-`),
      );
      return { dir, file: NodePath.join(dir, label) };
    }),
    ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

/** Uploads one asset, replacing a leftover of the same name from an interrupted attempt. */
const uploadVerified = Effect.fn("uploadVerified")(function* (
  client: GitHubReleasesClient,
  releaseId: number,
  name: string,
  bytes: Uint8Array,
) {
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return yield* fail(
      `${name} is ${bytes.byteLength} bytes, above the 2 GiB release asset limit.`,
    );
  }
  for (let attempt = 1; ; attempt++) {
    for (const asset of yield* client.listAssets(releaseId)) {
      if (asset.name === name) yield* client.deleteAsset(asset.id);
    }
    const uploaded = yield* client.uploadAsset(releaseId, name, bytes).pipe(Effect.option);
    if (uploaded._tag === "Some") {
      if (uploaded.value.size !== bytes.byteLength) {
        return yield* fail(
          `GitHub stored ${uploaded.value.size} bytes for ${name}, expected ${bytes.byteLength}.`,
        );
      }
      return uploaded.value;
    }
    if (attempt >= 3) return yield* fail(`Failed to upload ${name} after ${attempt} attempts.`);
    yield* Console.log(`Upload of ${name} failed; retrying.`);
  }
});

export interface PutOptions {
  readonly tag: string;
  readonly target: string;
  readonly name: string;
  readonly dir: string;
  readonly paths: ReadonlyArray<string>;
  readonly partBytes?: number;
}

export const putHandoff = Effect.fn("putHandoff")(function* (
  client: GitHubReleasesClient,
  options: PutOptions,
) {
  const partBytes = options.partBytes ?? DEFAULT_PART_BYTES;
  if (!isStagingTag(options.tag)) return yield* fail(`${options.tag} is not a staging tag.`);
  if (!validName(options.name)) return yield* fail(`Invalid hand-off name ${options.name}.`);
  if (partBytes <= 0 || partBytes > MAX_ASSET_BYTES) return yield* fail("Invalid part size.");
  const paths = options.paths.length === 0 ? ["."] : options.paths;
  for (const path of paths) {
    if (!validPath(path)) return yield* fail(`Hand-off paths must be relative: ${path}`);
    const full = NodePath.join(options.dir, path);
    const empty =
      !NodeFS.existsSync(full) ||
      (NodeFS.statSync(full).isDirectory() && NodeFS.readdirSync(full).length === 0);
    if (empty) return yield* fail(`${full} is missing or empty; nothing to hand off.`);
  }

  const draftTag = handoffTag(options.tag, options.name);
  let release = findStagingRelease(yield* client.listReleases(), draftTag);
  if (release === undefined) {
    release = yield* client.createStagingDraft(draftTag, options.target);
    yield* Console.log(`Created staging draft ${draftTag} (${release.id}).`);
  }
  const releaseId = release.id;

  // A re-run replaces the whole hand-off. Remove the manifest first so a consumer
  // never trusts a half-replaced one.
  const stale = yield* client.listAssets(releaseId);
  for (const asset of stale.toSorted(
    (a, b) => Number(b.name.endsWith(MANIFEST_SUFFIX)) - Number(a.name.endsWith(MANIFEST_SUFFIX)),
  )) {
    yield* client.deleteAsset(asset.id);
  }

  const { file } = yield* temporaryFile(`${options.name}.tar`);
  yield* runTar(["-cf", "-", ...paths], options.dir, { stdout: file });
  const size = NodeFS.statSync(file).size;
  const parts: Array<{ asset: string; size: number; sha256: string }> = [];
  for (let offset = 0, index = 0; offset < size || index === 0; offset += partBytes, index++) {
    const bytes = yield* readRange(file, offset, Math.min(partBytes, size - offset));
    const asset = partAssetName(options.name, index);
    yield* uploadVerified(client, releaseId, asset, bytes);
    parts.push({ asset, size: bytes.byteLength, sha256: sha256(bytes) });
    yield* Console.log(`Staged ${asset} (${bytes.byteLength} bytes).`);
  }
  const manifest: StagingManifest = { name: options.name, size, parts };
  const manifestText = yield* encodeManifest(manifest).pipe(
    Effect.mapError(() => new NightlyStagingError({ message: "Cannot encode manifest." })),
  );
  const manifestBytes = new TextEncoder().encode(manifestText);
  const manifestName = `${options.name}${MANIFEST_SUFFIX}`;
  yield* uploadVerified(client, releaseId, manifestName, manifestBytes);

  // Read back what GitHub stored, so a lost upload fails this job and not a consumer.
  const stored = new Map((yield* client.listAssets(releaseId)).map((asset) => [asset.name, asset]));
  for (const expected of [...parts, { asset: manifestName, size: manifestBytes.byteLength }]) {
    const asset = stored.get(expected.asset);
    if (asset?.state !== "uploaded" || asset.size !== expected.size) {
      return yield* fail(
        `${expected.asset} is not stored in ${draftTag} after upload (${asset?.state ?? "absent"}).`,
      );
    }
  }
  return manifest;
}, Effect.scoped);

export interface GetOptions {
  readonly tag: string;
  readonly names: ReadonlyArray<string>;
  readonly dir: string;
  /** Delay before listing a hand-off's assets again when a part is not there yet. */
  readonly retryDelayMs?: number;
}

/** This run's hand-off drafts by name; the lowest id wins for a duplicated tag. */
function handoffDrafts(releases: ReadonlyArray<GitHubRelease>, tag: string) {
  const drafts = new Map<string, GitHubRelease>();
  for (const release of releases.toSorted((left, right) => right.id - left.id)) {
    const parsed = parseHandoffTag(release.tag_name);
    if (release.draft && parsed?.run === tag) drafts.set(parsed.name, release);
  }
  return drafts;
}

/** The manifest and parts of one hand-off, or why it is incomplete. */
const readHandoff = Effect.fn("readHandoff")(function* (
  client: GitHubReleasesClient,
  release: GitHubRelease,
  name: string,
) {
  const assets = yield* client.listAssets(release.id);
  const byName = new Map<string, GitHubReleaseAsset>(assets.map((asset) => [asset.name, asset]));
  const manifestAsset = byName.get(`${name}${MANIFEST_SUFFIX}`);
  if (manifestAsset?.state !== "uploaded") {
    return { problem: `${name} has no complete manifest (${manifestAsset?.state ?? "absent"}).` };
  }
  const manifest = yield* decodeManifest(
    new TextDecoder().decode(yield* client.downloadAsset(manifestAsset.id)),
  ).pipe(
    Effect.mapError(() => new NightlyStagingError({ message: `Malformed manifest for ${name}.` })),
  );
  if (manifest.name !== name) return yield* fail(`Manifest ${name} names ${manifest.name}.`);
  const parts: Array<{ asset: GitHubReleaseAsset; size: number; sha256: string }> = [];
  for (const part of manifest.parts) {
    if (handoffOfAsset(part.asset) !== name) {
      return yield* fail(`Manifest ${name} lists a foreign part ${part.asset}.`);
    }
    const asset = byName.get(part.asset);
    if (asset?.state !== "uploaded") {
      const present = assets.map((item) => `${item.name}=${item.state ?? "?"}`).join(", ");
      return {
        problem: `${name} is missing part ${part.asset} (${asset?.state ?? "absent"}; release holds ${present}).`,
      };
    }
    parts.push({ asset, size: part.size, sha256: part.sha256 });
  }
  return { manifest, parts };
});

export const getHandoffs = Effect.fn("getHandoffs")(function* (
  client: GitHubReleasesClient,
  options: GetOptions,
) {
  const drafts = handoffDrafts(yield* client.listReleases(), options.tag);
  const handoffs = [...drafts.keys()].toSorted();
  const selected = new Set<string>();
  for (const glob of options.names) {
    const matches = handoffs.filter(globMatcher(glob));
    if (matches.length === 0) return yield* fail(`No hand-off matches ${glob} in ${options.tag}.`);
    for (const match of matches) selected.add(match);
  }
  NodeFS.mkdirSync(options.dir, { recursive: true });
  const fetched: string[] = [];
  for (const name of [...selected].toSorted()) {
    let read = yield* readHandoff(client, drafts.get(name)!, name);
    for (let attempt = 1; "problem" in read && attempt < 4; attempt++) {
      yield* Console.log(`${read.problem} Listing again (${attempt}/3).`);
      yield* Effect.sleep(options.retryDelayMs ?? 5_000);
      read = yield* readHandoff(client, drafts.get(name)!, name);
    }
    if ("problem" in read) return yield* fail(read.problem);
    const expected = read.parts.reduce((sum, part) => sum + part.size, 0);
    if (expected !== read.manifest.size)
      return yield* fail(
        `${name} parts add up to ${expected} bytes, manifest says ${read.manifest.size}.`,
      );
    // Each part is verified before tar sees any of its bytes.
    const extractor = yield* tarExtractor(options.dir);
    let total = 0;
    for (const part of read.parts) {
      const bytes = yield* client.downloadAsset(part.asset.id);
      if (bytes.byteLength !== part.size || sha256(bytes) !== part.sha256) {
        return yield* fail(`${part.asset.name} does not match its manifest size and SHA-256.`);
      }
      yield* extractor.write(bytes);
      total += bytes.byteLength;
    }
    yield* extractor.finish;
    yield* Console.log(`Restored ${name} (${total} bytes) into ${options.dir}.`);
    fetched.push(name);
  }
  return fetched;
}, Effect.scoped);

export interface CleanupOptions {
  readonly tag: string;
  readonly keep: ReadonlyArray<string>;
  readonly maxAgeHours: number;
}

/**
 * Deletes this run's hand-off drafts, except the hand-offs keep names, and any other
 * staging draft older than maxAgeHours (a run whose cleanup never ran).
 */
export const cleanupStaging = Effect.fn("cleanupStaging")(function* (
  client: GitHubReleasesClient,
  options: CleanupOptions,
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const cutoff = now - options.maxAgeHours * 3_600_000;
  const keep = options.keep.map(globMatcher);
  for (const release of yield* client.listReleases()) {
    if (!release.draft) continue;
    const parsed = parseHandoffTag(release.tag_name);
    const run = parsed?.run ?? (isStagingTag(release.tag_name) ? release.tag_name : undefined);
    if (run === undefined) continue;
    if (run === options.tag) {
      if (parsed !== undefined && keep.some((matches) => matches(parsed.name))) {
        yield* Console.log(`Kept ${release.tag_name} for inspection.`);
        continue;
      }
      yield* Console.log(`Deleting staging draft ${release.tag_name} (${release.id}).`);
      yield* client.deleteRelease(release.id);
      continue;
    }
    const created = release.created_at === undefined ? Number.NaN : Date.parse(release.created_at);
    if (Number.isFinite(created) && created <= cutoff) {
      yield* Console.log(`Deleting stale staging draft ${release.tag_name} (${release.id}).`);
      yield* client.deleteRelease(release.id);
    }
  }
});

const repo = Flag.String("repo");
const tag = Flag.String("tag");
const put = Command.make(
  "put",
  {
    repo,
    tag,
    target: Flag.String("target"),
    name: Flag.String("name"),
    dir: Flag.String("dir"),
    paths: Flag.String("paths").pipe(Flag.withDefault(".")),
  },
  (options) =>
    Effect.gen(function* () {
      const client = yield* makeGitHubReleasesClient(options.repo);
      yield* putHandoff(client, { ...options, paths: splitList(options.paths) });
    }),
);
const get = Command.make(
  "get",
  { repo, tag, names: Flag.String("names"), dir: Flag.String("dir") },
  (options) =>
    Effect.gen(function* () {
      const client = yield* makeGitHubReleasesClient(options.repo);
      yield* getHandoffs(client, { ...options, names: splitList(options.names) });
    }),
);
const NonnegativeInteger = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const cleanup = Command.make(
  "cleanup",
  {
    repo,
    tag,
    keep: Flag.String("keep").pipe(Flag.withDefault("")),
    maxAgeHours: Flag.String("max-age-hours").pipe(
      Flag.withSchema(NonnegativeInteger),
      Flag.withDefault(72),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const client = yield* makeGitHubReleasesClient(options.repo);
      yield* cleanupStaging(client, { ...options, keep: splitList(options.keep) });
    }),
);
const command = Command.make("nightly-staging").pipe(Command.withSubcommands([put, get, cleanup]));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
