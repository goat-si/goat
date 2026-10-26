// @effect-diagnostics-next-line nodeBuiltinImport:off -- snapshot digest, no provider identity derivation.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- bounded no-follow snapshot adapter.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- acquisition validates absolute server configuration only.
import * as NodePath from "node:path";
import {
  MemoryImportRpcError,
  type MemoryImportIssue,
  type MemoryImportSourceFormat,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import { scanMemoryValue } from "../MemorySecretScanner.ts";
import type {
  ImportDiscoveredSlot,
  ImportSlot,
  ImportSnapshot,
  ImportSourceFile,
  MemoryImportReaderShape,
} from "./MemoryImportTypes.ts";
import { isSupportedGitVersion } from "./gitSupport.ts";
import {
  ASIDE_DIRECTORIES,
  asidePage,
  asideSelection,
  absolute,
  execute,
  safe,
  validateStateBoundary,
} from "./MemoryImportReaderSupport.ts";

const CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";
const PROCESS_LIMIT = 8 * 1024 * 1024;
const PROFILES = [
  "codex-handbook-v1",
  "codex-ad-hoc-v1",
  "claude-topic-v1",
  "claude-topic-metadata-v1",
  "omo-memory-core-beta63",
  "aside-semantic-v1",
] as const;
/** Server acquisition configuration only; no caller paths or provider settings lookup. */
export type MemoryImportReaderConfig = {
  readonly stateDir: string;
  readonly roots: readonly {
    readonly format: MemoryImportSourceFormat;
    readonly rootSlot: string;
    readonly path: string;
  }[];
  readonly gitExecutable?: string;
  /** Deterministic fault injection after a source read, before any bytes are accepted. */
  readonly onSourceRead?: () => void;
  /** Value-free lifecycle observation; no source bytes, paths, arguments or environment. */
  /** Optional acquisition-owned seal barrier, before any Git process; no source values exposed. */
  readonly onSnapshotSealed?: () => Effect.Effect<void, MemoryImportRpcError>;
  readonly onProcessSpawn?: (event: {
    readonly operation: string;
    readonly pid: number;
    readonly executable: string;
  }) => void;
};

// Node lacks openat. Walk every ancestor without following links, compare the opened file,
// then restat the file and the entire ancestor chain before accepting any bytes. A same-user
// attacker swapping a component away and back between checks remains an accepted threat-model
// limitation; a detected change always fails closed. Never realpath a source to bypass this.
type Stamp = NodeFS.BigIntStats;
const identity = (a: Stamp, b: Stamp) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const stamp = (a: Stamp, b: Stamp) =>
  identity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const fs = NodeFS.promises;
// oxlint-disable-next-line goat/no-global-process-runtime -- Node FS adapter enforces the actual OS permission model, independent of app platform overrides.
const posixPermissions = NodeOS.platform() !== "win32";
const strictText = (bytes: Buffer) => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw error("invalid_utf8");
  }
  if (text.includes("\0")) throw error("path_rejected");
  return text;
};
const snapshotMutations = new Map<string, Promise<void>>();
const nodeSnapshot = (config: MemoryImportReaderConfig, input: SnapshotOperation) =>
  // An interrupted caller must wait for filesystem work to settle before finalizers remove it.
  Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        // Serialize owned directory creation/removal so concurrent slots cannot mistake our
        // own mutations for source drift. Copy operations retain independent slot ownership.
        const mutating = input.action !== "copy" && input.action !== "discover";
        const previous = mutating ? snapshotMutations.get(config.stateDir) : undefined;
        let release = () => {};
        const lock = new Promise<void>((resolve) => {
          release = resolve;
        });
        if (mutating) snapshotMutations.set(config.stateDir, lock);
        await previous;
        try {
          const checks = new Map<string, { before: Stamp; stable: boolean }>();
          const stat = async (path: string) => {
            try {
              return await fs.lstat(path, { bigint: true });
            } catch (cause) {
              // A vanished entry may be an initially absent source or a changed ancestor.
              // Recheck observed ancestors before classifying the missing entry.
              for (const [ancestor, { before, stable }] of checks) {
                if (
                  ancestor !== path &&
                  !path.startsWith(
                    ancestor.endsWith(NodePath.sep) ? ancestor : `${ancestor}${NodePath.sep}`,
                  )
                )
                  continue;
                try {
                  if (
                    !(stable ? stamp : identity)(before, await fs.lstat(ancestor, { bigint: true }))
                  )
                    throw error("source_changed");
                } catch {
                  throw error("source_changed");
                }
              }
              throw cause;
            }
          };
          const remember = async (
            path: string,
            directory: boolean,
            stable = false,
            expected?: Stamp,
          ) => {
            const before = await stat(path);
            if (expected && !stamp(expected, before)) throw error("source_changed");
            const previous = checks.get(path);
            if (previous && !(previous.stable ? stamp : identity)(previous.before, before))
              throw error("source_changed");
            if (before.isSymbolicLink() || !(directory ? before.isDirectory() : before.isFile()))
              throw error("path_rejected");
            checks.set(path, {
              before: previous?.before ?? before,
              stable: stable || previous?.stable === true,
            });
            return before;
          };
          const verify = async (target?: string) => {
            for (const [path, { before, stable }] of checks) {
              if (
                target !== undefined &&
                target !== path &&
                !target.startsWith(path.endsWith(NodePath.sep) ? path : `${path}${NodePath.sep}`)
              )
                continue;
              let after: Stamp;
              try {
                after = await stat(path);
              } catch {
                throw error("source_changed");
              }
              if (!(stable ? stamp : identity)(before, after)) throw error("source_changed");
            }
          };
          const directory = async (path: string) => {
            absolute(path);
            const base = NodePath.parse(path).root;
            await remember(base, true);
            let current = base;
            // System ancestors may cross a volume boundary (e.g. macOS /System/Volumes).
            // Below each explicitly registered root, every descendant must stay on its device.
            for (const part of path.slice(base.length).split(NodePath.sep)) {
              current = NodePath.join(current, part);
              await remember(current, true);
            }
            return current;
          };
          const child = async (
            parent: string,
            name: string,
            isDirectory: boolean,
            stable = true,
            expected?: Stamp,
          ) => {
            safe(name);
            const path = NodePath.join(parent, name);
            const before = await remember(path, isDirectory, stable, expected);
            const parentStat = checks.get(parent)!.before;
            if (before.dev !== parentStat.dev) throw error("path_rejected");
            return before;
          };
          const names = async (path: string, maximum = 4096, sourceStable = false) => {
            // Source listings remain stable until final verification; owned parents may mutate.
            const before = await remember(path, true, sourceStable);
            const result: string[] = [];
            const handle = await fs.opendir(path);
            try {
              for (;;) {
                const entry = await handle.read();
                if (!entry) break;
                // Node decodes directory names with replacement; reject ambiguous names conservatively.
                const name = entry.name;
                if (name.includes("\uFFFD")) throw error("invalid_utf8");
                safe(name);
                result.push(name);
                if (result.length > maximum) throw error("limit_exceeded");
              }
            } finally {
              await handle.close();
            }
            const after = await stat(path);
            if (!stamp(before, after)) throw error("source_changed");
            await verify(path);
            return result.sort();
          };
          const read = async (path: string, before: Stamp, maximum: number) => {
            if (before.size > BigInt(maximum)) throw error("limit_exceeded");
            // Node/libuv opens descriptors close-on-exec; O_CLOEXEC is not exposed by Node.
            // If a platform omits O_NOFOLLOW, the lstat/fstat/ancestor checks still apply.
            let handle: NodeFS.promises.FileHandle;
            try {
              handle = await fs.open(
                path,
                NodeFS.constants.O_RDONLY |
                  (NodeFS.constants.O_NOFOLLOW ?? 0) |
                  (NodeFS.constants.O_NONBLOCK ?? 0),
              );
            } catch {
              await verify(path);
              throw error("source_unreadable");
            }
            try {
              if (!stamp(before, await handle.stat({ bigint: true })))
                throw error("source_changed");
              const chunks: Buffer[] = [];
              let size = 0;
              for (;;) {
                const bytes = Buffer.alloc(Math.min(65536, maximum - size + 1));
                const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
                if (!bytesRead) break;
                chunks.push(bytes.subarray(0, bytesRead));
                size += bytesRead;
                if (size > maximum) {
                  if (!stamp(before, await handle.stat({ bigint: true })))
                    throw error("source_changed");
                  await verify(path);
                  throw error("limit_exceeded");
                }
              }
              config.onSourceRead?.();
              if (
                !stamp(before, await handle.stat({ bigint: true })) ||
                BigInt(size) !== before.size
              )
                throw error("source_changed");
              await verify(path);
              return Buffer.concat(chunks, size);
            } finally {
              await handle.close();
            }
          };
          const own = (s: Stamp, mode: number) => {
            // Windows has no POSIX uid/mode enforcement; the configured private state directory is
            // the ownership boundary there. POSIX enforces owner and exact private permissions.
            if (
              posixPermissions &&
              (s.uid !== BigInt(process.getuid!()) || Number(s.mode & 0o777n) !== mode)
            )
              throw error("path_rejected");
          };
          const mkdir = async (parent: string, name: string, existing = false) => {
            const path = NodePath.join(parent, name);
            await verify(parent);
            try {
              await fs.mkdir(path, { mode: 0o700 });
            } catch (cause) {
              if (!existing || !isFsCode(cause, "EEXIST")) throw cause;
            }
            own(await child(parent, name, true, false), 0o700);
            return path;
          };
          const write = async (parent: string, name: string, data: Buffer) => {
            safe(name);
            await verify(parent);
            const handle = await fs.open(
              NodePath.join(parent, name),
              NodeFS.constants.O_WRONLY |
                NodeFS.constants.O_CREAT |
                NodeFS.constants.O_EXCL |
                (NodeFS.constants.O_NOFOLLOW ?? 0),
              0o600,
            );
            try {
              await handle.writeFile(data);
            } finally {
              await handle.close();
            }
          };
          const result: {
            files?: {
              selector: string;
              utf8Base64: string;
              byteCount: number;
              issue?: MemoryImportIssue;
            }[];
            selections?: string[];
          } = {};
          if (
            input.action === "init" ||
            input.action === "allocate" ||
            input.action === "cleanup" ||
            input.action === "remove"
          ) {
            let state = await directory(config.stateDir);
            const s = checks.get(state)!.before;
            if (
              posixPermissions &&
              (s.uid !== BigInt(process.getuid!()) || (s.mode & 0o022n) !== 0n)
            )
              throw error("path_rejected");
            for (const name of ["memory-import", "snapshots"]) {
              if (input.action === "init") state = await mkdir(state, name, true);
              else {
                await child(state, name, true, false);
                state = NodePath.join(state, name);
                own(checks.get(state)!.before, 0o700);
              }
            }
            if (input.action === "allocate") {
              const dest = await mkdir(state, input.id);
              await mkdir(dest, "repo");
              await mkdir(dest, "cwd");
            }
            if (input.action === "cleanup" || input.action === "remove") {
              const entries = await names(state, 2);
              const paths: { path: string; directory: boolean }[] = [];
              for (const name of entries) {
                if (input.action === "remove" && name !== input.id) continue;
                if (!/^snapshot-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name))
                  throw error("path_rejected");
                let count = 0,
                  total = 0n,
                  objectTotal = 0n,
                  objectCount = 0;
                const inspect = async (
                  parent: string,
                  name: string,
                  depth: number,
                  rel: string,
                ): Promise<void> => {
                  const path = NodePath.join(parent, name);
                  const s = await stat(path);
                  const obj = rel === "repo/objects" || rel.startsWith("repo/objects/");
                  if (++count > 4096 || (obj && ++objectCount > 3584) || depth > 9)
                    throw error("limit_exceeded");
                  if (rel) safe(rel.startsWith("repo/") ? rel.slice(5) : rel);
                  await child(parent, name, s.isDirectory(), false, s);
                  own(s, s.isDirectory() ? 0o700 : 0o600);
                  if (s.isDirectory())
                    for (const n of await names(path))
                      await inspect(path, n, depth + 1, rel ? `${rel}/${n}` : n);
                  else {
                    total += s.size;
                    if (obj) objectTotal += s.size;
                    if (total > 67108864n || objectTotal > 62914560n) throw error("limit_exceeded");
                  }
                  paths.push({ path, directory: s.isDirectory() });
                };
                await inspect(state, name, 0, "");
              }
              await verify();
              for (const entry of paths) {
                // Removal changes directory timestamps; identity remains checked before each mutation.
                await verify(entry.path);
                if (entry.directory) await fs.rmdir(entry.path);
                else await fs.unlink(entry.path);
                checks.delete(entry.path);
              }
            }
          } else if (input.action === "discover") {
            const root = await directory(input.root);
            result.selections = [];
            if (input.format === "aside") {
              // Reads only directory listings; page bytes are read when the user previews.
              const folder = async (parent: string, name: string) => {
                const path = NodePath.join(parent, name);
                let s: Stamp;
                try {
                  s = await stat(path);
                } catch (cause) {
                  if (isFsCode(cause, "ENOENT")) return undefined;
                  throw cause;
                }
                if (s.isSymbolicLink() || !s.isDirectory()) return undefined;
                await child(parent, name, true, false, s);
                return path;
              };
              for (const slot of await names(root, 512, true)) {
                if (slot.startsWith(".") || slot.includes(":")) continue;
                const slotPath = await folder(root, slot);
                const memory = slotPath && (await folder(slotPath, "memory"));
                if (!memory) continue;
                const present = new Set(await names(memory, 4096, true));
                for (const name of ASIDE_DIRECTORIES) {
                  if (!present.has(name)) continue;
                  const path = await folder(memory, name);
                  if (!path || !(await names(path, 4096, true)).some(asidePage)) continue;
                  result.selections.push(`${slot}:${name}`);
                  if (result.selections.length > 128) throw error("limit_exceeded");
                }
              }
            } else
              for (const name of await names(root, 512, true)) {
                const s = await stat(NodePath.join(root, name));
                await child(root, name, s.isDirectory(), false, s);
                if (s.isDirectory()) result.selections.push(name);
                if (result.selections.length > 128) throw error("limit_exceeded");
              }
          } else {
            const root = await directory(input.root);
            let source = root;
            for (const part of input.relative.split("/")) {
              await child(source, part, true);
              source = NodePath.join(source, part);
            }
            const dest = await directory(input.snapshot);
            own(checks.get(dest)!.before, 0o700);
            let count = input.format === "omo" ? 4 : 0,
              objectsCount = 0,
              total = Buffer.byteLength(input.config),
              objectBytes = 0,
              sourceBytes = 0;
            const files: NonNullable<typeof result.files> = (result.files = []);
            const walk = async (
              parent: string,
              out: string,
              rel: string,
              depth: number,
              git: boolean,
            ): Promise<void> => {
              const aside = input.format === "aside";
              // Aside folders may hold many skipped logs; only pages count against the file budget.
              for (const name of await names(
                parent,
                aside ? 4096 : (git ? 4096 : 512) - count,
                true,
              )) {
                if (aside && !asidePage(name)) continue;
                const selector = rel ? `${rel}/${name}` : name;
                safe(selector);
                const obj = selector === "objects" || selector.startsWith("objects/");
                const path = NodePath.join(parent, name);
                const s = await stat(path);
                // Aside reads only regular pages directly in the selected directory. Links,
                // subdirectories and non-page files are skipped without being opened or followed.
                if (aside && (s.isSymbolicLink() || !s.isFile())) continue;
                if (++count > (git ? 4096 : 512) || (obj && ++objectsCount > 3584) || depth > 8)
                  throw error("limit_exceeded");
                await child(parent, name, s.isDirectory(), true, s);
                if (
                  git &&
                  ["commondir", "objects/info/alternates", "objects/info/http-alternates"].includes(
                    selector,
                  )
                )
                  throw error("path_rejected");
                const selected = git
                  ? selector === "HEAD" ||
                    selector === "packed-refs" ||
                    (selector.startsWith("refs/") && !selector.startsWith("refs/replace")) ||
                    (obj && !selector.startsWith("objects/info"))
                  : input.format === "codex"
                    ? selector === "MEMORY.md" ||
                      (selector.startsWith("extensions/ad_hoc/notes/") &&
                        selector.split("/").length === 4 &&
                        selector.endsWith(".md"))
                    : input.format === "aside" ||
                      (!selector.includes("/") &&
                        selector.endsWith(".md") &&
                        !["MEMORY.md", "CLAUDE.md"].includes(selector));
                if (s.isDirectory()) {
                  const copyDir =
                    git &&
                    (["refs", "objects"].includes(selector) ||
                      (selector.startsWith("refs/") && !selector.startsWith("refs/replace")) ||
                      (obj && !selector.startsWith("objects/info")));
                  await walk(
                    path,
                    copyDir ? await mkdir(out, name) : out,
                    selector,
                    depth + 1,
                    git,
                  );
                } else if (git && selector === "config") {
                  const text = strictText(await read(path, s, 262144)).toLowerCase();
                  if (/^\s*\[\s*include(?:if)?\b/m.test(text)) throw error("path_rejected");
                  if (/^\s*\[\s*extensions\b/m.test(text)) throw error("unsupported_format");
                } else if (selected) {
                  if (input.format === "aside") {
                    // Report each unreadable page with its own reason; never truncate or fail
                    // the other pages in the directory.
                    const refuse = (issue: MemoryImportIssue) =>
                      files.push({
                        selector,
                        utf8Base64: "",
                        byteCount: Number(s.size),
                        issue,
                      });
                    if (s.size > 262144n) {
                      refuse("limit_exceeded");
                      continue;
                    }
                    sourceBytes += Number(s.size);
                    if (sourceBytes > 8388608) throw error("limit_exceeded");
                    const data = await read(path, s, 262144);
                    try {
                      strictText(data);
                    } catch (cause) {
                      if (!isImportError(cause)) throw cause;
                      // strictText reports a NUL byte as path_rejected; for a page it is bad text.
                      refuse(cause.issue === "path_rejected" ? "invalid_utf8" : cause.issue);
                      continue;
                    }
                    files.push({
                      selector,
                      utf8Base64: data.toString("base64"),
                      byteCount: data.length,
                    });
                    await write(out, `${files.length}.txt`, data);
                    continue;
                  }
                  if (git) {
                    total += Number(s.size);
                    if (obj) objectBytes += Number(s.size);
                    if (total > 67108864 || objectBytes > 62914560 || total - objectBytes > 4194304)
                      throw error("limit_exceeded");
                  } else {
                    sourceBytes += Number(s.size);
                    if (sourceBytes > 8388608) throw error("limit_exceeded");
                  }
                  const data = await read(path, s, git ? Number(s.size) : 262144);
                  if (git) await write(out, name, data);
                  else {
                    strictText(data);
                    files.push({
                      selector,
                      utf8Base64: data.toString("base64"),
                      byteCount: data.length,
                    });
                    await write(out, `${files.length}.txt`, data);
                  }
                }
              }
            };
            if (input.format === "omo") {
              await child(source, ".git", true);
              await walk(NodePath.join(source, ".git"), dest, "", 1, true);
              await write(dest, "config", Buffer.from(input.config));
            } else await walk(source, dest, "", 1, false);
          }
          await verify();
          return result;
        } finally {
          release();
          if (mutating && snapshotMutations.get(config.stateDir) === lock)
            snapshotMutations.delete(config.stateDir);
        }
      },
      catch: (cause) => (isFsCode(cause, "ENOENT") ? error("source_missing") : normalize(cause)),
    }),
  );
