/** The most characters a description may have. Longer guidance goes in the entry's guide. */
export const DESCRIPTION_BUDGET = 400;

/**
 * Descriptions that were longer than the budget when it was set, at their length then. Each may
 * shrink but never grow, and leaves this list once it fits; descriptionBudget.test.ts holds both.
 */
export const DESCRIPTIONS_OVER_BUDGET: Readonly<Record<string, number>> = {
  "pull_request_guide.update": 578,
  "pull_request.link": 551,
  "pull_request.watch": 1416,
};
