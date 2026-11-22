import type { ScheduledTaskUpsertSchedule } from "@goat/contracts";

const githubTrigger = (
  event: string,
  path: string,
  value: string,
): ScheduledTaskUpsertSchedule => ({
  type: "webhook",
  signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", required: true },
  filters: [
    { path: "headers.x-github-event", op: "equals", value: event },
    { path, op: "equals", value },
  ],
});

export const GOAT_BOT_TEMPLATES = [
  {
    id: "ci-watcher",
    name: "CI watcher",
    face: "🔍",
    purpose: "Investigate failing checks.",
    instructions: "Identify the first actionable failure and suggest how to reproduce it.",
    firstMessage: "Help me decide which repository and checks to watch.",
    automation: {
      title: "Check failed",
      prompt:
        "Investigate the failing check {{body.check_run.name}} at {{body.check_run.html_url}}.",
      schedule: githubTrigger("check_run", "body.check_run.conclusion", "failure"),
    },
  },
  {
    id: "pr-reviewer",
    name: "PR reviewer",
    face: "📋",
    purpose: "Review incoming pull requests.",
    instructions:
      "Review the pull request for correctness and regression risk. Cite evidence for each finding.",
    firstMessage: "Help me write a review checklist for this repository.",
    automation: {
      title: "Pull request opened",
      prompt: "Review {{body.pull_request.html_url}} and report actionable findings.",
      schedule: githubTrigger("pull_request", "body.action", "opened"),
    },
  },
  {
    id: "release-notes",
    name: "Release notes",
    face: "📝",
    purpose: "Draft weekly release notes.",
    instructions: "Summarize user-visible changes and flag changes that need verification.",
    firstMessage: "Help me identify the sources and audience for our release notes.",
    automation: {
      title: "Weekly release notes · Friday at 09:00",
      prompt: "Draft this week's release notes.",
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [5] },
    },
  },
  {
    id: "standup",
    name: "Standup",
    face: "☀️",
    purpose: "Prepare a weekday check-in.",
    instructions: "Summarize progress, next steps, and blockers from the work I share.",
    firstMessage: "Help me set up a short standup format.",
    automation: {
      title: "Weekday check-in · 09:00",
      prompt: "Prepare a brief standup update from the information we have.",
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
    },
  },
  {
    id: "issue-triager",
    name: "Issue triager",
    face: "🏷️",
    purpose: "Triage incoming issues.",
    instructions: "Identify missing information, suggest a priority, and propose a next step.",
    firstMessage: "Help me define the issue categories and their priorities.",
    automation: {
      title: "Issue webhook",
      prompt: "Triage the issue from this event: {{body}}",
      schedule: {
        type: "webhook",
        signature: {
          header: "x-goat-signature",
          encoding: "hex",
          prefix: "sha256=",
          required: true,
        },
      },
    },
  },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  face: string;
  purpose: string;
  instructions: string;
  firstMessage: string;
  automation: { title: string; prompt: string; schedule: ScheduledTaskUpsertSchedule };
}>;

export const goatBotTemplate = (id: string | undefined) =>
  GOAT_BOT_TEMPLATES.find((template) => template.id === id);
