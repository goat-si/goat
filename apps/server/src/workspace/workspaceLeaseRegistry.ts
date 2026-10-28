// @effect-diagnostics nodeBuiltinImport:off -- claims are checked and published in the one synchronous step that admits a lease.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { GOAT_HOME_DIR_NAME } from "@goat/shared/goatHome";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Leases every GOAT server of this user on this machine sees. Each holds an SQLite lock on its
 * holder file for life (as `server-owner.lock`), which the OS drops when it dies. A claim is a
 * record naming its holder, published before the others are read, so of two conflicting claims
 * at least one sees the other. Records whose holder's lock can be taken are a dead server's.
 */

export type WorkspaceClaimKind = "lease" | "subtree";

export type WorkspaceClaim =
  /** release returns why the record could not be removed yet; the next claim retries it. */
  | { readonly kind: "acquired"; readonly release: () => string | null }
  | { readonly kind: "busy" }
  | { readonly kind: "unavailable"; readonly reason: string };

interface ClaimRecord {
  readonly holder: string;
  readonly kind: WorkspaceClaimKind;
  readonly key: string;
}

interface Registry {
  readonly dir: string;
  readonly holder: string;
  readonly lock: NodeSqlite.DatabaseSync;
  readonly records: Set<string>;
  /** Released records whose file could not be removed; they still block other servers. */
  readonly unreleased: Set<string>;
  sequence: number;
}

let registry: Registry | undefined;

const ACQUIRED_LOCALLY: WorkspaceClaim = { kind: "acquired", release: () => null };

const isBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) || cause.message === "database is locked");

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const holderFile = (dir: string, holder: string) => NodePath.join(dir, holder + ".holder");

const unlinkQuietly = (file: string) => {
  try {
    NodeFS.unlinkSync(file);
  } catch {
    // Already gone, or Windows still has it open; a later reader removes it.
  }
};

/** Removes a released record, or keeps it for the next claim to retry and says why. */
const removeRecord = (current: Registry, record: string): string | null => {
  try {
    NodeFS.unlinkSync(record);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      current.unreleased.add(record);
      return `${record} could not be removed: ${errorText(cause)}`;
    }
  }
  current.unreleased.delete(record);
  return null;
};

/** Keys are canonical: forward slashes, no trailing slash. */
const inside = (root: string, key: string) => key === root || key.startsWith(root + "/");

const conflicts = (kind: WorkspaceClaimKind, key: string, other: ClaimRecord) =>
  kind === "lease"
    ? other.kind === "subtree" && inside(other.key, key)
    : other.kind === "lease"
      ? inside(key, other.key)
      : inside(key, other.key) || inside(other.key, key);

/** Whether the holder's server is running: true while its lock is held. */
const holderAlive = (dir: string, holder: string): boolean | { readonly reason: string } => {
  const file = holderFile(dir, holder);
  if (!NodeFS.existsSync(file)) return false;
  let probe: NodeSqlite.DatabaseSync;
  try {
    probe = new NodeSqlite.DatabaseSync(file);
  } catch (cause) {
    return { reason: `${file} could not be opened: ${errorText(cause)}` };
  }
  try {
    probe.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK");
    return false;
  } catch (cause) {
    return isBusy(cause) ? true : { reason: `${file} could not be checked: ${errorText(cause)}` };
  } finally {
    probe.close();
  }
};

const decodeRecord = (text: string): ClaimRecord | null => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) return null;
  const { holder, kind, key } = value as Record<string, unknown>;
  return typeof holder === "string" &&
    (kind === "lease" || kind === "subtree") &&
    typeof key === "string"
    ? { holder, kind, key }
    : null;
};

/** Busy when another live server's claim conflicts with this one; unavailable when unsure. */
const scan = (current: Registry, kind: WorkspaceClaimKind, key: string): WorkspaceClaim | null => {
  let names: ReadonlyArray<string>;
  try {
    names = NodeFS.readdirSync(current.dir);
  } catch (cause) {
    return { kind: "unavailable", reason: `${current.dir} could not be read: ${errorText(cause)}` };
  }
  const alive = new Map<string, boolean>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const holder = name.slice(0, name.indexOf("."));
    if (holder === current.holder) continue;
    let live = alive.get(holder);
    if (live === undefined) {
      const checked = holderAlive(current.dir, holder);
      if (typeof checked === "object") return { kind: "unavailable", reason: checked.reason };
      live = checked;
      alive.set(holder, live);
      // Its lock was free, so that server is gone and nothing it claimed is in use.
      if (!live)
        for (const leftover of names)
          if (leftover.startsWith(holder + "."))
            unlinkQuietly(NodePath.join(current.dir, leftover));
    }
    if (!live) continue;
    const file = NodePath.join(current.dir, name);
    let record: ClaimRecord | null;
    try {
      record = decodeRecord(NodeFS.readFileSync(file, "utf8"));
    } catch (cause) {
      // Released between the listing and this read.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { kind: "unavailable", reason: `${file} could not be read: ${errorText(cause)}` };
    }
    if (record === null) return { kind: "unavailable", reason: `${file} is not a lease record` };
    if (conflicts(kind, key, record)) return { kind: "busy" };
  }
  return null;
};