const isFsCode = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
type SnapshotOperation =
  | { action: "init" }
  | { action: "cleanup" }
  | { action: "allocate"; id: string }
  | { action: "remove"; id: string }
  | { action: "discover"; root: string; format: MemoryImportSourceFormat }
  | {
      action: "copy";
      root: string;
      relative: string;
      snapshot: string;
      format: MemoryImportSourceFormat;
      config: string;
    };

type Budget = {
  live: number;
  unavailable: boolean;
  owners: number;
  initializing: boolean;
  slots: Semaphore.Semaphore;
};
// Deliberate server/stateDir admission ownership, shared by acquisitions in this process.
const budgets = new Map<string, Budget>();
const error = (issue: MemoryImportIssue) => new MemoryImportRpcError({ issue });
const isImportError = Schema.is(MemoryImportRpcError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const normalize = (cause: unknown) => (isImportError(cause) ? cause : error("source_unreadable"));
/** L5 must await this before activation. Single server owner per stateDir is a deployment precondition. */
export const cleanupMemoryImportSnapshots = (config: MemoryImportReaderConfig) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        absolute(config.stateDir);
        validateStateBoundary(config);
      },
      catch: normalize,
    });
    const budget = budgets.get(config.stateDir);
    if (budget && (budget.owners > 0 || budget.live > 0 || budget.initializing))
      return yield* Effect.fail(error("source_unreadable"));
    yield* nodeSnapshot(config, { action: "init" });
    yield* nodeSnapshot(config, { action: "cleanup" });
    budgets.delete(config.stateDir);
  });

