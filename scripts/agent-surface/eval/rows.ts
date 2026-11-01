/**
 * What the report checks before it scores rows (docs/operations/agent-surface-eval.md): that each
 * row is one run, belongs to an arm of the campaign, and ran what that arm states, and that a
 * verdict comes from one paired campaign. Nothing here touches a server or the filesystem.
 */
import { type Campaign, CampaignError, type RunRow, type Task, type TaskSet } from "./core.ts";

/** The tasks a gate judges: goat_eval names every task, manual ones included. */
export const requiredTasks = (taskSet: TaskSet, gate: Campaign["gate"]): ReadonlyArray<Task> =>
  gate === "eval" ? taskSet.tasks : taskSet.tasks.filter((task) => !task.manual);

/**
 * Refuses rows a report must not pool. A verdict needs one campaign: ABBA pairs the arms within
 * a campaign, and runs from two campaigns were never paired.
 */
export const checkRows = (
  rows: ReadonlyArray<RunRow>,
  campaign: Pick<Campaign, "arms" | "candidateArm">,
): { readonly campaignIds: ReadonlyArray<string> } => {
  const seen = new Set<string>();
  const coordinates = new Set<string>();
  for (const row of rows) {
    const key = row.threadId ?? [row.campaignId, row.task, row.arm, row.pair].join("|");
    if (seen.has(key)) throw new CampaignError("run " + key + " appears twice");
    seen.add(key);
    // Two threads at one schedule step would let repeated runs fill the minimum.
    const coordinate = [row.campaignId, row.task, row.arm, row.pair].join("|");
    if (coordinates.has(coordinate))
      throw new CampaignError("schedule step " + coordinate + " has two runs");
    coordinates.add(coordinate);
    const arm = campaign.arms.find((candidate) => candidate.id === row.arm);
    if (arm === undefined) throw new CampaignError("row " + key + " is from arm " + row.arm);
    // Rows before these fields existed cannot be checked against the arm, only grouped by it.
    if (
      (row.providerInstanceId !== undefined &&
        row.providerInstanceId !== arm.modelSelection.instanceId) ||
      (row.model !== undefined && row.model !== arm.modelSelection.model) ||
      (row.listing !== undefined && JSON.stringify(row.listing) !== JSON.stringify(arm.listing))
    )
      throw new CampaignError("row " + key + " did not run what arm " + arm.id + " states");
  }
  const campaignIds = [...new Set(rows.map((row) => row.campaignId))];
  if (campaign.candidateArm !== null && campaignIds.length > 1)
    throw new CampaignError(
      "a verdict comes from one paired campaign; these rows come from " + campaignIds.join(", "),
    );
  if (campaign.candidateArm !== null) checkPairs(rows, campaign.arms);
  return { campaignIds };
};

/**
 * A verdict compares runs that were paired: per task both arms ran the same pairs, and each run
 * went first or second as the ABBA schedule says (core.ts schedule).
 */
const checkPairs = (rows: ReadonlyArray<RunRow>, arms: Campaign["arms"]) => {
  const [first, second] = arms;
  if (second === undefined) return;
  for (const row of rows) {
    const leads = row.pair % 2 === 0 ? first.id : second.id;
    if (row.slot !== (row.arm === leads ? 0 : 1))
      throw new CampaignError(
        row.task + " pair " + row.pair + ": arm " + row.arm + " ran in the wrong order",
      );
  }
  for (const task of new Set(rows.map((row) => row.task))) {
    const pairsOf = (armId: string) =>
      JSON.stringify(
        rows
          .filter((row) => row.task === task && row.arm === armId)
          .map((row) => row.pair)
          .toSorted((a, b) => a - b),
      );
    if (pairsOf(first.id) !== pairsOf(second.id))
      throw new CampaignError(task + ": the two arms did not run the same pairs");
  }
};
