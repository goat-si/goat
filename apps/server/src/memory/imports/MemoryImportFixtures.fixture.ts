/**
 * Frozen WP5 fixture API (L2 r1): buildMemoryImportFixture(profile, { seed?, files? })
 * acquires a Scope-owned synthetic sandbox. `trustedRoot` maps rootSlot; `sourceRoot` is the selected memory directory/repo;
 * `stateDir` is isolated reader state. `snapshot`/`discovered` are parser/coordinator inputs.
 * files replaces the complete allowlisted text set (relative selectors only).
 * captureMemoryImportInventory(sourceRoot) records all source bytes, modes and links,
 * including Git refs/index/config/objects, without following symlinks. Compare before/after.
 * buildMemoryImportFault mutates ONLY this sandbox and returns root/slot for reader negatives;
 * its original snapshot remains the pre-fault parser input. snapshotMemoryImportFiles makes
 * pure parser-negative inputs. makeMemoryImportWorkload fixes §4.4's 16 bodies/64 aliases.
 * All data is synthetic; no provider CLI, host env/config or installed home is consulted.
 * Fixture digests are canonical test inputs, not a specification of the reader digest codec.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk/Git fixture uses Node directly, without application services.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk/Git fixture uses Node directly, without application services.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk/Git fixture uses Node directly, without application services.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synthetic disk/Git fixture uses Node directly, without application services.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type {
  ImportDiscoveredSlot,
  ImportSnapshot,
  ImportSourceFile,
  ImportSlot,
} from "./MemoryImportTypes.ts";
import { it } from "@effect/vitest";
import { isSupportedGitVersion } from "./gitSupport.ts";

const MEMORY_IMPORT_FIXTURE_SEED = "wp5-fixture-v1";
const MEMORY_IMPORT_FIXTURE_CLOCK = "2026-10-13T00:00:00.000Z";
export const MEMORY_IMPORT_FIXTURE_PROFILES = [
  "codex-handbook-v1",
  "codex-ad-hoc-v1",
  "claude-topic-v1",
  "claude-topic-metadata-v1",
  "omo-memory-core-beta63",
] as const;
export type MemoryImportFixtureProfile = (typeof MEMORY_IMPORT_FIXTURE_PROFILES)[number];
export const MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS = {
  "codex-handbook-v1": "codex-handbook-v1",
  "codex-ad-hoc-v1": "codex-ad-hoc-v1",
  "claude-topic-v1": "claude-topic-v1",
  "claude-topic-metadata-v1": "claude-topic-metadata-v1",
  "omo-memory-core-beta63": "omo-memory-core-beta63",
} as const;

const digest = (bytes: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const sorted = (values: readonly string[]) => [...values].sort();
const write = (path: string, bytes: string | Buffer) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(path, bytes, { mode: 0o600 });
};
const safeSelector = (selector: string) => {
  if (
    !selector ||
    Buffer.byteLength(selector) > 512 ||
    selector.includes("\\") ||
    selector.includes("\0") ||
    selector.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error("Invalid synthetic fixture selector");
  }
};

export type MemoryImportFixture = {
  readonly sandbox: string;
  readonly trustedRoot: string;
  readonly sourceRoot: string;
  readonly stateDir: string;
  readonly emptyHome: string;
  readonly seed: string;
  readonly clockSeed: typeof MEMORY_IMPORT_FIXTURE_CLOCK;
  readonly profile: MemoryImportFixtureProfile;
  readonly snapshot: ImportSnapshot;
  readonly discovered: ImportDiscoveredSlot;
};

/** Pure snapshot cloning: raw text is intentionally unvalidated for negative parser tests. */
export const snapshotMemoryImportFiles = (
  snapshot: ImportSnapshot,
  files: readonly ImportSourceFile[],
): ImportSnapshot => ({
  ...snapshot,
  files: [...files],
  snapshotDigest: digest(
    JSON.stringify([
      snapshot.format,
      snapshot.profile,
      snapshot.parserVersion,
      snapshot.commitOid ?? null,
      files.map((file) => [file.selector, file.text, file.byteCount]),
    ]),
  ),
});

const defaultFiles = (
  profile: MemoryImportFixtureProfile,
  seed: string,
): Record<string, string> => {
  const body = `Use the synthetic ${digest(seed).slice(0, 12)} fixture guidance.\n`;
  switch (profile) {
    case "codex-handbook-v1":
      return {
        "MEMORY.md": `# Task Group: Fixture guidance\nscope: synthetic fixture task\n\n## Task 1: Stable guidance\n\n### learnings\n- ${body}`,
      };
    case "codex-ad-hoc-v1":
      return { "extensions/ad_hoc/notes/2026-10-13-fixture.md": body };
    case "claude-topic-v1":
      return {
        "fixture.md": `---\nname: Fixture guidance\ndescription: Synthetic direct topic\ntype: project\n---\n${body}`,
      };
    case "claude-topic-metadata-v1":
      return {
        "fixture.md": `---\nname: Fixture guidance\ndescription: Synthetic metadata topic\nmetadata:\n  type: project\n  node_type: memory\n  originSessionId: synthetic-session\n---\n${body}`,
      };
    case "omo-memory-core-beta63":
      return {
        "notes/2026-10.md": `---\ndescription: Synthetic ledger\nread_only: false\nkind: observation\naliases: ["fixture"]\nlimit: 4096\n---\n${body}`,
      };
  }
};