/**
 * Publishes a claim on the canonical key and keeps it unless another server's conflicts: a lease
 * conflicts with a folder held whole over it, a whole-folder hold with any claim inside it or over
 * it. Leases never conflict with each other here. Acquired at once while the registry is off.
 */
export function claimWorkspace(kind: WorkspaceClaimKind, key: string): WorkspaceClaim {
  const current = registry;
  if (current === undefined) return ACQUIRED_LOCALLY;
  for (const leftover of current.unreleased) {
    const failed = removeRecord(current, leftover);
    if (failed !== null) return { kind: "unavailable", reason: failed };
  }
  const name = `${current.holder}.${++current.sequence}`;
  const record = NodePath.join(current.dir, name + ".json");
  try {
    NodeFS.mkdirSync(current.dir, { recursive: true });
    const draft = NodePath.join(current.dir, name + ".tmp");
    NodeFS.writeFileSync(draft, JSON.stringify({ holder: current.holder, kind, key }));
    // Readers only list .json files, so a record is seen whole or not at all.
    NodeFS.renameSync(draft, record);
  } catch (cause) {
    return {
      kind: "unavailable",
      reason: `a lease could not be recorded in ${current.dir}: ${errorText(cause)}`,
    };
  }
  current.records.add(record);
  const release = () => (current.records.delete(record) ? removeRecord(current, record) : null);
  const verdict = scan(current, kind, key);
  if (verdict === null) return { kind: "acquired", release };
  release();
  return verdict;
}

/**
 * Joins the registry in dir for this process until the returned disable runs. Throws when its
 * holder lock cannot be taken.
 */
export function enableWorkspaceLeaseRegistry(dir: string): {
  readonly holder: string;
  readonly disable: () => void;
} {
  if (registry !== undefined) throw new Error("The workspace lease registry is already enabled.");
  NodeFS.mkdirSync(dir, { recursive: true });
  const holder = NodeCrypto.randomUUID();
  const file = holderFile(dir, holder);
  const lock = new NodeSqlite.DatabaseSync(file);
  try {
    // Exclusive locking mode keeps the lock past the commit, until close.
    lock.exec(
      "PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS holder (id INTEGER); COMMIT",
    );
  } catch (cause) {
    lock.close();
    unlinkQuietly(file);
    throw cause;
  }
  const current: Registry = {
    dir,
    holder,
    lock,
    records: new Set(),
    unreleased: new Set(),
    sequence: 0,
  };
  registry = current;
  return {
    holder,
    disable: () => {
      if (registry !== current) return;
      registry = undefined;
      for (const record of [...current.records, ...current.unreleased]) unlinkQuietly(record);
      current.records.clear();
      current.unreleased.clear();
      current.lock.close();
      for (const suffix of ["", "-journal"]) unlinkQuietly(file + suffix);
    },
  };
}

class WorkspaceLeaseRegistryError extends Schema.TaggedError<WorkspaceLeaseRegistryError>()(
  "WorkspaceLeaseRegistryError",
  { dir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `GOAT could not join the workspace lease registry in ${this.dir}, which keeps other GOAT servers on this machine from removing checkouts this one uses.`;
  }
}

/** Joins this machine's registry until the scope closes; a server must not run without it. */
export const holdWorkspaceLeaseRegistry = Effect.fn("workspaceLeaseRegistry.hold")(function* () {
  const home = yield* HostProcess.HomeDirectory;
  const dir = NodePath.join(home, GOAT_HOME_DIR_NAME, "workspace-leases");
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => enableWorkspaceLeaseRegistry(dir),
      catch: (cause) => new WorkspaceLeaseRegistryError({ dir, cause }),
    }),
    (joined) => Effect.sync(() => joined.disable()),
  );
});
