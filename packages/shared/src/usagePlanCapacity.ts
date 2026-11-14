import type { ServerProviderUsageWindow } from "@goat/contracts";
import type { LimitAccount, LimitPoolMember } from "./usageLimits.ts";

const CODEX_PLAN_CAPACITY: Record<string, number> = {
  "ChatGPT Plus Subscription": 1,
  "ChatGPT Pro 100 Subscription": 5,
  "ChatGPT Pro 200 Subscription": 20,
};
// Claude's published plan multipliers describe the session allowance only.
const CLAUDE_SESSION_CAPACITY: Record<string, number> = { Pro: 1, Max: 5, Ultra: 20 };

function planCapacity(account: LimitAccount, kind: ServerProviderUsageWindow["kind"]) {
  if (!account.plan) return undefined;
  if (account.driver === "codex" && (kind === "session" || kind === "weekly")) {
    return CODEX_PLAN_CAPACITY[account.plan];
  }
  if (account.driver === "claudeAgent" && kind === "session") {
    return CLAUDE_SESSION_CAPACITY[account.plan];
  }
  return undefined;
}

export function poolWeights(
  members: readonly LimitPoolMember[],
  kind: ServerProviderUsageWindow["kind"],
) {
  const entries = members.map((member) => ({
    member,
    capacity: planCapacity(member.account, kind),
  }));
  const comparable = entries.every(({ capacity }) => capacity !== undefined);
  const weights = new Map(
    entries.map(({ member, capacity }) => [member, comparable ? (capacity ?? 1) : 1]),
  );
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const weightOf = (member: LimitPoolMember) => {
    const weight = weights.get(member);
    if (weight === undefined) throw new Error("Missing pool member weight");
    return weight;
  };
  return { totalWeight, weightOf };
}