/** Complete environment, never process.env; fixture creation itself must ignore host Git config. */
const git = (
  fixture: Pick<MemoryImportFixture, "sourceRoot" | "emptyHome">,
  args: readonly string[],
  input?: string | Buffer,
) => {
  const result = NodeChildProcess.spawnSync(
    "/usr/bin/git",
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
    {
      cwd: fixture.sourceRoot,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: fixture.emptyHome,
        XDG_CONFIG_HOME: fixture.emptyHome,
        LC_ALL: "C",
        TZ: "UTC",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: MEMORY_IMPORT_FIXTURE_CLOCK,
        GIT_COMMITTER_DATE: MEMORY_IMPORT_FIXTURE_CLOCK,
      },
      input,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) throw new Error("Synthetic fixture Git failed");
  return result.stdout.trim();
};

const commitFixture = (
  fixture: Pick<MemoryImportFixture, "sourceRoot" | "emptyHome">,
  files: Record<string, string>,
) => {
  git(fixture, [
    "init",
    "--quiet",
    "--object-format=sha1",
    "--initial-branch=fixture",
    `--template=${fixture.emptyHome}`,
  ]);
  for (const selector of sorted(Object.keys(files))) {
    const oid = git(fixture, ["hash-object", "-w", "--stdin"], files[selector]);
    git(fixture, ["update-index", "--add", "--cacheinfo", `100644,${oid},${selector}`]);
  }
  const tree = git(fixture, ["write-tree"]);
  const oid = git(fixture, ["commit-tree", tree], "WP5 synthetic memory fixture\n");
  git(fixture, ["update-ref", "refs/heads/fixture", oid]);
  return oid;
};

/** Scope finalizer is registered before any provider tree, Git object or state file is written. */
const hostGitSupported = (() => {
  try {
    return isSupportedGitVersion(
      NodeChildProcess.execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }),
    );
  } catch {
    return false;
  }
})();
// Faults the reader refuses only once Git reads the repository.
const GIT_READ_FAULTS = new Set(["git-symlink", "gitlink", "missing-object"]);
/**
 * The omo reader runs the host's Git and refuses versions outside its support policy, such as
 * stock Ubuntu 24.04's 2.43; a fake Git in MemoryImportReader.test.ts covers that refusal. These
 * gate the cases that need a supported real Git, so they run where one exists.
 */
export const hostGit = {
  supported: hostGitSupported,
  it: it.effect.skipIf(!hostGitSupported),
  cases: <T>(cases: ReadonlyArray<T>) => (hostGitSupported ? cases : []),
  profiles: MEMORY_IMPORT_FIXTURE_PROFILES.filter(
    (profile) => hostGitSupported || profile !== "omo-memory-core-beta63",
  ),
  faults: <T extends readonly [string, ...unknown[]]>(faults: ReadonlyArray<T>) =>
    faults.filter(([fault]) => hostGitSupported || !GIT_READ_FAULTS.has(fault)),
};

