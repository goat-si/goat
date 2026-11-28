// Placeholder data mirroring the Paper SSOT (봇 홈 — SSOT). Replace with server data.
export type BotStatus = "idle" | "working" | "needs-you" | "done";

export interface BotRow {
  id: string;
  name: string;
  driver: string;
  status: BotStatus;
  lastLine: string;
  when: string;
  color: string;
}

export const bots: BotRow[] = [
  { id: "main", name: "GOAT", driver: "claudeAgent", status: "idle", lastLine: "2 decisions are waiting. Everything else is running.", when: "3:41 PM", color: "#111113" },
  { id: "reviewer", name: "Reviewer", driver: "codex", status: "needs-you", lastLine: "PR #7712 reviewed. Decide whether to merge.", when: "Needs you", color: "#FF8A1F" },
  { id: "ci", name: "CI Watch", driver: "claudeAgent", status: "working", lastLine: "Fixing 2 red checks on main. 3/5 tests pass.", when: "Working", color: "#9C6B3E" },
  { id: "browser", name: "Browser Hand", driver: "antigravity", status: "needs-you", lastLine: "Needs a Luma login code. Check your phone.", when: "Needs you", color: "#2FB36B" },
  { id: "standup", name: "Standup", driver: "pi", status: "idle", lastLine: "Posted Mapo and Gangnam threads. Next run 07:00.", when: "Yesterday", color: "#B9B9C0" },
  { id: "release", name: "Release Notes", driver: "opencode", status: "working", lastLine: "Drafting v2.93.0. Features first, fixes below.", when: "Working", color: "#3D5AFE" },
];

export const selectedRuntime = {
  cli: "Codex CLI 0.142.0",
  model: "gpt-6.1-sol · high",
  machine: "Wicked server · local",
  account: "ChatGPT Pro · j***@lidgeai.com",
  permissions: "Full access",
  workspace: "opencodex · codex/pr-7712",
};
