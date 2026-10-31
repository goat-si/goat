import type { BuiltInSkillName } from "@goat/contracts";

export type SettingsPage = "new-threads" | "source-control" | "agent-behavior" | "maintenance";

export const PAGE_TITLES: Record<SettingsPage, string> = {
  "new-threads": "New threads",
  "source-control": "Source control",
  "agent-behavior": "Agent behavior",
  maintenance: "Maintenance",
};

export const MESSAGE_NAMED_SKILL_SETTINGS = [
  {
    name: "goat-discipline",
    title: "Development discipline skill",
    subtitle:
      "Built in. On a turn whose message names $goat-discipline, agents get GOAT's longer guidance for code changes. Off keeps it out of the $ menu and out of turns.",
    projectDescription: "Load it in this project when a message names $goat-discipline.",
  },
  {
    name: "goat-docs",
    title: "GOAT Docs skill",
    subtitle:
      "Built in. On a turn whose message names $goat-docs, agents answer questions about GOAT from its user guides and cite them. Off keeps it out of the $ menu and out of turns.",
    projectDescription: "Load it in this project when a message names $goat-docs.",
  },
] as const satisfies ReadonlyArray<{
  readonly name: BuiltInSkillName;
  readonly title: string;
  readonly subtitle: string;
  readonly projectDescription: string;
}>;