export const buildMemoryImportFixture = (
  profile: MemoryImportFixtureProfile,
  options: { readonly seed?: string; readonly files?: Readonly<Record<string, string>> } = {},
) =>
  Effect.gen(function* () {
    const sandbox = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeFS.mkdtempSync(
          NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "goat-memory-import-fixture-"),
        ),
      ),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    );
    return yield* Effect.sync(() => {
      NodeFS.chmodSync(sandbox, 0o700);
      const seed = options.seed ?? MEMORY_IMPORT_FIXTURE_SEED;
      const trustedRoot = NodePath.join(sandbox, "trusted", "provider");
      const sourceRoot = profile.startsWith("codex-")
        ? NodePath.join(trustedRoot, "memories")
        : NodePath.join(
            trustedRoot,
            "fixture-selection",
            profile.startsWith("claude-") ? "memory" : "repo",
          );
      const stateDir = NodePath.join(sandbox, "state");
      const emptyHome = NodePath.join(sandbox, "empty-home");
      for (const path of [sourceRoot, stateDir, emptyHome])
        NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
      const files = { ...(options.files ?? defaultFiles(profile, seed)) };
      for (const [selector, text] of Object.entries(files)) {
        safeSelector(selector);
        write(NodePath.join(sourceRoot, selector), text);
      }
      const format = profile.startsWith("codex-")
        ? "codex"
        : profile.startsWith("claude-")
          ? "claude"
          : "omo";
      const slot: ImportSlot = {
        format,
        rootSlot: "fixture-root",
        selection: format === "codex" ? null : "fixture-selection",
      };
      const parserVersion = MEMORY_IMPORT_FIXTURE_PARSER_VERSIONS[profile];
      const sourceLocator = `fixture/${profile}`;
      const commitOid =
        format === "omo" ? commitFixture({ sourceRoot, emptyHome }, files) : undefined;
      // Excluded files exercise selection without changing the pinned commit or parser snapshot.
      if (format === "codex") {
        write(NodePath.join(sourceRoot, "memory_summary.md"), "Excluded synthetic summary\n");
        write(NodePath.join(sourceRoot, "raw_memories.md"), "Excluded synthetic raw data\n");
      } else if (format === "claude") {
        write(NodePath.join(sourceRoot, "MEMORY.md"), "Navigation only; fixture.md\n");
        write(NodePath.join(sourceRoot, "nested", "excluded.md"), "Excluded nested topic\n");
      } else {
        write(NodePath.join(sourceRoot, "untracked.md"), "Excluded untracked bytes\n");
        const first = sorted(Object.keys(files))[0];
        if (first) write(NodePath.join(sourceRoot, first), "Excluded dirty bytes\n");
      }
      const snapshot = snapshotMemoryImportFiles(
        {
          slot,
          format,
          parserVersion,
          profile,
          sourceLocator,
          snapshotDigest: "",
          files: [],
          ...(commitOid ? { commitOid } : {}),
        },
        sorted(Object.keys(files)).map((selector) => ({
          selector,
          text: files[selector]!,
          byteCount: Buffer.byteLength(files[selector]!),
        })),
      );
      const discovered: ImportDiscoveredSlot = {
        slot,
        parserVersion,
        profile,
        sourceLocator,
        label: `Synthetic ${profile}`,
      };
      return {
        sandbox,
        trustedRoot,
        sourceRoot,
        stateDir,
        emptyHome,
        seed,
        clockSeed: MEMORY_IMPORT_FIXTURE_CLOCK,
        profile,
        snapshot,
        discovered,
      } satisfies MemoryImportFixture;
    });
  });

/** Stable byte/inventory capture; lstat + readlink means links are recorded, never traversed. */
export const captureMemoryImportInventory = (root: string) => {
  const entries: {
    path: string;
    kind: string;
    mode: number;
    bytes?: number;
    hash?: string;
    target?: string;
  }[] = [];
  const visit = (relative: string) => {
    const path = NodePath.join(root, relative);
    const stat = NodeFS.lstatSync(path);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink())
      entries.push({ path: relative, kind: "symlink", mode, target: NodeFS.readlinkSync(path) });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory", mode });
      for (const child of sorted(NodeFS.readdirSync(path)))
        visit(relative ? `${relative}/${child}` : child);
    } else if (stat.isFile()) {
      const bytes = NodeFS.readFileSync(path);
      entries.push({
        path: relative,
        kind: "file",
        mode,
        bytes: bytes.length,
        hash: digest(bytes),
      });
    } else entries.push({ path: relative, kind: "other", mode });
  };
  visit("");
  return { entries, digest: digest(JSON.stringify(entries)) };
};

export type MemoryImportFixtureFault =
  | "symlink-root"
  | "symlink-ancestor"
  | "symlink-file"
  | "traversal"
  | "malformed-utf8"
  | "nul"
  | "oversized-file"
  | "secret-header"
  | "git-symlink"
  | "gitlink"
  | "gitfile"
  | "commondir"
  | "alternates"
  | "http-alternates"
  | "metadata-symlink"
  | "config-include"
  | "missing-object";

/** Negative builder; byte faults update committed omo blobs, preserving the pre-fault snapshot.
 * symlink-file is a filesystem-only fault for Codex/Claude; use git-symlink for omo. */