/** Read-only startup admission check; acquisition still rechecks the full no-follow chain. */
export const preflightMemoryImportStateDirectory = (stateDir: string) =>
  Effect.tryPromise({
    try: async () => {
      absolute(stateDir);
      const stat = await fs.lstat(stateDir, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (posixPermissions &&
          (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n) !== 0n))
      )
        throw error("path_rejected");
    },
    catch: normalize,
  });

/** Acquire once in L5's Scope; discover/read themselves have no Scope requirement. */
export const acquireMemoryImportReader = (config: MemoryImportReaderConfig) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        absolute(config.stateDir);
        validateStateBoundary(config);
        if (config.gitExecutable !== undefined) absolute(config.gitExecutable);
        if (config.roots.length > 128) throw error("limit_exceeded");
        const keys = new Set<string>();
        for (const root of config.roots) {
          absolute(root.path);
          safe(root.rootSlot);
          if (root.rootSlot.includes("/") || [...root.rootSlot].length > 256)
            throw error("path_rejected");
          const key = `${root.format}/${root.rootSlot}`;
          if (keys.has(key)) throw error("path_rejected");
          keys.add(key);
        }
      },
      catch: normalize,
    });
    const roots = config.roots.map((root) => ({ ...root }));
    const previous = budgets.get(config.stateDir);
    const slots = yield* Semaphore.make(2);
    const budget: Budget = previous ?? {
      live: 0,
      unavailable: false,
      owners: 0,
      initializing: true,
      slots,
    };
    if (previous?.initializing || previous?.unavailable)
      return yield* Effect.fail(error("source_unreadable"));
    budgets.set(config.stateDir, budget);
    if (!previous) {
      yield* nodeSnapshot(config, { action: "init" }).pipe(
        Effect.andThen(nodeSnapshot(config, { action: "cleanup" })),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            budget.initializing = false;
            if (exit._tag === "Failure") budget.unavailable = true;
          }),
        ),
      );
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        budget.owners++;
      }),
      () =>
        Effect.sync(() => {
          budget.owners--;
        }),
    );
    let closed = false;
    const operations = yield* Scope.make();
    yield* Effect.addFinalizer((exit) =>
      Effect.sync(() => {
        closed = true;
      }).pipe(Effect.andThen(Scope.close(operations, exit))),
    );
    const manage = <A>(operation: Effect.Effect<A, MemoryImportRpcError>) =>
      Effect.try({
        try: () => {
          if (closed || budget.unavailable) throw error("source_unreadable");
        },
        catch: normalize,
      }).pipe(
        Effect.andThen(
          Effect.acquireUseRelease(
            Effect.forkIn(operation, operations),
            Fiber.join,
            Fiber.interrupt,
          ),
        ),
      );
    const available = () => {
      if (closed || budget.unavailable) throw error("source_unreadable");
    };
    const snapshot = <A>(use: (path: string) => Effect.Effect<A, MemoryImportRpcError>) =>
      Effect.gen(function* () {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const id = yield* Effect.acquireRelease(
              Effect.gen(function* () {
                const id = yield* Effect.try({
                  try: () => {
                    available();
                    return `snapshot-${NodeCrypto.randomUUID()}`;
                  },
                  catch: normalize,
                });
                if (!(yield* budget.slots.takeIfAvailable(1)))
                  return yield* Effect.fail(error("limit_exceeded"));
                budget.live++;
                return id;
              }),
              (id) =>
                nodeSnapshot(config, { action: "remove", id }).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      budget.live--;
                    }).pipe(Effect.andThen(budget.slots.release(1))),
                  ),
                  Effect.catch(() =>
                    Effect.sync(() => {
                      budget.unavailable = true;
                    }).pipe(
                      Effect.andThen(Effect.logError("Memory import snapshot cleanup failed.")),
                    ),
                  ),
                ),
            );
            yield* nodeSnapshot(config, { action: "allocate", id });
            return yield* use(NodePath.join(config.stateDir, "memory-import", "snapshots", id));
          }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.fail(budget.unavailable ? error("source_unreadable") : cause),
          ),
          Effect.flatMap((value) =>
            budget.unavailable ? Effect.fail(error("source_unreadable")) : Effect.succeed(value),
          ),
        );
      });
    const locate = (slot: ImportSlot) => {
      available();
      safe(slot.rootSlot);
      const root = roots.find((r) => r.format === slot.format && r.rootSlot === slot.rootSlot);
      if (!root) throw error("source_missing");
      if (slot.format === "codex") {
        if (slot.selection !== null) throw error("path_rejected");
      } else {
        if (slot.selection === null) throw error("path_rejected");
        safe(slot.selection);
        if (slot.selection.includes("/")) throw error("path_rejected");
        if (slot.format === "aside") asideSelection(slot.selection);
      }
      return root;
    };
    const metadata = (slot: ImportSlot, profile: string): ImportDiscoveredSlot => {
      const sourceLocator = `${slot.format}/${slot.rootSlot}${slot.selection ? `/${slot.selection}` : ""}`;
      safe(sourceLocator);
      const aside =
        slot.format === "aside" && slot.selection ? asideSelection(slot.selection) : null;
      return {
        slot,
        profile,
        parserVersion: profile,
        sourceLocator,
        label: aside ? `${aside.slot}/${aside.directory}` : slot.rootSlot,
      };
    };
    const read: MemoryImportReaderShape["read"] = ({ slot }) =>
      Effect.gen(function* () {
        const root = yield* Effect.try({ try: () => locate(slot), catch: normalize });
        return yield* snapshot((path) =>
          Effect.gen(function* () {
            const repo = NodePath.join(path, "repo");
            const copied = yield* nodeSnapshot(config, {
              action: "copy",
              root: root.path,
              relative:
                slot.format === "codex"
                  ? "memories"
                  : slot.format === "aside"
                    ? (({ slot: store, directory }) => `${store}/memory/${directory}`)(
                        asideSelection(slot.selection!),
                      )
                    : `${slot.selection}/${slot.format === "claude" ? "memory" : "repo"}`,
              snapshot: repo,
              format: slot.format,
              config: slot.format === "omo" ? CONFIG : "",
            });
            if (config.onSnapshotSealed) yield* Effect.suspend(config.onSnapshotSealed);
            let files: ImportSourceFile[] = yield* Effect.try({
              try: () =>
                (copied.files ?? []).map((file) => {
                  if (file.issue)
                    return {
                      selector: file.selector,
                      text: "",
                      byteCount: file.byteCount,
                      issue: file.issue,
                    };
                  const bytes = Buffer.from(file.utf8Base64, "base64");
                  if (
                    bytes.length !== file.byteCount ||
                    bytes.length > 262144 ||
                    bytes.toString("base64") !== file.utf8Base64
                  )
                    throw error("source_unreadable");
                  return {
                    selector: file.selector,
                    text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
                    byteCount: file.byteCount,
                  };
                }),
              catch: normalize,
            });
            let commitOid: string | undefined;
            let profile: string;
            if (slot.format === "omo") {
              if (!config.gitExecutable) return yield* Effect.fail(error("source_unreadable"));
              const gitExecutable = config.gitExecutable;
              const git = (args: readonly string[], cap = PROCESS_LIMIT) =>
                execute(
                  gitExecutable,
                  [
                    "--no-replace-objects",
                    "-c",
                    "credential.helper=",
                    "-c",
                    "core.askPass=",
                    "-c",
                    "protocol.allow=never",
                    ...args,
                  ],
                  NodePath.join(path, "cwd"),
                  cap,
                  repo,
                  (pid) =>
                    config.onProcessSpawn?.({ operation: "git", pid, executable: gitExecutable }),
                ).pipe(
                  Effect.flatMap((result) =>
                    result.code === 0
                      ? Effect.succeed(result.bytes)
                      : Effect.fail(error("source_unreadable")),
                  ),
                );
              const version = (yield* git(["--version"], 256)).toString("utf8");
              if (!isSupportedGitVersion(version))
                return yield* Effect.fail(error("source_unreadable"));
              const run = (args: readonly string[], cap?: number) =>
                git(["--no-lazy-fetch", ...args], cap);
              commitOid = (yield* run(["rev-parse", "--verify", "HEAD^{commit}"], 128))
                .toString("utf8")
                .trim();
              if (!/^[0-9a-f]{40}$/.test(commitOid))
                return yield* Effect.fail(error("unsupported_format"));
              const tree = yield* run(["ls-tree", "-rz", "--full-tree", commitOid]);
              files = [];
              let bytes = 0;
              const treeText = yield* Effect.try({
                try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(tree),
                catch: () => error("invalid_utf8"),
              });
              const entries = treeText.split("\0").filter(Boolean);
              if (entries.length > 512) return yield* Effect.fail(error("limit_exceeded"));
              for (const entry of entries) {
                const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/s.exec(entry);
                if (!match) return yield* Effect.fail(error("unsupported_format"));
                const [, mode, type, oid, selector] = match;
                yield* Effect.try({
                  try: () => {
                    safe(selector!);
                    if (selector!.split("/").length > 8) throw error("limit_exceeded");
                    if ((mode !== "100644" && mode !== "100755") || type !== "blob")
                      throw error("path_rejected");
                  },
                  catch: normalize,
                });
                if (!/^(system|notes|people|reference|projects)\/.*\.md$/.test(selector!)) continue;
                const size = Number(
                  (yield* run(["cat-file", "-s", oid!], 32)).toString("ascii").trim(),
                );
                if (!Number.isSafeInteger(size) || size < 0)
                  return yield* Effect.fail(error("source_unreadable"));
                bytes += size;
                if (size > 262144 || bytes > PROCESS_LIMIT)
                  return yield* Effect.fail(error("limit_exceeded"));
                const content = yield* run(["cat-file", "blob", oid!], 262144);
                if (content.length !== size) return yield* Effect.fail(error("source_changed"));
                const text = yield* Effect.try({
                  try: () =>
                    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content),
                  catch: () => error("invalid_utf8"),
                });
                files.push({ selector: selector!, text, byteCount: content.length });
              }
              profile = PROFILES[4];
            } else if (slot.format === "aside") {
              profile = PROFILES[5];
              // A page carrying a secret is refused on its own; its text never leaves the reader.
              files = files.map((file) =>
                !file.issue && scanMemoryValue(file.text).kind === "blocked"
                  ? {
                      selector: file.selector,
                      text: "",
                      byteCount: file.byteCount,
                      issue: "secret_detected" as const,
                    }
                  : file,
              );
            } else if (slot.format === "codex") {
              // One registered slot may contain both supported Codex profiles; L3 can dispatch per selector.
              profile = files.some((file) => file.selector === "MEMORY.md")
                ? PROFILES[0]
                : PROFILES[1];
            } else
              profile = files.some((file) =>
                /^---\r?\n(?:(?!---)[^])*?^metadata:[^]*?^---\s*$/m.test(file.text),
              )
                ? PROFILES[3]
                : PROFILES[2];
            yield* Effect.try({
              try: () => {
                // An Aside folder whose entries are all skipped previews as empty.
                if (!files.length && slot.format !== "aside") throw error("source_missing");
                for (const file of files) {
                  safe(file.selector);
                  if (file.text.includes("\0")) throw error("path_rejected");
                  if (scanMemoryValue(file.text).kind === "blocked") throw error("secret_detected");
                }
              },
              catch: normalize,
            });
            files.sort((a, b) => a.selector.localeCompare(b.selector, "en"));
            const info = yield* Effect.try({
              try: () => metadata(slot, profile),
              catch: normalize,
            });
            return {
              ...info,
              format: slot.format,
              files,
              snapshotDigest: NodeCrypto.createHash("sha256")
                .update(encodeJson([profile, commitOid ?? null, files]))
                .digest("hex"),
              ...(commitOid ? { commitOid } : {}),
            } satisfies ImportSnapshot;
          }),
        );
      });
    const discover: MemoryImportReaderShape["discover"] = ({ format }) =>
      Effect.gen(function* () {
        yield* Effect.try({ try: available, catch: normalize });
        const result: ImportDiscoveredSlot[] = [];
        for (const root of roots.filter((root) => root.format === format)) {
          const selections =
            format === "codex"
              ? [null]
              : ((yield* nodeSnapshot(config, { action: "discover", root: root.path, format }))
                  .selections ?? []);
          for (const selection of selections) {
            if (result.length >= 128) return yield* Effect.fail(error("limit_exceeded"));
            const slot: ImportSlot = { format, rootSlot: root.rootSlot, selection };
            // Aside has one fixed profile; discovery must not read page bytes.
            const profile = format === "aside" ? PROFILES[5] : (yield* read({ slot })).profile;
            result.push(
              yield* Effect.try({ try: () => metadata(slot, profile), catch: normalize }),
            );
          }
        }
        return result;
      });
    return {
      discover: (input) => manage(discover(input)),
      read: (input) => manage(read({ slot: { ...input.slot } })),
    } satisfies MemoryImportReaderShape;
  });
