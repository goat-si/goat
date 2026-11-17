import type { ThreadResult } from "@goat/contracts";

/**
 * Whether two reads of a thread's result decide auto-done the same way: the same run, status and
 * outcome. A read that fetches an equal result again keeps a completion's token valid.
 */
export const sameDecision = (
  cached: ThreadResult | null | undefined,
  judged: ThreadResult | null | undefined,
): boolean =>
  cached === undefined || judged === undefined
    ? false
    : cached === null || judged === null
      ? cached === judged
      : cached.runId === judged.runId &&
        cached.runStatus === judged.runStatus &&
        cached.outcome === judged.outcome;
