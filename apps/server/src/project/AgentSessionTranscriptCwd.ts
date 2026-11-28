import { normalizeProjectPathForComparison } from "@goat/shared/path";
import type * as Path from "effect/Path";
import { LEGACY_MANAGED_WORKTREE_PATH } from "@goat/contracts/legacyT3Names";
import * as Schema from "effect/Schema";
import {
  createTranscriptJsonReader,
  TranscriptJsonLimitError,
  createTranscriptJsonSelector,
} from "./AgentSessionJson.ts";
import type { AgentSessionSource } from "./AgentSessionScanner.ts";

function normalizeForWorktreeMatch(value: string, caseFold: boolean): string {
  const normalized = `${value.replaceAll("\\", "/")}/`;
  return caseFold ? normalized.toLowerCase() : normalized;
}

export function isGoatManagedWorktree(
  candidatePath: string,
  worktreesDir: string,
  caseFold: boolean,
): boolean {
  const normalized = normalizeForWorktreeMatch(candidatePath, caseFold);
  return (
    normalized.startsWith(normalizeForWorktreeMatch(worktreesDir, caseFold)) ||
    normalized.includes("/.goat/worktrees/") ||
    normalized.includes(LEGACY_MANAGED_WORKTREE_PATH)
  );
}

export function makeExcludedProjectPath(
  path: Path.Path,
  home: string,
  tmp: string,
  base: string,
  realBase: string,
  worktrees: string,
  realWorktrees: string,
  fold: boolean,
) {
  const roots = new Set(
    [home, tmp, "/tmp", "/private/tmp"].map((p) =>
      normalizeProjectPathForComparison(path.resolve(p)),
    ),
  );
  const ancestors = [
    path.join(home, "Downloads"),
    path.join(home, "Documents", "Codex"),
    base,
    realBase,
  ];
  return (candidate: string) =>
    roots.has(normalizeProjectPathForComparison(candidate)) ||
    ancestors.some((p) =>
      normalizeForWorktreeMatch(candidate, fold).startsWith(normalizeForWorktreeMatch(p, fold)),
    ) ||
    isGoatManagedWorktree(candidate, worktrees, fold) ||
    isGoatManagedWorktree(candidate, realWorktrees, fold);
}

const selectCwdPath = createTranscriptJsonSelector(
  Schema.Struct({
    cwd: Schema.String,
    type: Schema.String,
    payload: Schema.Struct({
      cwd: Schema.String,
      source: Schema.Struct({ subagent: Schema.Null, subAgent: Schema.Null }),
    }),
  }),
);

// false stops metadata scanning for an excluded rollout, even if later records contain a cwd.
export function extractCwd(parsed: unknown, source: AgentSessionSource): string | null | false {
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (source === "pi")
    return record.type === "session" && typeof record.cwd === "string"
      ? record.cwd.trim() || null
      : null;
  if (typeof record.cwd === "string" && record.cwd.trim().length > 0) {
    return record.cwd;
  }
  const payload = record.payload;
  if (typeof payload === "object" && payload !== null) {
    if (source === "codex" && record.type === "session_meta") {
      const sessionSource = (payload as Record<string, unknown>).source;
      if (
        typeof sessionSource === "object" &&
        sessionSource !== null &&
        !Array.isArray(sessionSource) &&
        (Object.hasOwn(sessionSource, "subagent") || Object.hasOwn(sessionSource, "subAgent"))
      ) {
        return false;
      }
    }
    const nested = (payload as Record<string, unknown>).cwd;
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested;
    }
  }
  return null;
}

export function makeCwdScanner(
  source: AgentSessionSource,
  budget: { recordsRemaining: number; truncated: boolean },
  maxBytes: number,
  maxRecords: number,
) {
  let recordsRead = 0;
  let selectedBytes = 0;
  const reserveSelected = (bytes: number) => {
    selectedBytes += bytes;
    if (selectedBytes > maxBytes) {
      throw new TranscriptJsonLimitError("Transcript cwd fields exceed the scan limit");
    }
  };
  // Claude writes cwd before message, so a record with a large image need not be read to its end.
  let topLevelCwd: string | null = null;
  const createReader = () =>
    createTranscriptJsonReader(reserveSelected, selectCwdPath, {
      onTopLevelString: (key, value) => {
        if (source !== "pi" && key === "cwd" && value.trim().length > 0) topLevelCwd ??= value;
      },
    });
  let reader = createReader();
  let decoder = new TextDecoder();
  let recordStarted = false;
  const reserveRecord = () => {
    if (recordsRead === maxRecords || budget.recordsRemaining === 0) {
      budget.truncated = true;
      return false;
    }
    recordsRead += 1;
    budget.recordsRemaining -= 1;
    return true;
  };
  const finishRecord = () => {
    reader.write(decoder.decode());
    const value = reader.finish();
    reader = createReader();
    decoder = new TextDecoder();
    recordStarted = false;
    selectedBytes = 0;
    return extractCwd(value, source);
  };
  const scanChunk = (chunk: Uint8Array): string | false | null | undefined => {
    let start = 0;
    while (start < chunk.byteLength) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.byteLength : newline;
      if (end > start) {
        recordStarted = true;
        reader.write(decoder.decode(chunk.subarray(start, end), { stream: true }));
        if (topLevelCwd !== null) return reserveRecord() ? topLevelCwd : null;
      }
      if (newline === -1) return undefined;
      if (!reserveRecord()) return null;
      const cwd = finishRecord();
      if (cwd !== null) return cwd;
      start = newline + 1;
    }
    return undefined;
  };
  const readLastRecord = () => (!recordStarted || !reserveRecord() ? null : finishRecord());

  return { scanChunk, readLastRecord };
}