export const buildMemoryImportFault = (
  fixture: MemoryImportFixture,
  fault: MemoryImportFixtureFault,
) => {
  let root = fixture.trustedRoot;
  let slot = fixture.snapshot.slot;
  const first = fixture.snapshot.files[0];
  if (!first) throw new Error("Fault requires a nonempty synthetic fixture");
  const file = NodePath.join(fixture.sourceRoot, first.selector);
  const corrupt = (data: string | Buffer) => {
    write(file, data);
    if (fixture.snapshot.format === "omo") {
      const oid = git(fixture, ["hash-object", "-w", "--stdin"], data);
      git(fixture, ["update-index", "--add", "--cacheinfo", `100644,${oid},${first.selector}`]);
      const tree = git(fixture, ["write-tree"]);
      const commit = git(fixture, ["commit-tree", tree], "WP5 corrupt bytes fixture\n");
      git(fixture, ["update-ref", "refs/heads/fixture", commit]);
    }
  };
  switch (fault) {
    case "symlink-root":
      root = NodePath.join(fixture.sandbox, "root-link");
      NodeFS.symlinkSync("trusted/provider", root);
      break;
    case "symlink-ancestor":
      NodeFS.renameSync(
        NodePath.join(fixture.sandbox, "trusted"),
        NodePath.join(fixture.sandbox, "trusted-real"),
      );
      NodeFS.symlinkSync("trusted-real", NodePath.join(fixture.sandbox, "trusted"));
      break;
    case "symlink-file":
      if (fixture.snapshot.format === "omo")
        throw new Error("symlink-file requires Codex/Claude; use git-symlink for omo");
      NodeFS.renameSync(file, `${file}.target`);
      NodeFS.symlinkSync(`${file.split("/").at(-1)}.target`, file);
      break;
    case "traversal":
      slot = { ...slot, selection: "../outside" };
      break;
    case "malformed-utf8":
      corrupt(Buffer.from([0xc3, 0x28]));
      break;
    case "nul":
      corrupt("Synthetic\0body\n");
      break;
    case "oversized-file":
      corrupt(Buffer.alloc(262_145, 0x61));
      break;
    case "secret-header":
      corrupt(`---\ndescription: -----BEGIN PRIVATE KEY-----\n---\nSafe synthetic body\n`);
      break;
    default: {
      if (fixture.snapshot.format !== "omo") throw new Error("Git fault requires omo fixture");
      const metadata = NodePath.join(fixture.sourceRoot, ".git");
      switch (fault) {
        case "git-symlink":
        case "gitlink": {
          const oid =
            fault === "gitlink"
              ? fixture.snapshot.commitOid!
              : git(fixture, ["hash-object", "-w", "--stdin"], "../outside\n");
          const mode = fault === "gitlink" ? "160000" : "120000";
          git(fixture, ["update-index", "--add", "--cacheinfo", `${mode},${oid},notes/unsafe.md`]);
          const tree = git(fixture, ["write-tree"]);
          const commit = git(fixture, ["commit-tree", tree], "WP5 unsafe entry fixture\n");
          git(fixture, ["update-ref", "refs/heads/fixture", commit]);
          break;
        }
        case "gitfile":
          NodeFS.rmSync(metadata, { recursive: true });
          write(metadata, "gitdir: ../outside\n");
          break;
        case "commondir":
          write(NodePath.join(metadata, "commondir"), "../outside\n");
          break;
        case "alternates":
        case "http-alternates":
          write(NodePath.join(metadata, "objects", "info", fault), "../../../outside\n");
          break;
        case "metadata-symlink":
          NodeFS.renameSync(
            NodePath.join(metadata, "objects"),
            NodePath.join(fixture.sandbox, "objects"),
          );
          NodeFS.symlinkSync(
            NodePath.relative(metadata, NodePath.join(fixture.sandbox, "objects")),
            NodePath.join(metadata, "objects"),
          );
          break;
        case "config-include":
          write(
            NodePath.join(fixture.sandbox, "include-config"),
            "[fixture]\n\tsentinel = synthetic\n",
          );
          write(
            NodePath.join(metadata, "config"),
            `[include]\n\tpath = ${NodePath.relative(metadata, NodePath.join(fixture.sandbox, "include-config"))}\n`,
          );
          break;
        case "missing-object": {
          const oid = git(fixture, [
            "rev-parse",
            `${fixture.snapshot.commitOid}:${first.selector}`,
          ]);
          NodeFS.rmSync(NodePath.join(metadata, "objects", oid.slice(0, 2), oid.slice(2)));
          write(NodePath.join(metadata, "objects", "pack", "fixture.promisor"), "");
          break;
        }
      }
    }
  }
  return { root, slot };
};

/** 16 distinct exactly-4096-byte UTF-8 bodies, four stable aliases each; round changes bytes only. */
export const makeMemoryImportWorkload = (round = 0, seed = MEMORY_IMPORT_FIXTURE_SEED) => {
  if (!Number.isSafeInteger(round) || round < 0)
    throw new Error("Invalid synthetic workload round");
  return Array.from({ length: 16 }, (_, index) => {
    const prefix = `Synthetic memory ${index} round ${round} ${digest(seed)}\n`;
    const body = prefix + "x".repeat(4096 - Buffer.byteLength(prefix));
    return {
      body,
      aliases: Array.from({ length: 4 }, (_, alias) => `fixture/${index}/${alias}#body`),
    };
  });
};
