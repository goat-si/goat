/** The most characters a description may have. Longer guidance goes in the entry's guide. */
export const DESCRIPTION_BUDGET = 400;

/**
 * Descriptions that were longer than the budget when it was set, at their length then. Each may
 * shrink but never grow, and leaves this list once it fits; descriptionBudget.test.ts holds both.
 */
export const DESCRIPTIONS_OVER_BUDGET: Readonly<Record<string, number>> = {
  "environment.preferences_update": 432,
  "environment.read": 420,
  "project.create": 498,
  "project.list": 497,
  "project.read": 473,
  "pull_request_guide.update": 578,
  "pull_request.link": 551,
  "pull_request.watch": 1416,
  "repository.snapshot": 740,
  "worktree.cleanup": 820,
  "worktree.handoff": 931,
  "worktree.inventory": 582,
  "worktree.remove": 798,
};
