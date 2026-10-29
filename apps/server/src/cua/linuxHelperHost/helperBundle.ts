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
  [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

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

/** Owners whose files the server may run: root and the server's own user. */
const trustedOwner = (uid: bigint) => uid === 0n || uid === BigInt(process.getuid?.() ?? -1);

/**
 * Why a path may not hold the helper. A folder others can write may still hold it when it is
 * sticky (as /tmp is): only an entry's owner can then rename or replace it.
 */
function untrusted(stat: NodeFS.BigIntStats, sticky: boolean) {
  if (stat.isSymbolicLink()) return "is a symbolic link";
  if (!stat.isFile() && !stat.isDirectory()) return "is not a regular file";
  if (!trustedOwner(stat.uid)) return "belongs to another user";
  // Group write counts too: the group may have other members, and a POSIX ACL that lets
  // anyone else write shows in the group bits as its mask.
  const shared = (Number(stat.mode) & 0o022) !== 0;
  if (shared && !(sticky && stat.isDirectory() && (Number(stat.mode) & 0o1000) !== 0))
    return "can be changed by other users (chmod g-w,o-w it)";
  return undefined;
}

/**
 * Every path under the bundle, and every folder above it up to /, with its identity, or why the
 * bundle cannot be trusted: a folder above it that someone else could rename would let them swap
 * the whole bundle after the check.
 */
async function walk(directory: string): Promise<Walk | string> {
  const identities = new Map<string, string>();
  const files: string[] = [];
  for (let above = NodePath.dirname(directory); ; above = NodePath.dirname(above)) {
    const stat = await NodeFSP.lstat(above, { bigint: true });
    const refused = untrusted(stat, true);
    if (refused !== undefined) return above + " " + refused + ".";
    // Its entries come and go (/tmp); a swap through it changes the next folder's inode instead.
    identities.set(above, [stat.dev, stat.ino, stat.mode, stat.uid].join(":"));
    if (NodePath.dirname(above) === above) break;
  }
  const visit = async (path: string): Promise<string | undefined> => {
    const stat = await NodeFSP.lstat(path, { bigint: true });
    const name = NodePath.relative(directory, path);
    const refused = untrusted(stat, false);
    if (refused !== undefined) return (name || "Its folder") + " " + refused + ".";
    identities.set(path, identity(stat));
    if (stat.isFile()) {
      files.push(name);
      return undefined;
    }
    for (const entry of (await NodeFSP.readdir(path)).toSorted()) {
      const below = await visit(NodePath.join(path, entry));
      if (below !== undefined) return below;
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
    // A path that changed while it was hashed may not be what was hashed; nothing is kept, so
    // the next check starts over.
    const after = await walk(directory);
    if (typeof after === "string") return after;
    if (!same(walked.identities, after.identities)) return "it changed while it was checked.";
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
