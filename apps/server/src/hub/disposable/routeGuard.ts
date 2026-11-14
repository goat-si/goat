// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous fingerprint of a public key.
import * as NodeCrypto from "node:crypto";

import type { DisposableRecord } from "./disposableClass.ts";

/** What a kept-machine path is about to route to: an alias, the environment it reached, the key it offered. */
export interface RouteClaim {
  readonly alias?: string;
  readonly environmentId?: string | null;
  readonly hostKeyFingerprint?: string;
}

export interface DisposableClaim {
  readonly attachId: string;
  readonly nodeId: string;
  readonly by: "alias" | "environment" | "host_key";
  /** Pen's pen-<name> names several members, and this disposable machine is one of them. */
  readonly shared?: true;
}

/** What Pen's own known_hosts ties each alias to: the members' node ids and ED25519 key fingerprints. */
export type PenAliases = ReadonlyMap<
  string,
  { readonly nodeIds: ReadonlySet<string>; readonly fingerprints: ReadonlySet<string> }
>;

/** An alias as ssh compares it: case-insensitive, and a trailing dot names the same host. */
const normalAlias = (alias: string) => alias.trim().toLowerCase().replace(/\.$/u, "");

const ed25519Fingerprint = (key: string) =>
  "SHA256:" +
  NodeCrypto.createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("base64")
    .replace(/=+$/u, "");

/**
 * Reads Pen's known_hosts, where Pen writes one "pen-<name>,pen-<nodeId> <type> <key>" line per member
 * key (apps/pen daemon writeKnownHosts). A twin name (several members) maps to every member it names.
 */
export const penAliases = (knownHosts: string): PenAliases => {
  const aliases = new Map<string, { nodeIds: Set<string>; fingerprints: Set<string> }>();
  for (const line of knownHosts.split(/\r?\n/u)) {
    const [hosts = "", type, key] = line.trim().split(/\s+/u);
    const names = hosts.split(",").map(normalAlias);
    const node = names[1]?.startsWith("pen-") === true ? names[1].slice(4) : undefined;
    if (node === undefined || names.length !== 2 || type === undefined || key === undefined)
      continue;
    for (const name of names) {
      const entry = aliases.get(name) ?? {
        nodeIds: new Set<string>(),
        fingerprints: new Set<string>(),
      };
      entry.nodeIds.add(node);
      if (type === "ssh-ed25519") entry.fingerprints.add(ed25519Fingerprint(key));
      aliases.set(name, entry);
    }
  }
  return aliases;
};

/**
 * Design section 6, Disposable: Pen only. A path that adds or moves a route refuses when its alias,
 * the environment it reached or the sshd key it was offered belongs to an open disposable record.
 * Only records refuse: an empty or unreadable table reads as kept (design section 1, Fail safe).
 */
export const claimedBy = (
  records: ReadonlyArray<DisposableRecord>,
  claim: RouteClaim,
  pen: PenAliases = new Map(),
): DisposableClaim | undefined => {
  const alias = claim.alias === undefined ? undefined : normalAlias(claim.alias);
  // Pen's own pen-<name> alias: the members it names, read offline from Pen's file.
  const members = alias === undefined ? undefined : pen.get(alias);
  for (const record of records) {
    if (record.final) continue;
    const found = (by: DisposableClaim["by"], shared = false) => ({
      attachId: record.attachId,
      nodeId: record.nodeId,
      by,
      ...(shared ? { shared: true as const } : {}),
    });
    const node = record.nodeId.toLowerCase();
    if (alias === "pen-" + node) return found("alias");
    if (
      members?.nodeIds.has(node) === true ||
      (record.sshdPin !== null && members?.fingerprints.has(record.sshdPin) === true)
    )
      return found("alias", (members?.nodeIds.size ?? 0) > 1);
    if (
      claim.environmentId !== undefined &&
      claim.environmentId !== null &&
      claim.environmentId === record.environmentId
    )
      return found("environment");
    if (claim.hostKeyFingerprint !== undefined && claim.hostKeyFingerprint === record.sshdPin)
      return found("host_key");
  }
  return undefined;
};

const BY: Record<DisposableClaim["by"], string> = {
  alias: "its Pen alias",
  environment: "the GOAT environment it reached",
  host_key: "the SSH host key it offered",
};

/** The refusal every guarded path gives, naming the record and the way out. */
export const refusalText = (claim: DisposableClaim | undefined, target: string) =>
  claim === undefined
    ? ""
    : claim.shared === true
      ? target +
        " names more than one Pen member, and one of them is the disposable machine pen-" +
        claim.nodeId +
        " (attach " +
        claim.attachId +
        "), which GOAT reaches only through its own Pen route. Reach the other member by an alias of your own (a Host block without the Pen name), or rename one of them in Pen."
      : target +
        " is a disposable machine (attach " +
        claim.attachId +
        ", matched by " +
        BY[claim.by] +
        "): GOAT reaches it only through its own Pen route, so no other route or link may name it. Detach it in Settings → Hub on web or desktop first; once its record has ended, it can be added as a kept machine.";
