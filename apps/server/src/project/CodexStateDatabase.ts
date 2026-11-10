// @effect-diagnostics nodeBuiltinImport:off - Codex keeps its project index in SQLite; this is a small read-only lookup.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type { ProviderInstanceId } from "@goat/contracts";
import { normalizeProjectPathForComparison } from "@goat/shared/path";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  codexHistorySourcePath,
  readCodexHistoryThreadIds,
  type CodexHistoryThreadRef,
} from "./CodexThreadHistory.ts";

interface CodexStateThread {
  readonly id: string;
  readonly cwd: string;
  readonly updatedAtMs: number;
  readonly createdAtMs: number;
  readonly title: string;
  readonly model: string | null;
}

interface CodexStateProject {
  readonly roots: ReadonlyArray<string>;
}

interface CodexStateSnapshot {
  readonly threads: ReadonlyArray<CodexStateThread>;
  readonly projects: ReadonlyArray<CodexStateProject>;
  readonly projectRoots: ReadonlyArray<string>;
  readonly complete: boolean;
}

interface CodexCandidateGroup {
  readonly cwd: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly lastActiveAtMs: number | null;
  readonly transcripts: ReadonlyArray<{
    readonly filePath: string;
    readonly mtimeMs: number;
    readonly historyThread: CodexHistoryThreadRef;
  }>;
}

interface CodexHome {
  readonly homePath: string;
  readonly providerInstanceId: ProviderInstanceId;
}

const STATE_DATABASE_NAMES = ["state_5.sqlite", "state_4.sqlite", "state.sqlite"] as const;
const MAX_CODEX_SESSION_INDEX_BYTES = 1024 * 1024;
const MAX_CODEX_STATE_THREADS = 20_000;
const MAX_CODEX_PROJECT_ROOTS = 20_000;
const MAX_DATE_MS = 8.64e15;
const ROLLOUT_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const CodexSessionIndexEntry = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.String,
});
const decodeCodexSessionIndexEntry = Schema.decodeUnknownOption(
  Schema.fromJsonString(CodexSessionIndexEntry),
);

export function codexThreadIdFromRolloutPath(filePath: string): string | undefined {
  // Continued rollouts are named `<thread-id>_<segment-id>.jsonl`; the thread is the first UUID.
  const name = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  return ROLLOUT_ID.exec(name)?.[0];
}

function comparisonPath(value: string): string {
  const normalized = normalizeProjectPathForComparison(value);
  // Codex may write a UNC root with forward slashes; normalize both forms before comparing.
  return normalized.startsWith("//") ? normalized.replaceAll("/", "\\").toLowerCase() : normalized;
}

function makeProjectRootLookup(projectRoots: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const roots = new Map<string, string>();
  for (const root of projectRoots) roots.set(comparisonPath(root), root);
  return roots;
}

function resolveProjectRoot(cwd: string, roots: ReadonlyMap<string, string>): string | undefined {
  const normalized = comparisonPath(cwd);
  const windows = normalized.startsWith("\\\\") || /^[a-zA-Z]:\\/.test(normalized);
  const dirname = windows ? NodePath.win32.dirname : NodePath.posix.dirname;
  let current = normalized;
  while (true) {
    const root = roots.get(current);
    if (root !== undefined) return root;
    const parent = comparisonPath(dirname(current));
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Prefer the most specific project root that contains the thread's working directory. */
export function resolveCodexProjectCwd(cwd: string, projectRoots: ReadonlyArray<string>): string {
  return resolveProjectRoot(cwd, makeProjectRootLookup(projectRoots)) ?? cwd;
}

function parseCodexThreadNames(contents: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const entry = Option.getOrUndefined(decodeCodexSessionIndexEntry(line));
    const name = entry?.thread_name.trim();
    if (entry !== undefined && name) names.set(entry.id, name);
  }
  return names;
}

export const readCodexThreadNames = Effect.fn("AgentSessionScanner.readCodexThreadNames")(
  (homePath: string, fileSystem: FileSystem.FileSystem, path: Path.Path) =>
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = path.join(homePath, "session_index.jsonl");
        const file = yield* fileSystem.open(indexPath, { flag: "r" });
        const size = Number((yield* file.stat).size);
        const start = Math.max(0, size - MAX_CODEX_SESSION_INDEX_BYTES);
        yield* file.seek(BigInt(start), "start");
        const bytes = yield* file.readAlloc(size - start);
        const contents = Option.match(bytes, {
          onNone: () => "",
          onSome: (value) => new TextDecoder().decode(value),
        });
        // A tail read can start mid-record.
        return parseCodexThreadNames(
          start > 0 ? contents.slice(contents.indexOf("\n") + 1) : contents,
        );
      }),
    ).pipe(Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map())),
);

