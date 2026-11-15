import { LEGACY_MANAGED_WORKTREE_PATH } from "@goat/contracts/legacyT3Names";
import type { AgentSessionSource } from "./AgentSessionScanner.ts";

export function normalizeForWorktreeMatch(value: string, caseFold: boolean): string {
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

// false stops metadata scanning for an excluded rollout, even if later records contain a cwd.
export function extractCwd(line: string, source: AgentSessionSource): string | null | false {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
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
