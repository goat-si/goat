// @effect-diagnostics nodeBuiltinImport:off -- Hashes the packaged helper's files before the host runs them.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Checks a packaged Linux helper before each spawn: every file matches manifest.json, nothing is
 * unlisted, nothing is a symlink or writable by other users (so no one else swaps a file before
 * the spawn), and, once a release key is set, manifest.json.sig is its signature of the manifest.
 */

/**
 * Ed25519 public keys (SPKI PEM) that sign released Linux helper manifests. None is provisioned
 * yet, so a bundle is held to its manifest's hashes only (docs/operations/release.md).
 */
const LINUX_HELPER_SIGNING_KEYS: ReadonlyArray<string> = [];

export const MANIFEST = "manifest.json";
export const SIGNATURE = "manifest.json.sig";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024;

const Manifest = Schema.Struct({
  name: Schema.Literal("goat-computer-use"),
  platform: Schema.Literal("linux"),
  files: Schema.Record(Schema.String, Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));

/** Paths in the bundle, each with what identifies its content without reading it. */
type Identities = ReadonlyMap<string, string>;
interface Walk {
  readonly identities: Identities;
  /** Regular files, relative to the bundle. */
  readonly files: ReadonlyArray<string>;
}

const identity = (stat: NodeFS.BigIntStats) =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

const sha256 = async (path: string) => {
  const hash = NodeCrypto.createHash("sha256");
  await NodeStreamPromises.pipeline(NodeFS.createReadStream(path), hash);
  return hash.digest("hex");
};

async function readBounded(path: string, max: number) {
  const handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(bytes, 0, max + 1, 0);
    return bytesRead > max ? undefined : bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Every path under the bundle with its identity, or why the bundle cannot be trusted. */
async function walk(directory: string): Promise<Walk | string> {
  const identities = new Map<string, string>();
  const files: string[] = [];
  const visit = async (path: string): Promise<string | undefined> => {
    const stat = await NodeFSP.lstat(path, { bigint: true });
    const name = NodePath.relative(directory, path);
    if (stat.isSymbolicLink()) return name + " is a symbolic link.";
    if (!stat.isFile() && !stat.isDirectory()) return name + " is not a regular file.";
    if ((Number(stat.mode) & 0o022) !== 0)
      return (name || "Its folder") + " can be changed by other users.";
    identities.set(path, identity(stat));
    if (stat.isFile()) {
      files.push(name);
      return undefined;
    }
    for (const entry of (await NodeFSP.readdir(path)).toSorted()) {
      const refused = await visit(NodePath.join(path, entry));
      if (refused !== undefined) return refused;
    }
    return undefined;
  };
  return (await visit(directory)) ?? { identities, files };
}

const signedBy = (manifest: Buffer, signature: Buffer, keys: ReadonlyArray<string>) =>
  keys.some((key) => {
    try {
      return NodeCrypto.verify(null, manifest, NodeCrypto.createPublicKey(key), signature);
    } catch {
      return false;
    }
  });

/** Why a bundle may not run, or undefined once every check passed for what walked found. */
async function verify(
  directory: string,
  entry: string,
  walked: Walk,
  keys: ReadonlyArray<string>,
): Promise<string | undefined> {
  const bytes = walked.files.includes(MANIFEST)
    ? await readBounded(NodePath.join(directory, MANIFEST), MAX_MANIFEST_BYTES)
    : undefined;
  const manifest = bytes === undefined ? Option.none() : decodeManifest(bytes.toString("utf8"));
  if (bytes === undefined || Option.isNone(manifest))
    return MANIFEST + " is missing or is not a Linux helper manifest.";
  if (keys.length > 0) {
    const signature = walked.files.includes(SIGNATURE)
      ? await readBounded(NodePath.join(directory, SIGNATURE), MAX_SIGNATURE_BYTES)
      : undefined;
    if (signature === undefined) return "it is not signed by GOAT (" + SIGNATURE + ").";
    if (!signedBy(bytes, Buffer.from(signature.toString("utf8").trim(), "base64"), keys))
      return MANIFEST + " is not signed by GOAT's release key.";
  }
  const listed = manifest.value.files;
  const named = NodePath.relative(directory, entry);
  if (!Object.hasOwn(listed, named)) return named + " is not in " + MANIFEST + ".";
  for (const file of walked.files)
    if (file !== MANIFEST && file !== SIGNATURE && !Object.hasOwn(listed, file))
      return file + " is not in " + MANIFEST + ".";
  for (const [file, expected] of Object.entries(listed)) {
    // A name outside the bundle, or one that is a folder, is not a file the bundle holds.
    if (!walked.files.includes(file)) return file + " is missing.";
    if ((await sha256(NodePath.join(directory, file))) !== expected)
      return file + " does not match " + MANIFEST + ".";
  }
  return undefined;
}

/**
 * The check the host runs before each spawn of the helper at entry: undefined when it may run,
 * else why not, in words for the person setting it up. A result stands while no path in the
 * bundle changes; a file changed while it was hashed changes its identity, so the next check
 * hashes again.
 */
export function makeHelperBundleCheck(
  entry: string,
  keys: ReadonlyArray<string> = LINUX_HELPER_SIGNING_KEYS,
): () => Promise<string | undefined> {
  const file = NodePath.resolve(entry);
  const directory = NodePath.dirname(file);
  let last: { readonly identities: Identities; readonly refused: string | undefined } | undefined;
  const same = (a: Identities, b: Identities) =>
    a.size === b.size && [...a].every(([path, id]) => b.get(path) === id);
  const check = async () => {
    const walked = await walk(directory);
    if (typeof walked === "string") return walked;
    if (last !== undefined && same(last.identities, walked.identities)) return last.refused;
    const refused = await verify(directory, file, walked, keys);
    last = { identities: walked.identities, refused };
    return refused;
  };
  return () =>
    check().then(
      (refused) =>
        refused === undefined
          ? undefined
          : "GOAT's Linux computer use helper was not started: " + refused + " Reinstall it.",
      (error: unknown) =>
        "GOAT's Linux computer use helper was not started: it could not be read (" +
        String(error) +
        ").",
    );
}