const emptySnapshot = (complete = true): CodexStateSnapshot => ({
  threads: [],
  projects: [],
  projectRoots: [],
  complete,
});

function isSubagentSource(value: unknown): boolean {
  if (typeof value !== "string" || !value.trimStart().startsWith("{")) return false;
  try {
    const source: unknown = JSON.parse(value);
    return (
      typeof source === "object" &&
      source !== null &&
      (Object.hasOwn(source, "subagent") || Object.hasOwn(source, "subAgent"))
    );
  } catch {
    return false;
  }
}

function readSnapshot(databasePath: string): CodexStateSnapshot {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true, timeout: 1000 });
  try {
    let complete = true;
    const columns = new Set(
      (
        database.prepare("PRAGMA table_info(threads)").all() as unknown as ReadonlyArray<{
          name?: unknown;
        }>
      ).flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
    );
    const optional = (name: string) => (columns.has(name) ? name : `NULL AS ${name}`);
    const rows = database
      .prepare(
        `SELECT id, cwd, updated_at, source, ${optional("created_at")}, ${optional("title")}, ${optional("model")} FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(MAX_CODEX_STATE_THREADS + 1) as unknown as ReadonlyArray<{
      id: unknown;
      cwd: unknown;
      updated_at: unknown;
      source: unknown;
      created_at: unknown;
      title: unknown;
      model: unknown;
    }>;
    const threadRows = rows.slice(0, MAX_CODEX_STATE_THREADS);
    if (rows.length > MAX_CODEX_STATE_THREADS) complete = false;
    const projects = new Map<string, { roots: Array<string> }>();
    const collectProjects = () => {
      const allRows = database
        .prepare(
          "SELECT p.id AS id, r.path AS path FROM projects p JOIN project_roots r ON r.project_id = p.id LIMIT ?",
        )
        .all(MAX_CODEX_PROJECT_ROOTS + 1) as unknown as ReadonlyArray<{
        id: unknown;
        path: unknown;
      }>;
      const rows = allRows.slice(0, MAX_CODEX_PROJECT_ROOTS);
      if (allRows.length > MAX_CODEX_PROJECT_ROOTS) complete = false;
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.path !== "string" || row.path.length === 0) {
          continue;
        }
        const project = projects.get(row.id) ?? { roots: [] };
        project.roots.push(row.path);
        projects.set(row.id, project);
      }
    };
    try {
      collectProjects();
    } catch {
      // Older Codex versions may predate the project tables; thread mapping still works.
      projects.clear();
      complete = false;
    }
    const threads = threadRows.flatMap((row): Array<CodexStateThread> => {
      if (
        typeof row.id !== "string" ||
        typeof row.cwd !== "string" ||
        row.cwd.length === 0 ||
        isSubagentSource(row.source)
      ) {
        return [];
      }
      const raw = typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at);
      const updatedAtMs = Number.isFinite(raw) ? (raw > 1e12 ? raw : raw * 1000) : 0;
      const rawCreatedAt =
        typeof row.created_at === "number" ? row.created_at : Number(row.created_at);
      const createdAtMs = Number.isFinite(rawCreatedAt)
        ? rawCreatedAt > 1e12
          ? rawCreatedAt
          : rawCreatedAt * 1000
        : 0;
      return [
        {
          id: row.id,
          cwd: row.cwd,
          updatedAtMs: Math.abs(updatedAtMs) <= MAX_DATE_MS ? updatedAtMs : 0,
          createdAtMs: Math.abs(createdAtMs) <= MAX_DATE_MS ? createdAtMs : 0,
          title: typeof row.title === "string" ? row.title.trim() : "",
          model:
            typeof row.model === "string" && row.model.trim().length > 0 ? row.model.trim() : null,
        },
      ];
    });
    const projectList = [...projects.values()];
    return {
      threads,
      projects: projectList,
      projectRoots: projectList.flatMap((project) => project.roots),
      complete,
    };
  } finally {
    database.close();
  }
}

const readCodexState = Effect.fn("CodexStateDatabase.read")(function* (homePath: string) {
  const databasePath = STATE_DATABASE_NAMES.map((name) => NodePath.join(homePath, name)).find(
    (candidate) => NodeFS.existsSync(candidate),
  );
  if (databasePath === undefined) return emptySnapshot();
  return yield* Effect.try(() => readSnapshot(databasePath)).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read the Codex state database", { homePath, cause }).pipe(
        Effect.as(emptySnapshot(false)),
      ),
    ),
  );
});

const readCodexStates = Effect.fn("CodexStateDatabase.readAll")(function* (
  homes: ReadonlyArray<CodexHome>,
) {
  const states = new Map<string, CodexStateSnapshot>();
  for (const home of homes) {
    states.set(home.homePath, yield* readCodexState(home.homePath));
  }
  return states;
});

function buildCodexCwdByThread(
  homes: ReadonlyArray<CodexHome>,
  states: ReadonlyMap<string, CodexStateSnapshot>,
): ReadonlyMap<string, string> {
  const cwdByThread = new Map<string, string>();
  for (const home of homes) {
    const state = states.get(home.homePath);
    if (state === undefined) continue;
    const roots = makeProjectRootLookup(state.projectRoots);
    for (const thread of state.threads) {
      cwdByThread.set(
        `${home.providerInstanceId}\0${thread.id}`,
        resolveProjectRoot(thread.cwd, roots) ?? thread.cwd,
      );
    }
  }
  return cwdByThread;
}

function buildCodexCandidateGroups(
  homes: ReadonlyArray<CodexHome>,
  states: ReadonlyMap<string, CodexStateSnapshot>,
  fileThreads: ReadonlySet<string>,
  cwdByThread: ReadonlyMap<string, string>,
): { readonly groups: ReadonlyArray<CodexCandidateGroup>; readonly complete: boolean } {
  type MutableGroup = {
    cwd: string;
    providerInstanceId: ProviderInstanceId;
    homePath: string;
    lastActiveAtMs: number | null;
    transcripts: Array<{
      filePath: string;
      mtimeMs: number;
      historyThread: CodexHistoryThreadRef;
    }>;
  };
  const byCwd = new Map<string, MutableGroup>();
  const seenThreads = new Set<string>();
  let complete = true;
  for (const home of homes) {
    const state = states.get(home.homePath);
    if (state === undefined) continue;
    for (const project of state.projects) {
      for (const root of project.roots) {
        const key = `${home.providerInstanceId}\0${root}`;
        const existing = byCwd.get(key);
        if (existing === undefined) {
          byCwd.set(key, {
            cwd: root,
            providerInstanceId: home.providerInstanceId,
            homePath: home.homePath,
            lastActiveAtMs: null,
            transcripts: [],
          });
        }
      }
    }
    const history = readCodexHistoryThreadIds(home.homePath);
    if (!history.complete) complete = false;
    const projectRootKeys = new Set(state.projectRoots.map(comparisonPath));
    for (const thread of state.threads) {
      const threadKey = `${home.providerInstanceId}\0${thread.id}`;
      if (fileThreads.has(threadKey)) continue;
      const cwd = cwdByThread.get(`${home.providerInstanceId}\0${thread.id}`);
      if (cwd === undefined) continue;
      if (!projectRootKeys.has(comparisonPath(cwd))) continue;
      const key = `${home.providerInstanceId}\0${cwd}`;
      const existing = byCwd.get(key);
      if (existing === undefined) continue;
      existing.lastActiveAtMs =
        existing.lastActiveAtMs === null
          ? thread.updatedAtMs
          : Math.max(existing.lastActiveAtMs, thread.updatedAtMs);
      if (seenThreads.has(threadKey) || !history.ids.has(thread.id)) continue;
      seenThreads.add(threadKey);
      existing.transcripts.push({
        filePath: codexHistorySourcePath(thread.id),
        mtimeMs: thread.updatedAtMs,
        historyThread: { ...thread, homePath: home.homePath },
      });
    }
  }
  return { groups: [...byCwd.values()], complete };
}

export const readCodexProjectState = Effect.fn("CodexStateDatabase.readProjectState")(function* (
  homes: ReadonlyArray<CodexHome>,
) {
  const stateByHome = yield* readCodexStates(homes);
  return {
    stateByHome,
    cwdByThread: buildCodexCwdByThread(homes, stateByHome),
    complete: [...stateByHome.values()].every((state) => state.complete),
  };
});

/** Codex projects, including projects whose rollout files are gone. */
export function codexStateOnlyCandidateGroups(
  homes: ReadonlyArray<CodexHome>,
  states: ReadonlyMap<string, CodexStateSnapshot>,
  transcripts: ReadonlyArray<{
    readonly filePath: string;
    readonly providerInstanceId: ProviderInstanceId;
  }>,
  cwdByThread: ReadonlyMap<string, string>,
): { readonly groups: ReadonlyArray<CodexCandidateGroup>; readonly complete: boolean } {
  const fileThreads = new Set<string>();
  for (const transcript of transcripts) {
    const threadId = codexThreadIdFromRolloutPath(transcript.filePath);
    if (threadId !== undefined) {
      fileThreads.add(`${transcript.providerInstanceId}\0${threadId}`);
    }
  }
  return buildCodexCandidateGroups(homes, states, fileThreads, cwdByThread);
}
