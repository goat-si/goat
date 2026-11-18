import {
  LEGACY_WORKTREE_BRANCH_PREFIX,
  LEGACY_WORKTREE_LONG_BRANCH_PREFIX,
} from "@goat/contracts/legacyT3Names";
import { WORKTREE_BRANCH_PREFIX } from "./git.ts";

// Ignore generated worktree prefixes while preserving searches by their hex token.
const TEMP_BRANCH_PREFIXES = `(?:${WORKTREE_BRANCH_PREFIX}|${LEGACY_WORKTREE_BRANCH_PREFIX}|${LEGACY_WORKTREE_LONG_BRANCH_PREFIX})`;
export const WORKTREE_BRANCH_PREFIX_PATTERN = new RegExp(
  `^(?:${TEMP_BRANCH_PREFIXES}/(?=\\S)|${TEMP_BRANCH_PREFIXES}-(?=[0-9a-f]{8}$))`,
);
export const FLAT_BRANCH_QUERY_PREFIX_PATTERN = new RegExp(
  `(^| )${TEMP_BRANCH_PREFIXES}-(?=[0-9a-f]{1,8}(?: |$))`,
  "g",
);
