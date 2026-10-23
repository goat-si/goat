/** The most characters a description may have. Longer guidance goes in the entry's guide. */
export const DESCRIPTION_BUDGET = 400;

/**
 * Descriptions that were longer than the budget when it was set, at their length then. Each may
 * shrink but never grow, and leaves this list once it fits; descriptionBudget.test.ts holds both.
 */
export const DESCRIPTIONS_OVER_BUDGET: Readonly<Record<string, number>> = {
  "cloud_agent.holders": 752,
  "cloud_agent.launch": 915,
  "cloud_agent.run_register": 653,
  "connection.add_ssh": 1117,
  "connection.remove": 401,
  "handoff.create": 586,
  "host.status": 1311,
  "hub.device_join": 1275,
  "hub.device_leave": 745,
  "hub.device_repair": 544,
  "hub.device_verify": 422,
  "operation.cancel": 451,
  "operation.read": 644,
  "operation.wait": 456,
  "provider.add": 532,
  "provider.addable_list": 527,
  "provider.diagnose": 1917,
  "provider.home_request": 412,
  "provider.host_matrix": 974,
  "provider.list": 654,
  "provider.login_start": 704,
  "provider.setup_open": 733,
  "provider.sync": 910,
  "provider.update": 949,
  "pull_request_guide.update": 578,
  "pull_request.link": 551,
  "pull_request.watch": 1416,
};
