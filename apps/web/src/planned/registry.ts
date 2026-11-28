// Planned surfaces (structure/60_planned.md). One registry so a shell is found and removed in one place:
// when the owner flips a row to live, delete its entry here and the shell that uses it.
export type PlannedState = "planned" | "undecided";
export const PLANNED = {
  "new-bot": { state: "planned", what: "Create a bot with its own face and job" },
  "runtime-picker-other": { state: "planned", what: "Run a bot on Claude, Antigravity, OpenCode or Pi" },
  "runtime-picker-change": { state: "planned", what: "Switch an existing thread's model (change_thread)" },
  "thread-list-slice": { state: "planned", what: "Thread mode: every thread, newest first (next slice)" },
  inbox: { state: "planned", what: "Every request that needs you, in one place" },
  multiplexer: { state: "planned", what: "Open threads side by side in panes" },
  "library-memory": { state: "undecided", what: "Browse and edit what bots remember" },
  machines: { state: "planned", what: "Pick and wake the machines your bots run on" },
  search: { state: "planned", what: "Search across bots and threads" },
  "settings-accounts": { state: "planned", what: "Accounts, providers and sign-in" },
  "terminal-lens": { state: "planned", what: "See a thread as its terminal" },
  activity: { state: "planned", what: "What every bot did, as a feed" },
  usage: { state: "planned", what: "Usage and cost per bot and provider" },
  "pull-requests": { state: "planned", what: "Pull requests your bots opened or reviewed" },
  routines: { state: "planned", what: "Schedules and triggers that start bots" },
  notifications: { state: "planned", what: "Notifications and the activity view" },
  share: { state: "planned", what: "Share a bot or thread" },
  attachments: { state: "planned", what: "Attach files and images" },
  voice: { state: "planned", what: "Talk instead of typing" },
  "thread-filters": { state: "planned", what: "Filter and group threads into folders" },
  "bot-settings": { state: "planned", what: "Change a bot's name, face, job and runtime" },
} as const satisfies Record<string, { state: PlannedState; what: string }>;
export type PlannedId = keyof typeof PLANNED;
export const plannedTooltip = (id: PlannedId) => `${PLANNED[id].what} · not built yet`;
