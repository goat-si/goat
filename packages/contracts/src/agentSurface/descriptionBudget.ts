/** The most characters a description may have. Longer guidance goes in the entry's guide. */
export const DESCRIPTION_BUDGET = 400;

/**
 * Descriptions that were longer than the budget when it was set, at their length then. Each may
 * shrink but never grow, and leaves this list once it fits; descriptionBudget.test.ts holds both.
 */
export const DESCRIPTIONS_OVER_BUDGET: Readonly<Record<string, number>> = {
  "connection.add_ssh": 1117,
  "connection.remove": 401,
  "host.status": 1311,
  "hub.device_join": 1275,
  "hub.device_leave": 745,
  "hub.device_repair": 544,
  "hub.device_verify": 422,
};
