import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

export const STANDING_INSTRUCTIONS_MAX_CHARS = 20_000;

/**
 * Dispatcher-owned policy GOAT prepends to the first message of threads that
 * agents launch (goat_thread_launch, including launches over SSH). Distinct
 * from AGENTS.md, which the repository owns. Empty means none.
 */
export const StandingInstructions = TrimmedString.check(
  Schema.isMaxLength(STANDING_INSTRUCTIONS_MAX_CHARS),
);
